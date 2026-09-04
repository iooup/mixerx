/**
 * Phillips / Stockham / particle shading adapted from Vercel's vgpu FFT ocean example (MIT).
 * https://vgpu.sh/examples/fft-ocean — see docs/licenses/vgpu-MIT.txt.
 * Runs on our existing device and HDR chain; no vgpu runtime or external assets are needed.
 */
import { OCEAN_SIZE, OCEAN_WORLD_SIZE } from "./ocean-spectrum";

export function oceanComputeShaders(resolution: number) {
  const common = /* wgsl */ `
const N: u32 = ${resolution}u;
const PI: f32 = 3.14159265359;
@group(0) @binding(0) var<storage, read> source: array<vec4f>;
@group(0) @binding(2) var<uniform> params: array<vec4f, 2>;
fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
fn at(p: vec2i) -> vec4f {
  let wrapped = vec2u((p % i32(N) + i32(N)) % i32(N));
  return source[wrapped.y * N + wrapped.x];
}
`;
  return {
    spectrum: `${common}
@group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(8, 8) fn evolve(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N || id.y >= N) { return; }
  let index = id.y * N + id.x;
  let k = (2.0 * PI / ${OCEAN_SIZE}.0) * vec2f(vec2i(
    select(i32(id.x) - i32(N), i32(id.x), id.x < N / 2u),
    select(i32(id.y) - i32(N), i32(id.y), id.y < N / 2u)));
  let kLen = length(k);
  let phase = sqrt(9.81 * kLen) * params[0].x;
  let h0 = source[index];
  let h = cmul(h0.xy, vec2f(cos(phase), sin(phase)))
        + cmul(h0.zw, vec2f(cos(phase), -sin(phase)));
  let direction = k / max(kLen, 0.00001);
  let chop = 1.51;
  let hx = vec2f(h.y, -h.x) * direction.x * chop;
  let hz = vec2f(h.y, -h.x) * direction.y * chop;
  // Two complex transforms pack three real fields: dx + i*height, dz.
  result[index] = vec4f(hx.x - h.y, hx.y + h.x, hz);
}
`,
    ifft: `${common}
@group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(8, 8) fn transform(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N || id.y >= N) { return; }
  let horizontal = params[0].y > 0.5;
  let index = select(id.y, id.x, horizontal);
  let size = u32(params[0].x);
  let evenIndex = (index / size) * (size / 2u) + index % (size / 2u);
  let a = select(vec2u(id.x, evenIndex), vec2u(evenIndex, id.y), horizontal);
  let b = select(vec2u(id.x, evenIndex + N / 2u), vec2u(evenIndex + N / 2u, id.y), horizontal);
  let even = source[a.y * N + a.x];
  let odd = source[b.y * N + b.x];
  let phase = 2.0 * PI * f32(index) / f32(size);
  let twiddle = vec2f(cos(phase), sin(phase));
  // Unnormalised inverse: the physical spectrum's scale is applied once in surface().
  result[id.y * N + id.x] = vec4f(even.xy + cmul(twiddle, odd.xy), even.zw + cmul(twiddle, odd.zw));
}
`,
    surface: `${common}
struct Surface { displacement: vec4f, normalFoam: vec4f }
@group(0) @binding(1) var<storage, read_write> result: array<Surface>;
fn displacement(p: vec2i) -> vec3f {
  let scale = 0.005 * params[0].y;
  var d = at(p).xyz * scale;
  let z = (f32(p.y) / f32(N) - 0.5) * ${OCEAN_WORLD_SIZE}.0;
  let front = (80.0 - z) - params[0].z * 38.0;
  d.y += exp(-front * front / 90.0) * params[0].w * 2.8;
  return d;
}
@compute @workgroup_size(8, 8) fn surface(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N || id.y >= N) { return; }
  let p = vec2i(id.xy);
  let spacing = ${OCEAN_WORLD_SIZE}.0 / f32(N);
  let dx = (displacement(p + vec2i(1, 0)) - displacement(p - vec2i(1, 0))) / (2.0 * spacing);
  let dz = (displacement(p + vec2i(0, 1)) - displacement(p - vec2i(0, 1))) / (2.0 * spacing);
  let normal = normalize(vec3f(-dx.y, 1.0, -dz.y));
  let jacobian = (1.0 + dx.x) * (1.0 + dz.z) - dx.z * dz.x;
  let foam = 1.0 - smoothstep(0.0, 0.8, jacobian);
  result[id.y * N + id.x] = Surface(vec4f(displacement(p), 0.0), vec4f(normal, foam));
}
`,
  };
}

export function oceanParticleShader(resolution: number): string {
  return /* wgsl */ `
const N: u32 = ${resolution}u;
struct Surface { displacement: vec4f, normalFoam: vec4f }
struct Camera { viewProj: mat4x4f, eye: vec4f, settings: vec4f }
@group(1) @binding(0) var<storage, read> ocean: array<Surface>;
@group(1) @binding(1) var<uniform> cam: Camera;
fn ocean_at(p: vec2u) -> Surface { return ocean[(p.y % N) * N + p.x % N]; }
struct OceanVertex {
  @builtin(position) position: vec4f,
  @location(0) point: vec2f,
  @location(1) colour: vec3f,
  @location(2) alpha: f32,
}
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> OceanVertex {
  let grid = u32(cam.settings.x);
  let cell = vec2f(f32(instance % grid), f32(instance / grid));
  // Stable sub-cell jitter removes the rigid dot lattice without introducing flicker.
  let uv = (cell + vec2f(0.5) + (hash22(cell) - 0.5) * 0.45) / f32(grid);
  let coord = uv * f32(N);
  let p = vec2u(floor(coord));
  let blend = fract(coord);
  let a = ocean_at(p); let b = ocean_at(p + vec2u(1, 0));
  let c = ocean_at(p + vec2u(0, 1)); let d = ocean_at(p + vec2u(1, 1));
  let disp = mix(mix(a.displacement, b.displacement, blend.x), mix(c.displacement, d.displacement, blend.x), blend.y).xyz;
  let nf = mix(mix(a.normalFoam, b.normalFoam, blend.x), mix(c.normalFoam, d.normalFoam, blend.x), blend.y);
  let world = vec3f((uv.x - 0.5) * ${OCEAN_WORLD_SIZE}.0, 0.0, (uv.y - 0.5) * ${OCEAN_WORLD_SIZE}.0) + disp;
  let projected = cam.viewProj * vec4f(world, 1.0);
  let corner = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(-1,1), vec2f(1,-1), vec2f(1,1))[vertex];
  // Scale with the output height: small thumbnails retain the same field of waves.
  let diameter = clamp(vp.y / 480.0, 1.0, 3.0) * cam.settings.y;
  let offset = corner * diameter / vp.xy * projected.w;
  let viewDir = normalize(cam.eye.xyz - world);
  let fresnel = pow(1.0 - clamp(dot(normalize(nf.xyz), viewDir), 0.0, 1.0), 5.0);
  let crest = smoothstep(-0.5, 2.0, disp.y);
  let foam = clamp(nf.w, 0.0, 1.0);
  let fade = pow(1.0 - smoothstep(60.0, 260.0, length(cam.eye.xyz - world)), 2.2);
  let edge = smoothstep(0.0, 0.06, uv.x) * (1.0 - smoothstep(0.94, 1.0, uv.x));
  // Silver-white like the reference; a restrained palette tint keeps DJ colour controls useful.
  let tint = mix(vec3f(0.82, 0.88, 1.0), side_colour(uv.x), 0.12 * u.bg.w);
  let brightness = (0.13 + 0.8 * crest + 0.2 * fresnel + 1.6 * foam) * (0.65 + u.colA.w);
  var out: OceanVertex;
  out.position = vec4f(projected.xy + offset, projected.zw);
  out.point = corner;
  out.colour = tint * brightness;
  out.alpha = (0.16 + 0.27 * crest + 0.2 * fresnel + 0.6 * foam) * fade * edge * cam.settings.z;
  return out;
}
@fragment fn fs(in: OceanVertex) -> @location(0) vec4f {
  let radius = dot(in.point, in.point);
  if (radius > 1.0) { discard; }
  let alpha = in.alpha * (1.0 - smoothstep(0.25, 1.0, radius));
  return vec4f(in.colour * alpha, alpha);
}
`;
}
