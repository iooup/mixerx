/**
 * The Director: a pure state machine that turns music structure and
 * DJ gestures into rendering intent. Every Stage window runs its own Director on the same frames,
 * so all displays agree. Strobe safety is enforced here, never per scene: at most three flashes
 * per second, no full-frame luminance jumps under the photosensitive-safe switch, and reduced
 * motion removes bursts and flashes entirely.
 */
import { canBlendScenes, sceneCategory } from "../agent/scenes";
import { type CameraShot, shotForSection, shotIndex } from "./gpu/camera";
import { buildPalette, type Palette } from "./palette";
import {
  F,
  type OnAir,
  type StageEvent,
  type StageFrame,
  type StageSection,
  type StageSettings,
  type TransitionStyle,
} from "./protocol";

export interface SceneTransition {
  from: string;
  to: string;
  kind: TransitionStyle;
  progress: number; // 0..1
}

export interface Intent {
  sceneId: string;
  transition: SceneTransition | null;
  /**
   * The scene waiting for the next bar. The renderer simulates it (without drawing) from the moment
   * it is pending, so the incoming picture arrives already in motion instead of on its first frame.
   */
  pendingSceneId: string | null;
  intensity: number;
  motion: number;
  framing: number;
  saturation: number;
  warmth: number;
  flash: number;
  burst: number;
  invert: number;
  floor: number;
  tunnel: number;
  balance: number;
  freeze: number;
  cut: number;
  seed: number;
  strobe: number;
  /**
   * 0 → 1 over the last four bars before a drop, 1 at its downbeat, back to 0 within 0.3 s. The
   * whole picture contracts, cools and slows with it, so the crowd feels the drop coming without
   * a single word on the screen. Always 0 when section reactions are off.
   */
  anticipation: number;
  /** 0 → 1 when nothing has been on air for a while; the scene eases back and the idle layer shows. */
  idle: number;
  /** Camera shot chosen by the Director (see `gpu/camera.ts`); 0 is each scene's own look. */
  cameraShot: number;
  /** 1 while the now-playing lower third is on screen, so the picture makes room for the type. */
  lowerThird: number;
  /** 0 … 1 — how far the Kick Field's particles have assembled into the DJ's message. */
  morph: number;
  palette: Palette;
  beat: {
    phase: number;
    barPhase: number;
    phrasePhase: number;
    bpm: number;
    beatIndex: number;
    barIndex: number;
    phraseIndex: number;
    kickCount: number;
    snareCount: number;
    hatCount: number;
  };
  audio: {
    kick: number;
    snare: number;
    hat: number;
    rms: number;
    bass: number;
    mid: number;
    treble: number;
    centroid: number;
    flux: number;
    spectrum: Float32Array;
  };
  section: StageSection;
  barsToNext: number;
  onAir: OnAir;
  blackout: boolean;
  reducedMotion: boolean;
  crowd: boolean;
  /** Flashes emitted in the last second (for the studio read-out and tests). */
  flashesLastSecond: number;
}

interface SectionTargets {
  intensity: number;
  motion: number;
  framing: number;
  saturation: number;
  warmth: number;
}

const MAX_FLASHES_PER_SECOND = 3;
const DISSOLVE_BARS = 2;
/** Bars of build-up over which the anticipation rises to 1. */
const ANTICIPATION_BARS = 4;
/** Silence (or no frames) after which the Stage goes idle, and the ramps in and out. */
const IDLE_AFTER_SEC = 20;
const IDLE_IN_SEC = 3;
const IDLE_OUT_SEC = 0.3;
/** −60 dBFS: below this the room is silent. −40 dBFS: audio is back. */
const IDLE_QUIET_RMS = 0.001;
const IDLE_WAKE_RMS = 0.01;
/** Seconds it takes to fall back to 0 once the drop has landed. */
const ANTICIPATION_RELEASE_SEC = 0.3;
const BAR_GRACE_SEC = 0.3;
const NO_GRID_SWITCH_SEC = 0.5;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);
const approach = (current: number, target: number, dt: number, tau: number): number =>
  tau <= 0 ? target : current + (target - current) * (1 - Math.exp(-dt / tau));
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Per-section rendering targets; `ramp` is the progress toward the next section (builds). */
export function sectionTargets(section: StageSection, ramp: number, reactions: boolean): SectionTargets {
  if (!reactions) return { intensity: 0.65, motion: 0.55, framing: 0.4, saturation: 0.9, warmth: 0 };
  switch (section) {
    case "intro":
      return { intensity: 0.45, motion: 0.4, framing: 0.2, saturation: 0.8, warmth: -0.2 };
    case "build":
      return {
        intensity: lerp(0.5, 1, ramp),
        motion: lerp(0.5, 1, ramp),
        framing: lerp(0.2, 0.9, ramp),
        saturation: 0.9,
        warmth: lerp(0, 1, ramp),
      };
    case "drop":
      return { intensity: 1, motion: 1, framing: 0.8, saturation: 1, warmth: 0.3 };
    case "break":
      return { intensity: 0.3, motion: 0.3, framing: 0.1, saturation: 0.5, warmth: -0.5 };
    case "body":
      return { intensity: 0.7, motion: 0.65, framing: 0.5, saturation: 1, warmth: 0 };
    case "outro":
      return { intensity: 0.4, motion: 0.35, framing: 0.2, saturation: 0.7, warmth: -0.3 };
    default:
      return { intensity: 0.6, motion: 0.5, framing: 0.4, saturation: 0.9, warmth: 0 };
  }
}

/** What the Stage window knows that a frame does not: how old the frame it is drawing from is. */
export interface DirectorContext {
  /** Seconds since the frame the picture is based on arrived (0 for a live stream). */
  frameAgeSec: number;
}

/** Sliding one-second budget shared by flashes, bursts and strobes. */
export class FlashBudget {
  private readonly times: number[] = [];

  constructor(private readonly max = MAX_FLASHES_PER_SECOND) {}

  countLastSecond(now: number): number {
    while (this.times.length && (this.times[0] as number) <= now - 1) this.times.shift();
    return this.times.length;
  }

  /** Returns `strength` when a flash is allowed now, else 0. */
  request(now: number, strength: number): number {
    if (strength <= 0) return 0;
    if (this.countLastSecond(now) >= this.max) return 0;
    this.times.push(now);
    return strength;
  }
}

export class Director {
  private time = 0;
  private applied: string;
  private pending: string | null = null;
  private pendingSince = 0;
  private transition: SceneTransition | null = null;
  private transitionStartBar = 0;
  private transitionStartPhase = 0;
  private transitionStartTime = 0;
  private wipeArmed = false;
  private lastBarTime = Number.NEGATIVE_INFINITY;
  private intensity = 0.5;
  private motion = 0.5;
  private framing = 0.3;
  private saturation = 0.9;
  private warmth = 0;
  private flash = 0;
  private burst = 0;
  private burstEnvelope = 0;
  private invert = 0;
  private floor = 1;
  private tunnel = 0;
  private freeze = 0;
  private anticipation = 0;
  private idle = 0;
  private shot: CameraShot = "orbit";
  private seed = 1;
  private beatIndex = 0;
  private barIndex = 0;
  private phraseIndex = 0;
  private kickCount = 0;
  private snareCount = 0;
  private hatCount = 0;
  private silentFor = 0;
  private readonly loops: Record<"A" | "B", boolean> = { A: false, B: false };
  private readonly budget = new FlashBudget();
  private paletteKey = "";
  private palette: Palette = buildPalette({ source: "decks", keyHue: null });

  constructor(initialScene = "body-pulse") {
    this.applied = initialScene;
  }

  get scene(): string {
    return this.applied;
  }

  get pendingScene(): string | null {
    return this.pending;
  }

  /** Advances the Director by `dt` seconds with the latest frame and the events since the last call. */
  update(
    frame: StageFrame,
    events: StageEvent[],
    settings: StageSettings,
    dt: number,
    context: DirectorContext = { frameAgeSec: 0 },
  ): Intent {
    const step = Math.min(0.25, Math.max(0, dt));
    this.time += step;
    const f = frame.f;
    const bpm = f[F.bpm] ?? 0;
    const beatSec = bpm > 0 ? 60 / bpm : 0.5;
    const reduced = settings.reducedMotion;
    // Cinematic art always uses continuous motion, including incoming/outgoing transitions.
    const safe =
      settings.photosensitiveSafe ||
      [settings.sceneId, this.applied, this.transition?.from ?? ""].some(
        (id) => sceneCategory(id) === "cinematic",
      );

    // ---- events → counters, gestures, seeds ----
    let cut = 0;
    let barEvent = false;
    let kickEvent = false;
    let dropEvent = false;
    let phraseEvent = false;
    for (const event of events) {
      switch (event.kind) {
        case "beat":
          this.beatIndex += 1;
          break;
        case "bar":
          this.barIndex += 1;
          barEvent = true;
          this.lastBarTime = this.time;
          break;
        case "phrase":
          this.phraseIndex += 1;
          phraseEvent = true;
          break;
        case "kick":
          this.kickCount += 1;
          kickEvent = true;
          break;
        case "snare":
          this.snareCount += 1;
          break;
        case "hat":
          this.hatCount += 1;
          break;
        case "drop":
          dropEvent = true;
          break;
        case "cue":
          cut = 1;
          break;
        case "loopOn":
          if (event.deck) this.loops[event.deck] = true;
          break;
        case "loopOff":
          if (event.deck) this.loops[event.deck] = false;
          break;
        case "deckStop":
          if (event.deck) this.loops[event.deck] = false;
          break;
        default:
          break;
      }
    }
    if (phraseEvent || cut) this.seed += 1;

    // ---- section targets ----
    const barsToNext = f[F.barsToNextSection] ?? -1;

    // The drop is telegraphed, never announced: over the last four bars the picture contracts,
    // cools and slows, so the crowd feels it coming without a word on the screen.
    if (!settings.sectionReactions) {
      this.anticipation = 0;
    } else if (frame.next === "drop" && barsToNext >= 0) {
      this.anticipation = Math.max(
        this.anticipation,
        smoothstep(ANTICIPATION_BARS, 0, barsToNext - (f[F.barPhase] ?? 0)),
      );
    } else if (frame.section === "drop" && this.anticipation > 0) {
      this.anticipation = Math.max(0, this.anticipation - step / ANTICIPATION_RELEASE_SEC);
    } else {
      this.anticipation = approach(this.anticipation, 0, step, 0.2);
    }
    if (this.anticipation < 0.002) this.anticipation = 0;
    const antic = this.anticipation;

    const ramp = barsToNext >= 0 ? clamp01(1 - barsToNext / 16) : 0.5;
    const targets = sectionTargets(frame.section, ramp, settings.sectionReactions);
    const rms = f[F.rms] ?? 0;

    // Idle: twenty seconds with nothing on air (or no frames at all) and the Stage takes a breath.
    // It comes back within 300 ms on any level or any deck start — the DJ is never kept waiting.
    if (rms < IDLE_QUIET_RMS) this.silentFor += step;
    else this.silentFor = 0;
    // A frame this old means the console is gone or hidden; whatever it last said is not the room.
    const stale = context.frameAgeSec >= IDLE_AFTER_SEC;
    const awake = !stale && (rms > IDLE_WAKE_RMS || events.some((event) => event.kind === "deckStart"));
    const idleWanted = !awake && (stale || this.silentFor >= IDLE_AFTER_SEC);
    this.idle = idleWanted
      ? Math.min(1, this.idle + step / IDLE_IN_SEC)
      : Math.max(0, this.idle - step / IDLE_OUT_SEC);
    const idle = this.idle;

    const intensityTarget = targets.intensity * (0.2 + settings.intensity) * (1 - 0.65 * idle);
    // Anticipation holds the picture back: −20 % motion, −15 % saturation, the framing tightens.
    const motionTarget =
      targets.motion *
      (0.25 + settings.intensity * 0.75) *
      (reduced ? 0.35 : 1) *
      (1 - 0.2 * antic) *
      (1 - 0.8 * idle);
    this.intensity = approach(this.intensity, intensityTarget, step, 0.35);
    this.motion = approach(this.motion, motionTarget, step, 0.4);
    this.framing = approach(this.framing, targets.framing + 0.25 * antic, step, 0.5);
    this.saturation = approach(this.saturation, targets.saturation * (1 - 0.15 * antic), step, 0.3);
    this.warmth = approach(this.warmth, targets.warmth, step, 1);

    // ---- drop, flash, burst, inversion (strobe safety lives here) ----
    let flash = 0;
    let strobe = 0;
    if (dropEvent) {
      if (!safe && !reduced) flash = this.budget.request(this.time, 0.55);
      this.burstEnvelope = 1;
      this.invert = 1;
    }
    this.burstEnvelope *= Math.exp(-step / (beatSec * 2));
    if (this.burstEnvelope < 0.005) this.burstEnvelope = 0;
    if (safe || reduced) {
      // No sudden luminance jumps: the burst is capped and eased in over ~150 ms (≤ 6 % per frame).
      this.burst = approach(this.burst, this.burstEnvelope * 0.6, step, 0.15);
    } else {
      this.burst = this.burstEnvelope;
    }
    this.invert *= Math.exp(-step / (beatSec * 8));
    if (this.invert < 0.005) this.invert = 0;
    if (kickEvent && frame.section === "drop" && !safe && !reduced)
      strobe = this.budget.request(this.time, 1) ? 1 : 0;
    this.flash = Math.max(flash, this.flash * Math.exp(-step / 0.035));
    if (this.flash < 0.01) this.flash = 0;

    // ---- gestures ----
    const onAirLow =
      frame.onAir === "B"
        ? (f[F.lowB] ?? 1)
        : frame.onAir === "both"
          ? Math.max(f[F.lowA] ?? 1, f[F.lowB] ?? 1)
          : (f[F.lowA] ?? 1);
    this.floor = approach(this.floor, smoothstep(0.05, 0.45, onAirLow), step, 0.15);
    const filter = frame.onAir === "B" ? (f[F.filterB] ?? 0) : (f[F.filterA] ?? 0);
    this.tunnel = approach(this.tunnel, Math.max(-1, Math.min(1, filter)), step, 0.12);
    const freezeTarget = this.loops.A || this.loops.B ? 1 : 0;
    this.freeze = approach(this.freeze, freezeTarget, step, 0.1);

    // ---- scene selection at boundaries ----
    // A loaded, paused deck still reports its analysed BPM, but emits no bar boundaries.
    const clockRunning = bpm > 0 && frame.onAir !== "none";
    const wanted = settings.blackout ? this.applied : settings.sceneId;
    if (wanted !== this.applied && wanted !== this.pending && wanted !== this.transition?.to) {
      this.pending = wanted;
      this.pendingSince = this.time;
    } else if (this.pending && (wanted === this.applied || wanted === this.transition?.to)) {
      this.pending = null;
    }
    if (this.pending) {
      const atBoundary =
        barEvent ||
        this.time - this.lastBarTime <= BAR_GRACE_SEC ||
        (!clockRunning && this.time - this.pendingSince >= NO_GRID_SWITCH_SEC);
      if (atBoundary) {
        const kind: TransitionStyle = dropEvent
          ? "cut"
          : reduced && settings.transition === "wipe"
            ? "dissolve"
            : settings.transition;
        this.startTransition(this.pending, kind, f[F.barPhase] ?? 0);
        this.pending = null;
      }
    }
    if (this.transition) {
      const transition = this.transition;
      if (transition.kind === "cut") {
        transition.progress = 1;
      } else if (transition.kind === "dissolve") {
        const bars = clockRunning
          ? this.barIndex - this.transitionStartBar + (f[F.barPhase] ?? 0) - this.transitionStartPhase
          : (this.time - this.transitionStartTime) / 1.5;
        transition.progress = Math.max(transition.progress, clamp01(bars / DISSOLVE_BARS));
      } else {
        // Wipe on kick: hold until the next kick (at most one bar), then sweep over 0.6 beats.
        if (!this.wipeArmed && (kickEvent || this.time - this.transitionStartTime > beatSec * 4)) {
          this.wipeArmed = true;
          this.transitionStartTime = this.time;
        }
        transition.progress = this.wipeArmed
          ? clamp01((this.time - this.transitionStartTime) / (beatSec * 0.6))
          : 0;
      }
      if (transition.progress >= 1) {
        this.applied = transition.to;
        this.transition = null;
      }
    }

    // ---- camera ----
    // The operator cuts only on a bar (a drop forces one); between bars it keeps circling.
    if (barEvent || dropEvent)
      this.shot = settings.sectionReactions
        ? shotForSection(frame.section, antic, this.phraseIndex, reduced)
        : "orbit";

    // ---- palette (cached by its inputs) ----
    // Warmth only moves the key-derived palette, so a locked palette is not rebuilt for it.
    const warmthStep = settings.palette === "key" ? Math.round(this.warmth * 20) / 20 : 0;
    const paletteKey = `${settings.palette}|${frame.keyHue ?? "x"}|${settings.custom?.join(",") ?? ""}|${warmthStep}`;
    if (paletteKey !== this.paletteKey) {
      this.paletteKey = paletteKey;
      this.palette = buildPalette({
        source: settings.palette,
        keyHue: frame.keyHue,
        custom: settings.custom,
        warmth: warmthStep,
      });
    }

    const spectrum = f.subarray(F.spectrumStart, F.spectrumStart + F.spectrumBins);
    let bass = 0;
    let mid = 0;
    let treble = 0;
    for (let band = 0; band < F.spectrumBins; band += 1) {
      const value = spectrum[band] ?? 0;
      if (band < 12) bass += value / 12;
      else if (band < 40) mid += value / 28;
      else treble += value / 24;
    }

    return {
      sceneId: settings.blackout ? "blackout" : this.applied,
      transition: settings.blackout ? null : this.transition ? { ...this.transition } : null,
      pendingSceneId: settings.blackout ? null : this.pending,
      intensity: this.intensity,
      motion: this.motion,
      framing: this.framing,
      saturation: this.saturation,
      warmth: this.warmth,
      flash: this.flash,
      burst: this.burst,
      invert: this.invert,
      floor: this.floor,
      tunnel: this.tunnel,
      balance: f[F.crossfader] ?? 0,
      freeze: this.freeze,
      cut,
      seed: this.seed,
      strobe,
      anticipation: antic,
      idle: this.idle,
      cameraShot: shotIndex(this.shot),
      lowerThird: 0,
      morph: 0,
      palette: this.palette,
      beat: {
        phase: f[F.beatPhase] ?? 0,
        barPhase: f[F.barPhase] ?? 0,
        phrasePhase: f[F.phrasePhase] ?? 0,
        bpm,
        beatIndex: this.beatIndex,
        barIndex: this.barIndex,
        phraseIndex: this.phraseIndex,
        kickCount: this.kickCount,
        snareCount: this.snareCount,
        hatCount: this.hatCount,
      },
      audio: {
        kick: f[F.kick] ?? 0,
        snare: f[F.snare] ?? 0,
        hat: f[F.hat] ?? 0,
        rms,
        bass,
        mid,
        treble,
        centroid: f[F.centroid] ?? 0,
        flux: f[F.flux] ?? 0,
        spectrum,
      },
      section: frame.section,
      barsToNext,
      onAir: frame.onAir,
      blackout: settings.blackout,
      reducedMotion: reduced,
      crowd: !settings.blackout && settings.crowdScenes.includes(this.applied),
      flashesLastSecond: this.budget.countLastSecond(this.time),
    };
  }

  private startTransition(to: string, kind: TransitionStyle, barPhase: number): void {
    const from = this.transition ? this.transition.to : this.applied;
    if (this.transition) this.applied = this.transition.to;
    if (kind === "cut" || !canBlendScenes(from, to)) {
      this.applied = to;
      this.transition = null;
      return;
    }
    this.transition = { from, to, kind, progress: 0 };
    this.transitionStartBar = this.barIndex;
    this.transitionStartPhase = barPhase;
    this.transitionStartTime = this.time;
    this.wipeArmed = false;
  }
}
