import type { Intent } from "../director";
import type { PetId } from "./characters";
import type { DancerSeed } from "./crowd-math";

export type PetMove = "rest" | "groove" | "step" | "wave" | "jump";
export interface PetPose {
  row: number;
  column: number;
  x: number;
  y: number;
  lean: number;
  stretch: number;
  move: PetMove;
}

const TAU = Math.PI * 2;
const wrap = (value: number, length: number) => ((value % length) + length) % length;
const clamp = (value: number) => Math.min(1, Math.max(0, value));
export const REST_POSE: Readonly<PetPose> = Object.freeze({
  row: 0,
  column: 0,
  x: 0,
  y: 0,
  lean: 0,
  stretch: 1,
  move: "rest",
});

// Eight-beat phrases: robot pops, quick shuffles, wing responses and heel-toe steps.
// Indices sample original limb poses in authored dance order, not continuous walking loops.
const PHRASES: Record<PetId, readonly PetMove[]> = {
  codex: ["groove", "wave", "step", "step", "groove", "wave", "step", "jump"],
  fireball: ["step", "step", "jump", "wave", "step", "step", "jump", "jump"],
  hoots: ["groove", "wave", "groove", "wave", "step", "wave", "step", "jump"],
  dario: ["step", "groove", "step", "wave", "step", "groove", "step", "jump"],
};
const STEP_FRAMES: Record<PetId, readonly number[]> = {
  codex: [0, 0, 2, 2, 4, 4, 2, 0],
  fireball: [0, 2, 4, 6, 7, 5, 3, 1],
  hoots: [0, 1, 3, 3, 5, 5, 3, 1],
  dario: [0, 2, 3, 2, 0, 5, 6, 5],
};
const WAVE_FRAMES = [0, 1, 2, 3, 3, 2, 1, 0];
const JUMP_FRAMES = [0, 1, 2, 2, 3, 4, 4, 0];

/** Beat-locked choreography, with actual kick/snare envelopes driving the body and hands. */
export function petPose(id: PetId, seed: DancerSeed, intent: Intent): PetPose {
  if (intent.reducedMotion || intent.onAir === "none" || intent.blackout || intent.beat.bpm <= 0)
    return { ...REST_POSE };
  const quiet = intent.section === "break" || intent.section === "intro" || intent.section === "outro";
  const beat = intent.beat.beatIndex + intent.beat.phase;
  // The lead stays exactly on the beat; the back rows answer a fraction later.
  const offset = seed.id === 0 ? 0 : seed.phase * 0.18;
  const local = beat - offset;
  const phase = wrap(local, 1);
  const beatInPhrase = Math.floor(wrap(local, 8));
  const kick = clamp(intent.audio.kick);
  const snare = clamp(intent.audio.snare);
  const bass = clamp(intent.audio.bass);
  const energy = clamp(intent.audio.rms * 2 + bass * 0.35);
  const amp = (0.3 + 0.7 * intent.intensity) * (0.4 + 0.6 * energy) * (1 - intent.anticipation * 0.65);
  const sway = Math.sin((local / 4 + seed.phase * 0.2) * TAU);
  const side = Math.floor(wrap(local, 4)) < 2 ? 1 : 2;
  let move: PetMove = PHRASES[id][beatInPhrase] as PetMove;
  if (quiet) move = "groove";
  else if (intent.anticipation > 0.45 || intent.section === "build") move = "wave";
  else if (intent.burst > 0.25 || (intent.section === "drop" && beatInPhrase % 4 === seed.id % 4))
    move = "jump";
  else if (snare > 0.28) move = "wave";
  const tick = Math.min(7, Math.floor(phase * 8));
  const row = move === "step" ? side : move === "wave" ? 3 : move === "jump" ? 4 : 0;
  const column =
    move === "step"
      ? (STEP_FRAMES[id][tick] as number)
      : move === "wave"
        ? Math.max(WAVE_FRAMES[tick] as number, snare > 0.28 ? Math.round(snare * 3) : 0)
        : move === "jump"
          ? (JUMP_FRAMES[tick] as number)
          : Math.floor((wrap(local, quiet ? 4 : 2) / (quiet ? 4 : 2)) * 6);
  const hop = Math.sin(phase * Math.PI) ** 2;
  const leap = move === "jump" ? (id === "fireball" ? 54 : 36) : quiet ? 3 : 9;
  // Codex pops squarely, Fireball springs, Hoots rocks its wings, Dario shifts heel-to-toe.
  const lean = id === "codex" ? Math.tanh(sway * 5) * 0.075 : sway * (id === "hoots" ? 0.12 : 0.09);
  return {
    row,
    column,
    move,
    x: sway * (id === "dario" ? 25 : id === "fireball" ? 17 : 11) * amp,
    y: (-hop * leap - intent.burst * 22 + kick * (id === "codex" ? 12 : 7) - snare * 6) * amp,
    lean: (lean + snare * (side === 1 ? 0.05 : -0.05)) * amp,
    stretch:
      1 + (kick * 0.07 - snare * 0.035 + Math.sin(phase * TAU) * (id === "dario" ? 0.045 : 0.02)) * amp,
  };
}

/** Bounded state, one pose per visible dancer. Freeze holds the whole pose; silence snaps to rest. */
export class PetMotion {
  private readonly poses = new Map<number, PetPose>();
  private formation = "";

  configure(character: string, count: number): void {
    const formation = `${character}:${count}`;
    if (formation === this.formation) return;
    this.formation = formation;
    this.poses.clear();
  }

  update(id: PetId, seed: DancerSeed, intent: Intent, dt: number): PetPose {
    const previous = this.poses.get(seed.id);
    if (
      previous &&
      intent.freeze > 0.5 &&
      !intent.reducedMotion &&
      intent.onAir !== "none" &&
      !intent.blackout
    )
      return previous;
    const target = petPose(id, seed, intent);
    if (!previous || target.move === "rest") {
      this.poses.set(seed.id, target);
      return target;
    }
    const blend = 1 - Math.exp(-Math.min(0.05, Math.max(0, dt)) / 0.055);
    for (const key of ["x", "y", "lean", "stretch"] as const)
      target[key] = previous[key] + (target[key] - previous[key]) * blend;
    this.poses.set(seed.id, target);
    return target;
  }
}
