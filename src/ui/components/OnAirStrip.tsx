import { Bot, MonitorPlay, Settings2, ShieldAlert, ShieldCheck, Speaker } from "lucide-react";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../app/i18n-core";
import { beatPosition } from "../../engine/beat-math";
import type { DeckId, DeckState } from "../../state/session";
import { SESSION_MODES, sessionStore, useSession } from "../../state/session-store";
import { uiStore } from "../../state/ui-store";
import { formatTime, useEngineFrame, useFrameValue } from "../engine-hooks";
import { useRail } from "../hooks";
import { withViewTransition } from "../view-transition";
import { Segmented } from "./Segmented";

function Meter({ side }: { side: DeckId }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEngineFrame((frame) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const level = side === "A" ? frame?.meters.a : frame?.meters.b;
    const rms = level?.rms ?? 0;
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    const segments = 8;
    const lit = Math.round(((db + 60) / 60) * segments);
    const segmentWidth = (width - (segments - 1) * 2) / segments;
    for (let segment = 0; segment < segments; segment += 1) {
      const index = side === "A" ? segment : segments - 1 - segment;
      const x = index * (segmentWidth + 2);
      const on = segment < lit;
      ctx.fillStyle = on ? (segment >= 7 ? "#ff4d4d" : segment >= 5 ? "#ffc857" : "#5beb8a") : "#22262e";
      ctx.fillRect(x, 0, segmentWidth, height);
    }
  });
  return <canvas ref={canvasRef} className="meter" />;
}

function DeckSlot({ deck, side }: { deck: DeckState; side: DeckId }) {
  const style = { "--deck": side === "A" ? "var(--deck-a)" : "var(--deck-b)" } as CSSProperties;
  const name = deck.track ? `${deck.track.title} · ${deck.track.artist}` : t("deck.noTrack");
  const led = (
    <span
      key="led"
      className={deck.onAir ? "led led--on" : "led"}
      aria-hidden="true"
      data-testid={`onair-led-${side}`}
    />
  );
  const letter = (
    <span key="letter" className="onair__deck-name">
      {side}
    </span>
  );
  const track = (
    <span key="track" className="onair__track">
      {name}
    </span>
  );
  const meter = <Meter key="meter" side={side} />;
  const order = side === "A" ? [led, letter, track, meter] : [meter, track, letter, led];
  return (
    <div
      className={side === "A" ? "onair__deck" : "onair__deck onair__deck--b"}
      style={style}
      data-testid={`onair-deck-${side}`}
    >
      {order}
    </div>
  );
}

function CrossfaderGlyph({ value }: { value: number }) {
  const percentB = Math.round(value * 100);
  return (
    <span className="xfade" role="img" aria-label={t("onair.crossfader", { a: 100 - percentB, b: percentB })}>
      <b style={{ color: "var(--deck-a)" }}>A</b>
      <span className="xfade__rail" aria-hidden="true">
        <span className="xfade__knob" style={{ left: `${percentB}%` }} />
      </span>
      <b style={{ color: "var(--deck-b)" }}>B</b>
    </span>
  );
}

interface BadgeProps {
  tone: "ok" | "warn" | "danger" | "agent" | "muted";
  icon: ReactNode;
  text: string;
  title?: string;
  testId: string;
  data?: Record<`data-${string}`, string>;
  role?: "status";
  onClick?: () => void;
}

function Badge({ tone, icon, text, title, testId, data, role, onClick }: BadgeProps) {
  if (onClick) {
    return (
      <button
        type="button"
        className={`badge badge--${tone} badge--button`}
        data-testid={testId}
        title={title ?? text}
        onClick={onClick}
        {...data}
      >
        {icon}
        <span className="badge__text">{text}</span>
      </button>
    );
  }
  return (
    <span className={`badge badge--${tone}`} data-testid={testId} title={title ?? text} role={role} {...data}>
      {icon}
      <span className="badge__text">{text}</span>
    </span>
  );
}

function PrivacyBadge() {
  const { privacy } = useSession();
  const state = privacy.cspEnforced === null ? "checking" : privacy.cspEnforced ? "enforced" : "not-enforced";
  const tone = state === "enforced" ? "ok" : state === "not-enforced" ? "danger" : "muted";
  const label =
    state === "enforced"
      ? t("privacy.offline")
      : state === "not-enforced"
        ? t("privacy.notEnforced")
        : t("privacy.checking");
  const isolation = t("privacy.isolated", { state: privacy.crossOriginIsolated ? t("yes") : t("no") });
  return (
    <Badge
      tone={tone}
      icon={state === "not-enforced" ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
      text={label}
      title={`${label} · ${isolation}`}
      testId="csp-badge"
      data={{ "data-state": state }}
      role="status"
    />
  );
}

function RoutingBadge({ onOpen }: { onOpen: () => void }) {
  const { routing, engine } = useSession();
  const engineText = t(`engine.${engine.status}`, {
    rate: engine.sampleRate ? engine.sampleRate / 1000 : 0,
    latency: engine.latencyMs ?? 0,
    error: engine.error ?? "",
  });
  const text =
    engine.status !== "running"
      ? engineText
      : !routing.configured
        ? t("routing.notSetUp")
        : routing.cueConnected
          ? t("routing.cue", {
              device:
                routing.mode === "two-devices"
                  ? (routing.cueDeviceId ?? "—")
                  : t(`audio.mode.${routing.mode}`),
            })
          : t("routing.cueNotConnected");
  const tone =
    engine.status === "error"
      ? "danger"
      : engine.status === "running" && routing.configured && routing.cueConnected
        ? "ok"
        : "warn";
  return (
    <Badge
      tone={tone}
      icon={<Speaker size={14} />}
      text={text}
      title={`${engineText} · ${t("routing.setup")}`}
      testId="routing-badge"
      data={{ "data-engine": engine.status }}
      onClick={onOpen}
    />
  );
}

/** Agent status; clicking it opens the agent rail (the only way in on tablet layouts). */
function AgentBadge() {
  const { agent, autonomy } = useSession();
  const { toggle } = useRail();
  const short = t(`agent.short.${agent.webmcp}`, { count: agent.toolCount });
  const full = t(`agent.${agent.webmcp}`, { count: agent.toolCount });
  return (
    <Badge
      tone={agent.webmcp === "unavailable" ? "muted" : "agent"}
      icon={<Bot size={14} />}
      text={short}
      title={`${full} · ${t(`autonomy.${autonomy}`)} · ${t("rail.title")}`}
      testId="agent-badge"
      data={{ "data-webmcp": agent.webmcp }}
      onClick={toggle}
    />
  );
}

type StageBridgeModule = typeof import("../../visuals/console-bridge");

const loadBridge = (): Promise<StageBridgeModule> => import("../../visuals/console-bridge");

/** Stage status and actions (open the studio, a display on a chosen screen, a preview, blackout). */
function StageBadge() {
  const { visuals } = useSession();
  const [screens, setScreens] = useState<{ index: number; label: string; primary: boolean }[] | null>(null);
  const text = visuals.blackout
    ? t("onair.stageBlackout")
    : visuals.connected
      ? t("onair.stageDisplays", { count: visuals.displays })
      : t("onair.stage");
  const tone = visuals.blackout ? "danger" : visuals.connected ? "ok" : "muted";
  const openStudio = async () => {
    const bridge = await loadBridge();
    bridge.openStudio(bridge.startStageBridge().sessionId);
  };
  const openDisplay = async (screenIndex: number | null) => {
    const bridge = await loadBridge();
    const sessionId = bridge.startStageBridge().sessionId;
    if (screenIndex === null && screens === null) {
      const list = await bridge.listScreens();
      if (list && list.length > 1) {
        setScreens(list);
        return;
      }
    }
    setScreens(null);
    await bridge.openDisplay(sessionId, screenIndex);
  };
  const openPreview = async () => {
    const bridge = await loadBridge();
    const sessionId = bridge.startStageBridge().sessionId;
    const pip = bridge.pictureInPictureAvailable() ? await bridge.openPictureInPicture(sessionId) : null;
    if (!pip) withViewTransition(() => uiStore.dispatch({ type: "ui/stagePreview", open: true }));
  };
  const toggleBlackout = async () => {
    const bridge = await loadBridge();
    bridge.startStageBridge().patch({ blackout: !visuals.blackout });
  };
  return (
    <>
      <button
        type="button"
        className={`badge badge--${tone} badge--button`}
        popoverTarget="stage-popover"
        data-testid="stage-badge"
        data-connected={visuals.connected}
        data-displays={visuals.displays}
        data-blackout={visuals.blackout}
        title={text}
      >
        <MonitorPlay size={14} />
        <span className="badge__text">{text}</span>
      </button>
      <div id="stage-popover" popover="auto" className="stage-popover" data-testid="stage-popover">
        <span className="label">{t("stage.title")}</span>
        <p className="stage-popover__status">
          {visuals.connected
            ? t("stage.menu.status.connected", { count: visuals.displays })
            : t("stage.menu.status.none")}
        </p>
        <div className="stage-popover__actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void openStudio()}
            data-testid="stage-open-studio"
          >
            {t("stage.menu.open")}
          </button>
          <button type="button" onClick={() => void openDisplay(null)} data-testid="stage-open-display">
            {t("stage.menu.display")}
          </button>
          {screens?.map((screen) => (
            <button key={screen.index} type="button" onClick={() => void openDisplay(screen.index)}>
              {screen.label}
              {screen.primary ? ` · ${t("stage.screenPrimary")}` : ""}
            </button>
          ))}
          <button type="button" onClick={() => void openPreview()} data-testid="stage-open-preview">
            {t("stage.menu.preview")}
          </button>
          <button
            type="button"
            aria-pressed={visuals.blackout}
            onClick={() => void toggleBlackout()}
            data-testid="stage-toggle-blackout"
          >
            {t("stage.menu.blackout")}
          </button>
        </div>
        <StagePresets />
      </div>
    </>
  );
}

/**
 * The DJ's saved vibes, by name. The console keeps no Stage settings of its own: the list and the
 * apply both go through the Stage bridge, which owns and broadcasts them.
 */
function StagePresets() {
  const [presets, setPresets] = useState<{ name: string; builtin?: string; index: number }[]>([]);
  useEffect(() => {
    let live = true;
    void import("../../visuals/settings-store").then(({ stageSettingsStore }) => {
      const read = () => {
        if (!live) return;
        setPresets(
          stageSettingsStore.getState().presets.map((preset, index) => ({ name: preset.name, index })),
        );
      };
      read();
      const off = stageSettingsStore.subscribe(read);
      if (!live) off();
    });
    return () => {
      live = false;
    };
  }, []);
  if (!presets.length) return null;
  const apply = async (index: number) => {
    const [bridge, store, protocol] = await Promise.all([
      import("../../visuals/console-bridge"),
      import("../../visuals/settings-store"),
      import("../../visuals/protocol"),
    ]);
    const settings = store.stageSettingsStore.getState();
    const preset = settings.presets[index];
    if (preset) bridge.startStageBridge().patch(protocol.presetPatch(preset, settings));
  };
  return (
    <div className="stage-popover__presets" data-testid="stage-presets-menu">
      <span className="label">{t("stage.menu.presets")}</span>
      <div className="stage-popover__actions">
        {presets.map((preset) => (
          <button
            key={`${preset.index}-${preset.name}`}
            type="button"
            onClick={() => void apply(preset.index)}
            data-testid={`stage-apply-preset-${preset.index + 1}`}
          >
            {preset.builtin ? t(`stage.preset.${preset.builtin}`) : preset.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The night's arc, in its own chunk: a canvas band and the ring it reads, never in the entry. */
function ArcBand() {
  const [Band, setBand] = useState<ComponentType | null>(null);
  useEffect(() => {
    void import("./EnergyArc").then((module) => setBand(() => module.EnergyArc as ComponentType));
  }, []);
  return Band ? <Band /> : null;
}

function SettingsMenu({
  onOpenAudio,
  onOpenRecap,
  onOpenMidi,
}: {
  onOpenAudio: () => void;
  onOpenRecap: () => void;
  onOpenMidi: () => void;
}) {
  /**
   * A native popover lives in the top layer, so it would sit over any dialog it opens. Every row
   * that opens one closes the menu first.
   */
  const openThen = (open: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
    (event.currentTarget.closest("[popover]") as HTMLElement | null)?.hidePopover?.();
    open();
  };
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        popoverTarget="settings-popover"
        aria-label={t("settings.label")}
        data-testid="settings-toggle"
      >
        <Settings2 size={16} />
      </button>
      <div id="settings-popover" popover="auto" className="settings-popover">
        <button
          type="button"
          className="settings-popover__row"
          onClick={openThen(onOpenAudio)}
          data-testid="open-audio-setup"
        >
          {t("routing.setup")}
        </button>
        <button
          type="button"
          className="settings-popover__row"
          onClick={openThen(onOpenMidi)}
          data-testid="open-midi"
        >
          {t("midi.title")}
        </button>
        <button
          type="button"
          className="settings-popover__row"
          onClick={openThen(onOpenRecap)}
          data-testid="open-recap"
        >
          {t("recap.open")}
        </button>
      </div>
    </>
  );
}

export function OnAirStrip({
  onOpenAudioSetup,
  onOpenRecap,
  onOpenMidi,
}: {
  onOpenAudioSetup: () => void;
  onOpenRecap: () => void;
  onOpenMidi: () => void;
}) {
  const session = useSession();
  const { A, B } = session.decks;
  const status =
    A.onAir && B.onAir
      ? t("onair.both")
      : A.onAir
        ? t("onair.a")
        : B.onAir
          ? t("onair.b")
          : t("onair.silent");
  const onAirDeck = A.onAir ? "A" : B.onAir ? "B" : null;
  const onAirState = onAirDeck ? session.decks[onAirDeck] : null;
  const bpm = onAirState?.analysis ? (onAirState.analysis.grid.bpm * onAirState.rate).toFixed(1) : "—";
  const elapsed = useFrameValue((frame) => {
    if (!onAirDeck || !frame) return "";
    const state = frame.decks[onAirDeck];
    return `${formatTime(state.positionSec)} · -${formatTime(Math.max(0, state.durationSec - state.positionSec))}`;
  }, 250);
  const nextEvent = useFrameValue(
    (frame) => {
      const event = sessionStore.getState().scheduled[0];
      if (!event) return null;
      const analysis = sessionStore.getState().decks[event.referenceDeck].analysis;
      const reference = frame?.decks[event.referenceDeck];
      if (!analysis || !reference) return { deck: event.targetDeck, beats: null };
      const beats = Math.max(
        0,
        Math.ceil(event.atBeatIndex - beatPosition(analysis.grid, reference.positionSec)),
      );
      return { deck: event.targetDeck, beats };
    },
    150,
    (a, b) => a?.deck === b?.deck && a?.beats === b?.beats,
  );

  return (
    <>
      <section className="onair" data-testid="onair" aria-label={t("onair.label")}>
        <DeckSlot deck={A} side="A" />
        <div className="onair__centre">
          <span className="onair__status" role="status" aria-live="polite" data-testid="onair-status">
            {status}
          </span>
          <span className="onair__bpm num">
            {bpm} {t("onair.bpm")}
          </span>
          {elapsed && <span className="onair__time num">{elapsed}</span>}
          <CrossfaderGlyph value={session.mixer.crossfader} />
          <span className="onair__next" data-testid="onair-next">
            {nextEvent
              ? nextEvent.beats === null
                ? t("onair.enterArmed", { deck: nextEvent.deck })
                : t("onair.enterIn", { deck: nextEvent.deck, n: nextEvent.beats })
              : t("onair.noEvent")}
          </span>
        </div>
        <DeckSlot deck={B} side="B" />
        <div className="onair__right">
          <RoutingBadge onOpen={onOpenAudioSetup} />
          <PrivacyBadge />
          <StageBadge />
          <AgentBadge />
          <Segmented
            label={t("mode.label")}
            value={session.mode}
            options={SESSION_MODES.map((mode) => ({ value: mode, label: t(`mode.${mode}`) }))}
            onChange={(mode) => withViewTransition(() => sessionStore.dispatch({ type: "mode/set", mode }))}
            testId="mode-switch"
          />
          <SettingsMenu onOpenAudio={onOpenAudioSetup} onOpenRecap={onOpenRecap} onOpenMidi={onOpenMidi} />
        </div>
      </section>
      <ArcBand />
    </>
  );
}
