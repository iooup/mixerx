/**
 * Studio chrome around the output: top bar (VISUALS · LIVE · WebGPU,
 * OPEN DISPLAY, TEST SIGNAL, BLACKOUT, BACK TO CONSOLE), the Scene Library with live thumbnails,
 * the Director panel, and a read-only mirror of the ON-AIR strip.
 */
import {
  ArrowLeft,
  Maximize2,
  MonitorPlay,
  Moon,
  Pencil,
  Plus,
  TestTube2,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type SceneCategory, sceneById, sceneCategory, scenesInCategory } from "../../agent/scenes";
import { t } from "../../app/i18n-core";
import type { ScreenChoice } from "../../visuals/console-bridge";
import type { StageRenderer } from "../../visuals/gpu/renderer";
import {
  type MorphMode,
  type NightSkyMode,
  type PaletteSource,
  PRESET_CAP,
  type Preset,
  presetPatch,
  type TransitionStyle,
} from "../../visuals/protocol";
import { stageSettingsStore, useStageSettings } from "../../visuals/settings-store";
import { type StageClient, toggleCrowd } from "../../visuals/stage-client";
import { useStageStatus } from "../../visuals/stage-status";
import { Segmented } from "../components/Segmented";
import { CrowdPicker } from "./CrowdPicker";

interface ChromeProps {
  client: StageClient;
  renderer: StageRenderer | null;
}

function backToConsole(event: React.MouseEvent<HTMLAnchorElement>): void {
  const opener = window.opener as Window | null;
  if (opener && !opener.closed) {
    event.preventDefault();
    opener.focus();
    window.close();
  }
}

async function openDisplayFromStage(sessionId: string | null, screenIndex: number | null): Promise<void> {
  if (!sessionId) return;
  const bridge = await import("../../visuals/console-bridge");
  await bridge.openDisplay(sessionId, screenIndex);
}

function TopBar({ client }: { client: StageClient }) {
  const settings = useStageSettings();
  const status = useStageStatus();
  const [screens, setScreens] = useState<ScreenChoice[] | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const demo = client.getState().demo;
  const signal = !status.connected
    ? t("stage.noSignal")
    : demo
      ? t("stage.demoSignal")
      : settings.testSignal
        ? t("stage.testSignal")
        : t("stage.live", { fps: status.fps });
  const gpu =
    status.webgpu === "no"
      ? t("stage.noWebgpu")
      : status.software
        ? t("stage.webgpuSoftware")
        : t("stage.webgpu", { name: status.gpuName || "GPU" });

  const openDisplay = async () => {
    if (demo || !client.sessionId) return;
    const bridge = await import("../../visuals/console-bridge");
    const list = await bridge.listScreens();
    if (list && list.length > 1) {
      setScreens(list);
      popoverRef.current?.showPopover?.();
      return;
    }
    await bridge.openDisplay(client.sessionId, null);
  };

  return (
    <header className="stage__top" data-testid="stage-top">
      <span className="stage__title">{t("stage.visuals")}</span>
      <div className="stage__status">
        <span
          className={status.connected ? "badge badge--ok" : "badge badge--warn"}
          data-testid="stage-signal"
          role="status"
        >
          {signal}
        </span>
        <span
          className={status.webgpu === "no" ? "badge badge--danger" : "badge badge--muted"}
          data-testid="stage-gpu"
        >
          {gpu}
        </span>
        {status.gpuTimeMs !== null && (
          <span className="badge badge--muted num">
            {t("stage.gpuTime", { ms: status.gpuTimeMs.toFixed(1) })}
          </span>
        )}
        {status.scale < 0.99 && (
          <span className="badge badge--muted num">
            {t("stage.scale", { pct: Math.round(status.scale * 100) })}
          </span>
        )}
      </div>
      <div className="stage__actions">
        <button
          type="button"
          onClick={() => void openDisplay()}
          disabled={demo || !client.sessionId}
          data-testid="stage-open-display"
        >
          <MonitorPlay size={16} /> <span className="stage__btn-text">{t("stage.openDisplay")}</span>
        </button>
        <div ref={popoverRef} id="screen-popover" popover="auto" className="screen-popover">
          <span className="label">{t("stage.chooseScreen")}</span>
          <ul>
            {(screens ?? []).map((screen) => (
              <li key={screen.index}>
                <button
                  type="button"
                  onClick={() => {
                    popoverRef.current?.hidePopover?.();
                    void openDisplayFromStage(client.sessionId, screen.index);
                  }}
                >
                  {screen.label} ·{" "}
                  <span className="num">
                    {screen.width}×{screen.height}
                  </span>
                  {screen.primary ? ` · ${t("stage.screenPrimary")}` : ""}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => {
                  popoverRef.current?.hidePopover?.();
                  void openDisplayFromStage(client.sessionId, null);
                }}
              >
                {t("stage.screenAny")}
              </button>
            </li>
          </ul>
        </div>
        <button
          type="button"
          aria-pressed={settings.testSignal}
          disabled={demo}
          onClick={() => client.patch({ testSignal: !settings.testSignal })}
          data-testid="stage-test-signal"
        >
          <TestTube2 size={16} /> <span className="stage__btn-text">{t("stage.testSignal")}</span>
        </button>
        <button
          type="button"
          aria-pressed={status.crowd}
          onClick={() => toggleCrowd(client)}
          title={t("stage.crowdHint")}
          data-testid="stage-crowd-toggle"
        >
          <Users size={16} /> <span className="stage__btn-text">{t("stage.crowdButton")}</span>
        </button>
        <button
          type="button"
          className="stage__blackout"
          aria-pressed={settings.blackout}
          onClick={() => client.patch({ blackout: !settings.blackout })}
          data-testid="stage-blackout"
        >
          <Moon size={16} />{" "}
          <span className="stage__btn-text">
            {settings.blackout ? t("stage.restore") : t("stage.blackout")}
          </span>
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("stage.fullscreen")}
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen().catch(() => {});
          }}
        >
          <Maximize2 size={16} />
        </button>
        <a className="badge badge--muted" href="/" onClick={backToConsole} data-testid="stage-back">
          <ArrowLeft size={14} /> <span className="stage__btn-text">{t("stage.backToConsole")}</span>
        </a>
      </div>
    </header>
  );
}

/**
 * Live thumbnail of one scene. It is attached to the renderer only while the card is on screen:
 * a card scrolled out of the library costs nothing, and the round-robin that refreshes them has
 * fewer scenes to simulate.
 */
function Thumbnail({ sceneId, renderer }: { sceneId: string; renderer: StageRenderer | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !renderer) return;
    if (typeof IntersectionObserver === "undefined") return renderer.attachThumbnail(sceneId, canvas);
    let detach: (() => void) | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.at(-1)?.isIntersecting ?? false;
        if (visible && !detach) detach = renderer.attachThumbnail(sceneId, canvas);
        else if (!visible && detach) {
          detach();
          detach = null;
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      detach?.();
    };
  }, [renderer, sceneId]);
  return <canvas ref={ref} className="scene-card__thumb" width={192} height={108} />;
}

function SceneLibrary({ client, renderer }: ChromeProps) {
  const settings = useStageSettings();
  const status = useStageStatus();
  const category = sceneCategory(settings.sceneId);
  const lastScene = useRef<Record<SceneCategory, string>>({
    classic: "intro-lines",
    simple: "line-waves",
    cinematic: "cinematic-phoenix",
  });
  useEffect(() => {
    lastScene.current[category] = settings.sceneId;
  }, [category, settings.sceneId]);
  return (
    <nav className="stage__library" aria-label={t("stage.sceneLibrary")} data-testid="scene-library">
      <div className="scene-library__header">
        <h2 className="label">{t("stage.sceneLibrary")}</h2>
        <Segmented
          label={t("stage.sceneCategory")}
          value={category}
          options={(["classic", "simple", "cinematic"] as const).map((value) => ({
            value,
            label: t(`stage.category.${value}`),
          }))}
          onChange={(value) => client.patch({ sceneId: lastScene.current[value] })}
          testId="scene-category"
        />
        <p className="scene-library__hint">
          {t(category === "cinematic" ? "stage.cinematicHint" : "stage.categoryHint")}
        </p>
      </div>
      {scenesInCategory(category).map((scene) => {
        const current = status.sceneId === scene.id;
        const pending = status.pendingScene === scene.id && !current;
        return (
          <button
            key={scene.id}
            type="button"
            className="scene-card"
            aria-pressed={current || settings.sceneId === scene.id}
            data-pending={pending}
            data-testid={`scene-${scene.id}`}
            onClick={() =>
              client.patch({
                sceneId: scene.id,
                blackout: scene.id === "blackout" ? settings.blackout : false,
              })
            }
          >
            <Thumbnail sceneId={scene.id} renderer={renderer} />
            <span className="scene-card__title">
              {scene.title}
              {pending ? ` · ${t("stage.pending")}` : ""}
            </span>
            <span className="scene-card__meta">
              {scene.sections.length
                ? `${t("stage.suits")}: ${scene.sections.map((section) => t(`section.${section}`)).join(" · ")}`
                : ""}
            </span>
            <span className="scene-card__desc">{t(`scene.desc.${scene.id}`)}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** Name of a preset: the four we ship follow the interface language until the DJ renames them. */
export function presetLabel(preset: Preset): string {
  if (!preset.builtin) return preset.name;
  const translated = t(`stage.preset.${preset.builtin}`);
  // `translate` returns the key itself when a string is missing; fall back to the stored name.
  return translated === `stage.preset.${preset.builtin}` ? preset.name : translated;
}

/**
 * Vibes: one keystroke recalls a whole look. Saving takes the scene, palette, transition,
 * intensity, crowd and lower third exactly as they are now; applying puts them back and touches
 * nothing else (blackout, the test signal and the follow rule stay the DJ's).
 */
function Presets({ client }: { client: StageClient }) {
  const settings = useStageSettings();
  const status = useStageStatus();
  const presets = settings.presets;
  const save = () => {
    if (presets.length >= PRESET_CAP) return;
    const scene = status.sceneId && status.sceneId !== "blackout" ? status.sceneId : settings.sceneId;
    const suggestion = sceneById(scene)?.title ?? t("stage.presets");
    const name = window.prompt(t("stage.presetNamePrompt"), suggestion)?.trim();
    if (!name) return;
    const preset: Preset = {
      name: name.slice(0, 24),
      sceneId: scene,
      palette: settings.palette,
      ...(settings.custom ? { custom: settings.custom } : {}),
      transition: settings.transition,
      intensity: settings.intensity,
      crowd: settings.crowdScenes.includes(scene),
      crowdStyle: settings.crowdStyles[scene] ?? "classic",
      crowdLayout: settings.crowdLayouts[scene],
      lowerThird: settings.lowerThird,
    };
    client.patch({ presets: [...presets, preset] });
  };
  const rename = (index: number) => {
    const preset = presets[index];
    if (!preset) return;
    const name = window.prompt(t("stage.presetNamePrompt"), presetLabel(preset))?.trim();
    if (!name) return;
    // A renamed built-in becomes the DJ's own: the name no longer follows the interface language.
    const { builtin: _builtin, ...rest } = preset;
    client.patch({
      presets: presets.map((entry, i) => (i === index ? { ...rest, name: name.slice(0, 24) } : entry)),
    });
  };
  const remove = (index: number) => client.patch({ presets: presets.filter((_entry, i) => i !== index) });
  return (
    <section className="stage__presets" aria-label={t("stage.presets")} data-testid="stage-presets">
      <div className="stage__presets-head">
        <h2 className="label">{t("stage.presets")}</h2>
        <button
          type="button"
          className="stage__preset-save"
          onClick={save}
          disabled={presets.length >= PRESET_CAP}
          title={presets.length >= PRESET_CAP ? t("stage.presetFull") : undefined}
          data-testid="stage-preset-save"
        >
          <Plus size={14} /> {t("stage.presetSave")}
        </button>
      </div>
      {presets.length === 0 && <p className="stage__presets-empty">{t("stage.presetEmpty")}</p>}
      <ul className="stage__preset-list">
        {presets.map((preset, index) => {
          const label = presetLabel(preset);
          return (
            <li key={`${preset.builtin ?? "custom"}-${preset.name}`} className="stage__preset">
              <button
                type="button"
                className="stage__preset-apply"
                aria-pressed={settings.sceneId === preset.sceneId}
                title={t("stage.presetApplyHint", { n: index + 1 })}
                onClick={() => client.patch(presetPatch(preset, stageSettingsStore.getState()))}
                data-testid={`stage-preset-${index + 1}`}
              >
                <span className="stage__preset-name">{label}</span>
                <kbd>⇧{index + 1}</kbd>
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("stage.presetRename", { name: label })}
                onClick={() => rename(index)}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("stage.presetDelete", { name: label })}
                onClick={() => remove(index)}
                data-testid={`stage-preset-delete-${index + 1}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(value: boolean): void;
  testId: string;
}) {
  return (
    <label className="director__toggle" title={hint}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
      />
    </label>
  );
}

function DirectorPanel({ client }: { client: StageClient }) {
  const settings = useStageSettings();
  const status = useStageStatus();
  const custom = settings.custom ?? ["#ffa03c", "#3fd5ff"];
  return (
    <aside className="stage__director" aria-label={t("stage.director")} data-testid="director-panel">
      <h2 className="label">{t("stage.director")}</h2>
      <p className="director__hint">{t("stage.controlsHint")}</p>
      <section className="director__section">
        <label className="director__row" htmlFor="stage-intensity">
          <span>{t("stage.intensity")}</span>
          <span className="num">{Math.round(settings.intensity * 100)} %</span>
        </label>
        <input
          id="stage-intensity"
          className="director__range"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={settings.intensity}
          onChange={(event) => client.patch({ intensity: Number(event.target.value) })}
          data-testid="stage-intensity"
        />
        <div className="director__range-labels">
          <span>{t("stage.calm")}</span>
          <span>{t("stage.immersive")}</span>
        </div>
        <Toggle
          label={t("stage.follow")}
          hint={t("stage.followHint")}
          checked={settings.follow}
          onChange={(follow) => client.patch({ follow })}
          testId="stage-follow"
        />
      </section>
      <details className="director__details" data-testid="stage-appearance">
        <summary>{t("stage.appearance")}</summary>
        <section className="director__section">
          <div className="director__row">
            <span>{t("stage.palette")}</span>
            <Segmented
              label={t("stage.palette")}
              value={settings.palette}
              options={(["key", "decks", "custom"] as PaletteSource[]).map((value) => ({
                value,
                label: t(`stage.palette.${value}`),
              }))}
              onChange={(palette) => client.patch({ palette })}
              testId="stage-palette"
            />
          </div>
          {settings.palette === "custom" && (
            <div className="director__colours">
              <input
                type="color"
                value={custom[0]}
                aria-label={t("stage.customA")}
                onChange={(event) => client.patch({ custom: [event.target.value, custom[1]] })}
              />
              <input
                type="color"
                value={custom[1]}
                aria-label={t("stage.customB")}
                onChange={(event) => client.patch({ custom: [custom[0], event.target.value] })}
              />
            </div>
          )}
          <div className="director__row">
            <span>{t("stage.transition")}</span>
            <Segmented
              label={t("stage.transition")}
              value={settings.transition}
              options={(["cut", "dissolve", "wipe"] as TransitionStyle[]).map((value) => ({
                value,
                label: t(`stage.transition.${value}`),
              }))}
              onChange={(transition) => client.patch({ transition })}
              testId="stage-transition"
            />
          </div>
        </section>
        <section className="director__section">
          <Toggle
            label={t("stage.sectionReactions")}
            checked={settings.sectionReactions}
            onChange={(sectionReactions) => client.patch({ sectionReactions })}
            testId="stage-reactions"
          />
          <Toggle
            label={t("stage.photosensitive")}
            hint={t("stage.photosensitiveHint")}
            checked={settings.photosensitiveSafe}
            onChange={(photosensitiveSafe) => client.patch({ photosensitiveSafe })}
            testId="stage-photosensitive"
          />
          <Toggle
            label={t("stage.reducedMotion")}
            checked={settings.reducedMotion}
            onChange={(reducedMotion) => client.patch({ reducedMotion })}
            testId="stage-reduced"
          />
        </section>
      </details>
      <details className="director__details" data-testid="stage-overlays">
        <summary>{t("stage.overlays")}</summary>
        <section className="director__section">
          <Toggle
            label={t("stage.crowd")}
            hint={t("stage.crowdHint")}
            checked={status.crowd}
            onChange={() => toggleCrowd(client)}
            testId="stage-crowd"
          />
          <CrowdPicker client={client} />
          <Toggle
            label={t("stage.lowerThird")}
            hint={t("stage.lowerThirdHint")}
            checked={settings.lowerThird}
            onChange={(lowerThird) => client.patch({ lowerThird })}
            testId="stage-lower-third"
          />
        </section>
        <section className="director__section">
          <label className="director__row" htmlFor="stage-morph-text">
            <span title={t("stage.morphHint")}>{t("stage.morph")}</span>
          </label>
          <input
            id="stage-morph-text"
            className="director__text"
            type="text"
            maxLength={24}
            dir="auto"
            value={settings.morph.text}
            placeholder={t("stage.morphPlaceholder")}
            onChange={(event) => client.patch({ morph: { ...settings.morph, text: event.target.value } })}
            data-testid="stage-morph-text"
          />
          <div className="director__row">
            <Segmented
              label={t("stage.morph")}
              value={settings.morph.mode}
              options={(["off", "hold", "auto"] as MorphMode[]).map((value) => ({
                value,
                label: t(`stage.morph.${value}`),
              }))}
              onChange={(mode) => client.patch({ morph: { ...settings.morph, mode } })}
              testId="stage-morph-mode"
            />
          </div>
          <div className="director__row">
            <span title={t("stage.nightSkyHint")}>{t("stage.nightSky")}</span>
            <Segmented
              label={t("stage.nightSky")}
              value={settings.nightSky}
              options={(["auto", "always", "off"] as NightSkyMode[]).map((value) => ({
                value,
                label: t(`stage.nightSky.${value}`),
              }))}
              onChange={(nightSky) => client.patch({ nightSky })}
              testId="stage-night-sky"
            />
          </div>
        </section>
        <section className="director__section">
          <label className="director__row" htmlFor="stage-event-name">
            <span title={t("stage.eventNameHint")}>{t("stage.eventName")}</span>
          </label>
          <input
            id="stage-event-name"
            className="director__text"
            type="text"
            maxLength={40}
            dir="auto"
            value={settings.eventName}
            placeholder={t("stage.eventNamePlaceholder")}
            onChange={(event) => client.patch({ eventName: event.target.value })}
            data-testid="stage-event-name"
          />
        </section>
      </details>
      <details className="director__details" data-testid="stage-diagnostics">
        <summary>{t("stage.readout")}</summary>
        <section className="director__section">
          <dl className="director__readout" data-testid="stage-readout">
            <dt>{t("stage.readout.scene")}</dt>
            <dd data-testid="readout-scene">{status.sceneId || t("stage.readout.none")}</dd>
            <dt>{t("stage.readout.next")}</dt>
            <dd>
              {status.pendingScene
                ? t("stage.readout.atBar", { scene: status.pendingScene })
                : t("stage.readout.none")}
            </dd>
            <dt>{t("stage.readout.section")}</dt>
            <dd>
              {status.section === "none"
                ? t("stage.readout.none")
                : status.barsToNext >= 0
                  ? t("deck.sectionIn", { section: t(`section.${status.section}`), bars: status.barsToNext })
                  : t(`section.${status.section}`)}
            </dd>
            <dt>{t("stage.readout.flashes")}</dt>
            <dd data-testid="readout-flashes">{status.flashes}</dd>
            <dt>{t("stage.readout.frames")}</dt>
            <dd>{status.frameRate}</dd>
          </dl>
        </section>
      </details>
    </aside>
  );
}

function Strip() {
  const status = useStageStatus();
  const onAir =
    status.onAir === "both"
      ? t("onair.both")
      : status.onAir === "A"
        ? t("onair.a")
        : status.onAir === "B"
          ? t("onair.b")
          : t("onair.silent");
  const percentB = Math.round(status.crossfader * 100);
  return (
    <footer className="stage__strip" data-testid="stage-strip">
      <span className={status.onAir === "none" ? "led" : "led led--on"} aria-hidden="true" />
      <span className="onair__status">{onAir}</span>
      <span className="num">
        {status.bpm > 0 ? status.bpm.toFixed(1) : "—"} {t("onair.bpm")}
      </span>
      <span>
        {status.section === "none"
          ? t("stage.readout.none")
          : status.barsToNext >= 0
            ? t("deck.sectionIn", { section: t(`section.${status.section}`), bars: status.barsToNext })
            : t(`section.${status.section}`)}
      </span>
      <span
        className="xfade"
        role="img"
        aria-label={t("onair.crossfader", { a: 100 - percentB, b: percentB })}
      >
        <b style={{ color: "var(--deck-a)" }}>A</b>
        <span className="xfade__rail" aria-hidden="true">
          <span className="xfade__knob" style={{ left: `${percentB}%` }} />
        </span>
        <b style={{ color: "var(--deck-b)" }}>B</b>
      </span>
    </footer>
  );
}

export function StudioChrome({ client, renderer }: ChromeProps) {
  return (
    <>
      <TopBar client={client} />
      <div className="stage__left">
        <SceneLibrary client={client} renderer={renderer} />
        <Presets client={client} />
      </div>
      <DirectorPanel client={client} />
      <Strip />
    </>
  );
}

/** Audience Display: a hint that fades after a few seconds and returns on mouse movement. */
export function DisplayHint() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let timer = setTimeout(() => setVisible(false), 4000);
    const wake = () => {
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 3000);
    };
    window.addEventListener("mousemove", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
    };
  }, []);
  return (
    <div className="stage__hint" data-visible={visible} data-testid="display-hint" aria-hidden={!visible}>
      <span>
        <kbd>F</kbd> {t("stage.hint.fullscreen")}
      </span>
      <span>
        <kbd>Shift</kbd>+<kbd>B</kbd> {t("stage.hint.blackout")}
      </span>
    </div>
  );
}
