import type { SceneRenderer } from "../../../../agent/scenes";
import type { Intent } from "../../../director";
import {
  type DrawTarget,
  drawFullscreen,
  fullscreenPipelineAsync,
  type Scene,
  type SceneContext,
} from "../../scene";
import lotus from "./assets/astral-lotus.webp";
import crystal from "./assets/crystal-voyage.webp";
import phoenix from "./assets/phoenix.webp";
import phoenixSky from "./assets/phoenix-sky.webp";
import garden from "./assets/spectral-garden.webp";
import gate from "./assets/spectral-gate.webp";
import type { CinematicMotion } from "./motion";
import { CINEMATIC_SHADER } from "./shaders";

type CinematicRenderer = Extract<SceneRenderer, `cinematic-${string}`>;
const ART: Record<CinematicRenderer, [string, string | null, string]> = {
  "cinematic-phoenix": [phoenixSky, phoenix, "phoenix"],
  "cinematic-gate": [garden, gate, "gate"],
  "cinematic-lotus": [lotus, null, "lotus"],
  "cinematic-crystal": [crystal, null, "crystal"],
};

/** Image-backed WebGPU worlds, without a second audio engine, DOM animation or remote assets. */
export class CinematicScene implements Scene {
  ready: Promise<void> = Promise.resolve();
  private ctx!: SceneContext;
  private pipeline: GPURenderPipeline | null = null;
  private params!: GPUBuffer;
  private group: GPUBindGroup | null = null;
  private textures: GPUTexture[] = [];
  private disposed = false;
  private readonly values = new Float32Array(4);

  constructor(
    readonly renderer: CinematicRenderer,
    private readonly motion: CinematicMotion,
  ) {}

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.params = ctx.device.createBuffer({
      label: this.renderer,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = ctx.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const [bgUrl, subjectUrl, entry] = ART[this.renderer];
    const pipeline = fullscreenPipelineAsync(
      ctx,
      this.renderer,
      `${CINEMATIC_SHADER}\n@fragment fn fs(in: VSOut) -> @location(0) vec4f { return vec4f(${entry}(in.uv), 1.0); }`,
      { extraLayouts: [layout] },
    );
    this.ready = Promise.all([
      pipeline,
      this.loadTexture(bgUrl),
      subjectUrl ? this.loadTexture(subjectUrl) : null,
    ]).then(([compiled, bg, foreground]) => {
      if (this.disposed || !bg) return;
      this.pipeline = compiled;
      this.group = ctx.device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: bg.createView() },
          { binding: 2, resource: (foreground ?? bg).createView() },
        ],
      });
    });
  }

  private async loadTexture(url: string): Promise<GPUTexture | null> {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (this.disposed) return null;
    const levels = Math.min(6, Math.floor(Math.log2(Math.max(img.width, img.height))) + 1);
    const texture = this.ctx.device.createTexture({
      label: `${this.renderer} art`,
      size: [img.width, img.height],
      format: "rgba8unorm-srgb",
      mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.textures.push(texture);
    // Real image mips prevent glittering fine detail in small studio previews and thumbnails.
    for (let level = 0; level < levels; level++) {
      const width = Math.max(1, img.width >> level);
      const height = Math.max(1, img.height >> level);
      const bitmap = await createImageBitmap(img, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "high",
        premultiplyAlpha: "none",
      });
      if (this.disposed) {
        bitmap.close();
        return null;
      }
      this.ctx.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture, mipLevel: level, premultipliedAlpha: false },
        [width, height],
      );
      bitmap.close();
    }
    return texture;
  }

  update(_encoder: GPUCommandEncoder, _intent: Intent, _dt: number): void {
    this.values.set([this.motion.time, this.motion.energy, this.motion.bass, this.motion.treble]);
    this.ctx.device.queue.writeBuffer(this.params, 0, this.values);
  }

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (this.pipeline && this.group)
      drawFullscreen(encoder, this.pipeline, target, this.ctx.baseBindGroup, [this.group]);
  }

  dispose(): void {
    this.disposed = true;
    this.params.destroy();
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
  }
}
