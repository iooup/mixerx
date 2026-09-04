/**
 * Morph targets for the Kick Field: the shape the galaxy assembles into. A word, or one of three
 * built-in silhouettes, is rasterised into a small alpha mask and sampled into a few thousand
 * points; the particles then spring toward them.
 *
 * The sampling is deterministic — a prime stride visits every pixel of the mask exactly once in a
 * scrambled order, so stopping at the cap leaves a well-spread subset rather than a solid block of
 * the first rows. The rasterising needs a canvas; the sampling is pure and unit-tested.
 */

export const TARGET_CAP = 8192;
export const MASK_WIDTH = 256;
export const MASK_HEIGHT = 64;
/** Coprime with 256 × 64, so the walk is a permutation of every pixel. */
const STRIDE = 7919;
const ALPHA_THRESHOLD = 96;

export interface TargetPoint {
  /** −aspect … +aspect, where aspect is the mask's own. */
  x: number;
  /** −1 … 1, positive upward. */
  y: number;
  weight: number;
}

/**
 * Up to `cap` points from an alpha mask, spread over the whole shape. `mask` is one byte per
 * pixel, row-major from the top.
 */
export function samplePoints(
  mask: Uint8Array,
  width: number,
  height: number,
  cap = TARGET_CAP,
): TargetPoint[] {
  const points: TargetPoint[] = [];
  const total = width * height;
  if (total <= 0) return points;
  const aspect = width / Math.max(1, height);
  const stride = total % STRIDE === 0 ? 1 : STRIDE;
  let index = 0;
  for (let step = 0; step < total && points.length < cap; step += 1) {
    index = (index + stride) % total;
    const alpha = mask[index] ?? 0;
    if (alpha < ALPHA_THRESHOLD) continue;
    const px = index % width;
    const py = Math.floor(index / width);
    points.push({
      x: ((px + 0.5) / width - 0.5) * 2 * aspect,
      y: -((py + 0.5) / height - 0.5) * 2,
      weight: alpha / 255,
    });
  }
  return points;
}

/** Packs points into the storage-buffer layout (vec4: x, y, z, weight). */
export function packTargets(points: readonly TargetPoint[], cap = TARGET_CAP): Float32Array {
  const data = new Float32Array(cap * 4);
  for (let i = 0; i < Math.min(cap, points.length); i += 1) {
    const point = points[i] as TargetPoint;
    data[i * 4] = point.x;
    data[i * 4 + 1] = point.y;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = point.weight;
  }
  return data;
}

/** The three shapes that ship with the app, as SVG path data on a 0…100 square. */
export const SILHOUETTES: Record<string, string> = {
  heart:
    "M50 88 C22 68 6 52 6 34 C6 20 17 10 30 10 C39 10 46 15 50 22 C54 15 61 10 70 10 C83 10 94 20 94 34 C94 52 78 68 50 88 Z",
  star: "M50 6 L62 38 L96 38 L69 58 L79 92 L50 72 L21 92 L31 58 L4 38 L38 38 Z",
  // The Mixerx mark: two decks joined by a crossfader.
  mark: "M18 30 a18 18 0 1 0 0.001 0 Z M82 30 a18 18 0 1 0 0.001 0 Z M14 66 h72 v10 h-72 Z M46 56 h8 v30 h-8 Z",
};

type Canvas2D = OffscreenCanvasRenderingContext2D;

function maskContext(): { canvas: OffscreenCanvas; context: Canvas2D } | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(MASK_WIDTH, MASK_HEIGHT);
  const context = canvas.getContext("2d");
  return context ? { canvas, context } : null;
}

function alphaOf(context: Canvas2D, width: number, height: number): Uint8Array {
  const { data } = context.getImageData(0, 0, width, height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * 4 + 3] ?? 0;
  return mask;
}

/**
 * Rasterises a line of text into the alpha mask. The bundled Plex family does the shaping, so a
 * phrase looks exactly as it does in the interface. Null where the platform has no
 * `OffscreenCanvas`.
 */
export function rasteriseText(text: string): Uint8Array | null {
  const trimmed = text.trim().slice(0, 24);
  if (!trimmed) return null;
  const made = maskContext();
  if (!made) return null;
  const { context } = made;
  context.clearRect(0, 0, MASK_WIDTH, MASK_HEIGHT);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#fff";
  // Fit the word to the mask: start large and shrink until it fits with a margin.
  let size = MASK_HEIGHT * 0.78;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    context.font = `600 ${size.toFixed(1)}px "IBM Plex Sans", sans-serif`;
    if (context.measureText(trimmed).width <= MASK_WIDTH * 0.92) break;
    size *= 0.88;
  }
  context.fillText(trimmed, MASK_WIDTH / 2, MASK_HEIGHT / 2);
  return alphaOf(context, MASK_WIDTH, MASK_HEIGHT);
}

/** Rasterises one of the built-in silhouettes, centred and square inside the mask. */
export function rasteriseSilhouette(name: string): Uint8Array | null {
  const data = SILHOUETTES[name];
  if (!data || typeof Path2D === "undefined") return null;
  const made = maskContext();
  if (!made) return null;
  const { context } = made;
  context.clearRect(0, 0, MASK_WIDTH, MASK_HEIGHT);
  context.fillStyle = "#fff";
  context.save();
  const scale = (MASK_HEIGHT * 0.92) / 100;
  context.translate(MASK_WIDTH / 2 - 50 * scale, MASK_HEIGHT / 2 - 50 * scale);
  context.scale(scale, scale);
  context.fill(new Path2D(data));
  context.restore();
  return alphaOf(context, MASK_WIDTH, MASK_HEIGHT);
}

/** Points for a message: a built-in silhouette when the text names one, otherwise the text itself. */
export function targetsFor(text: string): TargetPoint[] {
  const key = text.trim().toLowerCase();
  const mask = key in SILHOUETTES ? rasteriseSilhouette(key) : rasteriseText(text);
  return mask ? samplePoints(mask, MASK_WIDTH, MASK_HEIGHT) : [];
}
