/** Iterative radix-2 complex FFT with precomputed twiddles and bit-reversal table. */
export class FFT {
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly reverse: Uint32Array;

  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0)
      throw new Error(`FFT size must be a power of two, got ${size}`);
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i += 1) {
      const angle = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i += 1) {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit += 1) reversed |= ((i >> bit) & 1) << (bits - 1 - bit);
      this.reverse[i] = reversed;
    }
  }

  /** In-place forward transform of (real, imag). */
  forward(real: Float32Array, imag: Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i += 1) {
      const j = this.reverse[i] ?? 0;
      if (j > i) {
        const tr = real[i] ?? 0;
        real[i] = real[j] ?? 0;
        real[j] = tr;
        const ti = imag[i] ?? 0;
        imag[i] = imag[j] ?? 0;
        imag[j] = ti;
      }
    }
    for (let length = 2; length <= n; length <<= 1) {
      const half = length >> 1;
      const step = n / length;
      for (let start = 0; start < n; start += length) {
        for (let k = 0; k < half; k += 1) {
          const twiddleIndex = k * step;
          const wr = this.cos[twiddleIndex] ?? 1;
          const wi = this.sin[twiddleIndex] ?? 0;
          const even = start + k;
          const odd = even + half;
          const oddReal = real[odd] ?? 0;
          const oddImag = imag[odd] ?? 0;
          const tr = oddReal * wr - oddImag * wi;
          const ti = oddReal * wi + oddImag * wr;
          const evenReal = real[even] ?? 0;
          const evenImag = imag[even] ?? 0;
          real[odd] = evenReal - tr;
          imag[odd] = evenImag - ti;
          real[even] = evenReal + tr;
          imag[even] = evenImag + ti;
        }
      }
    }
  }
}

export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return window;
}

/**
 * Magnitude spectrum of one windowed frame. `frame` is read starting at `offset`; `real`/`imag`
 * are scratch buffers of the FFT size; `out` receives size/2 + 1 magnitudes.
 */
export function magnitudeSpectrum(
  fft: FFT,
  frame: Float32Array,
  offset: number,
  window: Float32Array,
  real: Float32Array,
  imag: Float32Array,
  out: Float32Array,
): void {
  const n = fft.size;
  for (let i = 0; i < n; i += 1) {
    real[i] = (frame[offset + i] ?? 0) * (window[i] ?? 0);
    imag[i] = 0;
  }
  fft.forward(real, imag);
  const bins = n / 2 + 1;
  for (let i = 0; i < bins; i += 1) {
    const r = real[i] ?? 0;
    const im = imag[i] ?? 0;
    out[i] = Math.sqrt(r * r + im * im);
  }
}
