/**
 * Shared camera operator: wide through an intro, pushing in through a build, changing
 * angles on drops, and drifting low through breaks.
 *
 * A scene describes its bounds with SceneFrame; the Director's chosen shot becomes an eye,
 * target, and field of view. The camera stays above the scene floor. Reduced motion removes
 * handheld movement and dissolves between shots instead of cutting.
 */
import type { Intent } from "../director";
import { lookAt, perspective } from "./math";

export type CameraShot = "orbit" | "wide" | "push" | "low" | "top" | "handheld";

/** Order is the wire order: `Intent.cameraShot` and the `show.y` uniform carry the index. */
export const CAMERA_SHOTS: readonly CameraShot[] = ["orbit", "wide", "push", "low", "top", "handheld"];

export const shotIndex = (shot: CameraShot): number => Math.max(0, CAMERA_SHOTS.indexOf(shot));
export const shotAt = (index: number): CameraShot =>
  CAMERA_SHOTS[Math.min(CAMERA_SHOTS.length - 1, Math.max(0, Math.round(index)))] ?? "orbit";

/** What one scene wants framed. `distance` and `height` describe its own `orbit` shot exactly. */
export interface SceneFrame {
  distance: number;
  height: number;
  centre: [number, number, number];
  /** The camera never goes below this — a shot from under the floor is a mistake, not a look. */
  floorY: number;
  /** Never closer than this: a subject that grows with the bass must not swallow the camera. */
  minDistance?: number;
  fovDeg: number;
}

export interface ShotView {
  eye: [number, number, number];
  target: [number, number, number];
  fovDeg: number;
}

interface ShotShape {
  distance: number;
  height: number;
  fov: number;
  /** How fast this shot circles, relative to the base orbit. */
  spin: number;
  /** Vertical offset of the point it looks at, in units of the scene radius. */
  tilt: number;
}

const SHAPES: Record<CameraShot, ShotShape> = {
  orbit: { distance: 1, height: 1, fov: 0, spin: 1, tilt: 0 },
  wide: { distance: 1.38, height: 1.15, fov: 6, spin: 0.5, tilt: 0.02 },
  push: { distance: 0.7, height: 0.82, fov: -5, spin: 0.8, tilt: 0 },
  low: { distance: 0.96, height: 0.14, fov: 3, spin: 0.35, tilt: 0.12 },
  top: { distance: 0.82, height: 2.5, fov: -2, spin: 1.3, tilt: -0.06 },
  handheld: { distance: 0.88, height: 0.95, fov: 1, spin: 0.9, tilt: 0 },
};

/** Seconds a shot change takes when the camera dissolves instead of cutting (reduced motion). */
const DISSOLVE_SEC = 1.2;
/** Kick shake: at most 0.6 % of the frame height, gone within 120 ms. */
const SHAKE_FRACTION = 0.006;
const SHAKE_DECAY_SEC = 0.12;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Eye, target and field of view for one shot. Pure: the same inputs always give the same frame. */
export function shotView(
  shot: CameraShot,
  angle: number,
  frame: SceneFrame,
  intent: { framing: number; anticipation: number },
): ShotView {
  const shape = SHAPES[shot];
  // The Director's framing still pulls the camera in, and anticipation pushes it a further 10 %.
  const framing = 1 - 0.22 * intent.framing - 0.1 * intent.anticipation;
  const distance = Math.max(frame.minDistance ?? 0, frame.distance * shape.distance * framing);
  const height = frame.height * shape.height * (1 - 0.15 * intent.framing);
  const [cx, cy, cz] = frame.centre;
  const eyeY = Math.max(frame.floorY, cy + height);
  return {
    eye: [cx + Math.sin(angle) * distance, eyeY, cz + Math.cos(angle) * distance],
    target: [cx, cy + shape.tilt * frame.distance, cz],
    fovDeg: frame.fovDeg + shape.fov,
  };
}

/** The spin rate of a shot, for the operator's angle integration. */
export const shotSpin = (shot: CameraShot): number => SHAPES[shot].spin;

/** The shot's raw multipliers, for scenes whose geometry is not an orbit (the terrain). */
export const shotShape = (shot: CameraShot): Readonly<ShotShape> => SHAPES[shot];

/**
 * Per-scene camera state: the current and previous shot, the blend between them, the orbit angle
 * and the kick shake. One of these lives in each 3-D scene; `view()` may be called several times a
 * frame (main output, thumbnail, stats) and answers each aspect ratio from its own buffer.
 */
export class CameraOperator {
  private current: CameraShot = "orbit";
  private previous: CameraShot = "orbit";
  private blend = 1;
  private angle = 0.6;
  private shake = 0;
  private shakeSeed = 0;
  private lastSeed = -1;
  private frameIndex = 0;
  private readonly buffers = new Map<number, { buffer: GPUBuffer; writtenAt: number }>();

  /** Advances the rig. Call once per frame from the scene's own `update`. */
  step(intent: Intent, dt: number, events: { kick: number }): void {
    const wanted = shotAt(intent.cameraShot);
    if (wanted !== this.current) {
      this.previous = this.blend >= 1 ? this.current : this.previous;
      this.current = wanted;
      // Reduced motion never cuts: the camera dissolves from one shot to the next.
      this.blend = intent.reducedMotion ? 0 : 1;
    }
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / DISSOLVE_SEC);
    this.angle += dt * (0.04 + 0.1 * intent.motion) * shotSpin(this.current) * (1 - 0.9 * intent.freeze);
    // A cue jumps the orbit, as it always has.
    if (intent.seed !== this.lastSeed) {
      if (this.lastSeed >= 0 && intent.cut) this.angle += 1.9;
      this.lastSeed = intent.seed;
    }
    if (events.kick && !intent.reducedMotion) {
      this.shake = 1;
      this.shakeSeed += 1;
    }
    this.shake = Math.max(0, this.shake - dt / SHAKE_DECAY_SEC);
    this.intentShape = { framing: intent.framing, anticipation: intent.anticipation };
    this.frameIndex += 1;
  }

  /** Eye, target and lens of this frame — for scenes that build their own rays (the raymarcher). */
  currentView(frame: SceneFrame): ShotView {
    const now = shotView(this.current, this.angle, frame, this.intentShape);
    const shot =
      this.blend >= 1
        ? now
        : blendViews(shotView(this.previous, this.angle, frame, this.intentShape), now, this.blend);
    const reach =
      2 * Math.tan((shot.fovDeg * Math.PI) / 180 / 2) * frame.distance * SHAKE_FRACTION * this.shake;
    const wobble = (n: number) => Math.sin(this.shakeSeed * 12.9898 + n) * reach;
    return {
      eye: shot.eye,
      target: [
        shot.target[0] + wobble(1),
        Math.max(frame.floorY, shot.target[1] + wobble(2)),
        shot.target[2] + wobble(3),
      ],
      fovDeg: shot.fovDeg,
    };
  }

  /** The view of the current frame, blending the outgoing shot when the camera is dissolving. */
  matrices(frame: SceneFrame, aspect: number): { view: Float32Array; proj: Float32Array } {
    const shot = this.currentView(frame);
    const fov = (shot.fovDeg * Math.PI) / 180;
    return {
      view: lookAt(shot.eye, shot.target),
      proj: perspective(fov, aspect, frame.distance * 0.02, frame.distance * 12),
    };
  }

  private intentShape: { framing: number; anticipation: number } = { framing: 0.3, anticipation: 0 };

  /**
   * A uniform buffer holding `view` then `proj` for this aspect ratio, written at most once per
   * frame. Several targets (output, thumbnail, stats) each get their own.
   */
  buffer(
    device: GPUDevice,
    frame: SceneFrame,
    aspect: number,
    layout: "view-proj" | "view-then-proj" = "view-then-proj",
  ): GPUBuffer {
    const key = Math.round(aspect * 200);
    let entry = this.buffers.get(key);
    if (!entry) {
      if (this.buffers.size > 8) {
        for (const [k, value] of this.buffers) {
          value.buffer.destroy();
          this.buffers.delete(k);
        }
      }
      entry = {
        buffer: device.createBuffer({
          size: layout === "view-proj" ? 64 : 128,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        writtenAt: -1,
      };
      this.buffers.set(key, entry);
    }
    if (entry.writtenAt !== this.frameIndex) {
      entry.writtenAt = this.frameIndex;
      const { view, proj } = this.matrices(frame, aspect);
      if (layout === "view-proj") {
        device.queue.writeBuffer(entry.buffer, 0, multiplyProjView(proj, view));
      } else {
        const data = new Float32Array(32);
        data.set(view, 0);
        data.set(proj, 16);
        device.queue.writeBuffer(entry.buffer, 0, data);
      }
    }
    return entry.buffer;
  }

  dispose(): void {
    for (const entry of this.buffers.values()) entry.buffer.destroy();
    this.buffers.clear();
  }

  /**
   * The blended shot multipliers, for a scene whose geometry is not an orbit: the terrain keeps
   * looking down its own valley and answers the shot with its eye height, lens and drift instead.
   */
  blendedShape(): ShotShape {
    const from = SHAPES[this.previous];
    const to = SHAPES[this.current];
    const t = this.blend;
    return {
      distance: lerp(from.distance, to.distance, t),
      height: lerp(from.height, to.height, t),
      fov: lerp(from.fov, to.fov, t),
      spin: lerp(from.spin, to.spin, t),
      tilt: lerp(from.tilt, to.tilt, t),
    };
  }

  /** Diagnostics and tests. */
  get shot(): CameraShot {
    return this.current;
  }
  get orbitAngle(): number {
    return this.angle;
  }
  get shakeAmount(): number {
    return this.shake;
  }
}

function blendViews(from: ShotView, to: ShotView, t: number): ShotView {
  return {
    eye: [lerp(from.eye[0], to.eye[0], t), lerp(from.eye[1], to.eye[1], t), lerp(from.eye[2], to.eye[2], t)],
    target: [
      lerp(from.target[0], to.target[0], t),
      lerp(from.target[1], to.target[1], t),
      lerp(from.target[2], to.target[2], t),
    ],
    fovDeg: lerp(from.fovDeg, to.fovDeg, t),
  };
}

/** Column-major proj × view (the scenes that want one matrix). */
function multiplyProjView(proj: Float32Array, view: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (proj[k * 4 + row] ?? 0) * (view[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * The Director's shot for a section (pure). Cuts only happen on a bar, which the Director enforces;
 * this only says which shot the music wants right now.
 */
export function shotForSection(
  section: string,
  anticipation: number,
  phraseIndex: number,
  reduced: boolean,
): CameraShot {
  if (anticipation > 0.45) return "push";
  switch (section) {
    case "intro":
      return phraseIndex % 2 === 0 ? "wide" : "orbit";
    case "build":
      return "push";
    case "drop": {
      // A new angle every two phrases; the handheld is out under reduced motion.
      const cycle: CameraShot[] = reduced ? ["orbit", "low", "top"] : ["orbit", "low", "handheld", "top"];
      return cycle[Math.floor(phraseIndex / 2) % cycle.length] ?? "orbit";
    }
    case "break":
      return "low";
    case "outro":
      return "wide";
    default:
      return "orbit";
  }
}
