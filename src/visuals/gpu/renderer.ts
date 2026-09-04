/**
 * The Stage renderer: scenes draw into an HDR target (rgba16float);
 * a shared post chain adds bloom, tone-maps, applies the Director's flash/filter/blackout and the
 * scene transition, and presents. Adaptive resolution holds the frame rate; thumbnails and the
 * stats target reuse the same simulation so previews are faithful; device loss is reported so the
 * page can rebuild the renderer.
 */
import { SCENES, type SceneRenderer, sceneById, sceneCategory } from "../../agent/scenes";
import type { Intent } from "../director";
import { acquireGpu, chooseQuality, type GpuHandle, type GpuInfo, type Quality } from "./device";
import {
  baseLayoutEntries,
  COMMON_WGSL,
  createBaseBindGroup,
  DEPTH_FORMAT,
  type DrawTarget,
  type EventFlags,
  HDR_FORMAT,
  packUniforms,
  type Scene,
  type SceneContext,
  SHOW_FLOAT_COUNT,
  SHOW_FLOAT_OFFSET,
  uniformBytes,
  VIEWPORT_STRIDE,
} from "./scene";
import { BackdropScene } from "./scenes/backdrop";
import { type CinematicMotion, cinematicExposure, stepCinematicMotion } from "./scenes/cinematic/motion";
import { CinematicScene } from "./scenes/cinematic/scene";
import { CubesScene } from "./scenes/cubes";
import { KickFieldScene } from "./scenes/field";
import { InkScene } from "./scenes/ink";
import { LinesScene } from "./scenes/lines";
import { MonolithScene } from "./scenes/monolith";
import { LightRigScene } from "./scenes/rig";
import { TerrainScene } from "./scenes/terrain";
import { WavesScene } from "./scenes/waves";
import { UNIFORM_FLOATS } from "./shaders";

export interface FrameStats {
  meanLuma: number; // 0..1
  histogram: number[]; // 16 bins, fractions
  seq: number;
}

export interface RendererOptions {
  quality?: string | null;
  preview?: boolean;
}

const POST_WGSL = /* wgsl */ `
@group(1) @binding(0) var texA: texture_2d<f32>;
@group(1) @binding(1) var texB: texture_2d<f32>;
@group(1) @binding(2) var texBloom: texture_2d<f32>;
struct P { p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f }
@group(1) @binding(3) var<uniform> pp: P;

// p0: progress, kind (0 cut, 1 dissolve, 2 wipe), flash, exposure
// p1: saturation, invert (unused), bloom amount, tunnel
// p2: blackout, time, vignette, hasB
// p3: threshold / blur direction x, blur direction y, texel x, texel y

fn scene_mix(uv: vec2f) -> vec3f {
  let a = textureSample(texA, smp, uv).rgb;
  let b = textureSample(texB, smp, uv).rgb;
  let progress = pp.p0.x;
  let kind = pp.p0.y;
  var w = 0.0;
  if (kind < 0.5) { w = step(1.0, progress); }
  else if (kind < 1.5) { w = progress; }
  else { w = smoothstep(uv.x - 0.06, uv.x + 0.06, progress * 1.12 - 0.06); }
  return mix(a, b, w * pp.p2.w);
}

fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}
`;

const BRIGHT_FS = /* wgsl */ `
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  var acc = vec3f(0.0);
  let t = pp.p3.zw;
  acc = acc + scene_mix(in.uv + vec2f(-t.x, -t.y));
  acc = acc + scene_mix(in.uv + vec2f(t.x, -t.y));
  acc = acc + scene_mix(in.uv + vec2f(-t.x, t.y));
  acc = acc + scene_mix(in.uv + vec2f(t.x, t.y));
  let c = acc * 0.25;
  let l = luma(c);
  return vec4f(c * smoothstep(pp.p3.x, pp.p3.x + 0.6, l), 1.0);
}
`;

const BLUR_FS = /* wgsl */ `
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let dir = pp.p3.xy * pp.p3.zw;
  var acc = textureSample(texA, smp, in.uv).rgb * 0.227;
  let w = array<f32, 4>(0.194, 0.121, 0.054, 0.016);
  for (var i = 1; i <= 4; i = i + 1) {
    let o = dir * f32(i) * 1.5;
    acc = acc + (textureSample(texA, smp, in.uv + o).rgb + textureSample(texA, smp, in.uv - o).rgb) * w[i - 1];
  }
  return vec4f(acc, 1.0);
}
`;

const COMPOSITE_FS = /* wgsl */ `
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let tunnel = pp.p1.w;
  var c: vec3f;
  if (abs(tunnel) > 0.03) {
    let dir = in.uv - 0.5;
    var acc = vec3f(0.0);
    let amount = abs(tunnel) * 0.04;
    for (var i = 0; i < 6; i = i + 1) { acc = acc + scene_mix(in.uv - dir * amount * f32(i) / 5.0); }
    let blurred = acc / 6.0;
    let sharp = scene_mix(in.uv);
    c = select(sharp + (sharp - blurred) * (2.5 * tunnel), blurred, tunnel < 0.0);
  } else {
    c = scene_mix(in.uv);
  }
  c = c + textureSample(texBloom, smp, in.uv).rgb * pp.p1.z;
  c = aces(c * pp.p0.w);
  let l = luma(c);
  c = mix(vec3f(l), c, pp.p1.x);
  c = mix(c, vec3f(1.0), pp.p0.z);
  let v = 1.0 - smoothstep(0.55, 1.25, length(in.uv - 0.5) * 1.6) * pp.p2.z;
  c = c * v;
  // Room for the type: while the lower third is on screen the bottom of the picture eases down.
  c = c * (1.0 - smoothstep(0.6, 1.0, in.uv.y) * u.show.w * 0.18);
  c = c * (1.0 - pp.p2.x);
  let dither = (hash21(in.uv * vp.xy + pp.p2.y) - 0.5) / 255.0;
  return vec4f(pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)) + dither, 1.0);
}
`;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** A window that is not on screen draws no thumbnails (they are a studio convenience only). */
const documentHidden = (): boolean => typeof document !== "undefined" && document.hidden;

interface Target {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
}

interface Thumbnail {
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
}

/** Simulation steps run before a scene's first drawn frame so it never arrives empty. */
const PREROLL_STEPS = 6;
/** Frames after which the warm-up gives up on a scene whose pipelines never compiled. */
const WARM_UP_DEADLINE_FRAMES = 900;

const THUMB = [192, 108] as const;
const STATS = [64, 36] as const;
/** Every look with a renderer, in catalogue order: the warm-up walks this list one scene per frame. */
const WARM_UP_SCENES: string[] = SCENES.filter((scene) => scene.renderer !== "none").map((scene) => scene.id);

const VIEWPORT_SLOTS = 8;
const VIEWPORT_MAIN_SLOT = 0;
const VIEWPORT_THUMB_SLOT = 1;
const VIEWPORT_STATS_SLOT = 2;
const VIEWPORT_SCENES_START = 3;
/** Dynamic offsets are bytes: slot × stride. */
const VIEWPORT_MAIN = VIEWPORT_MAIN_SLOT * VIEWPORT_STRIDE;
const VIEWPORT_THUMB = VIEWPORT_THUMB_SLOT * VIEWPORT_STRIDE;
const VIEWPORT_STATS = VIEWPORT_STATS_SLOT * VIEWPORT_STRIDE;

export class StageRenderer {
  readonly info: GpuInfo;
  readonly quality: Quality;
  readonly preview: boolean;
  onLost: ((reason: string) => void) | null = null;
  /** Last uncaptured WebGPU error message (validation / out of memory), for the studio read-out. */
  lastError: string | null = null;
  /** Thumbnail draws so far (diagnostics). */
  thumbnailFrames = 0;
  /** True once every scene's pipelines are compiled and each has drawn one warm-up frame. */
  warmedUp = false;
  scale = 1;
  gpuTimeMs: number | null = null;
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly context: GPUCanvasContext;
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS);
  private readonly uniforms: GPUBuffer;
  private readonly viewports: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly baseLayout: GPUBindGroupLayout;
  private readonly baseBindGroup: GPUBindGroup;
  private readonly postLayout: GPUBindGroupLayout;
  private readonly bright: GPURenderPipeline;
  private readonly blur: GPURenderPipeline;
  private readonly composite: GPURenderPipeline;
  private readonly compositeStats: GPURenderPipeline;
  private readonly black: Target;
  private readonly paramBuffers: GPUBuffer[] = [];
  private readonly depths = new Map<string, Target>();
  private readonly scenes = new Map<SceneRenderer, Scene>();
  private readonly cinematicMotion: CinematicMotion = { time: 0, energy: 0, bass: 0, treble: 0 };
  /** Scenes whose pipelines have finished compiling (drawing before that would be a black frame). */
  private readonly readyScenes = new Set<Scene>();
  /** Frame number of each scene's last simulation step, so an incoming scene is never drawn cold. */
  private readonly lastUpdated = new Map<Scene, number>();
  private readonly thumbnails = new Map<string, Thumbnail>();
  private readonly thumbTarget: Target;
  private readonly statsTarget: Target;
  private readonly statsBuffer: GPUBuffer;
  private statsPending: ((stats: FrameStats | null) => void) | null = null;
  private statsBusy = false;
  private hdrA: Target | null = null;
  private hdrB: Target | null = null;
  private bloom0: Target | null = null;
  private bloom1: Target | null = null;
  private width = 0;
  private height = 0;
  private time = 0;
  private frames = 0;
  private slowFrames = 0;
  private fastFrames = 0;
  private frameEma = 0.016;
  private nextViewportSlot = VIEWPORT_SCENES_START;
  private querySet: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  private queryRead: GPUBuffer | null = null;
  private queryBusy = false;
  private disposed = false;
  private readonly sceneContext: SceneContext & { allocateViewport(w: number, h: number): number };
  private warmIndex = 0;

  static async create(
    canvas: HTMLCanvasElement,
    options: RendererOptions = {},
  ): Promise<StageRenderer | null> {
    const gpu = await acquireGpu();
    if (!gpu) return null;
    const context = canvas.getContext("webgpu");
    if (!context) {
      gpu.device.destroy();
      return null;
    }
    return new StageRenderer(gpu, context, options);
  }

  private constructor(gpu: GpuHandle, context: GPUCanvasContext, options: RendererOptions) {
    this.device = gpu.device;
    this.format = gpu.format;
    this.info = gpu.info;
    this.context = context;
    this.preview = Boolean(options.preview);
    this.quality = this.preview ? "low" : chooseQuality(gpu.info, options.quality ?? null);
    const device = this.device;
    context.configure({ device, format: this.format, alphaMode: "opaque" });
    void device.lost.then((info) => {
      if (this.disposed) return;
      this.disposed = true;
      this.onLost?.(info.reason);
    });
    device.addEventListener("uncapturederror", (event) => {
      const message = (event as GPUUncapturedErrorEvent).error.message;
      if (this.lastError !== message) console.warn(`[stage] WebGPU: ${message}`);
      this.lastError = message;
    });
    this.uniforms = device.createBuffer({
      label: "stage uniforms",
      size: uniformBytes(),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.viewports = device.createBuffer({
      label: "stage viewports",
      size: VIEWPORT_STRIDE * VIEWPORT_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.baseLayout = device.createBindGroupLayout({ label: "stage base", entries: baseLayoutEntries() });
    this.baseBindGroup = createBaseBindGroup(
      device,
      this.baseLayout,
      this.uniforms,
      this.viewports,
      this.sampler,
    );
    this.postLayout = device.createBindGroupLayout({
      label: "stage post",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    const postPipeline = (label: string, fragment: string, format: GPUTextureFormat) => {
      const module = device.createShaderModule({ label, code: `${COMMON_WGSL}\n${POST_WGSL}\n${fragment}` });
      return device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.baseLayout, this.postLayout] }),
        vertex: { module, entryPoint: "vs_fullscreen" },
        fragment: { module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
    };
    this.bright = postPipeline("stage bright", BRIGHT_FS, HDR_FORMAT);
    this.blur = postPipeline("stage blur", BLUR_FS, HDR_FORMAT);
    this.composite = postPipeline("stage composite", COMPOSITE_FS, this.format);
    this.compositeStats = postPipeline("stage composite stats", COMPOSITE_FS, "rgba8unorm");
    for (let i = 0; i < 8; i += 1)
      this.paramBuffers.push(
        device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      );
    this.black = this.createTarget(
      1,
      1,
      HDR_FORMAT,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    );
    this.thumbTarget = this.createTarget(
      THUMB[0],
      THUMB[1],
      HDR_FORMAT,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    );
    this.statsTarget = this.createTarget(
      STATS[0],
      STATS[1],
      "rgba8unorm",
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    );
    this.statsBuffer = device.createBuffer({
      size: 256 * STATS[1],
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.writeViewport(VIEWPORT_THUMB_SLOT, THUMB[0], THUMB[1]);
    this.writeViewport(VIEWPORT_STATS_SLOT, STATS[0], STATS[1]);
    if (gpu.info.timestampQuery) {
      this.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
      this.queryResolve = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      this.queryRead = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }
    this.sceneContext = {
      device,
      quality: this.quality,
      uniforms: this.uniforms,
      viewports: this.viewports,
      sampler: this.sampler,
      baseLayout: this.baseLayout,
      baseBindGroup: this.baseBindGroup,
      depthFor: (width, height) => this.depthFor(width, height),
      allocateViewport: (width, height) => {
        const slot = Math.min(VIEWPORT_SLOTS - 1, this.nextViewportSlot);
        this.nextViewportSlot += 1;
        this.writeViewport(slot, width, height);
        return slot * VIEWPORT_STRIDE;
      },
    };
    this.resize(2, 2);
  }

  private createTarget(width: number, height: number, format: GPUTextureFormat, usage: number): Target {
    const texture = this.device.createTexture({
      size: [Math.max(1, width), Math.max(1, height)],
      format,
      usage,
    });
    return { texture, view: texture.createView(), width: Math.max(1, width), height: Math.max(1, height) };
  }

  private writeViewport(slot: number, width: number, height: number): void {
    this.device.queue.writeBuffer(
      this.viewports,
      slot * VIEWPORT_STRIDE,
      new Float32Array([width, height, width / Math.max(1, height), 0]),
    );
  }

  private depthFor(width: number, height: number): GPUTextureView {
    const key = `${width}x${height}`;
    let target = this.depths.get(key);
    if (!target) {
      if (this.depths.size > 6) {
        for (const [k, t] of this.depths) {
          t.texture.destroy();
          this.depths.delete(k);
        }
      }
      target = this.createTarget(width, height, DEPTH_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT);
      this.depths.set(key, target);
    }
    return target.view;
  }

  /** Canvas size in device pixels. */
  resize(width: number, height: number): void {
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.context.canvas.width = w;
    this.context.canvas.height = h;
    this.allocateHdr();
  }

  private allocateHdr(): void {
    const w = Math.max(2, Math.round(this.width * this.scale));
    const h = Math.max(2, Math.round(this.height * this.scale));
    if (this.hdrA && this.hdrA.width === w && this.hdrA.height === h) return;
    for (const target of [this.hdrA, this.hdrB, this.bloom0, this.bloom1]) target?.texture.destroy();
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    this.hdrA = this.createTarget(w, h, HDR_FORMAT, usage);
    this.hdrB = this.createTarget(w, h, HDR_FORMAT, usage);
    this.bloom0 = this.createTarget(Math.ceil(w / 4), Math.ceil(h / 4), HDR_FORMAT, usage);
    this.bloom1 = this.createTarget(Math.ceil(w / 4), Math.ceil(h / 4), HDR_FORMAT, usage);
    this.writeViewport(VIEWPORT_MAIN_SLOT, w, h);
  }

  private adapt(dt: number): void {
    if (this.preview) {
      if (this.scale !== 0.5) {
        this.scale = 0.5;
        this.allocateHdr();
      }
      return;
    }
    this.frameEma += (Math.min(0.1, dt) - this.frameEma) * 0.1;
    if (this.frameEma > 0.019) {
      this.slowFrames += 1;
      this.fastFrames = 0;
    } else if (this.frameEma < 0.012) {
      this.fastFrames += 1;
      this.slowFrames = 0;
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }
    if (this.slowFrames >= 20 && this.scale > 0.5) {
      this.scale = Math.max(0.5, this.scale * 0.85);
      this.slowFrames = 0;
      this.allocateHdr();
    } else if (this.fastFrames >= 180 && this.scale < 1) {
      this.scale = Math.min(1, this.scale * 1.15);
      this.fastFrames = 0;
      this.allocateHdr();
    }
  }

  private sceneFor(sceneId: string): Scene | null {
    const renderer = sceneById(sceneId)?.renderer ?? "none";
    if (renderer === "none") return null;
    let scene = this.scenes.get(renderer);
    if (!scene) {
      const factories: Record<Exclude<SceneRenderer, "none">, () => Scene> = {
        field: () => new KickFieldScene(),
        monolith: () => new MonolithScene(),
        terrain: () => new TerrainScene(),
        rig: () => new LightRigScene(),
        ink: () => new InkScene(),
        waves: () => new WavesScene(),
        cubes: () => new CubesScene(),
        backdrop: () => new BackdropScene(),
        "line-waves": () => new LinesScene("line-waves"),
        "line-orbits": () => new LinesScene("line-orbits"),
        "line-ribbons": () => new LinesScene("line-ribbons"),
        "line-lattice": () => new LinesScene("line-lattice"),
        "cinematic-phoenix": () => new CinematicScene("cinematic-phoenix", this.cinematicMotion),
        "cinematic-gate": () => new CinematicScene("cinematic-gate", this.cinematicMotion),
        "cinematic-lotus": () => new CinematicScene("cinematic-lotus", this.cinematicMotion),
        "cinematic-crystal": () => new CinematicScene("cinematic-crystal", this.cinematicMotion),
      };
      scene = factories[renderer]();
      scene.init(this.sceneContext);
      this.scenes.set(renderer, scene);
      const created = scene;
      void created.ready
        .then(() => this.readyScenes.add(created))
        .catch((error: unknown) => {
          this.lastError = `Scene ${renderer}: ${error instanceof Error ? error.message : String(error)}`;
        });
    }
    return scene;
  }

  private postGroup(a: Target, b: Target, bloom: Target, params: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.postLayout,
      entries: [
        { binding: 0, resource: a.view },
        { binding: 1, resource: b.view },
        { binding: 2, resource: bloom.view },
        { binding: 3, resource: { buffer: params } },
      ],
    });
  }

  private params(index: number, values: number[]): GPUBuffer {
    const buffer = this.paramBuffers[index] as GPUBuffer;
    this.device.queue.writeBuffer(buffer, 0, new Float32Array(values));
    return buffer;
  }

  private drawPost(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    target: DrawTarget,
    group: GPUBindGroup,
    timestampEnd = false,
  ): void {
    const descriptor: GPURenderPassDescriptor = {
      colorAttachments: [
        { view: target.view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    };
    if (timestampEnd && this.querySet)
      descriptor.timestampWrites = { querySet: this.querySet, endOfPassWriteIndex: 1 };
    const pass = encoder.beginRenderPass(descriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.baseBindGroup, [target.viewportOffset]);
    pass.setBindGroup(1, group);
    pass.draw(3);
    pass.end();
  }

  /** Renders one frame. `dt` is the wall-clock step in seconds; `events` flags this frame's onsets. */
  render(intent: Intent, dt: number, events: EventFlags): void {
    if (this.disposed || !this.hdrA || !this.hdrB || !this.bloom0 || !this.bloom1) return;
    this.adapt(dt);
    if (!this.hdrA || !this.hdrB || !this.bloom0 || !this.bloom1) return;
    this.time += dt;
    this.frames += 1;
    stepCinematicMotion(this.cinematicMotion, intent, dt);
    packUniforms(this.uniformData, intent, this.time, dt, this.quality, events);
    // Two writes: slots 0–13, then `show` and the spectrum. The scene-private slots (14, 15) are
    // owned by the scenes and keep whatever they last wrote.
    this.device.queue.writeBuffer(this.uniforms, 0, this.uniformData, 0, 14 * 4);
    this.device.queue.writeBuffer(
      this.uniforms,
      SHOW_FLOAT_OFFSET * 4,
      this.uniformData,
      SHOW_FLOAT_OFFSET,
      SHOW_FLOAT_COUNT,
    );

    const encoder = this.device.createCommandEncoder({ label: "stage frame" });
    // The GPU-time marker is a real 1×1 render pass: an empty compute pass can be dropped by the
    // backend, leaving query 0 unwritten and the reported time meaningless.
    if (this.querySet) {
      const marker = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.black.view,
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0 },
      });
      marker.end();
    }
    const blackout = intent.blackout || intent.sceneId === "blackout";
    const transition = intent.transition;
    const sceneA = blackout ? null : this.sceneFor(transition ? transition.from : intent.sceneId);
    const sceneB = blackout || !transition ? null : this.sceneFor(transition.to);
    const main: DrawTarget = {
      view: this.hdrA.view,
      width: this.hdrA.width,
      height: this.hdrA.height,
      viewportOffset: VIEWPORT_MAIN,
    };
    const mainB: DrawTarget = {
      view: this.hdrB.view,
      width: this.hdrB.width,
      height: this.hdrB.height,
      viewportOffset: VIEWPORT_MAIN,
    };
    if (sceneA && this.readyScenes.has(sceneA)) {
      this.simulate(encoder, sceneA, intent, dt, events);
      sceneA.draw(encoder, main);
    } else {
      this.clear(encoder, main.view);
    }
    if (sceneB && sceneB !== sceneA && this.readyScenes.has(sceneB)) {
      this.simulate(encoder, sceneB, intent, dt, events);
      sceneB.draw(encoder, mainB);
    } else if (sceneB === sceneA && sceneA && this.readyScenes.has(sceneA)) {
      sceneA.draw(encoder, mainB);
    } else {
      this.clear(encoder, mainB.view);
    }
    // The scene waiting for the next bar is simulated (never drawn) so it arrives in motion.
    const pending = blackout || !intent.pendingSceneId ? null : this.sceneFor(intent.pendingSceneId);
    if (pending && pending !== sceneA && pending !== sceneB && this.readyScenes.has(pending))
      this.simulate(encoder, pending, intent, dt, events);

    const progress = transition ? transition.progress : 0;
    const kind = transition ? (transition.kind === "cut" ? 0 : transition.kind === "dissolve" ? 1 : 2) : 0;
    const hasB = transition ? 1 : 0;
    // Over the last bar before a drop the exposure eases to 70 % — one breath, never a flash.
    const breath = smoothstep(0.84, 1, intent.anticipation);
    const cinematic = sceneCategory(intent.sceneId) === "cinematic";
    const exposure = cinematic
      ? cinematicExposure(intent.intensity)
      : (0.2 + 1.1 * intent.intensity) * (1 - 0.3 * breath);
    // The fixed blue rig keeps its hue and soft glow through section changes and drops.
    const blueRig = sceneA?.renderer === "rig" || sceneB?.renderer === "rig";
    const simple = sceneCategory(intent.sceneId) === "simple";
    const quiet = simple || cinematic;
    const flash = blueRig || quiet ? 0 : intent.flash;
    const saturation = blueRig || quiet ? 1 : intent.saturation;
    const invert = quiet ? 0 : intent.invert;
    const tunnel = quiet ? 0 : intent.tunnel;
    const bloomAmount = (0.12 + 0.33 * intent.intensity) * (blackout || quiet ? 0 : blueRig ? 0.25 : 1);
    const texelX = 1 / this.hdrA.width;
    const texelY = 1 / this.hdrA.height;
    const bloomTexelX = 1 / this.bloom0.width;
    const bloomTexelY = 1 / this.bloom0.height;
    const bloomTarget: DrawTarget = {
      view: this.bloom0.view,
      width: this.bloom0.width,
      height: this.bloom0.height,
      viewportOffset: VIEWPORT_MAIN,
    };
    const bloomTarget1: DrawTarget = {
      view: this.bloom1.view,
      width: this.bloom1.width,
      height: this.bloom1.height,
      viewportOffset: VIEWPORT_MAIN,
    };
    if (!blackout && !simple) {
      const brightParams = this.params(0, [
        progress,
        kind,
        0,
        1,
        1,
        0,
        0,
        0,
        0,
        this.time,
        0,
        hasB,
        0.65,
        0,
        texelX,
        texelY,
      ]);
      this.drawPost(
        encoder,
        this.bright,
        bloomTarget,
        this.postGroup(this.hdrA, this.hdrB, this.black, brightParams),
      );
      const blurH = this.params(1, [
        0,
        0,
        0,
        1,
        1,
        0,
        0,
        0,
        0,
        this.time,
        0,
        0,
        1,
        0,
        bloomTexelX,
        bloomTexelY,
      ]);
      this.drawPost(
        encoder,
        this.blur,
        bloomTarget1,
        this.postGroup(this.bloom0, this.black, this.black, blurH),
      );
      const blurV = this.params(2, [
        0,
        0,
        0,
        1,
        1,
        0,
        0,
        0,
        0,
        this.time,
        0,
        0,
        0,
        1,
        bloomTexelX,
        bloomTexelY,
      ]);
      this.drawPost(
        encoder,
        this.blur,
        bloomTarget,
        this.postGroup(this.bloom1, this.black, this.black, blurV),
      );
    }
    const compositeParams = this.params(3, [
      progress,
      kind,
      flash,
      exposure,
      saturation,
      invert,
      bloomAmount,
      tunnel,
      blackout ? 1 : 0,
      this.time,
      0.7,
      hasB,
      0,
      0,
      texelX,
      texelY,
    ]);
    const compositeGroup = this.postGroup(this.hdrA, this.hdrB, this.bloom0, compositeParams);
    let canvasView: GPUTextureView | null = null;
    try {
      canvasView = this.context.getCurrentTexture().createView();
    } catch {
      canvasView = null;
    }
    if (canvasView) {
      this.drawPost(
        encoder,
        this.composite,
        { view: canvasView, width: this.width, height: this.height, viewportOffset: VIEWPORT_MAIN },
        compositeGroup,
        true,
      );
    }

    // Studio thumbnails: one *visible* card every 12 frames, drawn from the same simulation. The
    // display and the console preview never attach any, and a hidden window draws none at all.
    if (!this.preview && this.thumbnails.size && this.frames % 12 === 0 && !documentHidden()) {
      const ids = [...this.thumbnails.keys()];
      const id = ids[Math.floor(this.frames / 12) % ids.length] as string;
      const thumbnail = this.thumbnails.get(id) as Thumbnail;
      this.thumbnailFrames += 1;
      this.renderThumbnail(encoder, id, thumbnail, intent, events, dt);
    }
    if (!this.warmedUp) this.warmStep(encoder, intent, events);

    // Stats readback (legibility tests): the composite at 64×36, copied to a mappable buffer.
    let statsCopied = false;
    if (this.statsPending && !this.statsBusy) {
      const statsParams = this.params(4, [
        progress,
        kind,
        flash,
        exposure,
        saturation,
        invert,
        bloomAmount,
        tunnel,
        blackout ? 1 : 0,
        this.time,
        0.7,
        hasB,
        0,
        0,
        texelX,
        texelY,
      ]);
      this.drawPost(
        encoder,
        this.compositeStats,
        { view: this.statsTarget.view, width: STATS[0], height: STATS[1], viewportOffset: VIEWPORT_STATS },
        this.postGroup(this.hdrA, this.hdrB, this.bloom0, statsParams),
      );
      encoder.copyTextureToBuffer(
        { texture: this.statsTarget.texture },
        { buffer: this.statsBuffer, bytesPerRow: 256 },
        [STATS[0], STATS[1], 1],
      );
      statsCopied = true;
      this.statsBusy = true;
    }
    let queryCopied = false;
    if (this.querySet && this.queryResolve && this.queryRead && !this.queryBusy && this.frames % 10 === 0) {
      encoder.resolveQuerySet(this.querySet, 0, 2, this.queryResolve, 0);
      encoder.copyBufferToBuffer(this.queryResolve, 0, this.queryRead, 0, 16);
      queryCopied = true;
      this.queryBusy = true;
    }
    this.device.queue.submit([encoder.finish()]);
    if (statsCopied) void this.readStats();
    if (queryCopied) void this.readQuery();
  }

  /**
   * One simulation step for a scene, with a short pre-roll when it has not run recently: a scene
   * that was off screen (a forced cut on a drop, the first switch of the night) is brought up to
   * speed before its first drawn frame, so the incoming picture is never an empty one.
   */
  private simulate(
    encoder: GPUCommandEncoder,
    scene: Scene,
    intent: Intent,
    dt: number,
    events: EventFlags,
  ): void {
    if (scene instanceof TerrainScene) scene.setFraming(intent.framing);
    const last = this.lastUpdated.get(scene);
    if (last === undefined || this.frames - last > 2) {
      const quiet: EventFlags = { kick: 0, snare: 0, hat: 0, bar: 0 };
      for (let step = 0; step < PREROLL_STEPS; step += 1) scene.update(encoder, intent, 1 / 60, quiet);
    }
    scene.update(encoder, intent, dt, events);
    this.lastUpdated.set(scene, this.frames);
  }

  /**
   * Warm-up: one scene per frame is created (its pipelines compile off the main thread) and, once
   * ready, simulated and drawn once into the thumbnail target. After this the first switch to any
   * scene shows a populated frame instantly instead of compiling a pipeline mid-beat.
   */
  private warmStep(encoder: GPUCommandEncoder, intent: Intent, events: EventFlags): void {
    if (this.frames > WARM_UP_DEADLINE_FRAMES) {
      this.warmedUp = true;
      return;
    }
    const ids = WARM_UP_SCENES;
    const id = ids[this.warmIndex];
    if (id === undefined) {
      this.warmedUp = true;
      return;
    }
    const scene = this.sceneFor(id);
    if (!scene) {
      this.warmIndex += 1;
      return;
    }
    if (!this.readyScenes.has(scene)) return; // still compiling: try again next frame
    this.warmIndex += 1;
    this.simulate(encoder, scene, intent, 1 / 60, events);
    scene.draw(encoder, {
      view: this.thumbTarget.view,
      width: THUMB[0],
      height: THUMB[1],
      viewportOffset: VIEWPORT_THUMB,
    });
    if (this.warmIndex >= ids.length) this.warmedUp = true;
  }

  private clear(encoder: GPUCommandEncoder, view: GPUTextureView): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.end();
  }

  private renderThumbnail(
    encoder: GPUCommandEncoder,
    sceneId: string,
    thumbnail: Thumbnail,
    intent: Intent,
    _events: EventFlags,
    _dt: number,
  ): void {
    const target: DrawTarget = {
      view: this.thumbTarget.view,
      width: THUMB[0],
      height: THUMB[1],
      viewportOffset: VIEWPORT_THUMB,
    };
    const scene = this.sceneFor(sceneId);
    if (scene && this.readyScenes.has(scene)) {
      // Scenes not on screen still need one simulation step so their thumbnails move.
      if (this.lastUpdated.get(scene) !== this.frames)
        this.simulate(encoder, scene, intent, 1 / 60, { kick: 0, snare: 0, hat: 0, bar: 0 });
      scene.draw(encoder, target);
    } else {
      this.clear(encoder, target.view);
    }
    let view: GPUTextureView;
    try {
      view = thumbnail.context.getCurrentTexture().createView();
    } catch {
      return;
    }
    const params = this.params(5, [
      0,
      0,
      0,
      sceneCategory(sceneId) === "cinematic"
        ? cinematicExposure(intent.intensity)
        : 0.2 + 1.1 * intent.intensity,
      scene?.renderer === "rig" || sceneCategory(sceneId) !== "classic" ? 1 : intent.saturation,
      0,
      0,
      0,
      sceneId === "blackout" ? 1 : 0,
      this.time,
      0.5,
      0,
      0,
      0,
      0,
      0,
    ]);
    this.drawPost(
      encoder,
      this.composite,
      {
        view,
        width: thumbnail.canvas.width,
        height: thumbnail.canvas.height,
        viewportOffset: VIEWPORT_THUMB,
      },
      this.postGroup(this.thumbTarget, this.black, this.black, params),
    );
  }

  private async readStats(): Promise<void> {
    try {
      await this.statsBuffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(this.statsBuffer.getMappedRange());
      const histogram = new Array<number>(16).fill(0);
      let sum = 0;
      let count = 0;
      for (let y = 0; y < STATS[1]; y += 1) {
        for (let x = 0; x < STATS[0]; x += 1) {
          const i = y * 256 + x * 4;
          const l =
            (0.2126 * (bytes[i] ?? 0) + 0.7152 * (bytes[i + 1] ?? 0) + 0.0722 * (bytes[i + 2] ?? 0)) / 255;
          sum += l;
          count += 1;
          const bin = Math.min(15, Math.floor(l * 16));
          histogram[bin] = (histogram[bin] ?? 0) + 1;
        }
      }
      this.statsBuffer.unmap();
      const stats: FrameStats = {
        meanLuma: sum / Math.max(1, count),
        histogram: histogram.map((n) => n / Math.max(1, count)),
        seq: this.frames,
      };
      const resolve = this.statsPending;
      this.statsPending = null;
      resolve?.(stats);
    } catch {
      this.statsPending = null;
    } finally {
      this.statsBusy = false;
    }
  }

  private async readQuery(): Promise<void> {
    const buffer = this.queryRead;
    if (!buffer) return;
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const values = new BigUint64Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      const begin = values[0] ?? 0n;
      const end = values[1] ?? 0n;
      const ms = end > begin ? Number(end - begin) / 1e6 : 0;
      // Smooth, and ignore stalls (a hidden tab, a screenshot) that are not render cost.
      if (ms > 0 && ms < 250)
        this.gpuTimeMs = this.gpuTimeMs === null ? ms : this.gpuTimeMs + (ms - this.gpuTimeMs) * 0.2;
    } catch {
      // Timestamps are optional.
    } finally {
      this.queryBusy = false;
    }
  }

  /** Luminance statistics of the next frame (the legibility test's probe); null when no frame renders in time. */
  requestStats(timeoutMs = 2000): Promise<FrameStats | null> {
    return new Promise((resolve) => {
      const previous = this.statsPending;
      previous?.(null);
      const timer = setTimeout(() => {
        if (this.statsPending === settle) this.statsPending = null;
        resolve(null);
      }, timeoutMs);
      const settle = (stats: FrameStats | null) => {
        clearTimeout(timer);
        resolve(stats);
      };
      this.statsPending = settle;
    });
  }

  /**
   * The shape the Kick Field's particles assemble into (the DJ's message). Uploaded once per
   * message; the amount itself rides on the intent every frame.
   */
  setMorphTargets(points: Float32Array | null, count: number): void {
    const scene = this.sceneFor("drop-burst");
    if (scene instanceof KickFieldScene) scene.setTargets(points, count);
  }

  /** Live thumbnail for one scene card. The studio attaches only the cards that are on screen. */
  attachThumbnail(sceneId: string, canvas: HTMLCanvasElement): () => void {
    if (this.preview) return () => {};
    const context = canvas.getContext("webgpu");
    if (!context) return () => {};
    canvas.width = THUMB[0];
    canvas.height = THUMB[1];
    context.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
    this.thumbnails.set(sceneId, { canvas, context });
    return () => {
      this.thumbnails.delete(sceneId);
      context.unconfigure();
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const scene of this.scenes.values()) scene.dispose();
    this.scenes.clear();
    this.readyScenes.clear();
    this.lastUpdated.clear();
    for (const target of [
      this.hdrA,
      this.hdrB,
      this.bloom0,
      this.bloom1,
      this.black,
      this.thumbTarget,
      this.statsTarget,
    ])
      target?.texture.destroy();
    for (const depth of this.depths.values()) depth.texture.destroy();
    this.depths.clear();
    this.device.destroy();
  }
}
