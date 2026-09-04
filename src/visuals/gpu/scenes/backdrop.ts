/** Backdrop (`backdrop`): a quiet palette gradient with slow haze, the ground for DOM layers such as the Face. */
import type { Intent } from "../../director";
import {
  type DrawTarget,
  drawFullscreen,
  type EventFlags,
  fullscreenPipelineAsync,
  type Scene,
  type SceneContext,
} from "../scene";

const FRAGMENT = /* wgsl */ `
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let p = (in.uv - 0.5) * vec2f(vp.z, 1.0);
  let haze = fbm2(p * 1.6 + vec2f(u.time.x * 0.05 * u.colB.w, -u.time.x * 0.03));
  // Anticipation closes the pool of light around the face.
  let antic = anticipation();
  let radial = 1.0 - smoothstep(0.1 - 0.05 * antic, 0.9 - 0.35 * antic, length(p));
  let tint = mix(u.colA.rgb, u.colB.rgb, smoothstep(-0.6, 0.6, p.x));
  var col = u.bg.rgb * 1.5 + tint * (0.06 + 0.08 * u.colA.w) * radial * (0.6 + 0.8 * haze);
  col = col + tint * u.audio.x * 0.04 * radial;
  return vec4f(col, 1.0);
}
`;

export class BackdropScene implements Scene {
  readonly renderer = "backdrop" as const;
  ready: Promise<void> = Promise.resolve();
  private ctx!: SceneContext;
  private pipeline: GPURenderPipeline | null = null;

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.ready = fullscreenPipelineAsync(ctx, "backdrop", FRAGMENT).then((pipeline) => {
      this.pipeline = pipeline;
    });
  }

  update(_encoder: GPUCommandEncoder, _intent: Intent, _dt: number, _events: EventFlags): void {}

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.pipeline) return;
    drawFullscreen(encoder, this.pipeline, target, this.ctx.baseBindGroup);
  }

  dispose(): void {}
}
