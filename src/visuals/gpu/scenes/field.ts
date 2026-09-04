/**
 * Kick Field (`drop-burst`), 3-D: a galaxy of particles orbiting the crossfader point. Particles
 * live on a thin disc with spiral arms and true orbits (gravity + tangential velocity), seen from
 * an elevated camera that circles slowly. kick = a shockwave ring travelling out through the disc,
 * bass = gravity (the disc tightens), hats = sparkles, phrase = new arm count, drop = the disc
 * explodes into a sphere and collapses back with the colours swapped, crossfader = the galaxy's
 * centre slides, loop = time freeze. Perspective size and depth fog carry the depth.
 */
import type { Intent } from "../../director";
import { CameraOperator, type SceneFrame } from "../camera";
import {
  COMMON_WGSL,
  type DrawTarget,
  type EventFlags,
  HDR_FORMAT,
  type Scene,
  type SceneContext,
  writePrivate,
} from "../scene";
import { TARGET_CAP } from "../targets";

const COUNTS = { low: 8192, medium: 32768, high: 65536 } as const;

const PARTICLE_STRUCT = /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f, extra: vec4f }
// pos.xyz position, pos.w life · vel.xyz velocity, vel.w kind · extra.x spark, extra.y radius0
`;

const COMPUTE = /* wgsl */ `
${PARTICLE_STRUCT}
@group(1) @binding(0) var<storage, read_write> particles: array<Particle>;
// The message: xy inside the mask, w the pixel's weight. scene0.y is how assembled it is,
// scene0.w how many points it has, scene1.xyz where the camera is watching from.
@group(1) @binding(1) var<storage, read> targets: array<vec4f>;

// Where a point of the message sits in the world: a plane between the disc and the camera.
fn target_world(i: u32) -> vec3f {
  let t = targets[i];
  // Anchored on what the camera is looking at, not on the attractor: the crossfader slides the
  // galaxy sideways, but a word half off the screen is not a message.
  let a = vec3f(0.0, -0.15, 0.0);
  let eye = u.scene1.xyz;
  let toCam = normalize(eye - a + vec3f(0.0, 0.001, 0.0));
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam));
  let up = cross(toCam, right);
  let spin = u.scene1.w;
  let c = cos(spin);
  let sn = sin(spin);
  // A slow rotation of the plane in its own axes, so the word breathes instead of sitting flat.
  let r = right * c + toCam * sn;
  // The word is sized to the frame, not to the world: it hangs a third of the way to the camera
  // and always fills about four fifths of the width, whatever shot the operator has cut to.
  let dist = length(eye - a);
  let scale = min(0.088, 0.055 * vp.z) * dist;
  return a + toCam * (dist * 0.33) + r * (t.x * scale) + up * (t.y * scale);
}

fn pcg(v0: u32) -> u32 {
  let v = v0 * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand01(i: u32) -> f32 { return f32(pcg(i)) / 4294967295.0; }

fn attractor() -> vec3f { return vec3f((u.gest.y * 2.0 - 1.0) * 0.9, 0.0, 0.0); }

fn spawn(i: u32, seed: f32) -> Particle {
  let s = u32(seed * 1013.0) + 17u;
  let r0 = rand01(i * 4u + s);
  let r1 = rand01(i * 4u + 1u + s);
  let r2 = rand01(i * 4u + 2u + s);
  let radius = 0.22 + 1.75 * sqrt(r0);
  let angle = r1 * 6.2831853;
  let thickness = 0.24 * (1.0 - radius / 2.2) + 0.04;
  let a = attractor();
  var p: Particle;
  let pos = a + vec3f(cos(angle) * radius, (r2 - 0.5) * thickness, sin(angle) * radius);
  // Circular orbit: tangential speed for the gravity in force().
  let g = 1.1;
  let speed = sqrt(g / radius);
  let tangent = vec3f(-sin(angle), 0.0, cos(angle));
  p.pos = vec4f(pos, 2.5 + rand01(i * 7u + s) * 6.0);
  p.vel = vec4f(tangent * speed * (0.85 + 0.3 * rand01(i * 9u + s)), rand01(i * 11u + 3u));
  p.extra = vec4f(0.0, radius, 0.0, 0.0);
  return p;
}

@compute @workgroup_size(256) fn cs(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&particles)) { return; }
  var p = particles[i];
  let dt = min(u.time.y, 0.05);
  let motion = u.colB.w;
  let seed = u.time.w;
  let freeze = u.gest.z;
  let a = attractor();
  if (p.pos.w <= 0.0 || (u.gest.w > 0.5 && fract(seed * 0.618 + p.vel.w) < 0.3)) {
    p = spawn(i + u32(seed * 7.0), seed);
  }
  let rel = p.pos.xyz - a;
  let flat = vec3f(rel.x, 0.0, rel.z);
  let r = max(length(flat), 0.05);
  let radial = flat / r;
  let tangent = vec3f(-radial.z, 0.0, radial.x);
  var vel = p.vel.xyz;
  // A particle carrying the message answers to the message, not to the galaxy: while it is
  // assembled the orbital forces let go of it, so the word sits exactly where it was written.
  let morph = u.scene0.y;
  let count = u32(max(0.0, u.scene0.w));
  let inWord = select(0.0, morph, i < count);
  let fieldGain = 1.0 - inWord;
  // Gravity toward the centre (the bass tightens the disc), a soft core, a spring to the disc plane.
  // Anticipation adds a steady inward pull: the galaxy draws in before the drop scatters it.
  let antic = anticipation();
  vel = vel - radial * antic * (1.4 + 0.8 * r) * dt * fieldGain;
  let g = 0.9 + 1.7 * u.bands.x;
  vel = vel - radial * (g / max(r * r, 0.16)) * dt * fieldGain;
  vel = vel + radial * (0.6 / (r * r + 0.05)) * step(r, 0.45) * dt * fieldGain;
  vel.y = vel.y - rel.y * (3.0 + 4.0 * u.bands.x) * dt * fieldGain;
  // Spiral arms: a torque toward the nearest arm; the phrase re-seeds their count.
  let arms = 2.0 + floor(hash11(seed * 3.7) * 4.0);
  let angle = atan2(rel.z, rel.x);
  let armPhase = fract((angle - 0.8 * r) * arms / 6.2831853 + 0.5) - 0.5;
  vel = vel - tangent * armPhase * (3.2 + 1.2 * motion) * dt * fieldGain;
  vel = vel + tangent * 0.35 * motion * dt * fieldGain;
  // Turbulence.
  let swirl = curl2(vec2f(rel.x, rel.z) * 0.9 + vec2f(u.time.x * 0.05, seed * 0.1));
  vel = vel + vec3f(swirl.x, (noise2(vec2f(rel.x, rel.z) * 2.0 + u.time.x * 0.1) - 0.5) * 0.6, swirl.y) * 0.25 * motion * dt * fieldGain;
  // Kick: a shockwave ring travelling outward (scene0.x = ring age, scene0.z = strength).
  let ringR = u.scene0.x * 2.2;
  let band = exp(-pow((r - ringR) / 0.22, 2.0)) * u.scene0.z * exp(-u.scene0.x * 1.4);
  vel = vel + (radial * 3.2 + vec3f(0.0, 1.4, 0.0) * (rand01(i * 13u) - 0.3)) * band * dt * 6.0 * fieldGain;
  // Drop: explode into a sphere, then gravity and the plane spring pull it back.
  let sphereDir = normalize(rel + vec3f(0.001, 0.002, 0.003));
  vel = vel + sphereDir * u.fx.y * 5.0 * dt + (vec3f(rand01(i * 3u), rand01(i * 5u), rand01(i * 7u)) - 0.5) * u.fx.y * 2.0 * dt;
  // The message: the first N particles are sprung toward their point in the word, the rest keep
  // orbiting. A drop releases them into the explosion above, which is why this comes last.
  if (morph > 0.001 && i < count) {
    let want = target_world(i);
    let pull = want - p.pos.xyz;
    let w = targets[i].w;
    vel = vel + pull * (14.0 * morph * (0.5 + 0.5 * w)) * dt;
    vel = vel * exp(-dt * 7.0 * morph);
    p.pos.w = max(p.pos.w, 1.0); // a particle in the word never dies mid-letter
  }
  // Damping, freeze, integration.
  vel = vel * exp(-dt * (0.35 + 3.0 * freeze));
  let speed = length(vel);
  if (speed > 4.0) { vel = vel / speed * 4.0; }
  p.vel = vec4f(vel, p.vel.w);
  p.pos = vec4f(p.pos.xyz + vel * dt * (1.0 - 0.96 * freeze), p.pos.w - dt * (1.0 - 0.9 * freeze));
  if (morph < 0.05 && length(p.pos.xyz - a) > 4.8) { p = spawn(i * 3u + 7u, seed + 0.5); }
  // Hats make a random subset sparkle.
  let pick = step(0.9, hash11(p.vel.w * 91.0 + u.hits.y));
  p.extra.x = max(p.extra.x * exp(-dt * 9.0), u.events.z * pick);
  particles[i] = p;
}
`;

const RENDER = /* wgsl */ `
${PARTICLE_STRUCT}
@group(1) @binding(0) var<storage, read> particles: array<Particle>;
struct Cam { view: mat4x4f, proj: mat4x4f }
@group(1) @binding(1) var<uniform> cam: Cam;

struct PVOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f, @location(2) glow: f32 }

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PVOut {
  var quad = array<vec2f, 6>(vec2f(-1.0,-1.0), vec2f(1.0,-1.0), vec2f(-1.0,1.0), vec2f(-1.0,1.0), vec2f(1.0,-1.0), vec2f(1.0,1.0));
  let p = particles[ii];
  let corner = quad[vi];
  let kind = p.vel.w;
  let spark = p.extra.x;
  let viewPos = (cam.view * vec4f(p.pos.xyz, 1.0)).xyz;
  let depth = max(0.3, -viewPos.z);
  let tierGain = select(select(1.0, 1.4, u.time.z < 1.5), 3.0, u.time.z < 0.5);
  // Particles carrying the DJ's message read as the message: bigger, in the accent colour, while
  // the rest of the galaxy steps back. Nothing gets brighter — the field around it gets dimmer.
  let morphAmount = u.scene0.y;
  let inWord = select(0.0, morphAmount, ii < u32(max(0.0, u.scene0.w)));
  let sizeScale = max(0.6, vp.y / 540.0);
  // Screen-size billboard with perspective: nearer particles are larger. The reference is the
  // camera's own distance, so a push-in reframes the galaxy without also doubling its brightness.
  let camDist = max(1.0, length((cam.view * vec4f(0.0, 0.0, 0.0, 1.0)).xyz));
  let px = (2.6 + 2.4 * u.colA.w + 2.0 * u.fx.y + 6.0 * spark) * (0.5 + kind) * sizeScale
    * (0.7 + 0.3 * tierGain) * (0.5625 * camDist / depth) * (1.0 - 0.5 * inWord);
  var clip = cam.proj * vec4f(viewPos, 1.0);
  clip = vec4f(clip.xy + corner * px * 2.0 / vp.xy * clip.w, clip.zw);
  var out: PVOut;
  out.pos = clip;
  out.uv = corner;
  let a = vec3f((u.gest.y * 2.0 - 1.0) * 0.9, 0.0, 0.0);
  let rel = p.pos.xyz - a;
  let r = length(vec2f(rel.x, rel.z));
  let ring = smoothstep(0.15, 2.0, r);
  let swap = step(0.5, u.fx.z);
  let inner = mix(u.colA.rgb, u.colB.rgb, swap);
  let outer = mix(u.colB.rgb, u.colA.rgb, swap);
  var col = mix(inner, outer, ring);
  col = mix(col, u.accent.rgb, smoothstep(0.15, 0.5, abs(rel.y)) * 0.6 + spark * 0.7 + inWord * 0.55);
  let speedGlow = smoothstep(0.3, 2.5, length(p.vel.xyz));
  let fog = 1.0 / (1.0 + depth * depth * 0.02);
  let nearFade = smoothstep(0.3, 1.2, depth);
  out.col = col;
  out.glow = (0.09 + 0.14 * u.colA.w + 0.12 * speedGlow + 0.14 * u.audio.x * kind + 0.6 * spark + 0.1 * u.fx.y)
    * smoothstep(0.0, 0.6, p.pos.w) * fog * nearFade * tierGain
    * (1.0 - 0.6 * morphAmount * (1.0 - step(0.001, inWord)))
    * (1.0 - 0.55 * inWord);
  return out;
}

@fragment fn fs(in: PVOut) -> @location(0) vec4f {
  let d = length(in.uv);
  let a = smoothstep(1.0, 0.0, d);
  let c = in.col * in.glow * a * a;
  return vec4f(c, 1.0);
}
`;

export class KickFieldScene implements Scene {
  readonly renderer = "field" as const;
  private ctx!: SceneContext;
  private count: number = COUNTS.medium;
  private buffer!: GPUBuffer;
  private targets!: GPUBuffer;
  private targetCount = 0;
  private morph = 0;
  private spin = 0;
  ready: Promise<void> = Promise.resolve();
  private computePipeline: GPUComputePipeline | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private computeGroup!: GPUBindGroup;
  private renderLayout!: GPUBindGroupLayout;
  private readonly camera = new CameraOperator();
  private kickAge = 10;
  private kickStrength = 0;

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.count = COUNTS[ctx.quality];
    const device = ctx.device;
    this.buffer = device.createBuffer({
      label: "kick-field particles",
      size: this.count * 48,
      usage: GPUBufferUsage.STORAGE,
    });
    this.targets = device.createBuffer({
      label: "kick-field message targets",
      size: TARGET_CAP * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const computeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    this.renderLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    });
    const renderModule = device.createShaderModule({ code: `${COMMON_WGSL}\n${RENDER}` });
    this.ready = Promise.all([
      device.createComputePipelineAsync({
        label: "kick-field compute",
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.baseLayout, computeLayout] }),
        compute: {
          module: device.createShaderModule({ code: `${COMMON_WGSL}\n${COMPUTE}` }),
          entryPoint: "cs",
        },
      }),
      device.createRenderPipelineAsync({
        label: "kick-field render",
        layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.baseLayout, this.renderLayout] }),
        vertex: { module: renderModule, entryPoint: "vs" },
        fragment: {
          module: renderModule,
          entryPoint: "fs",
          targets: [
            {
              format: HDR_FORMAT,
              blend: {
                color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      }),
    ]).then(([compute, render]) => {
      this.computePipeline = compute;
      this.renderPipeline = render;
    });
    this.computeGroup = device.createBindGroup({
      layout: computeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: { buffer: this.targets } },
      ],
    });
  }

  update(encoder: GPUCommandEncoder, intent: Intent, dt: number, events: EventFlags): void {
    if (events.kick) {
      this.kickAge = 0;
      this.kickStrength = 0.5 + 0.5 * intent.audio.kick;
    }
    this.kickAge += dt * (0.9 + 0.6 * intent.motion) * (1 - 0.95 * intent.freeze);
    // The shared operator drives the camera: it circles, cuts on bars and shakes on the kick.
    this.camera.step(intent, dt, events);
    this.morph = intent.morph;
    this.spin += dt * 0.22 * (intent.reducedMotion ? 0 : 1);
    const view = this.camera.currentView(KickFieldScene.FRAME);
    writePrivate(this.ctx, 0, [this.kickAge, this.morph, this.kickStrength, this.targetCount]);
    writePrivate(this.ctx, 1, [view.eye[0], view.eye[1], view.eye[2], Math.sin(this.spin) * 0.16]);
    if (!this.computePipeline) return;
    const pass = encoder.beginComputePass({ label: "kick-field simulate" });
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.ctx.baseBindGroup, [0]);
    pass.setBindGroup(1, this.computeGroup);
    pass.dispatchWorkgroups(Math.ceil(this.count / 256));
    pass.end();
  }

  /** The galaxy's own frame: a disc about 2.2 units across, seen from above its plane. */
  private static readonly FRAME: SceneFrame = {
    distance: 6.4,
    height: 3.8,
    centre: [0, -0.15, 0],
    // Never below the disc: a shot from underneath is looking at the back of every billboard, and
    // dead level with it the arms disappear into a line.
    floorY: 0.7,
    // A push-in stops where the disc still fits the frame; closer than this it is only glare.
    minDistance: 4.6,
    fovDeg: 46,
  };

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.renderPipeline) return;
    const group = this.ctx.device.createBindGroup({
      layout: this.renderLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        {
          binding: 1,
          resource: {
            buffer: this.camera.buffer(
              this.ctx.device,
              KickFieldScene.FRAME,
              target.width / Math.max(1, target.height),
            ),
          },
        },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.ctx.baseBindGroup, [target.viewportOffset]);
    pass.setBindGroup(1, group);
    pass.draw(6, this.count);
    pass.end();
  }

  /** The shape the particles assemble into; `null` clears it. Uploaded once per message. */
  setTargets(points: Float32Array | null, count: number): void {
    this.targetCount = Math.max(0, Math.min(TARGET_CAP, Math.min(count, this.count)));
    if (!points || this.targetCount === 0) return;
    this.ctx.device.queue.writeBuffer(this.targets, 0, points, 0, this.targetCount * 4);
  }

  dispose(): void {
    this.buffer?.destroy();
    this.targets?.destroy();
    this.camera.dispose();
  }
}
