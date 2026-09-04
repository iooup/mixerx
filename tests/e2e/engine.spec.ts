import { expect, type Page, test } from "@playwright/test";

type Harness = typeof import("../../src/engine/harness");

const HARNESS_URL = "/src/engine/harness.ts";

type HarnessMethod = {
  [K in keyof Harness]: Harness[K] extends (...args: infer A) => Promise<infer R> ? [K, A, R] : never;
}[keyof Harness];

async function harness<K extends HarnessMethod[0]>(
  page: Page,
  method: K,
  args: Extract<HarnessMethod, [K, unknown[], unknown]>[1],
): Promise<Extract<HarnessMethod, [K, unknown[], unknown]>[2]> {
  await page.goto("/");
  return page.evaluate(
    async ([name, callArgs, url]) => {
      const module = (await import(url)) as Record<string, (...input: unknown[]) => Promise<unknown>>;
      const fn = module[name];
      if (!fn) throw new Error(`harness method ${name} missing`);
      return fn(...callArgs);
    },
    [method, args, HARNESS_URL] as const,
  ) as Promise<Extract<HarnessMethod, [K, unknown[], unknown]>[2]>;
}

test.describe("audio engine (offline rendering of the real worklets)", () => {
  test("a deck starts exactly at the requested context frame", async ({ page }) => {
    const result = await harness(page, "deckStartsAtFrame", [1000]);
    expect(result.firstNonZero).toBe(1000);
    expect(result.valueAtStart).toBeCloseTo(0.5, 5);
  });

  test("a deck stops exactly at the requested context frame", async ({ page }) => {
    const result = await harness(page, "deckStopsAtFrame", [5000]);
    expect(result.lastNonZero).toBe(4999);
  });

  test("loops wrap inside the render quantum without a main-thread seek", async ({ page }) => {
    const { samples } = await harness(page, "deckLoops", []);
    // The ramp track has value frame/44100; the loop covers frames 1000–1199 (200 frames).
    const ramp = (frame: number) => frame / 44100;
    expect(samples[0]).toBeCloseTo(ramp(1000), 6);
    expect(samples[199]).toBeCloseTo(ramp(1199), 6);
    expect(samples[200]).toBeCloseTo(ramp(1000), 6);
    expect(samples[450]).toBeCloseTo(ramp(1050), 6);
  });

  test("rate doubles the playback slope", async ({ page }) => {
    const single = await harness(page, "deckRate", [1]);
    const double = await harness(page, "deckRate", [2]);
    expect(single.slopePerFrame).toBeCloseTo(1, 3);
    expect(double.slopePerFrame).toBeCloseTo(2, 3);
  });

  test("the limiter holds a full-scale sine under the ceiling and passes quiet signals", async ({ page }) => {
    const hot = await harness(page, "limiterCeiling", [1]);
    expect(hot.peak).toBeLessThanOrEqual(0.9);
    expect(hot.peak).toBeGreaterThan(0.8);
    const quiet = await harness(page, "limiterCeiling", [0.25]);
    expect(quiet.steadyGain).toBeCloseTo(1, 2);
  });

  test("the mixer applies equal-power and linear crossfader laws", async ({ page }) => {
    const mid = await harness(page, "mixerCrossfade", [0.5, "equal-power"]);
    expect(mid.level).toBeCloseTo(0.25 * Math.SQRT2, 3);
    const linear = await harness(page, "mixerCrossfade", [0.25, "linear"]);
    expect(linear.level).toBeCloseTo(0.25, 3);
    const aOnly = await harness(page, "mixerCrossfade", [0, "equal-power"]);
    expect(aOnly.level).toBeCloseTo(0.25, 3);
  });
});
