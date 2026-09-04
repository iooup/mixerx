/**
 * ITU-R BS.1770-4 integrated loudness (K-weighting, 400 ms blocks with 75 % overlap, absolute
 * −70 LUFS and relative −10 LU gating) and an over-sampled peak estimate.
 */
import { Biquad, kWeightingHighpass, kWeightingShelf } from "./dsp/biquad";

export interface LoudnessResult {
  integratedLufs: number;
  truePeakDb: number;
  gainSuggestionDb: number;
}

export const TARGET_LUFS = -14;

function blockPowers(channel: Float32Array, sampleRate: number): Float64Array {
  const shelf = new Biquad(kWeightingShelf(sampleRate));
  const highpassFilter = new Biquad(kWeightingHighpass(sampleRate));
  const blockLength = Math.round(sampleRate * 0.4);
  const hop = Math.round(sampleRate * 0.1);
  const blocks = Math.max(0, Math.floor((channel.length - blockLength) / hop) + 1);
  const powers = new Float64Array(blocks);
  // Running sum of squares over the block window using a ring of hop-sized partial sums.
  const partials = new Float64Array(Math.ceil(blockLength / hop));
  let partialIndex = 0;
  let partial = 0;
  let samplesInPartial = 0;
  let block = 0;
  for (let i = 0; i < channel.length; i += 1) {
    const weighted = highpassFilter.process(shelf.process(channel[i] ?? 0));
    partial += weighted * weighted;
    samplesInPartial += 1;
    if (samplesInPartial === hop) {
      partials[partialIndex] = partial;
      partialIndex = partialIndex + 1 >= partials.length ? 0 : partialIndex + 1;
      partial = 0;
      samplesInPartial = 0;
      if (i + 1 >= blockLength && block < blocks) {
        let sum = 0;
        for (let k = 0; k < partials.length; k += 1) sum += partials[k] ?? 0;
        powers[block] = sum / blockLength;
        block += 1;
      }
    }
  }
  return powers;
}

const powerToLufs = (power: number): number => -0.691 + 10 * Math.log10(Math.max(1e-12, power));

export function integratedLoudness(channels: Float32Array[], sampleRate: number): number {
  if (!channels.length) return -100;
  const perChannel = channels.slice(0, 2).map((channel) => blockPowers(channel, sampleRate));
  const blocks = Math.min(...perChannel.map((powers) => powers.length));
  if (blocks === 0) return -100;
  const summed = new Float64Array(blocks);
  for (let block = 0; block < blocks; block += 1) {
    let total = 0;
    for (const powers of perChannel) total += powers[block] ?? 0;
    summed[block] = total;
  }
  const absoluteGate = -70;
  let gatedSum = 0;
  let gatedCount = 0;
  for (let block = 0; block < blocks; block += 1) {
    if (powerToLufs(summed[block] ?? 0) > absoluteGate) {
      gatedSum += summed[block] ?? 0;
      gatedCount += 1;
    }
  }
  if (gatedCount === 0) return -100;
  const relativeGate = powerToLufs(gatedSum / gatedCount) - 10;
  let finalSum = 0;
  let finalCount = 0;
  for (let block = 0; block < blocks; block += 1) {
    if (powerToLufs(summed[block] ?? 0) > relativeGate) {
      finalSum += summed[block] ?? 0;
      finalCount += 1;
    }
  }
  return finalCount ? powerToLufs(finalSum / finalCount) : -100;
}

/** 4× over-sampled peak with a windowed-sinc interpolator (BS.1770 Annex 2 in spirit). */
export function truePeakDb(channels: Float32Array[]): number {
  const taps = 12;
  const phases = 4;
  const kernel: Float32Array[] = [];
  for (let phase = 0; phase < phases; phase += 1) {
    const filter = new Float32Array(taps);
    let sum = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const x = tap - taps / 2 + 1 - phase / phases;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const hann = 0.5 + 0.5 * Math.cos((Math.PI * x) / (taps / 2));
      filter[tap] = sinc * hann;
      sum += filter[tap] ?? 0;
    }
    for (let tap = 0; tap < taps; tap += 1) filter[tap] = (filter[tap] ?? 0) / sum;
    kernel.push(filter);
  }
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      peak = Math.max(peak, Math.abs(channel[i] ?? 0));
      for (let phase = 1; phase < phases; phase += 1) {
        const filter = kernel[phase];
        if (!filter) continue;
        let value = 0;
        for (let tap = 0; tap < taps; tap += 1)
          value += (channel[i + tap - taps / 2 + 1] ?? 0) * (filter[tap] ?? 0);
        peak = Math.max(peak, Math.abs(value));
      }
    }
  }
  return 20 * Math.log10(Math.max(1e-6, peak));
}

export function measureLoudness(channels: Float32Array[], sampleRate: number): LoudnessResult {
  const integratedLufs = integratedLoudness(channels, sampleRate);
  const peak = truePeakDb(channels);
  const gainSuggestionDb = Math.max(-12, Math.min(12, TARGET_LUFS - integratedLufs));
  return {
    integratedLufs: Math.round(integratedLufs * 10) / 10,
    truePeakDb: Math.round(peak * 10) / 10,
    gainSuggestionDb: Math.round(gainSuggestionDb * 10) / 10,
  };
}
