import { describe, expect, it } from "vitest";
import {
  beatInfo,
  beatPeriodSec,
  beatPosition,
  contextFrameAt,
  crossfaderGains,
  dbToGain,
  eqGainDb,
  faderGain,
  filterFrequencies,
  isOnAir,
  nextDownbeatSec,
  phaseErrorMs,
  secAtBeat,
  syncRate,
} from "../../src/engine/beat-math";
import type { BeatGrid } from "../../src/state/session";

const constantGrid = (bpm: number, firstBeatSec: number, downbeatOffset: 0 | 1 | 2 | 3 = 0): BeatGrid => ({
  kind: "constant",
  bpm,
  firstBeatSec,
  downbeatOffset,
  downbeatConfirmed: true,
  confidence: 1,
  candidates: [],
});

describe("crossfader and gain laws", () => {
  it("equal-power endpoints and midpoint", () => {
    expect(crossfaderGains(0, "equal-power")).toEqual({ a: 1, b: 0 });
    const mid = crossfaderGains(0.5, "equal-power");
    expect(mid.a).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.b).toBeCloseTo(Math.SQRT1_2, 6);
    const end = crossfaderGains(1, "equal-power");
    expect(end.a).toBeCloseTo(0, 6);
    expect(end.b).toBeCloseTo(1, 6);
  });

  it("linear and cut curves", () => {
    expect(crossfaderGains(0.25, "linear")).toEqual({ a: 0.75, b: 0.25 });
    expect(crossfaderGains(0.3, "cut")).toEqual({ a: 1, b: 0 });
    expect(crossfaderGains(0.7, "cut")).toEqual({ a: 0, b: 1 });
    const middle = crossfaderGains(0.5, "cut");
    expect(middle.a).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("fader, EQ kill, and filter mappings", () => {
    expect(faderGain(1)).toBe(1);
    expect(faderGain(0.5)).toBe(0.25);
    expect(faderGain(-1)).toBe(0);
    expect(eqGainDb(-26)).toBe(-60);
    expect(eqGainDb(-25)).toBe(-25);
    expect(eqGainDb(40)).toBe(12);
    expect(filterFrequencies(0)).toEqual({ highpassHz: 20, lowpassHz: 20000 });
    expect(filterFrequencies(1).highpassHz).toBeCloseTo(12000, 3);
    expect(filterFrequencies(-1).lowpassHz).toBeCloseTo(100, 3);
    expect(filterFrequencies(0.5).highpassHz).toBeGreaterThan(20);
    expect(isOnAir(true, 1)).toBe(true);
    expect(isOnAir(true, dbToGain(-70))).toBe(false);
    expect(isOnAir(false, 1)).toBe(false);
  });
});

describe("beat grid math", () => {
  const grid = constantGrid(120, 0.5, 1);

  it("maps seconds to beats and back on a constant grid", () => {
    expect(beatPosition(grid, 0.5)).toBe(0);
    expect(beatPosition(grid, 2.5)).toBe(4);
    expect(secAtBeat(grid, 4)).toBe(2.5);
    expect(beatPeriodSec(grid, 10)).toBe(0.5);
    const info = beatInfo(grid, 2.75, 8);
    expect(info.index).toBe(4);
    expect(info.phase).toBeCloseTo(0.5, 9);
    // downbeat offset 1: beats 1,5,9… are bar starts → beat 4.5 is 3.5 beats into the bar that started at beat 1
    expect(info.barPhase).toBeCloseTo(0.875, 9);
  });

  it("finds the next downbeat with a minimum lead", () => {
    // beat 1 is bar 1 (offset 1); at sec 0.5 (beat 0) with lead 4 → earliest beat 4 → next bar start beat 5 → 3.0 s
    expect(nextDownbeatSec(grid, 0.5, 4)).toBeCloseTo(3.0, 9);
    expect(nextDownbeatSec(grid, 3.0, 4)).toBeCloseTo(5.0, 9);
  });

  it("interpolates a beat list grid", () => {
    const list: BeatGrid = {
      kind: "list",
      bpm: 120,
      firstBeatSec: 1,
      beatsSec: new Float32Array([1, 1.5, 2.1, 2.6]),
      downbeatOffset: 0,
      downbeatConfirmed: false,
      confidence: 0.5,
      candidates: [],
    };
    expect(beatPosition(list, 1.25)).toBeCloseTo(0.5, 6);
    expect(beatPosition(list, 1.8)).toBeCloseTo(1.5, 6);
    expect(beatPosition(list, 0.75)).toBeCloseTo(-0.5, 6);
    expect(beatPosition(list, 3.1)).toBeCloseTo(4, 6);
    expect(secAtBeat(list, 1.5)).toBeCloseTo(1.8, 6);
    expect(beatPeriodSec(list, 1.8)).toBeCloseTo(0.6, 6);
  });

  it("measures the phase error between decks and sync rates", () => {
    const gridA = constantGrid(128, 0);
    const gridB = constantGrid(128, 0);
    expect(phaseErrorMs(gridA, 10, gridB, 10)).toBeCloseTo(0, 6);
    expect(phaseErrorMs(gridA, 10, gridB, 10.02)).toBeCloseTo(20, 6);
    expect(phaseErrorMs(gridA, 10, gridB, 9.98)).toBeCloseTo(-20, 6);
    const period = 60 / 128;
    expect(Math.abs(phaseErrorMs(gridA, 10, gridB, 10 + period * 0.5))).toBeCloseTo(period * 500, 3);
    expect(syncRate(128, 125)).toEqual({ rate: 1.024, clamped: false });
    expect(syncRate(140, 120)).toEqual({ rate: 1.08, clamped: true });
    expect(syncRate(0, 120)).toEqual({ rate: 1, clamped: false });
    expect(contextFrameAt(1.5, 48000, 0.25)).toBe(84000);
  });
});
