/**
 * Light Rig (`build-rise`): six fixed blue ceiling lights with uneven spacing, restrained
 * halos and slow staggered fades. Beats gently lift the light; breaks leave one slow column.
 */
import type { Intent } from "../../director";
import {
  type DrawTarget,
  drawFullscreen,
  type EventFlags,
  fullscreenPipelineAsync,
  type Scene,
  type SceneContext,
  writePrivate,
} from "../scene";

const FRAGMENT = /* wgsl */ `
fn vertical_beam(p: vec2f, x: f32, width: f32) -> f32 {
  let down = max(0.0, p.y - 0.035);
  let spread = width * (1.0 + down * 0.8);
  let distance = abs(p.x - x);
  let core = exp(-pow(distance / spread, 2.0) * 2.8);
  let halo = exp(-pow(distance / (spread * 1.6), 2.0)) * 0.05;
  let ends = smoothstep(0.03, 0.045, p.y) * (1.0 - smoothstep(0.89, 1.02, p.y));
  return (core + halo) * ends / (1.0 + down * 1.3);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let aspect = vp.z;
  // Screen-locked anchors: camera cuts, anticipation and breaks never move a light sideways.
  let p = vec2f((in.uv.x - 0.5) * aspect, in.uv.y);
  let haze = 0.7 + 0.3 * fbm2(p * 2.5 + vec2f(0.0, -u.scene0.x * 0.06));
  let blink = u.scene0.x;
  let breakMode = u.scene0.z;
  let pulse = 0.85 + 0.1 * u.audio.x + 0.03 * u.audio.z;
  let antic = anticipation();
  // One blue hue for shafts, fixtures and pools, independent of the musical palette.
  let tint = vec3f(0.025, 0.18, 0.6);
  // Close pairs, medium gaps and open spaces; every head stays directly above its own pool.
  let positions = array<f32, 6>(0.08, 0.2, 0.43, 0.54, 0.76, 0.91);
  var col = vec3f(0.0);
  for (var i = 0; i < 6; i = i + 1) {
    let fi = f32(i);
    let x = (positions[i] - 0.5) * aspect;
    let depth = f32((i * 7) % 3) / 2.0;
    let width = mix(0.007, 0.012, depth);
    // Scrambled phases and three rates prevent a left-to-right chase. Each lamp fades fully off.
    let phase = fract(blink * (0.72 + 0.14 * f32(i % 3)) + fract(fi * 0.618034));
    let envelope = smoothstep(0.0, 0.22, phase) * (1.0 - smoothstep(0.38, 0.68, phase));
    let on = envelope * mix(1.0, select(0.0, 1.0, i == 3), breakMode);
    let strength = on * (0.28 + 0.34 * u.colA.w) * pulse * (1.0 - 0.25 * antic);
    let accent = 1.0 + u.fx.y * 0.12;
    col = col + tint * vertical_beam(p, x, width) * strength * accent;
    let lamp = vec2f((p.x - x) / (width * 1.1), (p.y - 0.035) / 0.005);
    col = col + tint * exp(-dot(lamp, lamp) * 2.0) * strength * 0.6;
    let pool = vec2f((p.x - x) / (width * 2.5), (p.y - 0.955) / 0.011);
    col = col + tint * exp(-dot(pool, pool)) * strength * 0.1 * u.fx.w;
  }
  col = col * haze;
  col = col + vec3f(0.0015, 0.003, 0.006);
  return vec4f(col, 1.0);
}
`;

export class LightRigScene implements Scene {
  readonly renderer = "rig" as const;
  private ctx!: SceneContext;
  ready: Promise<void> = Promise.resolve();
  private pipeline: GPURenderPipeline | null = null;
  private blink = 0;
  private breakMode = 0;

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.ready = fullscreenPipelineAsync(ctx, "light-rig", FRAGMENT).then((pipeline) => {
      this.pipeline = pipeline;
    });
  }

  update(_encoder: GPUCommandEncoder, intent: Intent, dt: number, _events: EventFlags): void {
    const ramp =
      intent.section === "build" && intent.barsToNext >= 0
        ? Math.min(1, Math.max(0, 1 - intent.barsToNext / 16))
        : 0;
    const breakTarget = intent.section === "break" ? 1 : 0;
    this.breakMode += (breakTarget - this.breakMode) * (1 - Math.exp(-dt / 0.5));
    // 40% of the original fade rate: longer holds and off periods, with no onset-triggered jumps.
    const rate =
      (0.18 + 0.1 * intent.motion + 0.12 * ramp) *
      (1 - 0.6 * this.breakMode) *
      (intent.reducedMotion ? 0.35 : 1) *
      (1 - intent.freeze);
    this.blink += dt * rate;
    writePrivate(this.ctx, 0, [this.blink, rate, this.breakMode, 0]);
  }

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.pipeline) return;
    drawFullscreen(encoder, this.pipeline, target, this.ctx.baseBindGroup);
  }

  dispose(): void {}
}
