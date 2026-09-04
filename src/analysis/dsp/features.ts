import { FFT, hannWindow, magnitudeSpectrum } from "./fft";

export interface FrameFeatures {
  frames: number;
  fps: number;
  hop: number;
  fftSize: number;
  sampleRate: number;
  melBands: number;
  /** log-mel energies (log10, floored 40 dB below the track's loudest band), frames × melBands */
  logMel: Float32Array;
  /** chroma, frames × 12 (unit-sum per frame) */
  chroma: Float32Array;
  /** per-frame RMS of the analysed signal */
  rms: Float32Array;
  /** per-frame energy in 30–150 Hz (kick) */
  kick: Float32Array;
  /** per-frame energy above 2 kHz (hats) */
  high: Float32Array;
}

const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1);

interface MelFilter {
  start: number;
  end: number;
  weights: Float32Array;
}

export function melFilterbank(
  sampleRate: number,
  fftSize: number,
  bands: number,
  lowHz: number,
  highHz: number,
): MelFilter[] {
  const bins = fftSize / 2 + 1;
  const hzPerBin = sampleRate / fftSize;
  const lowMel = hzToMel(lowHz);
  const highMel = hzToMel(Math.min(highHz, sampleRate / 2));
  const centers: number[] = [];
  for (let i = 0; i <= bands + 1; i += 1)
    centers.push(melToHz(lowMel + ((highMel - lowMel) * i) / (bands + 1)) / hzPerBin);
  const filters: MelFilter[] = [];
  for (let band = 0; band < bands; band += 1) {
    const left = centers[band] ?? 0;
    const center = centers[band + 1] ?? left;
    const right = centers[band + 2] ?? center;
    const start = Math.max(0, Math.floor(left));
    const end = Math.min(bins - 1, Math.ceil(right));
    const weights = new Float32Array(Math.max(1, end - start + 1));
    for (let bin = start; bin <= end; bin += 1) {
      const weight =
        bin < center
          ? (bin - left) / Math.max(1e-6, center - left)
          : (right - bin) / Math.max(1e-6, right - center);
      weights[bin - start] = Math.max(0, Math.min(1, weight));
    }
    filters.push({ start, end, weights });
  }
  return filters;
}

/**
 * Frame-level features for the whole track from a mono signal: 40 log-mel bands, 12-bin chroma,
 * RMS, kick-band energy, and high-band energy. FFT 1024 / hop 256 at 22 050 Hz gives ≈ 86 fps.
 */
export function extractFrameFeatures(
  signal: Float32Array,
  sampleRate: number,
  fftSize = 1024,
  hop = 256,
): FrameFeatures {
  const melBands = 40;
  const frames = Math.max(1, Math.floor((signal.length - fftSize) / hop) + 1);
  const fft = new FFT(fftSize);
  const window = hannWindow(fftSize);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const magnitudes = new Float32Array(fftSize / 2 + 1);
  const filters = melFilterbank(sampleRate, fftSize, melBands, 30, 11000);
  const hzPerBin = sampleRate / fftSize;
  const bins = fftSize / 2 + 1;
  const pitchClass = new Int8Array(bins);
  for (let bin = 0; bin < bins; bin += 1) {
    const hz = bin * hzPerBin;
    pitchClass[bin] =
      hz >= 55 && hz <= 2500 ? ((Math.round(12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12 : -1;
  }
  const kickEnd = Math.min(bins - 1, Math.round(150 / hzPerBin));
  const kickStart = Math.max(1, Math.round(30 / hzPerBin));
  const highStart = Math.min(bins - 1, Math.round(2000 / hzPerBin));

  const mel = new Float32Array(frames * melBands);
  const chroma = new Float32Array(frames * 12);
  const rms = new Float32Array(frames);
  const kick = new Float32Array(frames);
  const high = new Float32Array(frames);
  const chromaFrame = new Float64Array(12);
  let melPeak = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * hop;
    magnitudeSpectrum(fft, signal, offset, window, real, imag, magnitudes);
    let energy = 0;
    for (let i = 0; i < fftSize; i += 1) {
      const sample = signal[offset + i] ?? 0;
      energy += sample * sample;
    }
    rms[frame] = Math.sqrt(energy / fftSize);

    for (let band = 0; band < melBands; band += 1) {
      const filter = filters[band];
      if (!filter) continue;
      let sum = 0;
      for (let bin = filter.start; bin <= filter.end; bin += 1) {
        const magnitude = magnitudes[bin] ?? 0;
        sum += magnitude * magnitude * (filter.weights[bin - filter.start] ?? 0);
      }
      mel[frame * melBands + band] = sum;
      if (sum > melPeak) melPeak = sum;
    }

    chromaFrame.fill(0);
    let chromaTotal = 0;
    let kickEnergy = 0;
    let highEnergy = 0;
    for (let bin = 1; bin < bins; bin += 1) {
      const magnitude = magnitudes[bin] ?? 0;
      const pc = pitchClass[bin] ?? -1;
      if (pc >= 0) {
        chromaFrame[pc] = (chromaFrame[pc] ?? 0) + magnitude;
        chromaTotal += magnitude;
      }
      if (bin >= kickStart && bin <= kickEnd) kickEnergy += magnitude * magnitude;
      if (bin >= highStart) highEnergy += magnitude * magnitude;
    }
    for (let pc = 0; pc < 12; pc += 1)
      chroma[frame * 12 + pc] = chromaTotal > 0 ? (chromaFrame[pc] ?? 0) / chromaTotal : 1 / 12;
    kick[frame] = Math.sqrt(kickEnergy) / fftSize;
    high[frame] = Math.sqrt(highEnergy) / fftSize;
  }

  // Log compression with a floor 40 dB below the loudest band, so silence-to-noise transitions do
  // not produce unbounded flux.
  const floor = Math.max(1e-12, melPeak * 1e-4);
  const logMel = new Float32Array(frames * melBands);
  for (let i = 0; i < logMel.length; i += 1) logMel[i] = Math.log10(Math.max(floor, mel[i] ?? 0));

  return {
    frames,
    fps: sampleRate / hop,
    hop,
    fftSize,
    sampleRate,
    melBands,
    logMel,
    chroma,
    rms,
    kick,
    high,
  };
}

function detrendAndNormalise(onset: Float32Array, fps: number): Float32Array {
  const frames = onset.length;
  const smoothed = new Float32Array(frames);
  const radius = Math.max(1, Math.round(fps * 0.5));
  let running = 0;
  const window = new Float32Array(radius * 2 + 1);
  let windowIndex = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    running -= window[windowIndex] ?? 0;
    window[windowIndex] = onset[frame] ?? 0;
    running += onset[frame] ?? 0;
    windowIndex = windowIndex + 1 >= window.length ? 0 : windowIndex + 1;
    const mean = running / Math.min(frame + 1, window.length);
    smoothed[frame] = Math.max(0, (onset[frame] ?? 0) - mean);
  }
  let peak = 1e-6;
  for (let frame = 0; frame < frames; frame += 1) peak = Math.max(peak, smoothed[frame] ?? 0);
  for (let frame = 0; frame < frames; frame += 1) smoothed[frame] = (smoothed[frame] ?? 0) / peak;
  return smoothed;
}

/**
 * Onset envelope = kick-band spectral flux (bands below ≈ 250 Hz) plus 0.35 × full-band flux, each
 * trend-removed and peak-normalised. Kick-driven music therefore locks to the kick, while the
 * full-band term still marks onsets in sections without a kick.
 */
export function onsetEnvelope(features: FrameFeatures): Float32Array {
  const { frames, melBands, logMel } = features;
  const lowBands = Math.max(1, Math.round(melBands * 0.16));
  const fluxAll = new Float32Array(frames);
  const fluxLow = new Float32Array(frames);
  for (let frame = 1; frame < frames; frame += 1) {
    let all = 0;
    let low = 0;
    for (let band = 0; band < melBands; band += 1) {
      const delta = (logMel[frame * melBands + band] ?? 0) - (logMel[(frame - 1) * melBands + band] ?? 0);
      if (delta <= 0) continue;
      all += delta;
      if (band < lowBands) low += delta;
    }
    fluxAll[frame] = all;
    fluxLow[frame] = low;
  }
  const normalisedAll = detrendAndNormalise(fluxAll, features.fps);
  const normalisedLow = detrendAndNormalise(fluxLow, features.fps);
  const onset = new Float32Array(frames);
  let peak = 1e-6;
  for (let frame = 0; frame < frames; frame += 1) {
    onset[frame] = (normalisedLow[frame] ?? 0) + 0.35 * (normalisedAll[frame] ?? 0);
    peak = Math.max(peak, onset[frame] ?? 0);
  }
  for (let frame = 0; frame < frames; frame += 1) onset[frame] = (onset[frame] ?? 0) / peak;
  return onset;
}

/** Frame index → seconds at the frame centre. */
export const frameToSec = (
  features: Pick<FrameFeatures, "hop" | "fftSize" | "sampleRate">,
  frame: number,
): number => (frame * features.hop + features.fftSize / 2) / features.sampleRate;

export const secToFrame = (
  features: Pick<FrameFeatures, "hop" | "fftSize" | "sampleRate">,
  sec: number,
): number => (sec * features.sampleRate - features.fftSize / 2) / features.hop;

/**
 * Fine chroma for key estimation: 8192-point frames (≈ 2.7 Hz per bin at 22 050 Hz) with
 * spectral-peak picking between 55 Hz and 2.5 kHz, so low partials land in the right pitch class.
 * Returns unit-sum chroma per frame at ≈ 5 frames/s.
 */
export function extractFineChroma(
  signal: Float32Array,
  sampleRate: number,
  fftSize = 8192,
  hop = 4096,
): Float32Array {
  const frames = Math.max(1, Math.floor((signal.length - fftSize) / hop) + 1);
  const fft = new FFT(fftSize);
  const window = hannWindow(fftSize);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const magnitudes = new Float32Array(fftSize / 2 + 1);
  const hzPerBin = sampleRate / fftSize;
  const lowBin = Math.max(2, Math.ceil(55 / hzPerBin));
  const highBin = Math.min(fftSize / 2 - 1, Math.floor(2500 / hzPerBin));
  const chroma = new Float32Array(frames * 12);
  const accumulator = new Float64Array(12);
  for (let frame = 0; frame < frames; frame += 1) {
    magnitudeSpectrum(fft, signal, frame * hop, window, real, imag, magnitudes);
    accumulator.fill(0);
    let frameMax = 0;
    for (let bin = lowBin; bin <= highBin; bin += 1) frameMax = Math.max(frameMax, magnitudes[bin] ?? 0);
    const threshold = frameMax * 0.02;
    let total = 0;
    for (let bin = lowBin; bin <= highBin; bin += 1) {
      const magnitude = magnitudes[bin] ?? 0;
      if (
        magnitude < threshold ||
        magnitude < (magnitudes[bin - 1] ?? 0) ||
        magnitude < (magnitudes[bin + 1] ?? 0)
      )
        continue;
      // Parabolic interpolation of the peak position for a precise frequency.
      const previous = magnitudes[bin - 1] ?? 0;
      const next = magnitudes[bin + 1] ?? 0;
      const denominator = previous - 2 * magnitude + next;
      const delta = Math.abs(denominator) > 1e-12 ? (0.5 * (previous - next)) / denominator : 0;
      const hz = (bin + delta) * hzPerBin;
      const pc = ((Math.round(12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12;
      accumulator[pc] = (accumulator[pc] ?? 0) + magnitude;
      total += magnitude;
    }
    for (let pc = 0; pc < 12; pc += 1)
      chroma[frame * 12 + pc] = total > 0 ? (accumulator[pc] ?? 0) / total : 1 / 12;
  }
  return chroma;
}
