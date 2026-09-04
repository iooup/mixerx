/**
 * FFT particle ocean, replacing Spectral Terrain under its stable `intro-lines` / `terrain` ids.
 * The simulation runs once per frame; main output, thumbnails and stats share its surface.
 */
import type { Intent } from "../../director";
import { CameraOperator } from "../camera";
import { lookAt, multiply, perspective } from "../math";
import {
  COMMON_WGSL,
  type DrawTarget,
  type EventFlags,
  HDR_FORMAT,
  type Scene,
  type SceneContext,
} from "../scene";
import { oceanComputeShaders, oceanParticleShader } from "./ocean-shaders";
import { ifftStages, initialOceanSpectrum, oceanResolution } from "./ocean-spectrum";

interface ComputeStep {
  pipeline: GPUComputePipeline;
  group: GPUBindGroup;
}

export class TerrainScene implements Scene {
  readonly renderer = "terrain" as const;
  ready: Promise<void> = Promise.resolve();
  private ctx!: SceneContext;
  private resolution = 64;
  private pipeline: GPURenderPipeline | null = null;
  private drawLayout!: GPUBindGroupLayout;
  private simulation!: GPUBuffer;
  private surface!: GPUBuffer;
  private readonly buffers: GPUBuffer[] = [];
  private readonly steps: ComputeStep[] = [];
  private readonly camera = new CameraOperator();
  private readonly cameras = new Map<number, { buffer: GPUBuffer; group: GPUBindGroup }>();
  private readonly parameters = new Float32Array(8);
  private readonly cameraData = new Float32Array(24);
  private elapsed = 0;
  private flatten = 0;
  private energy = 0;
  private kickAge = 20;
  private kickStrength = 0;
  private framing = 0.3;
  private reducedMotion = false;
  private disposed = false;

  private buffer(size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    const buffer = this.ctx.device.createBuffer({ size, usage, label });
    this.buffers.push(buffer);
    return buffer;
  }

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    const device = ctx.device;
    this.resolution = oceanResolution(ctx.quality);
    const bytes = this.resolution ** 2 * 16;
    const initial = this.buffer(
      bytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      "ocean spectrum seed",
    );
    const ping = this.buffer(bytes, GPUBufferUsage.STORAGE, "ocean FFT ping");
    const pong = this.buffer(bytes, GPUBufferUsage.STORAGE, "ocean FFT pong");
    this.surface = this.buffer(bytes * 2, GPUBufferUsage.STORAGE, "ocean displacement and normals");
    this.simulation = this.buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "ocean simulation");
    device.queue.writeBuffer(initial, 0, initialOceanSpectrum(this.resolution));
    const computeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      ],
    });
    const computePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [computeLayout] });
    const shaders = oceanComputeShaders(this.resolution);
    const compute = (label: string, code: string, entryPoint: string) =>
      device.createComputePipelineAsync({
        label,
        layout: computePipelineLayout,
        compute: { module: device.createShaderModule({ label, code }), entryPoint },
      });
    this.drawLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    });
    const particles = device.createShaderModule({
      label: "FFT ocean particles",
      code: `${COMMON_WGSL}\n${oceanParticleShader(this.resolution)}`,
    });
    const render = device.createRenderPipelineAsync({
      label: "FFT ocean particles",
      layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.baseLayout, this.drawLayout] }),
      vertex: { module: particles, entryPoint: "vs" },
      fragment: {
        module: particles,
        entryPoint: "fs",
        targets: [
          {
            format: HDR_FORMAT,
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    this.ready = Promise.all([
      compute("ocean spectrum evolution", shaders.spectrum, "evolve"),
      compute("ocean Stockham IFFT", shaders.ifft, "transform"),
      compute("ocean surface", shaders.surface, "surface"),
      render,
    ]).then(([evolve, transform, surface, pipeline]) => {
      if (this.disposed) return;
      const step = (pipeline: GPUComputePipeline, input: GPUBuffer, output: GPUBuffer, params: GPUBuffer) => {
        this.steps.push({
          pipeline,
          group: device.createBindGroup({
            layout: computeLayout,
            entries: [
              { binding: 0, resource: { buffer: input } },
              { binding: 1, resource: { buffer: output } },
              { binding: 2, resource: { buffer: params } },
            ],
          }),
        });
      };
      step(evolve, initial, ping, this.simulation);
      let input = ping;
      let output = pong;
      for (const stage of ifftStages(this.resolution)) {
        // Each dispatch owns immutable parameters: queue.writeBuffer cannot vary within a submission.
        const params = this.buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "ocean FFT stage");
        device.queue.writeBuffer(
          params,
          0,
          new Float32Array([stage.size, Number(stage.horizontal), 0, 0, 0, 0, 0, 0]),
        );
        step(transform, input, output, params);
        [input, output] = [output, input];
      }
      step(surface, input, this.surface, this.simulation);
      this.pipeline = pipeline;
    });
  }

  update(encoder: GPUCommandEncoder, intent: Intent, dt: number, events: EventFlags): void {
    if (!this.pipeline) return;
    this.camera.step(intent, dt, events);
    this.framing = intent.framing;
    this.reducedMotion = intent.reducedMotion;
    const audible = intent.audio.rms > 0.001;
    const speed = audible ? (0.22 + intent.motion * 0.24) * (1 - intent.freeze * 0.95) : 0;
    this.elapsed += dt * speed * (intent.reducedMotion ? 0.2 : 1);
    const smooth = 1 - Math.exp(-dt / 0.65);
    this.energy += ((audible ? intent.audio.bass : 0) - this.energy) * smooth;
    this.flatten += ((intent.section === "break" ? 1 : 0) - this.flatten) * smooth;
    if (events.kick && audible && !intent.reducedMotion) {
      this.kickAge = 0;
      this.kickStrength = intent.audio.kick;
    }
    this.kickAge += dt;
    const calm = (1 - 0.82 * this.flatten) * (1 - 0.7 * intent.anticipation);
    this.parameters[0] = this.elapsed;
    this.parameters[1] = (0.85 + this.energy * 0.8 + intent.burst * 0.15) * calm;
    this.parameters[2] = this.kickAge;
    this.parameters[3] = this.kickStrength * Math.exp(-this.kickAge * 0.8) * calm;
    this.ctx.device.queue.writeBuffer(this.simulation, 0, this.parameters);
    for (const step of this.steps) {
      // Separate usage scopes supply the storage-buffer dependency between butterfly stages.
      const pass = encoder.beginComputePass();
      pass.setPipeline(step.pipeline);
      pass.setBindGroup(0, step.group);
      pass.dispatchWorkgroups(this.resolution / 8, this.resolution / 8);
      pass.end();
    }
  }

  private cameraFor(target: DrawTarget): GPUBindGroup {
    // A viewport owns its buffer: the main output and thumbnail can share an aspect but differ in density.
    const key = target.viewportOffset;
    let cached = this.cameras.get(key);
    if (!cached) {
      const buffer = this.buffer(96, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "ocean camera");
      const group = this.ctx.device.createBindGroup({
        layout: this.drawLayout,
        entries: [
          { binding: 0, resource: { buffer: this.surface } },
          { binding: 1, resource: { buffer } },
        ],
      });
      cached = { buffer, group };
      this.cameras.set(key, cached);
    }
    const shape = this.camera.blendedShape();
    const sway = this.reducedMotion ? 0 : Math.sin(this.elapsed * 0.08) * 2.5;
    const eye: [number, number, number] = [sway, Math.max(18, 30 * Math.sqrt(shape.height)), 90];
    const aim: [number, number, number] = [sway * 0.3, eye[1] - 25, 55 - (shape.distance - 1) * 8];
    aim[1] += this.camera.shakeAmount * 0.35;
    const aspect = target.width / Math.max(1, target.height);
    const projection = perspective(((90 + shape.fov - this.framing * 5) * Math.PI) / 180, aspect, 0.1, 1000);
    this.cameraData.set(multiply(projection, lookAt(eye, aim)));
    this.cameraData.set([...eye, 0], 16);
    const grid = this.particleGrid(target);
    // Compensate dot coverage at lower quality, while keeping each dot small.
    this.cameraData.set([grid, Math.min(1.5, 512 / grid), 1 - this.flatten * 0.45, 0], 20);
    this.ctx.device.queue.writeBuffer(cached.buffer, 0, this.cameraData);
    return cached.group;
  }

  private particleGrid(target: DrawTarget): number {
    if (target.width <= 320) return 192;
    return this.ctx.quality === "high" ? 512 : this.ctx.quality === "medium" ? 384 : 256;
  }

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.pipeline) return;
    const group = this.cameraFor(target);
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.ctx.baseBindGroup, [target.viewportOffset]);
    pass.setBindGroup(1, group);
    pass.draw(6, this.particleGrid(target) ** 2);
    pass.end();
  }

  setFraming(framing: number): void {
    this.framing = framing;
  }

  dispose(): void {
    this.disposed = true;
    for (const buffer of this.buffers) buffer.destroy();
    this.buffers.length = 0;
    this.steps.length = 0;
    this.cameras.clear();
    this.camera.dispose();
    this.pipeline = null;
  }
}
