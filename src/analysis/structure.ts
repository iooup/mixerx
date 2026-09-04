/**
 * Downbeat estimation and structural segmentation on beat-synchronous features.
 */
import type { Section, SectionKind } from "../state/session";
import type { FrameFeatures } from "./dsp/features";

export interface DownbeatEstimate {
  offset: 0 | 1 | 2 | 3;
  confidence: number;
}

export interface BeatSyncFeatures {
  beats: number;
  logMel: Float32Array; // beats × melBands
  chroma: Float32Array; // beats × 12
  rms: Float32Array; // beats
  kick: Float32Array; // beats
  high: Float32Array; // beats
  flux: Float32Array; // beats (onset energy around the beat)
}

/** Averages frame features over each beat interval. */
export function beatSynchronous(
  features: FrameFeatures,
  onset: Float32Array,
  beatFrames: number[],
): BeatSyncFeatures {
  const beats = Math.max(0, beatFrames.length - 1);
  const { melBands } = features;
  const logMel = new Float32Array(beats * melBands);
  const chroma = new Float32Array(beats * 12);
  const rms = new Float32Array(beats);
  const kick = new Float32Array(beats);
  const high = new Float32Array(beats);
  const flux = new Float32Array(beats);
  for (let beat = 0; beat < beats; beat += 1) {
    const start = Math.max(0, beatFrames[beat] ?? 0);
    const end = Math.max(start + 1, Math.min(features.frames, beatFrames[beat + 1] ?? start + 1));
    const count = end - start;
    for (let frame = start; frame < end; frame += 1) {
      for (let band = 0; band < melBands; band += 1) {
        logMel[beat * melBands + band] =
          (logMel[beat * melBands + band] ?? 0) + (features.logMel[frame * melBands + band] ?? 0) / count;
      }
      for (let pc = 0; pc < 12; pc += 1) {
        chroma[beat * 12 + pc] =
          (chroma[beat * 12 + pc] ?? 0) + (features.chroma[frame * 12 + pc] ?? 0) / count;
      }
      rms[beat] = (rms[beat] ?? 0) + (features.rms[frame] ?? 0) / count;
      kick[beat] = (kick[beat] ?? 0) + (features.kick[frame] ?? 0) / count;
      high[beat] = (high[beat] ?? 0) + (features.high[frame] ?? 0) / count;
    }
    // Onset strength in the two frames around the beat itself.
    let peakOnset = 0;
    for (let frame = Math.max(0, start - 1); frame <= Math.min(features.frames - 1, start + 1); frame += 1) {
      peakOnset = Math.max(peakOnset, onset[frame] ?? 0);
    }
    flux[beat] = peakOnset;
  }
  return { beats, logMel, chroma, rms, kick, high, flux };
}

/** Scores the four possible bar phases by kick energy, onset strength, and 16-beat periodicity. */
export function estimateDownbeat(sync: BeatSyncFeatures): DownbeatEstimate {
  if (sync.beats < 8) return { offset: 0, confidence: 0 };
  const scores = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  let kickPeak = 1e-9;
  let fluxPeak = 1e-9;
  for (let beat = 0; beat < sync.beats; beat += 1) {
    kickPeak = Math.max(kickPeak, sync.kick[beat] ?? 0);
    fluxPeak = Math.max(fluxPeak, sync.flux[beat] ?? 0);
  }
  for (let beat = 0; beat < sync.beats; beat += 1) {
    const phase = beat % 4;
    const kick = (sync.kick[beat] ?? 0) / kickPeak;
    const flux = (sync.flux[beat] ?? 0) / fluxPeak;
    const phraseBonus = beat % 16 === 0 ? 0.25 : beat % 8 === 0 ? 0.1 : 0;
    scores[phase] = (scores[phase] ?? 0) + kick + 0.6 * flux + phraseBonus * (kick + flux);
    counts[phase] = (counts[phase] ?? 0) + 1;
  }
  const means = scores.map((score, phase) => score / Math.max(1, counts[phase] ?? 1));
  let best = 0;
  for (let phase = 1; phase < 4; phase += 1) if ((means[phase] ?? 0) > (means[best] ?? 0)) best = phase;
  const sorted = [...means].sort((left, right) => right - left);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  const confidence = top > 0 ? Math.max(0, Math.min(1, (top - second) / top)) : 0;
  return { offset: best as 0 | 1 | 2 | 3, confidence };
}

function cosineDistance(
  a: Float32Array,
  aOffset: number,
  b: Float32Array,
  bOffset: number,
  length: number,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[aOffset + i] ?? 0;
    const y = b[bOffset + i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 1;
  return 1 - dot / Math.sqrt(normA * normB);
}

/** Checkerboard novelty on the self-similarity of beat-synchronous mel + chroma features. */
export function noveltyCurve(sync: BeatSyncFeatures, melBands: number, kernelBeats = 32): Float32Array {
  const beats = sync.beats;
  const width = melBands + 12;
  const combined = new Float32Array(beats * width);
  for (let beat = 0; beat < beats; beat += 1) {
    for (let band = 0; band < melBands; band += 1)
      combined[beat * width + band] = sync.logMel[beat * melBands + band] ?? 0;
    for (let pc = 0; pc < 12; pc += 1)
      combined[beat * width + melBands + pc] = (sync.chroma[beat * 12 + pc] ?? 0) * 8;
  }
  const half = Math.max(2, Math.floor(kernelBeats / 2));
  const novelty = new Float32Array(beats);
  for (let beat = half; beat < beats - half; beat += 1) {
    let within = 0;
    let across = 0;
    let withinCount = 0;
    let acrossCount = 0;
    for (let i = 0; i < half; i += 1) {
      for (let j = 0; j < half; j += 1) {
        const pastA = beat - half + i;
        const pastB = beat - half + j;
        const futureA = beat + i;
        const futureB = beat + j;
        within += cosineDistance(combined, pastA * width, combined, pastB * width, width);
        within += cosineDistance(combined, futureA * width, combined, futureB * width, width);
        withinCount += 2;
        across += cosineDistance(combined, pastA * width, combined, futureB * width, width);
        acrossCount += 1;
      }
    }
    novelty[beat] = Math.max(0, across / Math.max(1, acrossCount) - within / Math.max(1, withinCount));
  }
  return novelty;
}

export interface SegmentationOptions {
  downbeatOffset: number;
  minSegmentBars?: number;
}

/** Picks section boundaries at novelty peaks snapped to 4-bar multiples from the downbeat. */
export function segmentBoundaries(novelty: Float32Array, options: SegmentationOptions): number[] {
  const beats = novelty.length;
  const minBeats = (options.minSegmentBars ?? 4) * 4;
  const boundaries: number[] = [0];
  const candidates: { beat: number; value: number }[] = [];
  let peak = 1e-9;
  for (let beat = 0; beat < beats; beat += 1) peak = Math.max(peak, novelty[beat] ?? 0);
  for (let beat = 1; beat < beats - 1; beat += 1) {
    const value = novelty[beat] ?? 0;
    if (value >= (novelty[beat - 1] ?? 0) && value >= (novelty[beat + 1] ?? 0) && value > 0.15 * peak) {
      candidates.push({ beat, value });
    }
  }
  candidates.sort((left, right) => right.value - left.value);
  const chosen: number[] = [];
  for (const candidate of candidates) {
    // Snap to the nearest 4-bar boundary (16 beats) relative to the downbeat.
    const relative = candidate.beat - options.downbeatOffset;
    const snapped = options.downbeatOffset + Math.round(relative / 16) * 16;
    if (snapped <= 0 || snapped >= beats) continue;
    if (chosen.some((existing) => Math.abs(existing - snapped) < minBeats)) continue;
    chosen.push(snapped);
  }
  boundaries.push(...chosen.sort((left, right) => left - right));
  return boundaries;
}

export function labelSections(
  sync: BeatSyncFeatures,
  boundaries: number[],
  downbeatOffset: number,
): Section[] {
  const beats = sync.beats;
  if (beats === 0) return [];
  const edges = [...boundaries, beats];
  let peakRms = 1e-9;
  let peakKick = 1e-9;
  for (let beat = 0; beat < beats; beat += 1) {
    peakRms = Math.max(peakRms, sync.rms[beat] ?? 0);
    peakKick = Math.max(peakKick, sync.kick[beat] ?? 0);
  }
  const stats = edges.slice(0, -1).map((start, index) => {
    const end = edges[index + 1] ?? beats;
    let rms = 0;
    let kick = 0;
    let first = 0;
    let last = 0;
    const count = Math.max(1, end - start);
    const quarter = Math.max(1, Math.floor(count / 4));
    for (let beat = start; beat < end; beat += 1) {
      rms += (sync.rms[beat] ?? 0) / peakRms;
      kick += (sync.kick[beat] ?? 0) / peakKick;
      if (beat < start + quarter) first += (sync.rms[beat] ?? 0) / peakRms / quarter;
      if (beat >= end - quarter) last += (sync.rms[beat] ?? 0) / peakRms / quarter;
    }
    return { start, end, energy: rms / count, kick: kick / count, slope: last - first };
  });
  const maxEnergy = Math.max(1e-9, ...stats.map((segment) => segment.energy));
  return stats.map((segment, index) => {
    const previous = stats[index - 1];
    const energy = segment.energy / maxEnergy;
    let kind: SectionKind = "body";
    if (index === 0 && energy < 0.7) kind = "intro";
    else if (index === stats.length - 1 && energy < 0.7 && stats.length > 1) kind = "outro";
    else if (energy >= 0.85 && segment.kick > 0.5) kind = "drop";
    else if (previous && energy < previous.energy / maxEnergy - 0.2 && segment.kick < 0.5) kind = "break";
    else if (segment.slope > 0.12 && energy < 0.85) kind = "build";
    const startBar = Math.floor((segment.start - downbeatOffset) / 4);
    const endBar = Math.ceil((segment.end - downbeatOffset) / 4);
    return {
      kind,
      startBar: Math.max(0, startBar),
      endBar: Math.max(startBar + 1, endBar),
      energy: Math.round(energy * 1000) / 1000,
    };
  });
}

/** Per-bar energy 0..1 from beat-synchronous RMS. */
export function energyPerBar(sync: BeatSyncFeatures, downbeatOffset: number): Float32Array {
  const bars = Math.max(1, Math.ceil((sync.beats - downbeatOffset) / 4));
  const energy = new Float32Array(bars);
  let peak = 1e-9;
  for (let bar = 0; bar < bars; bar += 1) {
    let sum = 0;
    let count = 0;
    for (let beat = downbeatOffset + bar * 4; beat < downbeatOffset + bar * 4 + 4; beat += 1) {
      if (beat < 0 || beat >= sync.beats) continue;
      sum += sync.rms[beat] ?? 0;
      count += 1;
    }
    energy[bar] = count ? sum / count : 0;
    peak = Math.max(peak, energy[bar] ?? 0);
  }
  for (let bar = 0; bar < bars; bar += 1) energy[bar] = (energy[bar] ?? 0) / peak;
  return energy;
}
