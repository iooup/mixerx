/**
 * Monolith (`body-pulse`): a raymarched signed-distance solid morphing between a Menger sponge,
 * a gyroid shell and a folded octahedron. bass = mass, mids = cavity depth, treble = edge sheen,
 * bar = rotation step, phrase = morph target, drop = shatter + camera cut, LOW kill = floor removed.
 */
import type { Intent } from "../../director";
import { CameraOperator, type SceneFrame } from "../camera";
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
fn sd_box(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sd_menger(p0: vec3f) -> f32 {
  var d = sd_box(p0, vec3f(1.0));
  var s = 1.0;
  for (var i = 0; i < 3; i = i + 1) {
    let q = p0 * s;
    let a = q - 2.0 * floor(q * 0.5) - 1.0; // mod(q, 2) - 1
    s = s * 3.0;
    let r = abs(1.0 - 3.0 * abs(a));
    let da = max(r.x, r.y);
    let db = max(r.y, r.z);
    let dc = max(r.z, r.x);
    let c = (min(da, min(db, dc)) - 1.0) / s;
    d = max(d, c);
  }
  return d;
}

fn sd_gyroid(p: vec3f, thickness: f32) -> f32 {
  let k = 3.4;
  let g = abs(dot(sin(p * k), cos(p.zxy * k))) / k - thickness;
  return max(g, sd_box(p, vec3f(1.0)));
}

fn sd_octa(p0: vec3f) -> f32 {
  var p = p0;
  var s = 1.0;
  for (var i = 0; i < 3; i = i + 1) {
    p = abs(p);
    if (p.x < p.y) { p = p.yxz; }
    if (p.x < p.z) { p = p.zyx; }
    if (p.y < p.z) { p = p.xzy; }
    p = p * 2.0 - vec3f(1.0, 0.6, 0.2);
    s = s * 2.0;
  }
  let m = (abs(p.x) + abs(p.y) + abs(p.z) - 1.0) * 0.57735 / s;
  return max(m, sd_box(p0, vec3f(1.05)));
}

fn morph_weights() -> vec3f {
  let phrase = i32(u.counts.z);
  let cur = phrase % 3;
  let prev = (phrase + 2) % 3;
  let t = smoothstep(0.0, 0.125, u.beat.z);
  var w = vec3f(0.0);
  w[prev] = 1.0 - t;
  w[cur] = w[cur] + t;
  return w;
}

fn sd_scene(p0: vec3f) -> f32 {
  // Anticipation contracts the monolith: it gathers itself before the drop blows it open.
  let mass = (1.0 + 0.45 * u.bands.x + 0.25 * u.audio.x) * (1.0 - 0.18 * anticipation());
  let step = u.counts.y + smoothstep(0.0, 0.3, u.beat.y);
  let angle = step * 0.2618 + u.time.x * 0.08 * u.colB.w + hash11(u.time.w) * 6.28 * 0.0;
  var p = p0;
  let r = rot2(angle);
  p = vec3f(r * p.xz, p.y).xzy;
  let tilt = rot2(0.5 + 0.35 * sin(u.time.x * 0.11 * u.colB.w));
  p = vec3f(p.x, tilt * p.yz);
  p = p / mass;
  p = p + (noise3(p * 3.0 + u.time.w) - 0.5) * u.fx.y * 0.5;
  let w = morph_weights();
  let thickness = 0.02 + 0.1 * (1.0 - u.bands.y);
  var d = 1e9;
  if (w.x > 0.001) { d = min(d, sd_menger(p) + (1.0 - w.x) * 0.6); }
  if (w.y > 0.001) { d = min(d, sd_gyroid(p, thickness) + (1.0 - w.y) * 0.6); }
  if (w.z > 0.001) { d = min(d, sd_octa(p) + (1.0 - w.z) * 0.6); }
  d = d * mass;
  let floor_d = p0.y + 1.35 + (1.0 - u.fx.w) * 20.0;
  return min(d, floor_d);
}

fn normal_at(p: vec3f) -> vec3f {
  let e = vec2f(0.002, 0.0);
  return normalize(vec3f(
    sd_scene(p + e.xyy) - sd_scene(p - e.xyy),
    sd_scene(p + e.yxy) - sd_scene(p - e.yxy),
    sd_scene(p + e.yyx) - sd_scene(p - e.yyx)));
}

fn ao(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  for (var i = 1; i <= 4; i = i + 1) {
    let h = 0.03 + 0.12 * f32(i);
    let d = sd_scene(p + n * h);
    occ = occ + (h - d) * sca;
    sca = sca * 0.6;
  }
  return clamp(1.0 - 2.5 * occ, 0.0, 1.0);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let aspect = vp.z;
  var uv = (in.uv - 0.5) * vec2f(aspect, 1.0) * 2.0;
  uv.y = -uv.y;
  let steps = select(select(48, 64, u.time.z > 0.5), 80, u.time.z > 1.5);
  // The shared camera operator writes eye, target and lens into the scene-private slots, so this
  // raymarcher answers the same shots (wide, push, low, top, handheld) as the mesh scenes.
  let ro = u.scene0.xyz;
  let ta = u.scene1.xyz;
  let lens = u.scene0.w;
  let f = normalize(ta - ro);
  let rgt = normalize(cross(f, vec3f(0.0, 1.0, 0.0)));
  let up = cross(rgt, f);
  let rd = normalize(uv.x * rgt + uv.y * up + lens * f);
  var t = 0.0;
  var hit = false;
  var p = ro;
  for (var i = 0; i < 80; i = i + 1) {
    if (i >= steps) { break; }
    p = ro + rd * t;
    let d = sd_scene(p);
    if (d < 0.0015 * (1.0 + t)) { hit = true; break; }
    t = t + d * 0.85;
    if (t > 14.0) { break; }
  }
  let fog = u.bg.rgb * (0.6 + 0.6 * u.colA.w);
  var col = fog * (1.0 - smoothstep(0.0, 1.4, length(uv)) * 0.6);
  if (hit) {
    let n = normal_at(p);
    let lA = normalize(vec3f(-1.2, 1.4, 0.8));
    let lB = normalize(vec3f(1.3, 0.6, -0.6));
    let occ = mix(1.0, ao(p, n), 0.6 + 0.4 * u.bands.y);
    let dA = max(dot(n, lA), 0.0);
    let dB = max(dot(n, lB), 0.0);
    let fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    let sheen = fres * (0.3 + 2.5 * u.bands.z);
    let onFloor = step(abs(p.y + 1.35), 0.02);
    let base = mix(u.colA.rgb, u.colB.rgb, u.fx.z);
    let baseB = mix(u.colB.rgb, u.colA.rgb, u.fx.z);
    var lit = (base * dA * 0.9 + baseB * dB * 0.7) * occ + u.accent.rgb * sheen * occ;
    lit = lit + base * u.audio.x * 0.25;
    let floorCol = fog * 2.0 * occ * (0.4 + 0.6 * dA) * u.fx.w;
    col = mix(lit, floorCol, onFloor);
    col = mix(col, fog, smoothstep(4.0, 13.0, t));
  }
  col = col * (0.35 + 0.9 * u.colA.w);
  return vec4f(col, 1.0);
}
`;

export class MonolithScene implements Scene {
  readonly renderer = "monolith" as const;
  private ctx!: SceneContext;
  ready: Promise<void> = Promise.resolve();
  private pipeline: GPURenderPipeline | null = null;
  private readonly camera = new CameraOperator();
  /**
   * A solid standing on a floor at y = −1.35. Its `mass` grows with the bass (`sd_scene`), so the
   * frame's minimum distance grows with it: a push-in must never end up inside the shape.
   */
  private frame: SceneFrame = {
    distance: 3.6,
    height: 0.9,
    centre: [0, -0.1, 0],
    floorY: -1.1,
    minDistance: 2.6,
    fovDeg: 64,
  };

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.ready = fullscreenPipelineAsync(ctx, "monolith", FRAGMENT).then((pipeline) => {
      this.pipeline = pipeline;
    });
  }

  update(_encoder: GPUCommandEncoder, intent: Intent, dt: number, events: EventFlags): void {
    this.camera.step(intent, dt, events);
    // `mass` in the shader; the camera keeps clear of the shape at its current size.
    const mass = 1 + 0.45 * intent.audio.bass + 0.25 * intent.audio.kick;
    this.frame = { ...this.frame, minDistance: 2.35 * mass };
    // The raymarcher builds its rays in the shader, so the camera crosses in the private slots:
    // scene0 = eye + lens (the focal multiplier), scene1 = what it is looking at.
    const { eye, target, fovDeg } = this.camera.currentView(this.frame);
    const lens = 1 / Math.tan(((fovDeg * Math.PI) / 180) * 0.5);
    writePrivate(this.ctx, 0, [eye[0], eye[1], eye[2], lens]);
    writePrivate(this.ctx, 1, [target[0], target[1], target[2], 0]);
  }

  draw(encoder: GPUCommandEncoder, target: DrawTarget): void {
    if (!this.pipeline) return;
    drawFullscreen(encoder, this.pipeline, target, this.ctx.baseBindGroup);
  }

  dispose(): void {
    this.camera.dispose();
  }
}
