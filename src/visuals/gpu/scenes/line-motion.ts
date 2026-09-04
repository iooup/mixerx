import type { Intent } from "../../director";

export interface LineMotion {
  time: number;
  energy: number;
  bass: number;
}

/** Smooth musical deformation; silence holds the drawing and reduced motion holds its travel. */
export function stepLineMotion(state: LineMotion, intent: Intent, dt: number): void {
  const step = Math.min(1 / 30, Math.max(0, dt));
  const audible = intent.audio.rms > 0.001;
  const ease = 1 - Math.exp(-step / 0.65);
  const energy = audible ? Math.min(1, intent.intensity * 0.7 + intent.audio.rms * 0.5) : 0.15;
  state.energy += (energy - state.energy) * ease;
  state.bass += ((audible ? Math.min(1, intent.audio.bass) : 0) - state.bass) * ease;
  if (audible && !intent.reducedMotion)
    state.time += step * (0.35 + state.energy * 0.45) * (1 - intent.freeze * 0.9);
}
