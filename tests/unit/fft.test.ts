import { describe, expect, it } from "vitest";
import { FFT, hannWindow, magnitudeSpectrum } from "../../src/analysis/dsp/fft";

function naiveDft(real: Float32Array): { real: number[]; imag: number[] } {
  const n = real.length;
  const outReal: number[] = [];
  const outImag: number[] = [];
  for (let k = 0; k < n; k += 1) {
    let sumReal = 0;
    let sumImag = 0;
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * k * t) / n;
      sumReal += (real[t] ?? 0) * Math.cos(angle);
      sumImag += (real[t] ?? 0) * Math.sin(angle);
    }
    outReal.push(sumReal);
    outImag.push(sumImag);
  }
  return { real: outReal, imag: outImag };
}

describe("FFT", () => {
  it("matches a naive DFT on random input", () => {
    const n = 64;
    const input = new Float32Array(n);
    let seed = 7;
    for (let i = 0; i < n; i += 1) {
      seed = (seed * 16807) % 2147483647;
      input[i] = seed / 2147483647 - 0.5;
    }
    const expected = naiveDft(input);
    const fft = new FFT(n);
    const real = new Float32Array(input);
    const imag = new Float32Array(n);
    fft.forward(real, imag);
    for (let k = 0; k < n; k += 1) {
      expect(real[k]).toBeCloseTo(expected.real[k] ?? 0, 3);
      expect(imag[k]).toBeCloseTo(expected.imag[k] ?? 0, 3);
    }
  });

  it("locates a pure tone in the magnitude spectrum", () => {
    const n = 1024;
    const sampleRate = 44100;
    const hz = 1000;
    const frame = new Float32Array(n);
    for (let i = 0; i < n; i += 1) frame[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
    const fft = new FFT(n);
    const out = new Float32Array(n / 2 + 1);
    magnitudeSpectrum(fft, frame, 0, hannWindow(n), new Float32Array(n), new Float32Array(n), out);
    let best = 0;
    for (let i = 1; i < out.length; i += 1) if ((out[i] ?? 0) > (out[best] ?? 0)) best = i;
    expect(Math.abs((best * sampleRate) / n - hz)).toBeLessThan(sampleRate / n);
  });

  it("rejects non power-of-two sizes", () => {
    expect(() => new FFT(1000)).toThrow();
  });
});
