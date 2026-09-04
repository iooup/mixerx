import { Biquad, lowpass } from "./biquad";

/** Equal-weight mono downmix. */
export function downmix(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return new Float32Array(first);
  const out = new Float32Array(first.length);
  const scale = 1 / channels.length;
  for (const channel of channels) {
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) + (channel[i] ?? 0) * scale;
  }
  return out;
}

/**
 * Resamples a mono signal with a 4th-order low-pass (two cascaded biquads at 0.45 × the lower
 * rate) followed by linear interpolation. Good enough for analysis; playback never uses it.
 */
export function resampleMono(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return new Float32Array(input);
  let source = input;
  if (outputRate < inputRate) {
    const cutoff = outputRate * 0.45;
    const stage1 = new Biquad(lowpass(inputRate, cutoff, 0.54));
    const stage2 = new Biquad(lowpass(inputRate, cutoff, 1.31));
    source = stage2.processBuffer(stage1.processBuffer(input));
  }
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const t = position - index;
    const a = source[index] ?? 0;
    const b = source[index + 1] ?? a;
    out[i] = a + (b - a) * t;
  }
  return out;
}
