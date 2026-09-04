/**
 * Landing-inspired line studies, rendered as thin antialiased instanced ribbons. One small
 * parameter buffer per look keeps simultaneous transitions and thumbnails independent.
 * Geometry follows the line art of the first introduction page (removed in 2026-09; see git
 * history); all assets and rendering stay on the device.
 */
import type { SceneRenderer } from "../../../agent/scenes";
import type { Intent } from "../../director";
import { COMMON_WGSL, type DrawTarget, HDR_FORMAT, type Scene, type SceneContext } from "../scene";
import { type LineMotion, stepLineMotion } from "./line-motion";

type LineRenderer = Extract<SceneRenderer, `line-${string}`>;
const SEGMENTS = 192;
const SHAPES: Record<LineRenderer, number> = {
  "line-waves": 0,
  "line-orbits": 1,
  "line-ribbons": 2,
  "line-lattice": 3,
};

const SHADER = /* wgsl */ `
@group(1) @binding(0) var<uniform> lines: vec4f; // travel, energy, bass, shape
const SEGMENTS: f32 = 192.0;

fn point(t: f32, row: f32) -> vec2f {
  let time = lines.x;
  let energy = lines.y + lines.z * 0.16;
  let angle = t * 2.0 * PI;
  var p: vec2f;
  if (lines.w < 0.5) {
    let envelope = pow(max(0.0, sin(t * PI)), 1.5);
    p = vec2f(20.0 + t * 780.0, 140.0 + row * 5.2
      + sin(t * 14.0 + row * 0.14 + time * 0.35) * (38.0 + energy * 56.0) * envelope);
  } else if (lines.w < 1.5) {
    let ring = row / 28.0 * 2.0 * PI;
    let radius = 108.0 + cos(ring) * (18.0 + energy * 46.0);
    p = vec2f(410.0 + cos(angle) * radius * 2.1,
      220.0 + sin(angle) * radius * 0.65 + sin(ring + time * 0.18) * 57.0);
  } else if (lines.w < 2.5) {
    let ring = row / 38.0 * 2.0 * PI;
    let tube = 59.0 + (10.0 + energy * 12.0) * sin(angle * 3.0 + time * 0.3 + ring * 2.0);
    let radius = 154.0 + tube * cos(ring);
    let x = radius * cos(angle);
    let y = radius * sin(angle);
    let z = tube * sin(ring) + 29.0 * sin(angle * 2.0 + time * 0.2);
    let tilt = -0.26;
    p = vec2f(410.0 + (x * cos(tilt) - y * sin(tilt)) * 1.55,
      220.0 + ((x * sin(tilt) + y * cos(tilt)) * 0.5 - z) * 1.25);
  } else {
    p = vec2f(55.0 + t * 710.0, 88.0 + row * 9.0
      + sin(t * PI * 6.0 + row * 0.29 + time * 0.2) * (12.0 + energy * 38.0) * sin(t * PI));
  }
  let scale = min(vp.x / 820.0, vp.y / 440.0);
  return (p - vec2f(410.0, 220.0)) * scale + vp.xy * 0.5;
}

struct LineVertex {
  @builtin(position) position: vec4f,
  @location(0) edge: f32,
  @location(1) colour: vec3f,
  @location(2) opacity: f32,
}

@vertex fn vs_line(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> LineVertex {
  let t = f32(vertex / 2u) / SEGMENTS;
  let row = f32(instance);
  let p = point(t, row);
  let tangent = point(t + 0.001, row) - point(t - 0.001, row);
  let normal = normalize(vec2f(-tangent.y, tangent.x));
  let edge = select(-1.0, 1.0, vertex % 2u == 1u);
  let width = clamp(vp.x / 820.0, 0.65, 1.7);
  let pixel = p + normal * edge * width;
  var out: LineVertex;
  out.position = vec4f(pixel.x / vp.x * 2.0 - 1.0, 1.0 - pixel.y / vp.y * 2.0, 0.0, 1.0);
  out.edge = edge;
  let blend = clamp(p.x / vp.x * 0.7 + p.y / vp.y * 0.3, 0.0, 1.0);
  out.colour = mix(mix(u.colA.rgb, u.colB.rgb, blend), vec3f(0.65), 0.18);
  let rows = select(28.0, 38.0, lines.w > 1.5 && lines.w < 2.5);
  out.opacity = 0.36 + row / rows * 0.55;
  return out;
}

@fragment fn fs_line(in: LineVertex) -> @location(0) vec4f {
  let coverage = 1.0 - smoothstep(0.25, 1.0, abs(in.edge));
  return vec4f(in.colour * (0.75 + lines.y * 0.3), coverage * in.opacity);
}
`;

export class LinesScene implements Scene {
  ready: Promise<void> = Promise.resolve();
  private ctx!: SceneContext;
  private pipeline: GPURenderPipeline | null = null;
  private params!: GPUBuffer;
  private group!: GPUBindGroup;
  private readonly values = new Float32Array(4);
  private readonly motion: LineMotion = { time: 0, energy: 0.4, bass: 0 };

  constructor(readonly renderer: LineRenderer) {}

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.params = ctx.device.createBuffer({
      label: this.renderer,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = ctx.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.group = ctx.device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.params } }],
    });
    const module = ctx.device.createShaderModule({ label: this.renderer, code: COMMON_WGSL + SHADER });
    this.ready = ctx.device
      .createRenderPipelineAsync({
        label: this.renderer,
        layout: ctx.device.createPipelineLayout({ bindGroupLayouts: [ctx.baseLayout, layout] }),
        vertex: { module, entryPoint: "vs_line" },
        fragment: {
          module,
          entryPoint: "fs_line",
          targets: [
            {
              format: HDR_FORMAT,
              blend: {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              },
            },
          ],
        },
        primitive: { topology: "triangle-strip" },
      })
      .then((pipeline) => {
        this.pipeline = pipeline;
      });
  }

  update(_encoder: GPUCommandEncoder, intent: Intent, dt: number): void {
    stepLineMotion(this.motion, intent, dt);
    this.values.set([this.motion.time, this.motion.energy, this.motion.bass, SHAPES[this.renderer]]);
    this.ctx.device.queue.writeBuffer(this.params, 0, this.values);
  }

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.pipeline) return;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.002, g: 0.003, b: 0.004, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.ctx.baseBindGroup, [target.viewportOffset]);
    pass.setBindGroup(1, this.group);
    pass.draw((SEGMENTS + 1) * 2, this.renderer === "line-ribbons" ? 38 : 28);
    pass.end();
  }

  dispose(): void {
    this.params.destroy();
  }
}
