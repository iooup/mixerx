/**
 * Timing of the now-playing lower third. A track that goes on air
 * slides its name in over 0.6 s, holds for 6 s and slides out over 0.6 s. Pure and unit-tested so
 * the studio, the display and the preview all show it for exactly the same length of time.
 */

export type LowerThirdPhase = "hidden" | "in" | "hold" | "out";

export interface LowerThirdState {
  phase: LowerThirdPhase;
  /** Seconds spent in the current phase. */
  t: number;
  /** 0 (off screen) … 1 (fully in), eased. */
  progress: number;
}

export const LOWER_THIRD_IN_SEC = 0.6;
export const LOWER_THIRD_HOLD_SEC = 6;
export const LOWER_THIRD_OUT_SEC = 0.6;

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return 1 - (1 - t) ** 3;
};

export const initialLowerThird = (): LowerThirdState => ({ phase: "hidden", t: 0, progress: 0 });

/**
 * Advances the state machine. `trigger` is true on the frame a new track went on air; `enabled`
 * is false while the setting is off or the Stage is blacked out, which hides it at once.
 */
export function stepLowerThird(
  state: LowerThirdState,
  dt: number,
  trigger: boolean,
  enabled: boolean,
): LowerThirdState {
  if (!enabled) {
    if (state.phase === "hidden" && state.progress === 0) return state;
    // Leave the way it came, never by vanishing.
    const out = Math.max(0, state.progress - dt / LOWER_THIRD_OUT_SEC);
    return out <= 0 ? initialLowerThird() : { phase: "out", t: state.t + dt, progress: out };
  }
  if (trigger) return { phase: "in", t: 0, progress: state.phase === "hidden" ? 0 : state.progress };
  const t = state.t + Math.max(0, dt);
  switch (state.phase) {
    case "in": {
      if (t >= LOWER_THIRD_IN_SEC) return { phase: "hold", t: t - LOWER_THIRD_IN_SEC, progress: 1 };
      return { phase: "in", t, progress: ease(t / LOWER_THIRD_IN_SEC) };
    }
    case "hold": {
      if (t >= LOWER_THIRD_HOLD_SEC) return { phase: "out", t: t - LOWER_THIRD_HOLD_SEC, progress: 1 };
      return { phase: "hold", t, progress: 1 };
    }
    case "out": {
      if (t >= LOWER_THIRD_OUT_SEC) return initialLowerThird();
      return { phase: "out", t, progress: 1 - ease(t / LOWER_THIRD_OUT_SEC) };
    }
    default:
      return state.progress === 0 && state.t === 0 ? state : initialLowerThird();
  }
}
