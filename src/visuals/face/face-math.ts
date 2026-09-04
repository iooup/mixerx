/**
 * The Face (`face` scene): an expressive abstract face drawn in SVG over a quiet backdrop. Pure
 * pose math so every window draws the same face: it nods on the beat, blinks on snares, follows
 * the crossfader with its eyes, opens its mouth with the bass, raises its brows through a build,
 * goes wide-eyed on the drop, floats when the LOW is killed and freezes in loops.
 */
export interface FaceInput {
  t: number;
  beatPhase: number;
  barPhase: number;
  kick: number;
  snare: number;
  hat: number;
  bass: number;
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
}

export interface FacePose {
  x: number;
  y: number;
  tilt: number; // degrees
  scale: number;
  eyeOpen: number; // 0 closed … 1 open … 1.3 wide
  pupilX: number;
  pupilY: number;
  browRaise: number; // 0..1
  browTilt: number; // degrees, positive = angry
  mouthOpen: number; // 0..1
  mouthSmile: number; // −1 frown … 1 smile
  mouthWidth: number; // multiplier
  cheekGlow: number; // 0..1
}

export interface FaceState {
  lastSnareCount: number;
  blinkUntil: number;
  nextRandomBlink: number;
}

export const initialFaceState = (): FaceState => ({
  lastSnareCount: 0,
  blinkUntil: -1,
  nextRandomBlink: 2.5,
});

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp(t, 0, 1);

const BLINK_SEC = 0.14;

export function facePose(input: FaceInput, state: FaceState): FacePose {
  const amp = input.reduced ? 0.35 : 1;
  // Blinks: every snare, plus a random one every few seconds so the face never stares.
  if (input.snareCount !== state.lastSnareCount) {
    state.lastSnareCount = input.snareCount;
    state.blinkUntil = input.t + BLINK_SEC;
  }
  if (input.t >= state.nextRandomBlink) {
    state.blinkUntil = input.t + BLINK_SEC;
    state.nextRandomBlink = input.t + 2 + ((input.t * 7.31) % 3);
  }
  const blinking =
    input.t < state.blinkUntil ? 1 - Math.abs((state.blinkUntil - input.t) / BLINK_SEC - 0.5) * 2 : 0;
  const ramp =
    input.section === "build" && input.barsToNext >= 0 ? clamp(1 - input.barsToNext / 16, 0, 1) : 0;
  const wide = input.burst * 0.3 + (input.section === "drop" ? 0.12 : 0);
  const eyeOpen = clamp((1 + wide) * (1 - blinking) - (input.section === "break" ? 0.25 : 0), 0.04, 1.35);

  const settle = (1 - input.beatPhase) ** 2;
  const nod = settle * 14 * amp * (0.5 + 0.5 * input.intensity);
  const float = (1 - input.floor) * (40 + 12 * Math.sin(input.t * 1.1));
  const shake = input.reduced ? 0 : input.burst * Math.sin(input.t * 60) * 6;
  const y = nod - float + shake;
  const x = (input.balance - 0.5) * 60 + shake * 0.5;
  const tilt =
    Math.sin(input.barPhase * Math.PI * 2) * 4 * amp * (0.5 + input.motion) + (input.balance - 0.5) * 8;
  const scale = 1 + 0.05 * input.kick * amp + 0.08 * input.burst;

  const pupilX = (input.balance - 0.5) * 44 + Math.sin(input.t * 0.7) * 4;
  const pupilY = -6 * settle + input.hat * 5 * amp;

  const browRaise = clamp(0.2 + 0.8 * ramp + 0.5 * input.burst + 0.3 * input.kick * amp, 0, 1.2);
  const browTilt = input.section === "drop" ? 10 + 6 * input.kick : input.section === "break" ? -4 : 0;

  const mouthOpen = clamp(0.08 + 0.9 * input.bass * amp + 0.3 * input.kick * amp + 0.5 * input.burst, 0, 1);
  const mouthSmile =
    input.section === "body"
      ? 0.7
      : input.section === "drop"
        ? 0.3
        : input.section === "break"
          ? -0.2
          : input.section === "build"
            ? lerp(0, 0.8, ramp)
            : 0.2;
  const mouthWidth = 0.9 + 0.3 * input.intensity + 0.15 * input.snare * amp;
  const cheekGlow = clamp(0.2 + 0.8 * input.kick * amp + 0.4 * input.burst, 0, 1);

  return {
    x,
    y,
    tilt,
    scale,
    eyeOpen,
    pupilX,
    pupilY,
    browRaise,
    browTilt,
    mouthOpen,
    mouthSmile,
    mouthWidth,
    cheekGlow,
  };
}

/** SVG path of the mouth for a pose (centred at the origin, in face units). */
export function mouthPath(pose: FacePose): string {
  const w = 120 * pose.mouthWidth;
  const smile = pose.mouthSmile * 45;
  const open = pose.mouthOpen * 110;
  return `M${-w} 0 Q0 ${(-smile + open * 0.15).toFixed(1)} ${w} 0 Q0 ${(open + smile).toFixed(1)} ${-w} 0 Z`;
}
