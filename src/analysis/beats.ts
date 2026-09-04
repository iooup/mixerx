/**
 * Beat tracking: Ellis (2007) dynamic programming over the onset envelope, followed by a robust
 * constant-grid fit (median period, circular-mean phase, inlier check) which is the normal case
 * for electronic music and survives breaks where the tracker may wander.
 */
import type { BeatGrid } from "../state/session";

export interface TrackedBeats {
  beatFrames: number[];
  beatsSec: Float32Array;
  beatScores: Float32Array;
}

export interface GridFit {
  bpm: number;
  firstBeatSec: number; // in [0, period)
  inlierFraction: number;
  constant: boolean;
}

function gaussianSmooth(signal: Float32Array, sigma: number): Float64Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const value = Math.exp(-0.5 * (i / sigma) ** 2);
    kernel[i + radius] = value;
    total += value;
  }
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const index = i + k;
      if (index < 0 || index >= signal.length) continue;
      sum += (signal[index] ?? 0) * (kernel[k + radius] ?? 0);
    }
    out[i] = sum / total;
  }
  return out;
}

export function trackBeats(
  onset: Float32Array,
  bpm: number,
  fps: number,
  frameToSec: (frame: number) => number,
  tightness = 100,
): TrackedBeats {
  const period = (60 / bpm) * fps;
  if (!(period > 1) || onset.length < period * 2) {
    return { beatFrames: [], beatsSec: new Float32Array(0), beatScores: new Float32Array(0) };
  }
  const localScore = gaussianSmooth(onset, period / 32);
  let mean = 0;
  for (let i = 0; i < localScore.length; i += 1) mean += localScore[i] ?? 0;
  mean /= localScore.length;
  let variance = 0;
  for (let i = 0; i < localScore.length; i += 1) variance += ((localScore[i] ?? 0) - mean) ** 2;
  const std = Math.sqrt(variance / localScore.length) || 1;
  for (let i = 0; i < localScore.length; i += 1) localScore[i] = (localScore[i] ?? 0) / std;

  const n = localScore.length;
  const windowStart = -Math.round(2 * period);
  const windowEnd = -Math.round(period / 2);
  const cumulative = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  const transition = new Float64Array(windowEnd - windowStart + 1);
  for (let offset = windowStart; offset <= windowEnd; offset += 1) {
    transition[offset - windowStart] = -tightness * Math.log(-offset / period) ** 2;
  }

  for (let i = 0; i < n; i += 1) {
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestIndex = -1;
    for (let offset = windowStart; offset <= windowEnd; offset += 1) {
      const candidate = i + offset;
      if (candidate < 0) continue;
      const score = (transition[offset - windowStart] ?? 0) + (cumulative[candidate] ?? 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = candidate;
      }
    }
    if (bestIndex < 0) {
      cumulative[i] = localScore[i] ?? 0;
    } else {
      cumulative[i] = bestScore + (localScore[i] ?? 0);
      backlink[i] = bestIndex;
    }
  }

  let last = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i += 1) {
    if ((cumulative[i] ?? 0) > (cumulative[last] ?? 0)) last = i;
  }
  const reversed: number[] = [];
  for (let i = last; i >= 0; i = backlink[i] ?? -1) reversed.push(i);
  const beatFrames = reversed.reverse();
  return {
    beatFrames,
    beatsSec: new Float32Array(beatFrames.map((frame) => frameToSec(frame))),
    beatScores: new Float32Array(beatFrames.map((frame) => Math.max(0, localScore[frame] ?? 0))),
  };
}

/**
 * Fits a constant tempo grid to tracked beats. The DP beats are frame-quantised, so each interval
 * is off by up to half a frame; the period must come from a regression over many beats, not from
 * the median interval. Iterates nearest-index assignment → least squares, rejecting outliers.
 */
export function fitConstantGrid(tracked: TrackedBeats, fallbackBpm: number): GridFit {
  const times = tracked.beatsSec;
  const n = times.length;
  const seed = fallbackBpm > 0 ? 60 / fallbackBpm : 0.5;
  const fail = (): GridFit => ({
    bpm: fallbackBpm,
    firstBeatSec: n ? (times[0] ?? 0) % seed : 0,
    inlierFraction: 0,
    constant: false,
  });
  if (n < 8) return fail();

  // 1. Trimmed mean of the intervals near the seed removes the quantisation bias.
  let sum = 0;
  let count = 0;
  for (let i = 1; i < n; i += 1) {
    const interval = (times[i] ?? 0) - (times[i - 1] ?? 0);
    if (Math.abs(interval - seed) <= 0.15 * seed) {
      sum += interval;
      count += 1;
    }
  }
  let period = count >= 4 ? sum / count : seed;

  // 2. Phase vote: the tracker can flip to the off-beat for whole sections, so the phase comes
  // from the strongest bin of an onset-weighted histogram of (time mod period), not from
  // the first beat.
  const bins = 24;
  const histogram = new Float64Array(bins);
  for (let i = 0; i < n; i += 1) {
    const phase = ((((times[i] ?? 0) / period) % 1) + 1) % 1;
    const weight = Math.max(0, tracked.beatScores[i] ?? 0) + 1e-3;
    const bin = Math.min(bins - 1, Math.floor(phase * bins));
    histogram[bin] = (histogram[bin] ?? 0) + weight;
  }
  let bestBin = 0;
  for (let bin = 1; bin < bins; bin += 1) {
    if ((histogram[bin] ?? 0) > (histogram[bestBin] ?? 0)) bestBin = bin;
  }
  let origin = ((bestBin + 0.5) / bins) * period;
  let inliers = 0;

  // 3. Nearest-index regression, tightening the tolerance as the fit converges.
  const tolerances = [0.25, 0.18, 0.12, 0.1, 0.1];
  for (const tolerance of tolerances) {
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    inliers = 0;
    for (let i = 0; i < n; i += 1) {
      const t = times[i] ?? 0;
      const k = Math.round((t - origin) / period);
      const residual = t - (origin + k * period);
      if (Math.abs(residual) > tolerance * period) continue;
      sk += k;
      st += t;
      skk += k * k;
      skt += k * t;
      inliers += 1;
    }
    if (inliers < 4) return fail();
    const denominator = inliers * skk - sk * sk;
    if (Math.abs(denominator) < 1e-9) return fail();
    const slope = (inliers * skt - sk * st) / denominator;
    const intercept = (st - slope * sk) / inliers;
    if (!(slope > 0.2 && slope < 1.2)) return fail();
    period = slope;
    origin = intercept;
  }

  // Constancy is judged on the rhythmic beats: a beat's weight is its onset strength, so beats
  // the tracker emits through beatless intros and breakdowns barely count.
  let weightedInliers = 0;
  let weightTotal = 0;
  for (let i = 0; i < n; i += 1) {
    const t = times[i] ?? 0;
    const weight = Math.max(0, tracked.beatScores[i] ?? 0) + 1e-3;
    const k = Math.round((t - origin) / period);
    const residual = t - (origin + k * period);
    weightTotal += weight;
    if (Math.abs(residual) <= 0.1 * period) weightedInliers += weight;
  }
  const inlierFraction = weightTotal > 0 ? weightedInliers / weightTotal : inliers / n;
  const firstBeatSec = ((origin % period) + period) % period;
  return {
    bpm: Math.round((60 / period) * 100) / 100,
    firstBeatSec,
    inlierFraction,
    constant: inlierFraction >= 0.7,
  };
}

export function gridBeatFrames(
  fit: GridFit,
  secToFrame: (sec: number) => number,
  totalFrames: number,
): number[] {
  const period = 60 / Math.max(1, fit.bpm);
  const frames: number[] = [];
  for (let beat = 0; ; beat += 1) {
    const frame = Math.round(secToFrame(fit.firstBeatSec + beat * period));
    if (frame >= totalFrames) break;
    if (frame >= 0) frames.push(frame);
  }
  return frames;
}

export function gridFromFit(
  fit: GridFit,
  tracked: TrackedBeats,
  downbeatOffset: 0 | 1 | 2 | 3,
  confidence: number,
  candidates: { bpm: number; score: number }[],
): BeatGrid {
  if (fit.constant || tracked.beatsSec.length < 4) {
    return {
      kind: "constant",
      bpm: fit.bpm,
      firstBeatSec: fit.firstBeatSec,
      downbeatOffset,
      downbeatConfirmed: false,
      confidence,
      candidates,
    };
  }
  return {
    kind: "list",
    bpm: fit.bpm,
    firstBeatSec: Math.max(0, tracked.beatsSec[0] ?? 0),
    beatsSec: tracked.beatsSec,
    downbeatOffset,
    downbeatConfirmed: false,
    confidence,
    candidates,
  };
}
