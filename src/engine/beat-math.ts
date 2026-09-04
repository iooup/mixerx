/**
 * Pure engine math: crossfader laws, fader/EQ/filter mappings, beat-grid arithmetic,
 * scheduling conversions, and sync helpers. No audio objects here; everything is unit-tested.
 */
import type { BeatGrid, CrossfaderCurve, DeckBeat, Section, SectionKind } from "../state/session";

export const TEMPO_RANGE_PCT = 8;
export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 12;
export const EQ_KILL_GAIN_DB = -60;
export const ON_AIR_THRESHOLD_DB = -60;

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
export const clamp01 = (value: number): number => clamp(Number.isFinite(value) ? value : 0, 0, 1);
export const wrap01 = (value: number): number => ((value % 1) + 1) % 1;

export function crossfaderGains(position: number, curve: CrossfaderCurve): { a: number; b: number } {
  const p = clamp01(position);
  if (curve === "linear") return { a: 1 - p, b: p };
  if (curve === "cut") {
    if (p <= 0.46) return { a: 1, b: 0 };
    if (p >= 0.54) return { a: 0, b: 1 };
    const t = (p - 0.46) / 0.08;
    return { a: Math.cos((t * Math.PI) / 2), b: Math.sin((t * Math.PI) / 2) };
  }
  return { a: Math.cos((p * Math.PI) / 2), b: Math.sin((p * Math.PI) / 2) };
}

/** Squared law: perceptually even, 0 at the bottom of the fader. */
export const faderGain = (value: number): number => clamp01(value) ** 2;

export const dbToGain = (db: number): number => 10 ** (db / 20);
export const gainToDb = (gain: number): number => 20 * Math.log10(Math.max(1e-6, gain));

/** EQ knob value in dB; the bottom of the range is a kill (−60 dB). */
export function eqGainDb(value: number): number {
  const db = clamp(value, EQ_MIN_DB, EQ_MAX_DB);
  return db <= EQ_MIN_DB + 0.01 ? EQ_KILL_GAIN_DB : db;
}

/** Bipolar filter: negative = low-pass down to 100 Hz, positive = high-pass up to 12 kHz. */
export function filterFrequencies(value: number): { highpassHz: number; lowpassHz: number } {
  const v = clamp(value, -1, 1);
  const amount = Math.abs(v);
  return {
    highpassHz: v > 0 ? 20 * 600 ** amount : 20,
    lowpassHz: v < 0 ? 20000 / 200 ** amount : 20000,
  };
}

export const tempoOffsetToRate = (pct: number): number =>
  1 + clamp(pct, -TEMPO_RANGE_PCT, TEMPO_RANGE_PCT) / 100;
export const rateToTempoOffset = (rate: number): number => (rate - 1) * 100;

export function isOnAir(playing: boolean, gain: number): boolean {
  return playing && gain > dbToGain(ON_AIR_THRESHOLD_DB);
}

// ---------- Beat grid ----------

function listIndex(beats: Float32Array, sec: number): number {
  let low = 0;
  let high = beats.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((beats[mid] ?? 0) <= sec) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Fractional beat index at `sec` (0 = first beat of the grid; negative before it). */
export function beatPosition(grid: BeatGrid, sec: number): number {
  if (grid.kind === "list" && grid.beatsSec && grid.beatsSec.length >= 2) {
    const beats = grid.beatsSec;
    const last = beats.length - 1;
    const first = beats[0] ?? 0;
    if (sec <= first) {
      const interval = Math.max(1e-3, (beats[1] ?? first + 0.5) - first);
      return (sec - first) / interval;
    }
    const index = listIndex(beats, sec);
    if (index >= last) {
      const interval = Math.max(1e-3, (beats[last] ?? 0) - (beats[last - 1] ?? 0));
      return last + (sec - (beats[last] ?? 0)) / interval;
    }
    const start = beats[index] ?? 0;
    const end = beats[index + 1] ?? start + 0.5;
    return index + (sec - start) / Math.max(1e-3, end - start);
  }
  return ((sec - grid.firstBeatSec) * grid.bpm) / 60;
}

/** Inverse of beatPosition. */
export function secAtBeat(grid: BeatGrid, beat: number): number {
  if (grid.kind === "list" && grid.beatsSec && grid.beatsSec.length >= 2) {
    const beats = grid.beatsSec;
    const last = beats.length - 1;
    const first = beats[0] ?? 0;
    if (beat <= 0) return first + beat * Math.max(1e-3, (beats[1] ?? first + 0.5) - first);
    if (beat >= last)
      return (beats[last] ?? 0) + (beat - last) * Math.max(1e-3, (beats[last] ?? 0) - (beats[last - 1] ?? 0));
    const index = Math.floor(beat);
    const start = beats[index] ?? 0;
    const end = beats[index + 1] ?? start + 0.5;
    return start + (beat - index) * (end - start);
  }
  return grid.firstBeatSec + (beat * 60) / grid.bpm;
}

/** Seconds per beat around `sec`. */
export function beatPeriodSec(grid: BeatGrid, sec: number): number {
  if (grid.kind === "list" && grid.beatsSec && grid.beatsSec.length >= 2) {
    const beat = Math.max(0, Math.min(grid.beatsSec.length - 2, Math.floor(beatPosition(grid, sec))));
    return Math.max(1e-3, (grid.beatsSec[beat + 1] ?? 0) - (grid.beatsSec[beat] ?? 0));
  }
  return 60 / grid.bpm;
}

export function beatInfo(grid: BeatGrid, sec: number, phraseBars: 8 | 16 = 8): DeckBeat {
  const position = beatPosition(grid, sec);
  const index = Math.floor(position);
  const barPosition = (position - grid.downbeatOffset) / 4;
  return {
    index,
    phase: wrap01(position - index),
    barPhase: wrap01(barPosition),
    phrasePhase: wrap01(barPosition / phraseBars),
    phraseBars,
  };
}

/** The next bar-1 (downbeat) at least `minLeadBeats` beats after `sec`. */
export function nextDownbeatSec(grid: BeatGrid, sec: number, minLeadBeats = 4): number {
  const earliest = beatPosition(grid, sec) + Math.max(0, minLeadBeats);
  const bars = Math.ceil((earliest - grid.downbeatOffset) / 4);
  return secAtBeat(grid, grid.downbeatOffset + bars * 4);
}

/** Beat phase of deck B relative to deck A in milliseconds of A's period, wrapped to (−½ period, ½ period]. */
export function phaseErrorMs(gridA: BeatGrid, secA: number, gridB: BeatGrid, secB: number): number {
  const phaseA = wrap01(beatPosition(gridA, secA));
  const phaseB = wrap01(beatPosition(gridB, secB));
  let delta = phaseB - phaseA;
  if (delta > 0.5) delta -= 1;
  if (delta <= -0.5) delta += 1;
  return delta * beatPeriodSec(gridA, secA) * 1000;
}

/** Rate multiplier that makes `sourceBpm` play at `targetBpm`, limited to the tempo range. */
export function syncRate(targetBpm: number, sourceBpm: number): { rate: number; clamped: boolean } {
  if (!(targetBpm > 0) || !(sourceBpm > 0)) return { rate: 1, clamped: false };
  const wanted = targetBpm / sourceBpm;
  const limit = TEMPO_RANGE_PCT / 100;
  const rate = clamp(wanted, 1 - limit, 1 + limit);
  return { rate, clamped: rate !== wanted };
}

/** AudioContext frame index for a moment `secondsFromNow` in the future. */
export function contextFrameAt(contextTimeNow: number, sampleRate: number, secondsFromNow: number): number {
  return Math.round((contextTimeNow + Math.max(0, secondsFromNow)) * sampleRate);
}

/** Seconds of context time until deck time `targetSec` is reached at `rate`, given the current deck position. */
export function secondsUntilDeckTime(positionSec: number, targetSec: number, rate: number): number {
  return Math.max(0, (targetSec - positionSec) / Math.max(1e-3, rate));
}

export interface SectionPosition {
  kind: SectionKind;
  bar: number; // 0-based bar index in the track
  barsToNext: number | null;
  next: SectionKind | null;
}

/** The section at `sec` and the whole bars left until the next one. */
export function sectionAt(sections: Section[], grid: BeatGrid, sec: number): SectionPosition | null {
  if (!sections.length) return null;
  const bar = (beatPosition(grid, sec) - grid.downbeatOffset) / 4;
  const index = sections.findIndex((section) => bar >= section.startBar && bar < section.endBar);
  if (index < 0) return null;
  const section = sections[index];
  const next = sections[index + 1];
  if (!section) return null;
  return {
    kind: section.kind,
    bar: Math.floor(bar),
    barsToNext: next ? Math.max(0, Math.ceil(next.startBar - bar)) : null,
    next: next?.kind ?? null,
  };
}
