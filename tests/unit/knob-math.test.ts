import { describe, expect, it } from "vitest";
import {
  CROSSFADER_CURVES,
  knobAngle,
  knobValue,
  nextCurve,
  quantize,
  wheelNotch,
} from "../../src/ui/knob-math";

describe("knob maths", () => {
  it("puts zero at 12 o'clock for asymmetric bipolar ranges (EQ −26…+12 dB)", () => {
    expect(knobAngle(0, -26, 12, true)).toBe(0);
    expect(knobAngle(-26, -26, 12, true)).toBe(-135);
    expect(knobAngle(12, -26, 12, true)).toBe(135);
    expect(knobAngle(-13, -26, 12, true)).toBeCloseTo(-67.5);
    expect(knobAngle(6, -26, 12, true)).toBeCloseTo(67.5);
  });

  it("maps unipolar ranges linearly over the 270° sweep", () => {
    expect(knobAngle(0, 0, 1, false)).toBe(-135);
    expect(knobAngle(0.5, 0, 1, false)).toBe(0);
    expect(knobAngle(1, 0, 1, false)).toBe(135);
    expect(knobAngle(2, 0, 1, false)).toBe(135);
  });

  it("inverts angles back to values and clamps outside the sweep", () => {
    for (const value of [-26, -13, -0.5, 0, 3, 12]) {
      expect(knobValue(knobAngle(value, -26, 12, true), -26, 12, true)).toBeCloseTo(value, 6);
    }
    expect(knobValue(knobAngle(0.35, -1, 1, true), -1, 1, true)).toBeCloseTo(0.35, 6);
    expect(knobValue(knobAngle(0.8, 0, 1, false), 0, 1, false)).toBeCloseTo(0.8, 6);
    expect(knobValue(-500, -26, 12, true)).toBe(-26);
    expect(knobValue(500, -26, 12, true)).toBe(12);
  });

  it("quantizes to the step grid anchored at the minimum", () => {
    expect(quantize(-12.26, -26, 12, 0.5)).toBe(-12.5);
    expect(quantize(0.004, -1, 1, 0.01)).toBe(0);
    expect(quantize(0.126, 0, 1, 0.01)).toBe(0.13);
    expect(quantize(99, -26, 12, 0.5)).toBe(12);
    expect(quantize(-99, -26, 12, 0.5)).toBe(-26);
  });

  it("makes a wheel notch about a fortieth of the range, never below one step", () => {
    expect(wheelNotch(-26, 12, 0.5)).toBe(1);
    expect(wheelNotch(-1, 1, 0.01)).toBeCloseTo(0.05, 6);
    expect(wheelNotch(0, 1, 0.01)).toBeCloseTo(0.03, 6);
    expect(wheelNotch(-12, 12, 0.5)).toBe(0.5);
  });

  it("cycles the crossfader curves in the documented order", () => {
    expect(CROSSFADER_CURVES).toEqual(["equal-power", "linear", "cut"]);
    expect(nextCurve("equal-power")).toBe("linear");
    expect(nextCurve("linear")).toBe("cut");
    expect(nextCurve("cut")).toBe("equal-power");
  });
});
