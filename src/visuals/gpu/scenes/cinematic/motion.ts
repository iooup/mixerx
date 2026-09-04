import type { Intent } from "../../../director";

export interface CinematicMotion {
  time: number;
  energy: number;
  bass: number;
  treble: number;
}

/** One clock for all four worlds and their thumbnails. No beat oscillator or brightness hits. */
export function stepCinematicMotion(state: CinematicMotion, intent: Intent, dt: number): void {
  const step = Math.min(1 / 30, Math.max(0, dt));
  const audible = intent.audio.rms > 0.001;
  const ease = 1 - Math.exp(-step / 0.7);
  const amount = Math.min(1, Math.max(0, intent.intensity));
  state.energy += ((audible ? amount : 0) - state.energy) * ease;
  state.bass +=
    ((audible && !intent.reducedMotion ? Math.min(1, intent.audio.bass) * amount : 0) - state.bass) * ease;
  state.treble += ((audible ? Math.min(1, intent.audio.treble) * amount : 0) - state.treble) * ease;
  if (audible && !intent.reducedMotion)
    state.time += step * (0.25 + Math.min(1, intent.motion) * 0.65) * (1 - intent.freeze * 0.95);
}

/** Art keeps its midtones at any intensity; the slider mostly changes motion and musical depth. */
export const cinematicExposure = (intensity: number): number =>
  0.72 + Math.min(1, Math.max(0, intensity)) * 0.22;
