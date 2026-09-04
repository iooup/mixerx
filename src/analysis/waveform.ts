/**
 * Waveform summaries: per 1 024 samples a peak plus low/mid/high RMS (4 bytes per bin), and an
 * 8-bins-per-second overview in the same layout. Both are computed on the mono downmix at the
 * original sample rate so they line up with playback positions exactly.
 */
import { Biquad, highpass, lowpass } from "./dsp/biquad";

export const WAVEFORM_HOP = 1024 as const;
export const OVERVIEW_BINS_PER_SECOND = 8;

export interface WaveformSummary {
  hop: typeof WAVEFORM_HOP;
  bins: Uint8Array;
  overview: Uint8Array;
}

const toByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value * 255)));

export function computeWaveform(mono: Float32Array, sampleRate: number): WaveformSummary {
  const hop = WAVEFORM_HOP;
  const count = Math.max(1, Math.ceil(mono.length / hop));
  const bins = new Uint8Array(count * 4);
  const lowFilter = new Biquad(lowpass(sampleRate, 200));
  const midHigh = new Biquad(highpass(sampleRate, 200));
  const midLow = new Biquad(lowpass(sampleRate, 2000));
  const highFilter = new Biquad(highpass(sampleRate, 2000));
  const lowRms = new Float32Array(count);
  const midRms = new Float32Array(count);
  const highRms = new Float32Array(count);
  const peaks = new Float32Array(count);
  for (let bin = 0; bin < count; bin += 1) {
    const start = bin * hop;
    const end = Math.min(mono.length, start + hop);
    let peak = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let i = start; i < end; i += 1) {
      const sample = mono[i] ?? 0;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      const l = lowFilter.process(sample);
      const m = midLow.process(midHigh.process(sample));
      const h = highFilter.process(sample);
      low += l * l;
      mid += m * m;
      high += h * h;
    }
    const length = Math.max(1, end - start);
    peaks[bin] = peak;
    lowRms[bin] = Math.sqrt(low / length);
    midRms[bin] = Math.sqrt(mid / length);
    highRms[bin] = Math.sqrt(high / length);
  }
  // Band values are scaled so that a loud track uses most of the byte range.
  let bandPeak = 1e-6;
  for (let bin = 0; bin < count; bin += 1) {
    bandPeak = Math.max(bandPeak, lowRms[bin] ?? 0, midRms[bin] ?? 0, highRms[bin] ?? 0);
  }
  for (let bin = 0; bin < count; bin += 1) {
    bins[bin * 4] = toByte(peaks[bin] ?? 0);
    bins[bin * 4 + 1] = toByte(Math.sqrt((lowRms[bin] ?? 0) / bandPeak));
    bins[bin * 4 + 2] = toByte(Math.sqrt((midRms[bin] ?? 0) / bandPeak));
    bins[bin * 4 + 3] = toByte(Math.sqrt((highRms[bin] ?? 0) / bandPeak));
  }

  const binsPerOverview = Math.max(1, Math.round(sampleRate / hop / OVERVIEW_BINS_PER_SECOND));
  const overviewCount = Math.max(1, Math.ceil(count / binsPerOverview));
  const overview = new Uint8Array(overviewCount * 4);
  for (let o = 0; o < overviewCount; o += 1) {
    let peak = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    let n = 0;
    for (let bin = o * binsPerOverview; bin < Math.min(count, (o + 1) * binsPerOverview); bin += 1) {
      peak = Math.max(peak, bins[bin * 4] ?? 0);
      low += bins[bin * 4 + 1] ?? 0;
      mid += bins[bin * 4 + 2] ?? 0;
      high += bins[bin * 4 + 3] ?? 0;
      n += 1;
    }
    overview[o * 4] = peak;
    overview[o * 4 + 1] = n ? Math.round(low / n) : 0;
    overview[o * 4 + 2] = n ? Math.round(mid / n) : 0;
    overview[o * 4 + 3] = n ? Math.round(high / n) : 0;
  }
  return { hop, bins, overview };
}
