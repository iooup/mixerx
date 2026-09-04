import { Headphones } from "lucide-react";
import { useRef } from "react";
import { t } from "../../app/i18n-core";
import { mixerActions } from "../../engine/actions";
import { beatPeriodSec, clamp, phaseErrorMs } from "../../engine/beat-math";
import type { ChannelStripState, CrossfaderCurve, DeckId } from "../../state/session";
import { useSession } from "../../state/session-store";
import { useEngineFrame, useFrameValue } from "../engine-hooks";
import { useMediaQuery } from "../hooks";
import { nextCurve } from "../knob-math";
import { Knob } from "./Knob";

/** Below this width the mixer becomes a horizontal band under the decks. */
export const BAND_LAYOUT_QUERY = "(max-width: 1023px)";

const EQ_MIN_DB = -26;
const EQ_MAX_DB = 12;
const KILL_THRESHOLD_DB = EQ_MIN_DB + 0.01;

type EqKey = "eqHigh" | "eqMid" | "eqLow";
const EQ_BANDS: { key: EqKey; label: string }[] = [
  { key: "eqHigh", label: "HI" },
  { key: "eqMid", label: "MID" },
  { key: "eqLow", label: "LOW" },
];

const CURVE_KEYS: Record<CrossfaderCurve, string> = {
  "equal-power": "equalPower",
  linear: "linear",
  cut: "cut",
};

const formatDb = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
const formatEq = (value: number) => (value <= KILL_THRESHOLD_DB ? "KILL" : formatDb(value));
const formatFilter = (value: number) =>
  value === 0 ? "OPEN" : value < 0 ? `LP ${Math.round(-value * 100)}` : `HP ${Math.round(value * 100)}`;
const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

function ChannelKnobs({ id, state, locked }: { id: DeckId; state: ChannelStripState; locked: boolean }) {
  const set = (key: keyof ChannelStripState, value: number) => void mixerActions.setStrip(id, key, value);
  return (
    <div role="group" className={`ch ch--${id.toLowerCase()}`} aria-label={t(`mixer.channel${id}`)}>
      <div className="ch__knobs">
        <Knob
          small
          bipolar
          label="TRIM"
          ariaLabel={`TRIM ${id}`}
          value={state.trim}
          min={-12}
          max={12}
          step={0.5}
          format={formatDb}
          disabled={locked}
          title={t("mixer.resetHint")}
          onChange={(value) => set("trim", value)}
          onDoubleClick={() => set("trim", 0)}
          testId={`trim-${id}`}
        />
        {EQ_BANDS.map((band) => (
          <Knob
            key={band.key}
            bipolar
            label={band.label}
            ariaLabel={`${band.label} ${id}`}
            value={state[band.key]}
            min={EQ_MIN_DB}
            max={EQ_MAX_DB}
            step={0.5}
            format={formatEq}
            kill={state[band.key] <= KILL_THRESHOLD_DB}
            disabled={locked}
            title={t("mixer.killHint")}
            onChange={(value) => set(band.key, value)}
            onDoubleClick={() => void mixerActions.toggleKill(id, band.key)}
            testId={`${band.key}-${id}`}
            guideTarget={band.key === "eqLow" ? `eq-low-${id}` : undefined}
          />
        ))}
        <Knob
          bipolar
          label="FILTER"
          ariaLabel={`FILTER ${id}`}
          value={state.filter}
          min={-1}
          max={1}
          step={0.01}
          format={formatFilter}
          disabled={locked}
          title={t("mixer.filterHint")}
          onChange={(value) => set("filter", value)}
          onDoubleClick={() => set("filter", 0)}
          testId={`filter-${id}`}
        />
      </div>
    </div>
  );
}

/** Post-fader level of one deck as 14 segments beside its fader (RMS lit, peak as a marker). */
function LevelMeter({ id, horizontal }: { id: DeckId; horizontal: boolean }) {
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
    const level = id === "A" ? frame?.meters.a : frame?.meters.b;
    const db = (value: number) => (value > 0 ? 20 * Math.log10(value) : -100);
    const segments = 14;
    const gap = 2;
    const length = horizontal ? width : height;
    const segmentLength = (length - gap * (segments - 1)) / segments;
    const litRms = Math.round(((db(level?.rms ?? 0) + 60) / 60) * segments);
    const litPeak = Math.round(((db(level?.peak ?? 0) + 60) / 60) * segments);
    for (let segment = 0; segment < segments; segment += 1) {
      const offset = segment * (segmentLength + gap);
      const on = segment < litRms;
      const peakHere = segment === litPeak - 1;
      const hot = segment >= segments - 2;
      const warm = segment >= segments - 4;
      ctx.fillStyle = on
        ? hot
          ? "#ff4d4d"
          : warm
            ? "#ffc857"
            : "#5beb8a"
        : peakHere
          ? "#a7aebb"
          : "#2b303a";
      if (horizontal) ctx.fillRect(offset, 0, segmentLength, height);
      else ctx.fillRect(0, height - offset - segmentLength, width, segmentLength);
    }
  });
  return (
    <span className="vm" aria-hidden="true">
      <canvas ref={canvasRef} className="vm__canvas" />
    </span>
  );
}

function FaderZone({
  id,
  state,
  locked,
  horizontal,
}: {
  id: DeckId;
  state: ChannelStripState;
  locked: boolean;
  horizontal: boolean;
}) {
  const fader = (
    <input
      type="range"
      className="fader"
      min={0}
      max={1}
      step={0.01}
      value={state.fader}
      disabled={locked}
      aria-label={t("mixer.level", { deck: id })}
      aria-valuetext={formatPercent(state.fader)}
      onChange={(event) => void mixerActions.setStrip(id, "fader", Number(event.target.value))}
      onDoubleClick={() => void mixerActions.setStrip(id, "fader", 1)}
      data-testid={`fader-${id}`}
    />
  );
  const meter = <LevelMeter id={id} horizontal={horizontal} />;
  return (
    <div className={`fz fz--${id.toLowerCase()}`}>
      <button
        type="button"
        className="pfl"
        aria-pressed={state.pfl}
        aria-label={t("mixer.pfl", { deck: id })}
        title={t("mixer.pfl", { deck: id })}
        onClick={() => void mixerActions.setStrip(id, "pfl", !state.pfl)}
        data-testid={`pfl-${id}`}
      >
        <Headphones size={15} aria-hidden="true" />
      </button>
      <div className="fz__pair">
        {id === "A" ? fader : meter}
        {id === "A" ? meter : fader}
      </div>
    </div>
  );
}

/** Phase error of B against A in ms, as a marker on a rail. */
function PhaseMeter({ hidden }: { hidden: boolean }) {
  const { decks } = useSession();
  const gridA = decks.A.analysis?.grid ?? null;
  const gridB = decks.B.analysis?.grid ?? null;
  const value = useFrameValue(
    (frame) => {
      if (!frame || !gridA || !gridB) return null;
      const a = frame.decks.A;
      const b = frame.decks.B;
      if (!a.playing || !b.playing) return null;
      const ms = phaseErrorMs(gridA, a.positionSec, gridB, b.positionSec);
      const halfBeatMs = (beatPeriodSec(gridA, a.positionSec) * 1000) / 2;
      return { ms: Math.round(ms), pct: clamp(ms / halfBeatMs, -1, 1) * 50 };
    },
    80,
    (x, y) => x?.ms === y?.ms,
  );
  return (
    <div className="phase" hidden={hidden} data-testid="phase-meter" data-ms={value?.ms ?? ""}>
      <span className="phase__deck" style={{ color: "var(--deck-a)" }}>
        A
      </span>
      <span className="phase__rail" role="img" aria-label={t("mixer.phaseLabel", { ms: value?.ms ?? "—" })}>
        <span className="phase__centre" />
        <span
          className={value && Math.abs(value.ms) < 15 ? "phase__marker phase__marker--ok" : "phase__marker"}
          style={{ left: `calc(50% + ${value?.pct ?? 0}%)` }}
        />
      </span>
      <span className="phase__deck" style={{ color: "var(--deck-b)" }}>
        B
      </span>
      <span className="phase__value num">{value ? `${value.ms > 0 ? "+" : ""}${value.ms} ms` : "—"}</span>
    </div>
  );
}

function LimiterLed() {
  const active = useFrameValue((frame) => (frame?.meters.limiterReduction ?? 0) > 0.1, 100);
  return (
    <span className={active ? "led led--warn" : "led"} title={t("mixer.limiter")} data-testid="limiter-led">
      <span className="sr-only">{t("mixer.limiter")}</span>
    </span>
  );
}

export interface MixerPanelProps {
  crossfaderLocked?: boolean;
  stripsLocked?: boolean;
  phaseMeterHidden?: boolean;
}

export function MixerPanel({
  crossfaderLocked = false,
  stripsLocked = false,
  phaseMeterHidden = false,
}: MixerPanelProps) {
  const { mixer, routing } = useSession();
  const band = useMediaQuery(BAND_LAYOUT_QUERY);
  const percentB = Math.round(mixer.crossfader * 100);
  const blendAvailable = routing.mode !== "single";
  const curveName = t(`curve.${CURVE_KEYS[mixer.curve]}`);

  return (
    <section className="panel mixer" aria-label={t("mixer.title")} data-testid="mixer">
      <div className="mx" dir="ltr">
        <div className="mx__top">
          <div className="mx__group">
            <Knob
              small
              label="MASTER"
              ariaLabel={t("mixer.masterLevel")}
              value={mixer.master}
              min={0}
              max={1}
              step={0.01}
              format={formatPercent}
              title={t("mixer.resetHint")}
              onChange={(value) => void mixerActions.setMaster(value)}
              onDoubleClick={() => void mixerActions.setMaster(1)}
              testId="master-level"
            />
            <LimiterLed />
          </div>
          <div className="mx__group">
            {blendAvailable && (
              <Knob
                small
                label="BLEND"
                ariaLabel={t("mixer.blend")}
                value={mixer.cueBlend}
                min={0}
                max={1}
                step={0.01}
                format={formatPercent}
                title={t("mixer.blendHint")}
                onChange={(value) => void mixerActions.setCueBlend(value)}
                onDoubleClick={() => void mixerActions.setCueBlend(0)}
                testId="cue-blend"
              />
            )}
            <Knob
              small
              label="CUE"
              ariaLabel={t("mixer.cueLevel")}
              value={mixer.cueLevel}
              min={0}
              max={1}
              step={0.01}
              format={formatPercent}
              title={t("mixer.resetHint")}
              onChange={(value) => void mixerActions.setCueLevel(value)}
              onDoubleClick={() => void mixerActions.setCueLevel(0.8)}
              testId="cue-level"
            />
          </div>
        </div>
        <div className="mx__channels">
          <ChannelKnobs id="A" state={mixer.a} locked={stripsLocked} />
          <ChannelKnobs id="B" state={mixer.b} locked={stripsLocked} />
        </div>
        <PhaseMeter hidden={phaseMeterHidden} />
        <div className="mx__faders">
          <FaderZone id="A" state={mixer.a} locked={stripsLocked} horizontal={band} />
          <FaderZone id="B" state={mixer.b} locked={stripsLocked} horizontal={band} />
        </div>
        <div className="xf" data-guide-target="crossfader">
          <b className="xf__a" aria-hidden="true">
            A
          </b>
          <input
            type="range"
            className="xf__input"
            min={0}
            max={100}
            step={1}
            value={percentB}
            disabled={crossfaderLocked}
            aria-label={t("mixer.crossfader")}
            aria-valuetext={t("onair.crossfader", { a: 100 - percentB, b: percentB })}
            onChange={(event) => void mixerActions.setCrossfader(Number(event.target.value) / 100)}
            data-testid="crossfader"
          />
          <b className="xf__b" aria-hidden="true">
            B
          </b>
        </div>
        <div className="mx__foot">
          <button
            type="button"
            className="chip"
            aria-label={t("mixer.curveCycle", { curve: curveName })}
            title={t("mixer.curveCycle", { curve: curveName })}
            onClick={() => void mixerActions.setCurve(nextCurve(mixer.curve))}
            data-testid="crossfader-curve"
            data-curve={mixer.curve}
          >
            {curveName}
          </button>
          <span className="num" aria-hidden="true">
            {100 - percentB} · {percentB}
          </span>
        </div>
      </div>
    </section>
  );
}
