/**
 * Pure maths for the mixer knobs. A knob sweeps 270° from
 * 7 o'clock to 5 o'clock. Bipolar knobs put zero at 12 o'clock even when the range is
 * asymmetric (EQ: −26…+12 dB), so the pointer angle reads like a hardware mixer.
 */
import type { CrossfaderCurve } from "../state/session";

export const KNOB_SWEEP_DEG = 270;
export const KNOB_MIN_DEG = -KNOB_SWEEP_DEG / 2;
/** Vertical drag distance for a full sweep, in CSS pixels. */
export const KNOB_DRAG_PX = 160;
/** Shift slows a drag or a wheel notch by this factor. */
export const KNOB_FINE_FACTOR = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Pointer angle in degrees (−135…135) for a value. */
export function knobAngle(value: number, min: number, max: number, bipolar: boolean): number {
  const bounded = clamp(value, min, max);
  const norm = bipolar
    ? 0.5 + 0.5 * (bounded < 0 ? bounded / -min : bounded / max)
    : (bounded - min) / (max - min);
  return KNOB_MIN_DEG + norm * KNOB_SWEEP_DEG;
}

/** Inverse of `knobAngle`; angles outside the sweep clamp to the ends. */
export function knobValue(angle: number, min: number, max: number, bipolar: boolean): number {
  const norm = clamp((angle - KNOB_MIN_DEG) / KNOB_SWEEP_DEG, 0, 1);
  if (!bipolar) return min + norm * (max - min);
  const signed = norm * 2 - 1;
  return signed < 0 ? signed * -min : signed * max;
}

/** Snaps to the control's step grid (anchored at `min`) and clamps. */
export function quantize(value: number, min: number, max: number, step: number): number {
  const snapped = Math.round((value - min) / step) * step + min;
  return Number(clamp(snapped, min, max).toFixed(6));
}

/** One mouse-wheel notch: about 1/40 of the range, never below one step. */
export function wheelNotch(min: number, max: number, step: number): number {
  return Math.max(step, quantize((max - min) / 40, 0, max - min, step));
}

export const CROSSFADER_CURVES: readonly CrossfaderCurve[] = ["equal-power", "linear", "cut"];

export function nextCurve(curve: CrossfaderCurve): CrossfaderCurve {
  const index = CROSSFADER_CURVES.indexOf(curve);
  return CROSSFADER_CURVES[(index + 1) % CROSSFADER_CURVES.length] ?? "equal-power";
}
