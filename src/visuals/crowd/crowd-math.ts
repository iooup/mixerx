/**
 * The Crowd: abstract dancers drawn in SVG over the WebGPU scene. Poses
 * are pure functions of the beat and the Director's intent so every window draws the same crowd.
 * Personalities: bouncers ride the beat, swayers follow the bar, jumpers leave the floor on drops,
 * raisers lift their arms through builds, and one lead dancer in the centre carries ribbons.
 *
 * The crowd follows musical sections: phones go up through a break, a wave of jumps runs
 * across the floor from the crossfader's side on every phrase, snares make the jumpers hop, hats
 * make the raisers flick their hands, and anticipation stills the floor with the arms already up.
 */
export type Personality = "bounce" | "sway" | "jump" | "raise" | "lead";

export interface DancerSeed {
  id: number;
  personality: Personality;
  /** Horizontal slot 0..1 across the stage. */
  slot: number;
  phase: number; // 0..1 offset into the beat/bar
  size: number; // 0.75..1.25 (lead: 1.6)
  swing: number; // 0..1 how much this dancer sways
  depth: number; // 0 front .. 1 back (drawn smaller and dimmer)
}

export interface CrowdInput {
  /** Seconds; the caller freezes it during loops. */
  t: number;
  beatPhase: number;
  barPhase: number;
  kick: number;
  snare: number;
  hat: number;
  snareCount: number;
  intensity: number;
  motion: number;
  section: string;
  barsToNext: number;
  burst: number;
  floor: number;
  freeze: number;
  balance: number;
  reduced: boolean;
  /** 0 → 1 over the four bars before a drop: the floor goes still with its arms already up. */
  anticipation: number;
  /** Smoothed 0..1 phone level; the caller eases it over one bar when the break ends. */
  phone: number;
  /** Seconds since the last phrase downbeat (the wave's start); large when there was none. */
  phraseAge: number;
  /** Seconds in one bar, from the on-air tempo. */
  barSec: number;
  /** The wave starts on deck A's side (left) unless the crossfader has moved past the middle. */
  waveFromLeft: boolean;
}

export interface DancerPose {
  x: number;
  y: number; // vertical offset from the floor line; negative = up
  scale: number;
  lean: number; // degrees
  headBob: number;
  hipShift: number;
  armL: number; // shoulder angle, 0 = hanging, 180 = straight up (degrees)
  armR: number;
  elbowL: number;
  elbowR: number;
  legL: number; // hip angle, positive = forward
  legR: number;
  kneeL: number;
  kneeR: number;
  jump: number;
  opacity: number;
  /** 0..1 — this dancer holds a lit phone up (breaks only). */
  phone: number;
  /** 0..1 — this dancer's part of the phrase wave right now. */
  wave: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Body proportions in local units (origin between the feet, y up is negative like SVG). */
export const BODY = Object.freeze({
  hipY: -62,
  neckY: -112,
  headY: -132,
  headR: 15,
  shoulderX: 11,
  hipX: 8,
  upperArm: 32,
  foreArm: 30,
  thigh: 34,
  shin: 32,
});

const PERSONALITIES: Personality[] = ["bounce", "sway", "jump", "raise"];

/** Bars of delay across the whole floor: the far side hops 0.4 bar after the near side. */
export const WAVE_BARS_PER_SLOT = 0.4;
/** How long one dancer's hop in the wave lasts. */
const WAVE_HOP_SEC = 0.35;

/** Phones go up through a break and nowhere else; the caller eases the level over one bar. */
export function phoneTarget(section: string): number {
  return section === "break" ? 1 : 0;
}

/** Two dancers in three carry a phone; the lead never does (its hands hold the ribbons). */
export function hasPhone(seed: DancerSeed): boolean {
  return seed.personality !== "lead" && seed.id % 3 !== 0;
}

/** Seconds this dancer waits before its part of the phrase wave. */
export function waveDelaySec(seed: DancerSeed, input: CrowdInput): number {
  const from = input.waveFromLeft ? seed.slot : 1 - seed.slot;
  return from * WAVE_BARS_PER_SLOT * Math.max(0, input.barSec);
}

/** This dancer's share of the phrase wave, 0..1. Reduced motion has no wave at all. */
export function waveHop(seed: DancerSeed, input: CrowdInput): number {
  if (input.reduced || seed.personality === "lead") return 0;
  const age = input.phraseAge - waveDelaySec(seed, input);
  if (age < 0 || age > WAVE_HOP_SEC) return 0;
  return Math.sin((age / WAVE_HOP_SEC) * Math.PI);
}

function seeded(seed: number): () => number {
  let state = (seed * 9301 + 49297) % 233280;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

export function makeCrowd(count: number, seed = 7): DancerSeed[] {
  const random = seeded(seed);
  const dancers: DancerSeed[] = [];
  const n = Math.max(0, Math.min(40, Math.round(count)));
  for (let i = 0; i < n; i += 1) {
    const lead = i === 0;
    const slot = lead ? 0.5 : (i - 0.5 + random() * 0.6 - 0.3) / Math.max(1, n - 1);
    dancers.push({
      id: i,
      personality: lead
        ? "lead"
        : (PERSONALITIES[Math.floor(random() * PERSONALITIES.length)] as Personality),
      slot: Math.min(0.98, Math.max(0.02, slot)),
      phase: random(),
      size: lead ? 1.6 : 0.75 + random() * 0.5,
      swing: random(),
      depth: lead ? 0 : random(),
    });
  }
  return dancers;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp(t, 0, 1);

/** Where the arms want to be for a section (degrees from hanging). */
export function armTarget(section: string, barsToNext: number, beatPhase: number, kick: number): number {
  switch (section) {
    case "build": {
      const ramp = barsToNext >= 0 ? clamp(1 - barsToNext / 16, 0, 1) : 0.5;
      return lerp(40, 165, ramp);
    }
    case "drop":
      return 155 + 20 * kick;
    case "break":
      return 25 + 15 * Math.sin(beatPhase * Math.PI);
    case "body":
      return 70 + 40 * (1 - beatPhase);
    default:
      return 20 + 10 * Math.sin(beatPhase * Math.PI);
  }
}

export function dancerPose(seed: DancerSeed, input: CrowdInput): DancerPose {
  // Anticipation stills the floor: the bodies stop moving while the arms stay up.
  const still = 1 - 0.6 * input.anticipation;
  const amp = (input.reduced ? 0.35 : 1) * (0.45 + 0.8 * input.intensity) * still;
  const beat = clamp((input.beatPhase + seed.phase * 0.15) % 1, 0, 1);
  const settle = (1 - beat) ** 2; // hits on the beat, settles until the next
  const bar = (input.barPhase + seed.phase) % 1;
  const isLead = seed.personality === "lead";
  const jumper = seed.personality === "jump";
  const raiser = seed.personality === "raise";
  const swayer = seed.personality === "sway";

  const bounce = settle * (jumper ? 22 : 14) * amp * (0.6 + 0.4 * input.motion);
  const jump = input.reduced ? 0 : input.burst * (jumper ? 1.4 : isLead ? 1.1 : 0.7);
  // Snares make the jumpers hop; the phrase wave makes everyone hop in turn.
  const snareHop = input.reduced || !jumper ? 0 : input.snare * 26 * amp;
  const wave = waveHop(seed, input);
  const float = (1 - input.floor) * (36 + 10 * Math.sin(input.t * 1.3 + seed.phase * 6.28));
  const freezeJitter = input.freeze > 0.5 ? Math.sin(input.t * 50 + seed.id) * 1.2 : 0;
  const y = -(bounce + snareHop + wave * 38 + jump * 64 + float) + freezeJitter;

  const leanAmp = (swayer ? 12 : 6) * amp * (0.5 + seed.swing);
  const lean =
    Math.sin(bar * Math.PI * 2) * leanAmp +
    (1 - input.floor) * Math.sin(input.t * 0.7 + seed.id) * 10 +
    (input.balance - 0.5) * 10;

  const hipSide = (input.snareCount + seed.id) % 2 === 0 ? 1 : -1;
  const hipShift = hipSide * (3 + 10 * input.snare) * amp;
  const headBob = -(input.kick * 7 + settle * 3) * amp;

  // Phones: one hand comes up to about shoulder-plus height and stays there through the break.
  const phone = hasPhone(seed) ? clamp(input.phone, 0, 1) : 0;
  const arms = armTarget(input.section, input.barsToNext, beat, input.kick);
  const raiseBoost = raiser ? 25 : 0;
  const armBase = clamp(arms + raiseBoost + jump * 40 + input.anticipation * 55 + wave * 30, 0, 178);
  const sway = Math.sin(input.t * (2 + 2 * input.motion) + seed.phase * 6.28) * 12 * amp;
  // Hats make the raisers flick their hands; everyone else keeps their arms where they are.
  const hatFlick = (raiser ? 34 : 10) * input.hat * amp;
  const armL = clamp(armBase + sway + (seed.id % 2 ? hatFlick : 0), 0, 178);
  const armR = clamp(armBase - sway + (seed.id % 2 ? 0 : hatFlick), 0, 178);
  const phoneArm = phone * 110;
  const elbowL = 20 + 35 * (1 - input.kick) * (armL < 90 ? 1 : 0.5) + hatFlick * 0.5 + phone * 55;
  const elbowR = 20 + 35 * (1 - input.kick) * (armR < 90 ? 1 : 0.5);

  const stepPhase = Math.sin(bar * Math.PI * 4 + seed.phase * 6.28);
  const legSwing = (swayer ? 6 : 12) * amp * stepPhase;
  const dangle = (1 - input.floor) * 12;
  const legL = legSwing + dangle * Math.sin(input.t * 1.1 + seed.id);
  const legR = -legSwing + dangle * Math.cos(input.t * 0.9 + seed.id);
  const kneeBend = 8 + input.kick * 26 * amp + jump * 45 + (1 - input.floor) * 20;
  const kneeL = kneeBend * (0.7 + 0.3 * (1 - stepPhase));
  const kneeR = kneeBend * (0.7 + 0.3 * (1 + stepPhase));

  const scale = seed.size * (1 - 0.35 * seed.depth) * (1 + 0.04 * input.kick * amp);
  const opacity = (1 - 0.5 * seed.depth) * (0.75 + 0.25 * input.intensity);
  return {
    x: 0,
    y,
    scale,
    lean,
    headBob,
    hipShift,
    armL: clamp(armL + phoneArm, 0, 178),
    armR,
    elbowL,
    elbowR,
    legL,
    legR,
    kneeL,
    kneeR,
    jump,
    opacity,
    phone,
    wave,
  };
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Forward kinematics for one arm in local body units (hand position for ribbons). */
export function handPoint(pose: DancerPose, side: -1 | 1): Point {
  const shoulderAngle = side === 1 ? pose.armR : pose.armL;
  const elbowAngle = side === 1 ? pose.elbowR : pose.elbowL;
  const sx = side * BODY.shoulderX + pose.hipShift * 0.3;
  const sy = BODY.neckY + 6;
  // 0° hangs down; the arm rotates outward from the body.
  const a1 = rad(shoulderAngle) * side;
  const ex = sx + Math.sin(a1) * BODY.upperArm;
  const ey = sy + Math.cos(a1) * BODY.upperArm;
  const a2 = a1 + rad(elbowAngle) * side;
  return { x: ex + Math.sin(a2) * BODY.foreArm, y: ey + Math.cos(a2) * BODY.foreArm };
}

/** Sparks that burst from the crowd on a drop: positions for a given burst envelope (1 → 0). */
export function sparkPoints(
  burst: number,
  seed: number,
  count = 20,
): { x: number; y: number; alpha: number }[] {
  const points: { x: number; y: number; alpha: number }[] = [];
  if (burst <= 0.01) return points;
  const random = seeded(seed * 13 + 5);
  const spread = (1 - burst) * 380;
  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI - Math.PI;
    const radius = spread * (0.4 + random() * 0.6);
    points.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.6 - 40,
      alpha: burst * (0.5 + random() * 0.5),
    });
  }
  return points;
}
