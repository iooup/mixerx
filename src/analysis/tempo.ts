/**
 * Tempo estimation from the onset envelope: autocorrelation over the whole track with a
 * log-normal prior, comb reinforcement, and a kick-pattern test to settle octave ambiguity.
 */

export interface TempoCandidate {
  bpm: number;
  score: number;
}

export interface TempoEstimate {
  bpm: number;
  confidence: number;
  candidates: TempoCandidate[];
}

const MIN_BPM = 60;
const MAX_BPM = 200;
const PRIOR_CENTER_BPM = 128;
const PRIOR_SIGMA_OCTAVES = 1.1;
/** Octave check: prefer the faster tempo when the kick repeats at half the chosen lag. */
const OCTAVE_MAX_BPM = 200;
const OCTAVE_KICK_RATIO = 0.6;

function autocorrelation(signal: Float32Array, minLag: number, maxLag: number): Float64Array {
  const n = signal.length;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += signal[i] ?? 0;
  mean /= Math.max(1, n);
  const centred = new Float64Array(n);
  let variance = 0;
  for (let i = 0; i < n; i += 1) {
    const value = (signal[i] ?? 0) - mean;
    centred[i] = value;
    variance += value * value;
  }
  const acf = new Float64Array(maxLag + 1);
  if (variance <= 0) return acf;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = lag; i < n; i += 1) sum += (centred[i] ?? 0) * (centred[i - lag] ?? 0);
    acf[lag] = sum / variance;
  }
  return acf;
}

function interpolate(acf: Float64Array, lag: number): number {
  const previous = acf[lag - 1] ?? 0;
  const current = acf[lag] ?? 0;
  const next = acf[lag + 1] ?? 0;
  const denominator = previous - 2 * current + next;
  if (Math.abs(denominator) < 1e-12) return lag;
  const delta = (0.5 * (previous - next)) / denominator;
  return lag + Math.max(-0.5, Math.min(0.5, delta));
}

export function estimateTempo(onset: Float32Array, kick: Float32Array, fps: number): TempoEstimate {
  const minLag = Math.max(2, Math.floor((60 / MAX_BPM) * fps));
  const maxLag = Math.min(onset.length - 2, Math.ceil((60 / MIN_BPM) * fps) * 4);
  if (maxLag <= minLag + 2) return { bpm: 0, confidence: 0, candidates: [] };
  const onsetAcf = autocorrelation(onset, minLag, maxLag);
  const kickAcf = autocorrelation(kick, minLag, maxLag);

  const scores: { lag: number; score: number }[] = [];
  const upper = Math.ceil((60 / MIN_BPM) * fps);
  for (let lag = minLag; lag <= Math.min(upper, maxLag); lag += 1) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_SIGMA_OCTAVES) ** 2);
    const comb =
      (onsetAcf[lag] ?? 0) +
      0.5 * (onsetAcf[Math.min(maxLag, lag * 2)] ?? 0) +
      0.25 * (onsetAcf[Math.min(maxLag, lag * 4)] ?? 0);
    const kickSupport = Math.max(0, kickAcf[lag] ?? 0);
    scores.push({ lag, score: Math.max(0, comb) * prior * (1 + 0.5 * kickSupport) });
  }

  const peaks = scores.filter((entry, index) => {
    const previous = scores[index - 1]?.score ?? -1;
    const next = scores[index + 1]?.score ?? -1;
    return entry.score > 0 && entry.score >= previous && entry.score >= next;
  });
  peaks.sort((left, right) => right.score - left.score);
  const best = peaks[0];
  if (!best) return { bpm: 0, confidence: 0, candidates: [] };

  // Four-on-the-floor music has a kick on every beat while snares/claps sit on 2 and 4, so the
  // full-band autocorrelation often peaks at two beats. When the kick pattern repeats at half
  // the chosen lag nearly as strongly, the shorter lag is the beat.
  let chosen = best;
  const halfLag = best.lag / 2;
  const halfLow = Math.floor(halfLag);
  const halfHigh = Math.ceil(halfLag);
  if (halfLow >= minLag) {
    const kickFull = kickAcf[best.lag] ?? 0;
    const kickHalf = Math.max(kickAcf[halfLow] ?? 0, kickAcf[halfHigh] ?? 0);
    const onsetHalf = Math.max(onsetAcf[halfLow] ?? 0, onsetAcf[halfHigh] ?? 0);
    const halfBpm = (60 * fps) / halfLag;
    if (
      halfBpm <= OCTAVE_MAX_BPM &&
      kickHalf > 0.1 &&
      kickHalf >= OCTAVE_KICK_RATIO * kickFull &&
      onsetHalf > 0
    ) {
      const nearest = peaks
        .filter((peak) => Math.abs(peak.lag - halfLag) <= 1.5)
        .sort((left, right) => right.score - left.score)[0];
      chosen = nearest ?? { lag: Math.round(halfLag), score: best.score };
    }
  }
  const refinedLag = interpolate(onsetAcf, chosen.lag);
  const bpm = (60 * fps) / refinedLag;
  const ranked = [chosen, ...peaks.filter((peak) => peak !== chosen)];
  const candidates = ranked.slice(0, 5).map((peak) => ({
    bpm: Math.round(((60 * fps) / interpolate(onsetAcf, peak.lag)) * 100) / 100,
    score: Math.round((peak.score / best.score) * 1000) / 1000,
  }));
  const second = ranked[1]?.score ?? 0;
  const confidence = Math.max(
    0,
    Math.min(1, 0.5 + 0.5 * ((chosen.score - second) / Math.max(1e-9, chosen.score))),
  );
  return { bpm: Math.round(bpm * 100) / 100, confidence, candidates };
}
