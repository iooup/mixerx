/**
 * Frame prediction: frames reach the Stage at ≤ 60 Hz but the Stage
 * renders at the display's rate (120 Hz here), so copying `beatPhase` straight from the last frame
 * moves the music in 60 Hz steps and freezes while the console tab is throttled.
 *
 * This is a pure, unit-tested extrapolator that sits between the channel and the Director:
 *
 * - the three phases run on their own continuous clock at `bpm / 60` beats per second (bar ÷ 4,
 *   phrase ÷ 4 × phraseBars), capped at 120 ms of extrapolation — beyond that the picture holds
 *   rather than inventing music;
 * - a new frame that agrees within 0.05 beat is slewed out over 50 ms, one that disagrees snaps;
 *   the output never steps backwards by more than 0.02 beat except on a snap;
 * - continuous features (rms, bands, spectrum, mixer positions) are smoothed with a ~10 ms time
 *   constant so 120 Hz rendering does not show 60 Hz stair steps, while the onset envelopes keep an
 *   instant attack and only smooth their release.
 *
 * Beat/bar/phrase *indices* stay with the events (the Director counts them), so nothing is counted
 * twice. Loops still freeze visual time in the Director; the music itself keeps running here.
 */
import { F, type StageFrame } from "./protocol";

/** Bars per phrase used by the console clock (`beatInfo` defaults to 8). */
export const PHRASE_BARS = 8;

const MAX_EXTRAPOLATION_MS = 120;
const SLEW_MS = 50;
/** Disagreements up to this (in beats) are slewed; anything larger snaps. */
export const SNAP_BEATS = 0.05;
/** The output may never step back further than this in one sample, except on a snap. */
export const MAX_BACKSTEP_BEATS = 0.02;
const FEATURE_TAU_SEC = 0.01;
const ONSET_RELEASE_TAU_SEC = 0.03;

/** Feature slots that carry a continuous quantity and are smoothed. */
const CONTINUOUS: number[] = [
  F.rms,
  F.peak,
  F.lufsShort,
  F.centroid,
  F.flux,
  F.crossfader,
  F.gainA,
  F.gainB,
  F.energy,
  F.lowA,
  F.lowB,
  F.filterA,
  F.filterB,
];
/** Onset envelopes: attack instantly, release smoothly. */
const ONSETS: number[] = [F.kick, F.snare, F.hat];
/** Copied verbatim: rates and counts must not be smoothed into meaningless in-between values. */
const VERBATIM: number[] = [F.bpm, F.barsToNextSection];

const wrap01 = (value: number): number => value - Math.floor(value);

/**
 * One phase running on its own clock. `base` is a continuous (unwrapped) position at `epochMs`;
 * `offset` is the correction left over from the last reconciliation, decaying linearly to zero.
 */
class PhaseClock {
  private base = 0;
  private rate = 0; // units per second
  private epochMs = 0;
  private offset = 0;
  private offsetAtMs = 0;
  private out = 0;
  private started = false;

  /** Continuous (unwrapped) position at `nowMs`. */
  value(nowMs: number): number {
    if (!this.started) return this.out;
    const elapsed = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, nowMs - this.epochMs)) / 1000;
    const decay = Math.max(0, 1 - Math.max(0, nowMs - this.offsetAtMs) / SLEW_MS);
    return this.base + elapsed * this.rate + this.offset * decay;
  }

  /** Monotonic sample: the value at `nowMs`, never more than `backstep` below the previous one. */
  sample(nowMs: number, backstep: number): number {
    const wanted = this.value(nowMs);
    const limited = Math.max(wanted, this.out - backstep);
    this.out = limited;
    return limited;
  }

  /** A frame arrived: `phase` is its 0..1 value, `sentMs` the local time it describes. */
  reconcile(phase: number, ratePerSec: number, sentMs: number, nowMs: number, snap: number): void {
    const previous = this.value(nowMs);
    // Unwrap the frame's 0..1 phase onto the continuous line closest to what we are showing.
    const elapsed = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, nowMs - sentMs)) / 1000;
    const raw = wrap01(phase) + elapsed * ratePerSec;
    const candidate = raw + Math.round(previous - raw);
    this.rate = ratePerSec;
    this.epochMs = sentMs;
    this.base = wrap01(phase) + Math.round(previous - raw);
    if (!this.started) {
      this.started = true;
      this.offset = 0;
      this.out = candidate;
      this.offsetAtMs = nowMs;
      return;
    }
    const delta = previous - candidate;
    if (Math.abs(delta) <= snap) {
      this.offset = delta;
      this.offsetAtMs = nowMs;
    } else {
      // Snap: the grid moved (a seek, a new track, a tempo jump). Follow it at once.
      this.offset = 0;
      this.offsetAtMs = nowMs;
      this.out = candidate;
    }
  }
}

export interface PredictorState {
  /** Milliseconds since the frame the prediction is based on (0 when no frame has arrived). */
  ageMs: number;
  /** True while the extrapolation cap holds the picture instead of advancing it. */
  holding: boolean;
}

/**
 * Turns the ≤ 60 Hz frame stream into a smooth per-render-frame view. Feed it every frame that
 * arrives (`push`) and read one view per rendered frame (`sample`).
 */
export class FramePredictor {
  private source: StageFrame | null = null;
  private readonly out: Float32Array;
  private readonly view: StageFrame;
  private readonly beat = new PhaseClock();
  private readonly bar = new PhaseClock();
  private readonly phrase = new PhaseClock();
  private lastSentMs = 0;
  private lastNowMs = 0;
  private primed = false;

  /** `speed` scales the musical clock; the standalone demo runs its 32 bars faster than real time. */
  constructor(
    empty: StageFrame,
    private readonly speed = 1,
  ) {
    this.out = new Float32Array(empty.f.length);
    this.view = { ...empty, f: this.out, events: [] };
  }

  /** Latest state, for the studio read-out and the perf hook. */
  state(nowMs: number): PredictorState {
    const ageMs = this.primed ? Math.max(0, nowMs - this.lastSentMs) : 0;
    return { ageMs, holding: ageMs > MAX_EXTRAPOLATION_MS };
  }

  /**
   * Accepts a frame. `nowMs` and `frame.sentAt` are on the same absolute clock
   * (`performance.timeOrigin + performance.now()`); a negative or absurd delay clamps to zero so a
   * clock difference between windows can never push the picture into the future.
   */
  push(frame: StageFrame, nowMs: number): void {
    const delay = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, nowMs - frame.sentAt));
    const sentMs = nowMs - delay;
    const bpm = frame.f[F.bpm] ?? 0;
    const beatsPerSec = bpm > 0 ? (bpm / 60) * this.speed : 0;
    this.beat.reconcile(frame.f[F.beatPhase] ?? 0, beatsPerSec, sentMs, nowMs, SNAP_BEATS);
    this.bar.reconcile(frame.f[F.barPhase] ?? 0, beatsPerSec / 4, sentMs, nowMs, SNAP_BEATS / 4);
    this.phrase.reconcile(
      frame.f[F.phrasePhase] ?? 0,
      beatsPerSec / (4 * PHRASE_BARS),
      sentMs,
      nowMs,
      SNAP_BEATS / (4 * PHRASE_BARS),
    );
    if (!this.primed) {
      this.out.set(frame.f);
      this.primed = true;
    }
    this.source = frame;
    this.lastSentMs = sentMs;
  }

  /** The frame to render at `nowMs`, `dt` seconds after the previous sample. */
  sample(nowMs: number, dt: number): StageFrame {
    const source = this.source;
    if (!source) return this.view;
    this.lastNowMs = nowMs;
    const step = Math.max(0, dt);
    const featureBlend = 1 - Math.exp(-step / FEATURE_TAU_SEC);
    const release = Math.exp(-step / ONSET_RELEASE_TAU_SEC);
    const f = source.f;
    const out = this.out;
    for (const index of CONTINUOUS) {
      const target = f[index] ?? 0;
      out[index] = (out[index] ?? 0) + (target - (out[index] ?? 0)) * featureBlend;
    }
    for (const index of ONSETS) {
      const target = f[index] ?? 0;
      out[index] = Math.max(target, (out[index] ?? 0) * release);
    }
    for (const index of VERBATIM) out[index] = f[index] ?? 0;
    for (let band = 0; band < F.spectrumBins; band += 1) {
      const index = F.spectrumStart + band;
      const target = f[index] ?? 0;
      out[index] = (out[index] ?? 0) + (target - (out[index] ?? 0)) * featureBlend;
    }
    out[F.beatPhase] = wrap01(this.beat.sample(nowMs, MAX_BACKSTEP_BEATS));
    out[F.barPhase] = wrap01(this.bar.sample(nowMs, MAX_BACKSTEP_BEATS / 4));
    out[F.phrasePhase] = wrap01(this.phrase.sample(nowMs, MAX_BACKSTEP_BEATS / (4 * PHRASE_BARS)));
    this.view.v = source.v;
    this.view.sessionId = source.sessionId;
    this.view.seq = source.seq;
    this.view.tAudio = source.tAudio;
    this.view.sentAt = source.sentAt;
    this.view.section = source.section;
    this.view.keyHue = source.keyHue;
    this.view.onAir = source.onAir;
    this.view.next = source.next ?? "none";
    return this.view;
  }

  /** Last time `sample` was called (diagnostics). */
  get sampledAt(): number {
    return this.lastNowMs;
  }
}
