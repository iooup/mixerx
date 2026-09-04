/**
 * Wave Lines (`waves`): a simple, readable look — stacked glowing lines that carry the spectrum
 * as waves rolling toward the viewer. kick = a ripple from the crossfader point, snare = alternate
 * lines flash, build = the lines gather, drop = every line spikes, break = slow calm swell.
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
fn spectrum_at(x: f32) -> f32 {
  let fx = clamp(x, 0.0, 0.999) * 63.0;
  let i = i32(floor(fx));
  let t = fract(fx);
  return mix(band(i), band(i + 1), t);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let aspect = vp.z;
  // The camera operator's shot becomes zoom and parallax for a flat scene.
  let zoom = shot_zoom();
  let uv = vec2f((in.uv.x - 0.5) / zoom + 0.5, (in.uv.y - 0.5) / zoom + 0.5 + shot_parallax());
  let motion = u.colB.w;
  let intensity = u.colA.w;
  let gather = u.accent.w;                 // framing: lines gather toward the centre in builds
  let attractor = u.gest.y;                // crossfader → ripple origin
  let kickAge = u.scene0.x;
  let calm = u.scene0.y;                   // break: calm swell
  let antic = anticipation();              // the lines converge before a drop
  var col = u.bg.rgb * 0.8;
  let lines = 14;
  for (var i = 0; i < lines; i = i + 1) {
    let d = f32(i) / f32(lines - 1);       // 0 far … 1 near
    let baseY = mix(0.22, 0.86, pow(d, 1.35)) * (1.0 - 0.16 * antic) + 0.08 * antic;
    let spread = mix(1.0, 0.45, gather * 0.6) * (1.0 - 0.35 * antic);
    let x = (uv.x - 0.5) / spread + 0.5;
    let spec = spectrum_at(x) * (0.35 + 0.65 * d);
    let swell = sin(x * 6.28 * (1.5 + d) - u.time.x * (0.6 + 1.6 * motion) + f32(i) * 0.7) * 0.5 + 0.5;
    let ripple = exp(-pow((abs(x - attractor) * 4.0 - kickAge * 3.0), 2.0) * 2.5) * exp(-kickAge * 1.2) * u.scene0.z;
    let spike = u.fx.y * (0.6 + 0.4 * hash11(f32(i) + u.counts.w));
    let amp = (0.02 + 0.1 * intensity) * (0.3 + 0.7 * d) * (1.0 - 0.6 * calm);
    let h = spec * amp * 1.6 + swell * amp * (0.35 + 0.65 * calm) + ripple * 0.08 + spike * 0.12 * (1.0 - calm);
    let lineY = baseY - h;
    let dist = abs(uv.y - lineY) * vp.y;
    let width = 1.2 + 1.5 * d + 2.0 * u.audio.x * d;
    let core = exp(-dist * dist / (width * width));
    let halo = exp(-dist / (8.0 + 12.0 * d)) * 0.12;
    let flash = select(0.0, u.audio.y * 0.8, (i + i32(u.hits.x)) % 2 == 0);
    let tint = side_colour(smoothstep(0.2, 0.8, x));
    let strength = (0.35 + 0.8 * intensity) * (0.35 + 0.65 * d) * (1.0 + flash) * (1.0 + 0.6 * spec);
    col = col + tint * (core + halo) * strength;
  }
  // A soft horizon glow behind the far lines.
  let horizon = exp(-pow((uv.y - 0.2) * 6.0, 2.0)) * 0.12 * (0.4 + intensity);
  col = col + u.accent.rgb * horizon;
  return vec4f(col, 1.0);
}
`;

export class WavesScene implements Scene {
  readonly renderer = "waves" as const;
  private ctx!: SceneContext;
  ready: Promise<void> = Promise.resolve();
  private pipeline: GPURenderPipeline | null = null;
  private kickAge = 10;
  private kickStrength = 0;
  private calm = 0;

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.ready = fullscreenPipelineAsync(ctx, "waves", FRAGMENT).then((pipeline) => {
      this.pipeline = pipeline;
    });
  }

  update(_encoder: GPUCommandEncoder, intent: Intent, dt: number, events: EventFlags): void {
    if (events.kick) {
      this.kickAge = 0;
      this.kickStrength = 0.5 + 0.5 * intent.audio.kick;
    }
    this.kickAge += dt * (0.8 + intent.motion) * (1 - 0.9 * intent.freeze);
    const calmTarget = intent.section === "break" || intent.section === "intro" ? 1 : 0;
    this.calm += (calmTarget - this.calm) * (1 - Math.exp(-dt / 0.8));
    writePrivate(this.ctx, 0, [this.kickAge, this.calm, this.kickStrength, 0]);
  }

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.pipeline) return;
    drawFullscreen(encoder, this.pipeline, target, this.ctx.baseBindGroup);
  }

  dispose(): void {}
}
