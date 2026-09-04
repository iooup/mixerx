/**
 * Scene contract and uniform packing. A scene simulates once per frame (`update`) and can be
 * drawn into any HDR target size (`draw`): the main output, the studio thumbnails and the stats
 * target all share one simulation, so the preview is faithful.
 */
import type { SceneRenderer } from "../../agent/scenes";
import type { Intent } from "../director";
import { srgbToLinear } from "../palette";
import type { StageSection } from "../protocol";
import type { Quality } from "./device";
import {
  COMMON_WGSL,
  SHOW_FLOAT_COUNT,
  SHOW_FLOAT_OFFSET,
  SLOT,
  UNIFORM_FLOATS,
  VIEWPORT_STRIDE,
} from "./shaders";

export const HDR_FORMAT: GPUTextureFormat = "rgba16float";
export const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

export interface EventFlags {
  kick: number;
  snare: number;
  hat: number;
  bar: number;
}

export interface SceneContext {
  device: GPUDevice;
  quality: Quality;
  uniforms: GPUBuffer;
  viewports: GPUBuffer;
  sampler: GPUSampler;
  /** Bind group layout shared by every scene: uniforms, viewport (dynamic), sampler. */
  baseLayout: GPUBindGroupLayout;
  baseBindGroup: GPUBindGroup;
  depthFor(width: number, height: number): GPUTextureView;
}

export interface DrawTarget {
  view: GPUTextureView;
  width: number;
  height: number;
  /** Byte offset of this target's viewport block (dynamic offset). */
  viewportOffset: number;
}

export interface Scene {
  readonly renderer: SceneRenderer;
  /** Allocates buffers and layouts synchronously and starts compiling the pipelines. */
  init(ctx: SceneContext): void;
  /**
   * Resolves once every pipeline is compiled. Pipelines are built with the `…Async` variants so the
   * first switch to a scene never blocks the frame; `update` and `draw` are no-ops until then.
   */
  readonly ready: Promise<void>;
  update(encoder: GPUCommandEncoder, intent: Intent, dt: number, events: EventFlags): void;
  draw(encoder: GPUCommandEncoder, target: DrawTarget): void;
  dispose(): void;
}

const SECTION_CODE: Record<StageSection, number> = {
  none: 0,
  intro: 1,
  build: 2,
  drop: 3,
  break: 4,
  body: 5,
  outro: 6,
};

const QUALITY_CODE: Record<Quality, number> = { low: 0, medium: 1, high: 2 };

/** Writes the shared uniform block for this frame (the scene-private slots are left untouched). */
export function packUniforms(
  out: Float32Array,
  intent: Intent,
  time: number,
  dt: number,
  quality: Quality,
  events: EventFlags,
): void {
  const set = (slot: number, x: number, y: number, z: number, w: number) => {
    const base = slot * 4;
    out[base] = x;
    out[base + 1] = y;
    out[base + 2] = z;
    out[base + 3] = w;
  };
  const a = srgbToLinear(intent.palette.a);
  const b = srgbToLinear(intent.palette.b);
  const accent = srgbToLinear(intent.palette.accent);
  const bg = srgbToLinear(intent.palette.background);
  set(SLOT.colA, a.r, a.g, a.b, intent.intensity);
  set(SLOT.colB, b.r, b.g, b.b, intent.motion);
  set(SLOT.accent, accent.r, accent.g, accent.b, intent.framing);
  set(SLOT.bg, bg.r, bg.g, bg.b, intent.saturation);
  set(SLOT.time, time, dt, QUALITY_CODE[quality], intent.seed);
  set(SLOT.beat, intent.beat.phase, intent.beat.barPhase, intent.beat.phrasePhase, intent.beat.bpm);
  set(
    SLOT.counts,
    intent.beat.beatIndex,
    intent.beat.barIndex,
    intent.beat.phraseIndex,
    intent.beat.kickCount,
  );
  set(SLOT.hits, intent.beat.snareCount, intent.beat.hatCount, intent.flashesLastSecond, intent.strobe);
  set(SLOT.audio, intent.audio.kick, intent.audio.snare, intent.audio.hat, intent.audio.rms);
  set(SLOT.bands, intent.audio.bass, intent.audio.mid, intent.audio.treble, intent.audio.centroid);
  set(SLOT.fx, intent.flash, intent.burst, intent.invert, intent.floor);
  set(SLOT.gest, intent.tunnel, intent.balance, intent.freeze, intent.cut);
  set(SLOT.misc, SECTION_CODE[intent.section], intent.barsToNext, intent.warmth, intent.audio.flux);
  set(SLOT.events, events.kick, events.snare, events.hat, events.bar);
  set(SLOT.show, intent.anticipation, intent.cameraShot, intent.idle, intent.lowerThird);
  const spectrum = intent.audio.spectrum;
  for (let band = 0; band < 64; band += 1) out[SLOT.spectrum * 4 + band] = spectrum[band] ?? 0;
}

export function uniformBytes(): number {
  return UNIFORM_FLOATS * 4;
}

/** Scene-private vec4 (slot `priv` or `priv2`) written directly to the buffer. */
export function writePrivate(ctx: SceneContext, slot: 0 | 1, values: [number, number, number, number]): void {
  const offset = (slot === 0 ? SLOT.priv : SLOT.priv2) * 16;
  ctx.device.queue.writeBuffer(ctx.uniforms, offset, new Float32Array(values));
}

export function baseLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [
    {
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" },
    },
    {
      binding: 1,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
    },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
      sampler: { type: "filtering" },
    },
  ];
}

export function createBaseBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  uniforms: GPUBuffer,
  viewports: GPUBuffer,
  sampler: GPUSampler,
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: { buffer: viewports, size: 16 } },
      { binding: 2, resource: sampler },
    ],
  });
}

export { COMMON_WGSL, SHOW_FLOAT_COUNT, SHOW_FLOAT_OFFSET, VIEWPORT_STRIDE };

/** A fullscreen fragment pipeline over the base layout (plus optional extra bind group layouts). */
export function fullscreenPipeline(
  ctx: SceneContext,
  label: string,
  fragment: string,
  options: { format?: GPUTextureFormat; extraLayouts?: GPUBindGroupLayout[]; blend?: GPUBlendState } = {},
): GPURenderPipeline {
  const module = ctx.device.createShaderModule({ label, code: `${COMMON_WGSL}\n${fragment}` });
  return ctx.device.createRenderPipeline({
    label,
    layout: ctx.device.createPipelineLayout({
      bindGroupLayouts: [ctx.baseLayout, ...(options.extraLayouts ?? [])],
    }),
    vertex: { module, entryPoint: "vs_fullscreen" },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{ format: options.format ?? HDR_FORMAT, ...(options.blend ? { blend: options.blend } : {}) }],
    },
    primitive: { topology: "triangle-list" },
  });
}

/** The same pipeline compiled off the main thread (warm-up path; see `StageRenderer.render`). */
export function fullscreenPipelineAsync(
  ctx: SceneContext,
  label: string,
  fragment: string,
  options: { format?: GPUTextureFormat; extraLayouts?: GPUBindGroupLayout[]; blend?: GPUBlendState } = {},
): Promise<GPURenderPipeline> {
  const module = ctx.device.createShaderModule({ label, code: `${COMMON_WGSL}\n${fragment}` });
  return ctx.device.createRenderPipelineAsync({
    label,
    layout: ctx.device.createPipelineLayout({
      bindGroupLayouts: [ctx.baseLayout, ...(options.extraLayouts ?? [])],
    }),
    vertex: { module, entryPoint: "vs_fullscreen" },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{ format: options.format ?? HDR_FORMAT, ...(options.blend ? { blend: options.blend } : {}) }],
    },
    primitive: { topology: "triangle-list" },
  });
}

export function drawFullscreen(
  encoder: GPUCommandEncoder,
  pipeline: GPURenderPipeline,
  target: DrawTarget,
  base: GPUBindGroup,
  extras: GPUBindGroup[] = [],
  load: GPULoadOp = "clear",
): void {
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: target.view, loadOp: load, storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, base, [target.viewportOffset]);
  extras.forEach((group, index) => {
    pass.setBindGroup(index + 1, group);
  });
  pass.draw(3);
  pass.end();
}
