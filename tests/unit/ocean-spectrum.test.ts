import { describe, expect, it } from "vitest";
import { ifftStages, initialOceanSpectrum } from "../../src/visuals/gpu/scenes/ocean-spectrum";

describe("ocean spectrum", () => {
  it("reproduces the same sea for the studio and audience without non-finite samples", () => {
    const seed = initialOceanSpectrum(64);
    expect(seed).toEqual(initialOceanSpectrum(64));
    expect(seed.some((value) => value !== 0)).toBe(true);
    expect(seed.every(Number.isFinite)).toBe(true);
    expect(Array.from(seed.slice(0, 4))).toEqual([0, 0, 0, -0]);
    expect(seed).not.toEqual(initialOceanSpectrum(64, 999));
  });

  it("pairs opposite frequencies so the time-evolved height is real", () => {
    const n = 64;
    const seed = initialOceanSpectrum(n);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = (y * n + x) * 4;
        const opposite = (((n - y) % n) * n + ((n - x) % n)) * 4;
        expect(seed[i + 2]).toBe(seed[opposite]);
        expect(seed[i + 3]).toBe(-(seed[opposite + 1] ?? 0));
      }
    }
  });

  it("rejects a non-FFT size before allocating resources", () => {
    for (const n of [0, 1, 3, 127, -64, Number.NaN]) expect(() => ifftStages(n)).toThrow("power of two");
  });
});
