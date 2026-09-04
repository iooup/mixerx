/** The artwork is sampled in linear colour, then goes through the same Stage compositor. */
export const CINEMATIC_SHADER = /* wgsl */ `
@group(1) @binding(0) var<uniform> cine: vec4f; // travel, smoothed energy, bass, treble
@group(1) @binding(1) var background: texture_2d<f32>;
@group(1) @binding(2) var subject: texture_2d<f32>;

fn cover_uv(uv: vec2f) -> vec2f {
  let size = vec2f(textureDimensions(background));
  let aspect = size.x / size.y;
  return (uv - 0.5) * vec2f(min(1.0, vp.z / aspect), min(1.0, aspect / vp.z)) + 0.5;
}

fn sky(uv: vec2f) -> vec3f {
  let level = max(0.0, log2(f32(textureDimensions(background).x) / vp.x));
  return textureSampleLevel(background, smp, uv, level).rgb;
}

fn figure(uv: vec2f) -> vec4f {
  let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  let level = max(0.0, log2(f32(textureDimensions(subject).x) / vp.x));
  return textureSampleLevel(subject, smp, uv, level) * inside;
}

fn tint(colour: vec3f, uv: vec2f) -> vec3f {
  let light = luma(colour);
  let palette = mix(u.colA.rgb, u.colB.rgb, smoothstep(0.1, 0.9, uv.x));
  return mix(colour, light * palette * 2.0, 0.12);
}

// Sparse soft particles with stable identities; no random values or flashing every frame.
fn dust(uv: vec2f, travel: f32) -> vec3f {
  var result = vec3f(0.0);
  for (var layer = 0; layer < 3; layer++) {
    let depth = f32(layer) + 1.0;
    let p = (uv * vec2f(vp.z, 1.0) + vec2f(sin(travel * 0.08) * 0.015, travel * 0.018 / depth)) * (14.0 + depth * 7.0);
    let cell = floor(p);
    let seed = hash22(cell + depth * 20.0);
    let d = length(fract(p) - (0.2 + seed * 0.6));
    let radius = 0.035 + seed.x * 0.03;
    let dot = (1.0 - smoothstep(0.0, radius, d)) * step(0.83, seed.y);
    result += mix(vec3f(0.15, 0.5, 0.8), vec3f(0.8, 0.35, 0.12), seed.x) * dot * 0.28;
  }
  return result;
}

fn ring(p: vec2f, radius: f32, width: f32) -> f32 {
  return 1.0 - smoothstep(width, width + max(0.001, 1.0 / vp.y), abs(length(p) - radius));
}

fn phoenix(uv: vec2f) -> vec3f {
  let t = cine.x;
  let bgUV = cover_uv(uv);
  var col = sky((bgUV - 0.5) * 0.98 + 0.5 + vec2f(sin(t * 0.1) * 0.004, 0.0)) * 0.8;
  let size = vec2f(textureDimensions(subject));
  let fit = min(vp.x / size.x, vp.y / size.y) * 0.91;
  var bird = (uv - 0.5) * vp.xy / (size * fit) + 0.5;
  bird.y += sin(t * 0.7) * 0.003;
  // A continuous wing weight keeps the shoulder attached and the body still.
  let wing = smoothstep(0.06, 0.44, abs(bird.x - 0.5)) * (1.0 - smoothstep(0.54, 0.8, bird.y));
  bird.y += wing * (sin(t * 1.05) * 0.04 + cine.z * 0.032);
  bird.x += sin(t * 0.6 + bird.y * 6.0) * 0.008 * smoothstep(0.55, 0.95, bird.y);
  let b = figure(bird);
  let p = (uv - 0.5) * vec2f(vp.z, 1.0);
  let angle = atan2(p.y, p.x);
  let halo = ring(p, 0.34, 0.0006) * (0.2 + 0.8 * pow(0.5 + 0.5 * sin(angle * 18.0 + t * 0.3), 4.0));
  col += vec3f(0.1, 0.23, 0.48) * halo * 0.25;
  col = mix(col, b.rgb * 0.72, b.a);
  let left = length((bird - vec2f(0.489, 0.26)) * vec2f(1.77, 1.0));
  let right = length((bird - vec2f(0.511, 0.26)) * vec2f(1.77, 1.0));
  let eye = exp(-min(left, right) * 290.0) * (0.12 + cine.w * 0.12);
  let blink = smoothstep(0.015, 0.10, abs(sin(t * 0.31 + 1.0)));
  col += vec3f(0.15, 0.5, 0.8) * eye * blink;
  return tint(col, uv) + dust(uv, t);
}

fn gate(uv: vec2f) -> vec3f {
  let t = cine.x;
  let p = (uv - 0.5) * vec2f(vp.z, 1.0);
  let bgUV = cover_uv(uv);
  var col = sky((bgUV - 0.5) * (0.99 - cine.z * 0.008) + 0.5) * 0.58;
  let r = length(p);
  let turn = rot2(t * 0.065) * p / (0.82 + cine.z * 0.055);
  let aspect = f32(textureDimensions(subject).x) / f32(textureDimensions(subject).y);
  let g = figure(turn / vec2f(aspect, 1.0) + 0.5);
  col = mix(col, g.rgb * 0.64, g.a);
  let angle = atan2(p.y, p.x);
  let filigree = pow(0.5 + 0.5 * sin(angle * 24.0 - t * 0.22), 5.0);
  let orbit = ring(p, 0.437 + cine.z * 0.023, 0.0008) + ring(p, 0.46, 0.0005) * 0.5;
  col += vec3f(0.12, 0.38, 0.52) * orbit * filigree * 0.35;
  col += vec3f(0.17, 0.05, 0.3) * exp(-abs(r - 0.42) * 45.0) * 0.08;
  return tint(col, uv) + dust(uv, t * 0.7) * 0.6;
}

fn lotus(uv: vec2f) -> vec3f {
  let t = cine.x;
  var q = cover_uv(uv);
  let center = vec2f(0.5, 0.64);
  let p = q - center;
  let petal = (1.0 - smoothstep(0.26, 0.49, length(p))) * (1.0 - smoothstep(0.69, 0.8, q.y));
  let opening = sin(t * 0.7) * 0.022 + cine.z * 0.025;
  q = q - p * petal * opening;
  q.y += petal * sin(t * 0.7) * 0.006;
  let water = smoothstep(0.72, 0.95, q.y);
  q.x += sin(q.y * 90.0 - t * 1.6) * water * 0.002;
  q.y += sin(q.x * 36.0 + t * 0.8) * water * 0.0015;
  return tint(sky(q) * 0.86, uv) + dust(uv, t * 0.55) * 0.7;
}

fn crystal(uv: vec2f) -> vec3f {
  let t = cine.x;
  let q = cover_uv(uv) - 0.5;
  // Two overlapping slow camera travels crossfade at zero weight, so wrapping never cuts.
  let a = fract(t * 0.028);
  let b = fract(t * 0.028 + 0.5);
  let weight = pow(sin(a * PI), 2.0);
  let colA = sky(q * (1.08 - a * 0.18) + 0.5);
  let colB = sky(q * (1.08 - b * 0.18) + 0.5);
  var col = mix(colB, colA, weight) * 0.85;
  let p = (uv - 0.5) * vec2f(vp.z, 1.0);
  let angle = atan2(p.y, p.x);
  let sector = cos((angle + PI / 6.0) % (PI / 3.0) - PI / 6.0);
  let hexRadius = length(p) * sector;
  for (var i = 0; i < 4; i++) {
    let phase = fract(t * 0.055 + f32(i) / 4.0);
    let radius = 0.06 + phase * phase * 0.88;
    let fade = sin(phase * PI);
    let edge = 1.0 - smoothstep(0.0005, 0.0025, abs(hexRadius - radius));
    col += vec3f(0.27, 0.16, 0.045) * edge * fade * 0.15;
  }
  return tint(col, uv) + dust(uv, -t * 0.6);
}
`;
