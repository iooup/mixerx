/**
 * The Stage route: `/stage?session=…` is the studio view (scene
 * library, Director, preview of the audience output), `&mode=display` is the audience display
 * (black chrome, F fullscreen, Shift+B blackout), `&preview=1` is the console's small preview,
 * and `?demo=1` runs the deterministic test signal without a console.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import stageEn from "../../locales/stage.en.json";
import { safeStorage } from "../../state/store";
import { useMediaQuery } from "../../ui/hooks";
import { DisplayHint, StudioChrome } from "../../ui/stage/StudioChrome";
import "../../ui/stage.css";
import { sceneById, sceneCategory, scenesInCategory } from "../../agent/scenes";
import { Crowd, type CrowdHandle } from "../../visuals/crowd/Crowd";
import { DEFAULT_CROWD_LAYOUT, MAX_CROWD_COUNT } from "../../visuals/crowd/characters";
import { PetCrowd } from "../../visuals/crowd/PetCrowd";
import { Director, type Intent } from "../../visuals/director";
import { Face, type FaceHandle } from "../../visuals/face/Face";
import { StageRenderer } from "../../visuals/gpu/renderer";
import type { EventFlags } from "../../visuals/gpu/scene";
import { type IdleHandle, IdleLayer } from "../../visuals/idle/IdleLayer";
import { LowerThird, type LowerThirdHandle } from "../../visuals/lower-third/LowerThird";
import { useStageMeta } from "../../visuals/meta-store";
import { MorphController } from "../../visuals/morph";
import { NightSky, type NightSkyHandle } from "../../visuals/night/NightSky";
import { presetPatch, STAGE_LAST_SESSION_KEY, type StageRole } from "../../visuals/protocol";
import { stageSettingsStore, useStageSettings } from "../../visuals/settings-store";
import { StageClient, toggleCrowd } from "../../visuals/stage-client";
import { stageStatusStore, useStageStatus } from "../../visuals/stage-status";
import { extendDictionaries, t } from "../i18n-core";

extendDictionaries(stageEn);

interface StageQuery {
  session: string | null;
  mode: "studio" | "display";
  preview: boolean;
  demo: boolean;
  speed: number;
  quality: string | null;
}

function readQuery(): StageQuery {
  const params = new URLSearchParams(window.location.search);
  const speed = Number.parseFloat(params.get("speed") ?? "1");
  return {
    session: params.get("session"),
    mode: params.get("mode") === "display" ? "display" : "studio",
    preview: params.get("preview") === "1",
    demo: params.get("demo") === "1",
    speed: Number.isFinite(speed) && speed > 0 ? Math.min(16, speed) : 1,
    quality: params.get("quality"),
  };
}

function ConnectPanel({ onLast, onDemo }: { onLast: (id: string) => void; onDemo: () => void }) {
  const last = safeStorage()?.getItem(STAGE_LAST_SESSION_KEY) ?? null;
  return (
    <main className="stage stage--connect" data-testid="stage" data-connected="false" data-mode="connect">
      <div className="stage-connect">
        <div className="stage-connect__card">
          <h1>{t("stage.connect.title")}</h1>
          <p>{t("stage.connect.body")}</p>
          <div className="stage-connect__actions">
            {last && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => onLast(last)}
                data-testid="stage-connect-last"
              >
                {t("stage.connect.last")} · <span className="num">{last}</span>
              </button>
            )}
            <button type="button" onClick={onDemo} data-testid="stage-connect-demo">
              {t("stage.connect.demo")}
            </button>
            <a className="badge badge--muted" href="/">
              {t("stage.connect.console")}
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Renderers by canvas: survives StrictMode's double mount, disposed on real unmount. */
const renderers = new Map<HTMLCanvasElement, Promise<StageRenderer | null>>();

/**
 * Simulation step cap. A stall longer than this (a hidden tab, a screenshot, a long task) is
 * integrated as one step and the remainder dropped, so returning to a tab never explodes a scene.
 */
const MAX_SIM_STEP = 1 / 30;
const FRAME_RING = 240;
/** Wall-clock milliseconds of the last rendered frames, and how many long tasks since connect. */
const frameTimes = new Float32Array(FRAME_RING);
let frameCursor = 0;
let longTasks = 0;
let longestTaskMs = 0;
let maxFrameMs = 0;
/** `performance.now()` → the absolute clock the frames are stamped on. */
const originMs = typeof performance === "undefined" ? 0 : performance.timeOrigin;

if (typeof PerformanceObserver !== "undefined") {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks += 1;
        longestTaskMs = Math.max(longestTaskMs, entry.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // Long-task timing is a diagnostic, not a feature.
  }
}

function readPerf(client: StageClient): StagePerf {
  const filled = Math.min(FRAME_RING, frameCursor);
  const values: number[] = [];
  for (let i = 0; i < filled; i += 1) values.push(frameTimes[i] as number);
  values.sort((a, b) => a - b);
  const at = (p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  const median = at(0.5);
  const renderer = rendererForPerf;
  return {
    fps: median > 0 ? Math.round(1000 / median) : 0,
    medianFrameMs: Math.round(median * 100) / 100,
    p95FrameMs: Math.round(at(0.95) * 100) / 100,
    gpuMs: renderer?.gpuTimeMs ?? null,
    longTasks,
    maxFrameMs: Math.round(maxFrameMs * 100) / 100,
    longestTaskMs: Math.round(longestTaskMs * 10) / 10,
    frameAgeMs: Math.round(client.prediction(originMs + performance.now()).ageMs),
    scale: renderer?.scale ?? 1,
    warmedUp: renderer?.warmedUp ?? false,
  };
}

/** Clears the accumulators so a test can measure one interval (a scene sweep) on its own. */
function resetPerf(): void {
  frameCursor = 0;
  frameTimes.fill(0);
  longTasks = 0;
  longestTaskMs = 0;
  maxFrameMs = 0;
}

/** The renderer the perf hook reports on (one Stage window renders one canvas). */
let rendererForPerf: StageRenderer | null = null;

interface StageViewProps {
  session: string | null;
  mode: "studio" | "display";
  preview: boolean;
  demo: boolean;
  speed: number;
  quality: string | null;
}

/** Frame-time statistics of the Stage window; `perf()` on the dev hook, nothing persisted. */
export interface StagePerf {
  fps: number;
  medianFrameMs: number;
  p95FrameMs: number;
  gpuMs: number | null;
  longTasks: number;
  /** Worst frame and worst long task since the last `perfReset()` (the whole session by default). */
  maxFrameMs: number;
  longestTaskMs: number;
  /** Age of the frame the prediction runs from, in milliseconds. */
  frameAgeMs: number;
  scale: number;
  warmedUp: boolean;
}

interface DevHook {
  stats(): Promise<unknown> | null;
  intent(): Intent | null;
  settings(): unknown;
  patch(patch: unknown): void;
  renderer(): StageRenderer | null;
  perf(): StagePerf;
  perfReset(): void;
}

function StageView({ session, mode, preview, demo, speed, quality }: StageViewProps) {
  const settings = useStageSettings();
  const status = useStageStatus();
  const meta = useStageMeta();
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const prefersReduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const outputRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const crowdRef = useRef<CrowdHandle>(null);
  const faceRef = useRef<FaceHandle>(null);
  const lowerThirdRef = useRef<LowerThirdHandle>(null);
  const idleRef = useRef<IdleHandle>(null);
  const nightSkyRef = useRef<NightSkyHandle>(null);
  const morphRef = useRef<MorphController>(new MorphController());
  const rendererRef = useRef<StageRenderer | null>(null);
  const [renderer, setRenderer] = useState<StageRenderer | null>(null);
  const directorRef = useRef<Director>(new Director(stageSettingsStore.getState().sceneId));
  const intentRef = useRef<Intent | null>(null);
  const role: StageRole = preview ? "preview" : mode === "display" ? "display" : "studio";
  const client = useMemo(() => new StageClient(session, { role, demo, speed }), [session, role, demo, speed]);
  const [attempts, setAttempts] = useState(0);

  // Channel / demo signal.
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  // Renderer: one per canvas (React StrictMode mounts twice; a second device on the same canvas
  // invalidates the first context), disposed only when the canvas really leaves the document;
  // re-created after a device loss.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    const cached = attempts === 0 ? renderers.get(canvas) : undefined;
    const promise = cached ?? StageRenderer.create(canvas, { quality, preview });
    renderers.set(canvas, promise);
    void promise.then((created) => {
      if (!active) return;
      if (!created) {
        stageStatusStore.dispatch({ type: "status/patch", patch: { webgpu: "no" } });
        return;
      }
      created.onLost = (reason) => {
        renderers.delete(canvas);
        rendererRef.current = null;
        rendererForPerf = null;
        setRenderer(null);
        stageStatusStore.dispatch({ type: "status/patch", patch: { lost: true, webgpu: "pending" } });
        if (reason !== "destroyed" && attempts < 3) setTimeout(() => setAttempts((n) => n + 1), 500);
      };
      rendererRef.current = created;
      rendererForPerf = created;
      setRenderer(created);
      const output = outputRef.current;
      if (output) {
        const dpr = preview ? 1 : Math.min(2, window.devicePixelRatio || 1);
        created.resize(output.clientWidth * dpr, output.clientHeight * dpr);
      }
      stageStatusStore.dispatch({
        type: "status/patch",
        patch: {
          webgpu: "yes",
          gpuName: created.info.architecture || created.info.vendor || created.info.description || "",
          software: created.info.software,
          lost: false,
        },
      });
    });
    return () => {
      active = false;
      rendererRef.current = null;
      setRenderer(null);
      // A StrictMode remount happens synchronously; a real unmount leaves the canvas disconnected.
      setTimeout(() => {
        if (canvas.isConnected || renderers.get(canvas) !== promise) return;
        renderers.delete(canvas);
        void promise.then((created) => created?.dispose());
      }, 0);
    };
  }, [quality, preview, attempts]);

  // Size follows the output box and the device pixel ratio.
  useEffect(() => {
    const output = outputRef.current;
    if (!output || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const dpr = preview ? 1 : Math.min(2, window.devicePixelRatio || 1);
      rendererRef.current?.resize(output.clientWidth * dpr, output.clientHeight * dpr);
    });
    observer.observe(output);
    return () => observer.disconnect();
  }, [preview]);

  // The render loop: frames → prediction → Director → renderer + crowd.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastStatus = 0;
    let fpsCount = 0;
    let fpsSince = performance.now();
    let fps = 0;
    const director = directorRef.current;
    const tick = (now: number) => {
      if (!document.hidden) raf = requestAnimationFrame(tick);
      if (preview && now - last < 30) return;
      // The simulation step is capped at 1/30 s: after a stall (a hidden tab, a screenshot) exactly
      // one capped step is integrated and the rest is dropped, so nothing explodes on return.
      const elapsed = (now - last) / 1000;
      const dt = Math.min(MAX_SIM_STEP, elapsed);
      last = now;
      frameTimes[frameCursor % FRAME_RING] = elapsed * 1000;
      frameCursor += 1;
      if (frameCursor > 1) maxFrameMs = Math.max(maxFrameMs, elapsed * 1000);
      const nowMs = originMs + now;
      const { frame, events } = client.take(nowMs, dt);
      const current = stageSettingsStore.getState();
      const effective =
        prefersReduced && !current.reducedMotion ? { ...current, reducedMotion: true } : current;
      const intent = director.update(frame, events, effective, dt, {
        frameAgeSec: client.prediction(nowMs).ageMs / 1000,
      });
      // The lower third is a DOM layer, so it reports its own visibility back into the intent: the
      // composite lifts the bottom of the picture a little while type is over it.
      intent.lowerThird =
        lowerThirdRef.current?.update(intent, dt, metaRef.current.now, effective.lowerThird) ?? 0;
      idleRef.current?.update(intent, dt);
      nightSkyRef.current?.update(intent, dt, effective.nightSky);
      // The message the galaxy writes: the controller owns the timing, the renderer the points.
      intent.morph = morphRef.current.step(
        effective.morph,
        metaRef.current.now?.title ?? "",
        intent,
        dt,
        events.some((event) => event.kind === "drop"),
      );
      const targets = morphRef.current.takeTargets();
      if (targets) rendererRef.current?.setMorphTargets(targets.points, targets.count);
      intentRef.current = intent;
      const flags: EventFlags = { kick: 0, snare: 0, hat: 0, bar: 0 };
      for (const event of events) {
        if (event.kind === "kick") flags.kick = 1;
        else if (event.kind === "snare") flags.snare = 1;
        else if (event.kind === "hat") flags.hat = 1;
        else if (event.kind === "bar") flags.bar = 1;
      }
      rendererRef.current?.render(intent, dt, flags);
      crowdRef.current?.update(intent, dt);
      faceRef.current?.update(intent, dt);
      fpsCount += 1;
      if (now - fpsSince >= 1000) {
        fps = Math.round((fpsCount * 1000) / (now - fpsSince));
        fpsCount = 0;
        fpsSince = now;
      }
      if (now - lastStatus >= 250) {
        lastStatus = now;
        const clientState = client.getState();
        stageStatusStore.dispatch({
          type: "status/patch",
          patch: {
            fps,
            gpuTimeMs: rendererRef.current?.gpuTimeMs ?? null,
            scale: rendererRef.current?.scale ?? 1,
            sceneId: intent.sceneId,
            pendingScene: director.pendingScene ?? (intent.transition ? intent.transition.to : null),
            connected: clientState.connected,
            frameRate: clientState.frameRate,
            flashes: intent.flashesLastSecond,
            section: intent.section,
            barsToNext: intent.barsToNext,
            onAir: intent.onAir,
            bpm: Math.round(intent.beat.bpm * 10) / 10,
            crossfader: Math.round(intent.balance * 100) / 100,
            intensity: Math.round(intent.intensity * 20) / 20,
            crowd: intent.crowd,
            face:
              sceneById(intent.sceneId)?.layer === "face" ||
              sceneById(intent.transition?.to ?? "")?.layer === "face",
          },
        });
      }
    };
    // Hidden windows get no animation frames; a 100 ms timer keeps settings, scene switches and
    // presence current so a display catches up the moment it is shown again.
    let timer: ReturnType<typeof setInterval> | null = null;
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        if (!timer) timer = setInterval(() => tick(performance.now()), 100);
      } else {
        if (timer) clearInterval(timer);
        timer = null;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
    };
  }, [client, preview, prefersReduced]);

  // Keys: F fullscreen, Shift+B blackout, T test signal (studio), 1–6 scenes (studio).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea")) return;
      const key = event.key.toLowerCase();
      if (key === "f" && !event.shiftKey) {
        event.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
      } else if (key === "b" && event.shiftKey) {
        event.preventDefault();
        client.patch({ blackout: !stageSettingsStore.getState().blackout });
      } else if (key === "t" && !event.shiftKey && mode === "studio") {
        event.preventDefault();
        client.patch({ testSignal: !stageSettingsStore.getState().testSignal });
      } else if (key === "c" && !event.shiftKey && mode === "studio") {
        event.preventDefault();
        toggleCrowd(client);
      } else if (key === "n" && !event.shiftKey && mode === "studio") {
        event.preventDefault();
        client.patch({ lowerThird: !stageSettingsStore.getState().lowerThird });
      } else if (key === "m" && !event.shiftKey && mode === "studio") {
        event.preventDefault();
        const morph = stageSettingsStore.getState().morph;
        client.patch({ morph: { ...morph, mode: morph.mode === "off" ? "hold" : "off" } });
      } else if (event.shiftKey && /^Digit[1-9]$/.test(event.code) && mode === "studio") {
        // Shift+1…9 recalls a vibe. The digit comes from the physical key, so it works on every
        // layout (Shift+1 is "!" on a US keyboard and something else again elsewhere).
        const settings = stageSettingsStore.getState();
        const preset = settings.presets[Number(event.code.slice(5)) - 1];
        if (preset) {
          event.preventDefault();
          client.patch(presetPatch(preset, settings));
        }
      } else if (/^[1-9]$/.test(event.key) && !event.shiftKey && mode === "studio") {
        const category = sceneCategory(stageSettingsStore.getState().sceneId);
        const id = scenesInCategory(category)[Number(event.key) - 1]?.id;
        if (id) client.patch({ sceneId: id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client, mode]);

  // Development hook for the legibility, sync and performance specs.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook: DevHook = {
      stats: () => rendererRef.current?.requestStats() ?? Promise.resolve(null),
      intent: () => intentRef.current,
      settings: () => stageSettingsStore.getState(),
      patch: (patch) => client.patch(patch as Parameters<StageClient["patch"]>[0]),
      renderer: () => rendererRef.current,
      perf: () => readPerf(client),
      perfReset: resetPerf,
    };
    (globalThis as { mixerxStage?: DevHook }).mixerxStage = hook;
    return () => {
      delete (globalThis as { mixerxStage?: DevHook }).mixerxStage;
    };
  }, [client]);

  const crowdCount = status.crowd ? MAX_CROWD_COUNT : 0;
  const crowdStyle = settings.crowdStyles[status.sceneId] ?? "classic";
  const crowdLayout = settings.crowdLayouts[status.sceneId] ?? DEFAULT_CROWD_LAYOUT;
  const display = mode === "display";
  const classes = display ? "stage stage--display" : "stage";
  return (
    <main
      className={classes}
      data-testid="stage"
      data-mode={preview ? "preview" : mode}
      data-connected={status.connected}
      data-scene={status.sceneId}
      data-blackout={settings.blackout}
      data-webgpu={status.webgpu}
      data-demo={demo}
    >
      {!display && <StudioChrome client={client} renderer={renderer} />}
      <div className="stage__output" ref={outputRef} data-testid="stage-output">
        <canvas ref={canvasRef} className="stage__canvas" data-testid="stage-canvas" />
        {status.face && <Face ref={faceRef} visible={status.face} />}
        {crowdCount > 0 &&
          (crowdStyle === "classic" ? (
            <Crowd ref={crowdRef} count={crowdCount} />
          ) : (
            <PetCrowd ref={crowdRef} layout={crowdLayout} character={crowdStyle} />
          ))}
        <NightSky ref={nightSkyRef} night={meta.night} />
        <IdleLayer ref={idleRef} eventName={meta.eventName || settings.eventName} />
        <LowerThird ref={lowerThirdRef} />
        {status.webgpu === "no" && <NoWebGpu />}
      </div>
      {display && !preview && <DisplayHint />}
    </main>
  );
}

function NoWebGpu() {
  return (
    <p className="stage__nogpu" role="status" data-testid="stage-nogpu">
      <b>{t("stage.noWebgpu")}</b> — {t("stage.noWebgpuBody")}
    </p>
  );
}

export function StagePage() {
  const query = useMemo(readQuery, []);
  const [session, setSession] = useState<string | null>(query.session);
  const [demo, setDemo] = useState(query.demo);

  useEffect(() => {
    document.title = `${t("app.name")} — ${t("stage.title")}`;
  }, []);

  if (!session && !demo) return <ConnectPanel onLast={setSession} onDemo={() => setDemo(true)} />;
  return (
    <StageView
      session={demo ? null : session}
      mode={query.mode}
      preview={query.preview}
      demo={demo}
      speed={query.speed}
      quality={query.quality}
    />
  );
}
