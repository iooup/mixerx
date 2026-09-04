/** Deterministic Phillips spectrum and Stockham schedule for the particle ocean. */
export const OCEAN_SIZE = 200;
export const OCEAN_WORLD_SIZE = 400;

export function oceanResolution(quality: "low" | "medium" | "high"): number {
  return quality === "high" ? 256 : quality === "medium" ? 128 : 64;
}

export function ifftStages(resolution: number): { size: number; horizontal: boolean }[] {
  if (resolution < 2 || !Number.isInteger(Math.log2(resolution)))
    throw new Error("Ocean resolution must be a power of two");
  return Array.from({ length: Math.log2(resolution) * 2 }, (_, index) => ({
    size: 2 ** ((index % Math.log2(resolution)) + 1),
    horizontal: index < Math.log2(resolution),
  }));
}

/** h0(k), conjugate(h0(-k)): paired from the same field so the inverse height stays real. */
export function initialOceanSpectrum(resolution: number, seed = 7341): Float32Array {
  ifftStages(resolution);
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  const h0 = new Float32Array(resolution * resolution * 2);
  const windAngle = 4.83;
  const windLength = 12.9 ** 2 / 9.81;
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const kx = ((2 * Math.PI) / OCEAN_SIZE) * (x < resolution / 2 ? x : x - resolution);
      const kz = ((2 * Math.PI) / OCEAN_SIZE) * (y < resolution / 2 ? y : y - resolution);
      const kk = kx * kx + kz * kz;
      // No mean-height offset or ambiguous Nyquist derivative.
      if (kk === 0 || x === resolution / 2 || y === resolution / 2) continue;
      const alignment = (kx * Math.cos(windAngle) + kz * Math.sin(windAngle)) / Math.sqrt(kk);
      const phillips =
        (1.3 *
          Math.exp(-1 / (kk * windLength ** 2)) *
          alignment ** 2 *
          Math.exp(-kk * (windLength * 0.001) ** 2) *
          (alignment < 0 ? 0.07 : 1)) /
        kk ** 2;
      const radius = Math.sqrt(-2 * Math.log(random())) * Math.sqrt(phillips / 2);
      const phase = 2 * Math.PI * random();
      const offset = (y * resolution + x) * 2;
      h0[offset] = radius * Math.cos(phase);
      h0[offset + 1] = radius * Math.sin(phase);
    }
  }
  const paired = new Float32Array(resolution * resolution * 4);
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const index = y * resolution + x;
      const opposite = ((resolution - y) % resolution) * resolution + ((resolution - x) % resolution);
      paired[index * 4] = h0[index * 2] ?? 0;
      paired[index * 4 + 1] = h0[index * 2 + 1] ?? 0;
      paired[index * 4 + 2] = h0[opposite * 2] ?? 0;
      paired[index * 4 + 3] = -(h0[opposite * 2 + 1] ?? 0);
    }
  }
  return paired;
}
