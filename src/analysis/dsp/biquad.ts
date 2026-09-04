/** RBJ cookbook biquads plus the ITU-R BS.1770 K-weighting stages, for any sample rate. */

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function normalise(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): BiquadCoefficients {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function lowpass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): BiquadCoefficients {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  return normalise((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

export function highpass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): BiquadCoefficients {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  return normalise((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

export function highshelf(
  sampleRate: number,
  cutoffHz: number,
  gainDb: number,
  q = Math.SQRT1_2,
): BiquadCoefficients {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const sqrtA2Alpha = 2 * Math.sqrt(A) * alpha;
  return normalise(
    A * (A + 1 + (A - 1) * cos + sqrtA2Alpha),
    -2 * A * (A - 1 + (A + 1) * cos),
    A * (A + 1 + (A - 1) * cos - sqrtA2Alpha),
    A + 1 - (A - 1) * cos + sqrtA2Alpha,
    2 * (A - 1 - (A + 1) * cos),
    A + 1 - (A - 1) * cos - sqrtA2Alpha,
  );
}

/** BS.1770 stage 1 (pre-filter) for any sample rate, using the analytic derivation that reproduces the
 * published 48 kHz coefficients (b0 = 1.53512485958697, a1 = −1.69065929318241). */
export function kWeightingShelf(sampleRate: number): BiquadCoefficients {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** BS.1770 stage 2 (RLB high-pass) for any sample rate; b = [1, −2, 1] as in the reference implementations. */
export function kWeightingHighpass(sampleRate: number): BiquadCoefficients {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + k / q + k * k;
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
}

export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private readonly c: BiquadCoefficients) {}

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x: number): number {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  processBuffer(input: Float32Array, output: Float32Array = new Float32Array(input.length)): Float32Array {
    for (let i = 0; i < input.length; i += 1) output[i] = this.process(input[i] ?? 0);
    return output;
  }
}
