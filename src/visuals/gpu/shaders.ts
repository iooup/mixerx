/**
 * WGSL shared by every scene and the post chain: the uniform block (packed by `scene.ts`), the
 * per-viewport block (dynamic offset), hashes, value noise, curl, and the fullscreen triangle.
 */

export const UNIFORM_FLOATS = 132; // 17 vec4 + 16 vec4 spectrum = 528 bytes
export const VIEWPORT_STRIDE = 256;

/** vec4 slots of the uniform block (index × 4 floats). */
export const SLOT = Object.freeze({
  colA: 0,
  colB: 1,
  accent: 2,
  bg: 3,
  time: 4,
  beat: 5,
  counts: 6,
  hits: 7,
  audio: 8,
  bands: 9,
  fx: 10,
  gest: 11,
  misc: 12,
  events: 13,
  priv: 14,
  priv2: 15,
  show: 16,
  spectrum: 17,
});

/** First float of the block written after the scene-private slots (`show` + the spectrum). */
export const SHOW_FLOAT_OFFSET = 16 * 4;
export const SHOW_FLOAT_COUNT = (1 + 16) * 4;

export const COMMON_WGSL = /* wgsl */ `
struct U {
  colA: vec4f,    // linear rgb, w = intensity
  colB: vec4f,    // w = motion
  accent: vec4f,  // w = framing
  bg: vec4f,      // w = saturation
  time: vec4f,    // x time, y dt, z quality (0 low, 1 medium, 2 high), w seed
  beat: vec4f,    // x beatPhase, y barPhase, z phrasePhase, w bpm
  counts: vec4f,  // x beatIndex, y barIndex, z phraseIndex, w kickCount
  hits: vec4f,    // x snareCount, y hatCount, z flashesLastSecond, w strobe
  audio: vec4f,   // x kick, y snare, z hat, w rms
  bands: vec4f,   // x bass, y mid, z treble, w centroid
  fx: vec4f,      // x flash, y burst, z invert, w floor
  gest: vec4f,    // x tunnel, y balance, z freeze, w cut
  misc: vec4f,    // x section, y barsToNext, z warmth, w flux
  events: vec4f,  // x kickOnset, y snareOnset, z hatOnset, w barOnset (1 on the frame it happened)
  scene0: vec4f,  // scene private (slot priv)
  scene1: vec4f,  // scene private (slot priv2)
  show: vec4f,    // x anticipation (0..1 before a drop), y cameraShot, z idle, w lowerThird
  spectrum: array<vec4f, 16>,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<uniform> vp: vec4f; // x width, y height, z aspect, w unused
@group(0) @binding(2) var smp: sampler;

const PI: f32 = 3.14159265;

fn band(i: i32) -> f32 {
  let k = clamp(i, 0, 63);
  return u.spectrum[k / 4][k % 4];
}

/** 0 → 1 over the last four bars before a drop; every scene contracts toward its centre with it. */
fn anticipation() -> f32 { return u.show.x; }

/**
 * The camera operator's shot (0 orbit, 1 wide, 2 push, 3 low, 4 top, 5 handheld). A flat scene
 * has no camera, so it answers the shot with its own zoom and a little parallax instead.
 */
fn shot_zoom() -> f32 {
  let s = u.show.y;
  if (s < 0.5) { return 1.0; }
  if (s < 1.5) { return 0.82; }   // wide
  if (s < 2.5) { return 1.28; }   // push
  if (s < 3.5) { return 1.1; }    // low
  if (s < 4.5) { return 0.9; }    // top
  return 1.06;                    // handheld
}

/** Vertical offset the shot gives a flat scene, in fractions of the frame (low looks up). */
fn shot_parallax() -> f32 {
  let s = u.show.y;
  if (s < 2.5) { return 0.0; }
  if (s < 3.5) { return 0.09; }   // low: the horizon rises
  if (s < 4.5) { return -0.08; }  // top: it drops
  return 0.0;
}

fn hash11(p: f32) -> f32 { return fract(sin(p * 127.1 + 0.37) * 43758.5453); }
fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn hash22(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}
fn hash31(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn noise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let n000 = hash31(i);
  let n100 = hash31(i + vec3f(1.0, 0.0, 0.0));
  let n010 = hash31(i + vec3f(0.0, 1.0, 0.0));
  let n110 = hash31(i + vec3f(1.0, 1.0, 0.0));
  let n001 = hash31(i + vec3f(0.0, 0.0, 1.0));
  let n101 = hash31(i + vec3f(1.0, 0.0, 1.0));
  let n011 = hash31(i + vec3f(0.0, 1.0, 1.0));
  let n111 = hash31(i + vec3f(1.0, 1.0, 1.0));
  let x00 = mix(n000, n100, w.x);
  let x10 = mix(n010, n110, w.x);
  let x01 = mix(n001, n101, w.x);
  let x11 = mix(n011, n111, w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

fn fbm2(p0: vec2f) -> f32 {
  var p = p0;
  var a = 0.5;
  var s = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    s = s + a * noise2(p);
    p = p * 2.03 + vec2f(1.7, 9.2);
    a = a * 0.5;
  }
  return s;
}

fn curl2(p: vec2f) -> vec2f {
  let e = 0.02;
  let dx = noise2(p + vec2f(e, 0.0)) - noise2(p - vec2f(e, 0.0));
  let dy = noise2(p + vec2f(0.0, e)) - noise2(p - vec2f(0.0, e));
  return vec2f(dy, -dx) / (2.0 * e);
}

fn rot2(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(c, s, -s, c);
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

/** Palette helper: A on the left of the balance point, B on the right; swapped (never blended to grey) while a drop's inversion lasts. */
fn side_colour(side: f32) -> vec3f {
  let swap = step(0.5, u.fx.z);
  let a = mix(u.colA.rgb, u.colB.rgb, swap);
  let b = mix(u.colB.rgb, u.colA.rgb, swap);
  return mix(a, b, side);
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs_fullscreen(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  out.uv = vec2f(p[i].x * 0.5 + 0.5, 1.0 - (p[i].y * 0.5 + 0.5));
  return out;
}
`;
