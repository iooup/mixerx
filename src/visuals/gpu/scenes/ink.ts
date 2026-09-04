/**
 * Ink Feedback (`break-haze`): ping-pong texture feedback with beat-synced rotation and zoom and a
 * curl-noise advection pass. kick = ink injection, phrase = symmetry change, crossfader = flow
 * direction, drop = zoom burst. The simulation runs at a fixed size; the draw pass fits any target.
 */
import type { Intent } from "../../director";
import {
  type DrawTarget,
  drawFullscreen,
  type EventFlags,
  fullscreenPipelineAsync,
  HDR_FORMAT,
  type Scene,
  type SceneContext,
  writePrivate,
} from "../scene";

const SIM_SIZE = { low: [320, 180], medium: [640, 360], high: [960, 540] } as const;

const SIMULATE = /* wgsl */ `
@group(1) @binding(0) var prev: texture_2d<f32>;

fn fold(p0: vec2f, n: f32) -> vec2f {
  if (n < 1.5) { return p0; }
  let r = length(p0);
  var a = atan2(p0.y, p0.x);
  let sector = 6.2831853 / n;
  a = abs(fract(a / sector + 0.5) - 0.5) * sector;
  return vec2f(cos(a), sin(a)) * r;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let aspect = vp.z;
  let p = (in.uv - 0.5) * vec2f(aspect, 1.0);
  let symmetry = u.scene0.x;
  let rotation = u.scene1.x;
  // Anticipation tightens the zoom and dims the ink; the drop then throws it open.
  let antic = anticipation();
  let zoom = u.scene1.w * (1.0 + 0.06 * antic);
  let decay = u.scene1.z * (1.0 - 0.25 * antic);
  var q = fold(p, symmetry);
  q = rot2(rotation) * q / zoom;
  let flow = vec2f(u.scene1.y, 0.0);
  q = q + curl2(q * 1.8 + vec2f(u.time.x * 0.08, u.time.w)) * 0.0045 * u.colB.w * (1.0 - 0.9 * u.gest.z) + flow;
  let readUv = q / vec2f(aspect, 1.0) + 0.5;
  var c = textureSample(prev, smp, readUv).rgb * decay;
  // Ink injection on kicks (position and strength from the CPU), plus a faint ring from the hats.
  let inject = vec2f(u.scene0.y, u.scene0.z);
  let blob = exp(-dot(p - inject, p - inject) * 70.0) * u.scene0.w;
  c = c + side_colour(step(0.0, inject.x)) * blob;
  let ring = smoothstep(0.02, 0.0, abs(length(p) - 0.32 - 0.1 * u.beat.x)) * u.audio.z * 0.05;
  c = c + u.accent.rgb * ring;
  c = min(c, vec3f(2.5));
  return vec4f(c, 1.0);
}
`;

const DRAW = /* wgsl */ `
@group(1) @binding(0) var state: texture_2d<f32>;

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let zoom = shot_zoom();
  let uv = vec2f((in.uv.x - 0.5) / zoom + 0.5, (in.uv.y - 0.5) / zoom + 0.5 + shot_parallax());
  var c = textureSample(state, smp, uv).rgb;
  c = c * (0.08 + 1.0 * u.colA.w);
  c = c + u.bg.rgb * 0.8;
  return vec4f(c, 1.0);
}
`;

export class InkScene implements Scene {
  readonly renderer = "ink" as const;
  private ctx!: SceneContext;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private groups: GPUBindGroup[] = [];
  private current = 0;
  ready: Promise<void> = Promise.resolve();
  private simulate: GPURenderPipeline | null = null;
  private drawPipeline: GPURenderPipeline | null = null;
  private layout!: GPUBindGroupLayout;
  private simViewport = 0;
  private width = 960;
  private height = 540;
  private injectX = 0;
  private injectY = 0;
  private injectStrength = 0;
  private lastKickCount = 0;

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    const device = ctx.device;
    const [width, height] = SIM_SIZE[ctx.quality];
    this.width = width;
    this.height = height;
    this.layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }],
    });
    for (let i = 0; i < 2; i += 1) {
      const texture = device.createTexture({
        label: `ink state ${i}`,
        size: [width, height],
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.textures.push(texture);
      const view = texture.createView();
      this.views.push(view);
      this.groups.push(
        device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: view }] }),
      );
    }
    this.ready = Promise.all([
      fullscreenPipelineAsync(ctx, "ink simulate", SIMULATE, { extraLayouts: [this.layout] }),
      fullscreenPipelineAsync(ctx, "ink draw", DRAW, { extraLayouts: [this.layout] }),
    ]).then(([simulate, draw]) => {
      this.simulate = simulate;
      this.drawPipeline = draw;
    });
    this.simViewport =
      (ctx as SceneContext & { allocateViewport?(w: number, h: number): number }).allocateViewport?.(
        width,
        height,
      ) ?? 0;
  }

  update(encoder: GPUCommandEncoder, intent: Intent, dt: number, events: EventFlags): void {
    if (!this.simulate) return;
    const symmetries = [1, 2, 3, 4, 6];
    const symmetry = symmetries[intent.beat.phraseIndex % symmetries.length] ?? 1;
    if (events.kick || intent.beat.kickCount !== this.lastKickCount) {
      this.lastKickCount = intent.beat.kickCount;
      const seed = intent.beat.kickCount * 0.618 + intent.seed;
      const angle = (seed % 1) * Math.PI * 2;
      const radius = 0.15 + 0.3 * ((seed * 7.3) % 1);
      const side = intent.balance < 0.5 ? -1 : 1;
      this.injectX = Math.cos(angle) * radius * 0.7 + side * 0.15;
      this.injectY = Math.sin(angle) * radius * 0.5;
      this.injectStrength =
        (0.6 + 0.6 * intent.audio.kick) * (0.2 + intent.intensity * intent.intensity) + intent.burst;
    }
    this.injectStrength *= Math.exp(-dt * 14);
    const rotation =
      Math.sin(intent.beat.barPhase * Math.PI * 2) * 0.05 * intent.motion + (intent.balance - 0.5) * 0.02;
    const zoom = 1 + 0.012 * intent.audio.kick + 0.2 * intent.burst + 0.004 * intent.motion;
    const decay = Math.exp(-dt * (1.6 + 2.0 * (1 - intent.intensity)));
    const flow = (intent.balance - 0.5) * 0.006;
    writePrivate(this.ctx, 0, [
      symmetry,
      this.injectX,
      this.injectY,
      this.injectStrength * (1 - 0.7 * intent.freeze),
    ]);
    writePrivate(this.ctx, 1, [rotation, flow, intent.freeze > 0.5 ? 1 : decay, zoom]);
    const next = 1 - this.current;
    drawFullscreen(
      encoder,
      this.simulate,
      {
        view: this.views[next] as GPUTextureView,
        width: this.width,
        height: this.height,
        viewportOffset: this.simViewport,
      },
      this.ctx.baseBindGroup,
      [this.groups[this.current] as GPUBindGroup],
    );
    this.current = next;
  }

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.drawPipeline) return;
    drawFullscreen(encoder, this.drawPipeline, target, this.ctx.baseBindGroup, [
      this.groups[this.current] as GPUBindGroup,
    ]);
  }

  dispose(): void {
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
  }
}
