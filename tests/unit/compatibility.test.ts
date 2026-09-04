import { describe, expect, it } from "vitest";
import {
  camelotDistance,
  camelotHue,
  compatibility,
  keyRelation,
  parseCamelot,
  tempoDeltaPct,
} from "../../src/library/compatibility";

describe("camelot wheel", () => {
  it("parses and measures distances around the wheel", () => {
    expect(parseCamelot("8A")).toEqual({ number: 8, mode: "A" });
    expect(parseCamelot("12b")).toEqual({ number: 12, mode: "B" });
    expect(parseCamelot("13A")).toBeNull();
    expect(parseCamelot("Am")).toBeNull();
    const a8 = parseCamelot("8A");
    const b8 = parseCamelot("8B");
    const a1 = parseCamelot("1A");
    const a12 = parseCamelot("12A");
    if (!a8 || !b8 || !a1 || !a12) throw new Error("parse");
    expect(camelotDistance(a8, a8)).toBe(0);
    expect(camelotDistance(a8, b8)).toBe(1);
    expect(camelotDistance(a1, a12)).toBe(1);
    expect(keyRelation(a8, b8)).toBe("relative");
    expect(keyRelation(a1, a12)).toBe("neighbour");
    expect(keyRelation(parseCamelot("7A") as never, parseCamelot("9A") as never)).toBe("energy-boost");
    expect(keyRelation(parseCamelot("7A") as never, parseCamelot("2B") as never)).toBe("clash");
    expect(camelotHue("1A")).toBe(0);
    expect(camelotHue("1B")).toBe(0);
    expect(camelotHue("7A")).toBe(180);
  });

  it("compares tempo in the nearest octave", () => {
    expect(tempoDeltaPct(128, 130)).toBeCloseTo(1.5625, 3);
    expect(tempoDeltaPct(136, 68)).toBeCloseTo(0, 6);
    expect(tempoDeltaPct(70, 140)).toBeCloseTo(0, 6);
    expect(Number.isNaN(tempoDeltaPct(0, 120))).toBe(true);
  });

  it("scores compatible tracks higher than clashing ones", () => {
    const reference = { camelot: "8A", bpm: 128, energy: 7 };
    const good = compatibility({ camelot: "9A", bpm: 129, energy: 7 }, reference);
    const bad = compatibility({ camelot: "3B", bpm: 150, energy: 3 }, reference);
    expect(good.score).toBeGreaterThan(0.9);
    expect(good.key).toBe("neighbour");
    expect(bad.score).toBeLessThan(0.2);
    expect(bad.key).toBe("clash");
    expect(compatibility({}, reference)).toEqual({
      score: 0.5,
      key: null,
      tempoDeltaPct: null,
      energyDelta: null,
    });
  });
});
