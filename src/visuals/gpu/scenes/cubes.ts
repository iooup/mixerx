/**
 * Cube Dance (`cubes`): 512 cubes that assemble into formations — a rolling grid, a helix, a
 * sphere, a lattice — one per phrase, and dance on the beat. kick = cubes swell, hats = a few
 * cubes spin, bass = the formation breathes, drop = the formation bursts apart and reassembles,
 * crossfader = colour split, loop = frozen in place.
 */
import type { Intent } from "../../director";
import { CameraOperator, type SceneFrame } from "../camera";
import {
  COMMON_WGSL,
  DEPTH_FORMAT,
  type DrawTarget,
  type EventFlags,
  HDR_FORMAT,
  type Scene,
  type SceneContext,
} from "../scene";

const COUNT = 512;

const SHADER = /* wgsl */ `
struct Cam { viewProj: mat4x4f }
@group(1) @binding(0) var<uniform> cam: Cam;

const N: f32 = ${COUNT}.0;

fn formation(kind: i32, i: i32, t: f32) -> vec3f {
  let fi = f32(i);
  if (kind == 0) {
    // Rolling grid 32 × 16 with a wave through it.
    let x = (f32(i % 32) - 15.5) * 0.17;
    let z = (f32(i / 32) - 7.5) * 0.17;
    let y = 0.3 * sin(x * 2.2 + t * 1.6) * (0.5 + band(i % 64)) + 0.15 * sin(z * 3.0 - t);
    return vec3f(x, y - 0.4, z);
  } else if (kind == 1) {
    // Helix.
    let s = fi / N;
    let angle = s * 25.13 + t * 0.4;
    return vec3f(cos(angle) * 1.25, (s - 0.5) * 2.6, sin(angle) * 1.25);
  } else if (kind == 2) {
    // Fibonacci sphere, breathing with the bass.
    let s = fi / N;
    let y = 1.0 - 2.0 * s;
    let r = sqrt(max(0.0, 1.0 - y * y));
    let phi = fi * 2.399963 + t * 0.15;
    return vec3f(cos(phi) * r, y, sin(phi) * r) * (1.35 + 0.35 * u.bands.x);
  }
  // Lattice 8 × 8 × 8.
  let lx = f32(i % 8) - 3.5;
  let ly = f32((i / 8) % 8) - 3.5;
  let lz = f32(i / 64) - 3.5;
  return vec3f(lx, ly, lz) * (0.34 + 0.06 * u.bands.x);
}

struct CVOut { @builtin(position) pos: vec4f, @location(0) col: vec3f }

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> CVOut {
  let i = i32(ii);
  let fi = f32(i);
  let h = hash11(fi * 0.37 + 1.0);
  // Local cube geometry: 6 faces × 2 triangles, derived from the vertex index.
  let face = i32(vi) / 6;
  let corner = i32(vi) % 6;
  var cu = 0.0; var cv = 0.0;
  if (corner == 1 || corner == 4) { cu = 1.0; }
  if (corner == 2 || corner == 3) { cv = 1.0; }
  if (corner == 5) { cu = 1.0; cv = 1.0; }
  let axis = face / 2;
  let sgn = f32(face % 2) * 2.0 - 1.0;
  var n = vec3f(0.0);
  var t1 = vec3f(0.0);
  var t2 = vec3f(0.0);
  if (axis == 0) { n = vec3f(sgn, 0.0, 0.0); t1 = vec3f(0.0, 1.0, 0.0); t2 = vec3f(0.0, 0.0, sgn); }
  else if (axis == 1) { n = vec3f(0.0, sgn, 0.0); t1 = vec3f(0.0, 0.0, 1.0); t2 = vec3f(sgn, 0.0, 0.0); }
  else { n = vec3f(0.0, 0.0, sgn); t1 = vec3f(sgn, 0.0, 0.0); t2 = vec3f(0.0, 1.0, 0.0); }
  let local = n * 0.5 + (cu - 0.5) * t1 + (cv - 0.5) * t2;

  // Formation: morph from the previous phrase's shape over the first two bars.
  let phrase = i32(u.counts.z);
  let cur = phrase % 4;
  let prev = (phrase + 3) % 4;
  let blend = smoothstep(0.0, 0.25, u.beat.z);
  let t = u.time.x * (0.4 + 0.8 * u.colB.w) * (1.0 - 0.95 * u.gest.z);
  var centre = mix(formation(prev, i, t), formation(cur, i, t), blend);
  // Anticipation gathers the lattice toward its own centre, ready to be thrown apart.
  centre = centre * (1.0 - 0.3 * anticipation());
  // Drop: burst apart (and reassemble as the burst decays); the seed scatters direction.
  let away = normalize(centre + vec3f(0.001, 0.002, 0.003));
  centre = centre + away * u.fx.y * (1.6 + 1.2 * h) + (hash11(fi + u.time.w) - 0.5) * u.fx.y;
  // Dance: swell on the kick, spin on the beat (hats spin a few harder), settle between beats.
  let settle = pow(1.0 - u.beat.x, 2.0);
  let size = 0.12 * (0.75 + 0.45 * u.audio.x * (0.5 + h)) * (1.0 + 0.5 * u.fx.y) * (0.85 + 0.3 * u.colA.w);
  let spin = u.beat.x * 6.2831853 * select(0.0, 1.0, h > 0.5) * (0.25 + u.colB.w) * (1.0 - u.gest.z)
    + u.hits.y * 0.3 * step(0.92, h) + t * 0.5;
  let cs = cos(spin); let sn = sin(spin);
  let ry = mat3x3f(vec3f(cs, 0.0, -sn), vec3f(0.0, 1.0, 0.0), vec3f(sn, 0.0, cs));
  let tilt = u.beat.y * 6.2831853 * 0.02 + settle * 0.15 * (h - 0.5);
  let ct = cos(tilt); let st = sin(tilt);
  let rx = mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, ct, st), vec3f(0.0, -st, ct));
  let rot = ry * rx;
  let world = centre + rot * local * size + vec3f(0.0, settle * 0.08 * u.colA.w, 0.0);
  let wn = normalize(rot * n);
  // Lighting: A from the left, B from the right, ambient from the background.
  let lA = normalize(vec3f(-1.0, 1.2, 0.8));
  let lB = normalize(vec3f(1.0, 0.6, -0.4));
  let side = smoothstep(-1.2, 1.2, centre.x - (u.gest.y * 2.0 - 1.0) * 1.2);
  let base = side_colour(side);
  let lit = base * (0.25 + 0.75 * max(dot(wn, lA), 0.0)) + u.accent.rgb * 0.25 * max(dot(wn, lB), 0.0)
    + u.bg.rgb * 2.0;
  let sparkle = step(0.97, hash11(fi * 3.1 + u.hits.y)) * u.audio.z;
  var out: CVOut;
  out.pos = cam.viewProj * vec4f(world, 1.0);
  out.col = (lit + u.accent.rgb * sparkle) * (0.4 + 0.9 * u.colA.w) * (1.0 + 0.3 * u.audio.x);
  return out;
}

@fragment fn fs(in: CVOut) -> @location(0) vec4f {
  return vec4f(in.col, 1.0);
}
`;

export class CubesScene implements Scene {
  readonly renderer = "cubes" as const;
  private ctx!: SceneContext;
  ready: Promise<void> = Promise.resolve();
  private pipeline: GPURenderPipeline | null = null;
  private layout!: GPUBindGroupLayout;
  private readonly camera = new CameraOperator();
  /** A lattice about 2.6 units across, standing on a notional floor. */
  private static readonly FRAME: SceneFrame = {
    distance: 5.4,
    height: 1.9,
    centre: [0, 0, 0],
    floorY: -0.5,
    fovDeg: 48,
  };

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    const device = ctx.device;
    this.layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const module = device.createShaderModule({ code: `${COMMON_WGSL}\n${SHADER}` });
    this.ready = device
      .createRenderPipelineAsync({
        label: "cubes",
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.baseLayout, this.layout] }),
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: "triangle-list", cullMode: "back" },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
      })
      .then((pipeline) => {
        this.pipeline = pipeline;
      });
  }

  update(_encoder: GPUCommandEncoder, intent: Intent, dt: number, events: EventFlags): void {
    this.camera.step(intent, dt, events);
  }

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.pipeline) return;
    const group = this.ctx.device.createBindGroup({
      layout: this.layout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.camera.buffer(
              this.ctx.device,
              CubesScene.FRAME,
              target.width / Math.max(1, target.height),
              "view-proj",
            ),
          },
        },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
      depthStencilAttachment: {
        view: this.ctx.depthFor(target.width, target.height),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.ctx.baseBindGroup, [target.viewportOffset]);
    pass.setBindGroup(1, group);
    pass.draw(36, COUNT);
    pass.end();
  }

  dispose(): void {
    this.camera.dispose();
  }
}
