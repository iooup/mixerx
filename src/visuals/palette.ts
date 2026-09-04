/**
 * Palettes for the Stage: key-derived hue (Camelot wheel → hue), the
 * deck colours, or a custom pair. Contrast is enforced so scenes never collapse into grey.
 * Only the key-derived palette follows the music: section warmth moves its hues, while the deck
 * colours and a custom pair are explicit choices and stay exactly as chosen.
 */
import type { PaletteSource } from "./protocol";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number; // degrees
  s: number; // 0..1
  l: number; // 0..1
}

export interface Palette {
  a: Rgb; // sRGB 0..1
  b: Rgb;
  accent: Rgb;
  background: Rgb;
  hueA: number;
  hueB: number;
  cssA: string;
  cssB: string;
  cssAccent: string;
}

export const DECK_A_HEX = "#ffa03c";
export const DECK_B_HEX = "#3fd5ff";

const wrapHue = (hue: number): number => ((hue % 360) + 360) % 360;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Camelot "8A" → 1..12 and A/B. */
export function parseCamelot(camelot: string | null | undefined): { number: number; minor: boolean } | null {
  const match = /^(1[0-2]|[1-9])([AB])$/i.exec((camelot ?? "").trim());
  if (!match) return null;
  return { number: Number(match[1]), minor: match[2]?.toUpperCase() === "A" };
}

/**
 * Adjacent Camelot numbers are harmonic neighbours, so they get adjacent hues (30° steps):
 * compatible tracks look alike on the Stage. Minor keys sit 12° cooler than their major twin.
 */
export function camelotHue(camelot: string | null | undefined): number | null {
  const parsed = parseCamelot(camelot);
  if (!parsed) return null;
  return wrapHue((parsed.number - 1) * 30 + 200 + (parsed.minor ? 12 : 0));
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = wrapHue(h) / 360;
  const sat = clamp01(s);
  const light = clamp01(l);
  if (sat === 0) return { r: light, g: light, b: light };
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: channel(hue + 1 / 3), g: channel(hue), b: channel(hue - 1 / 3) };
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1] as string, 16);
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (value: number) =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function srgbToLinear({ r, g, b }: Rgb): Rgb {
  const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return { r: channel(r), g: channel(g), b: channel(b) };
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

export function hueDistance(a: number, b: number): number {
  const delta = Math.abs(wrapHue(a) - wrapHue(b));
  return Math.min(delta, 360 - delta);
}

/** Contrast rules: saturated enough to read as colour, mid lightness, and hues at least 60° apart. */
export function enforceContrast(a: Hsl, b: Hsl): [Hsl, Hsl] {
  const fixLightness = (colour: Hsl): Hsl => ({ ...colour, l: Math.min(0.68, Math.max(0.42, colour.l)) });
  const first = { ...fixLightness(a), s: Math.max(0.55, a.s) };
  let second = { ...fixLightness(b), s: Math.max(0.55, b.s) };
  if (hueDistance(first.h, second.h) < 60) second = { ...second, h: wrapHue(first.h + 150) };
  return [first, second];
}

export interface PaletteInput {
  source: PaletteSource;
  keyHue: number | null;
  custom?: [string, string];
  /**
   * −1 (cool) … +1 (warm); the Director warms the palette during builds. It moves the
   * key-derived palette only — the deck colours and a custom pair are left untouched.
   */
  warmth?: number;
}

export function buildPalette({ source, keyHue, custom, warmth = 0 }: PaletteInput): Palette {
  let a: Hsl;
  let b: Hsl;
  /** Set by the key branch alone: the two explicit sources are locked against warmth. */
  let automatic = false;
  if (source === "custom" && custom) {
    const first = parseHex(custom[0]) ?? (parseHex(DECK_A_HEX) as Rgb);
    const second = parseHex(custom[1]) ?? (parseHex(DECK_B_HEX) as Rgb);
    a = rgbToHsl(first);
    b = rgbToHsl(second);
  } else if (source === "key" && keyHue !== null) {
    a = { h: keyHue, s: 0.8, l: 0.55 };
    b = { h: keyHue + 150, s: 0.75, l: 0.5 };
    automatic = true;
  } else {
    a = rgbToHsl(parseHex(DECK_A_HEX) as Rgb);
    b = rgbToHsl(parseHex(DECK_B_HEX) as Rgb);
  }
  const warm = automatic ? Math.min(1, Math.max(-1, warmth)) : 0;
  // Warmth pulls hues toward 30° (amber) and cools toward 210° (blue).
  const shift = (colour: Hsl): Hsl => {
    if (warm === 0) return colour;
    const target = warm > 0 ? 30 : 210;
    const delta = ((target - colour.h + 540) % 360) - 180;
    return { ...colour, h: wrapHue(colour.h + delta * Math.abs(warm) * 0.35) };
  };
  const [first, second] = enforceContrast(shift(a), shift(b));
  const accent: Hsl = {
    h: wrapHue((first.h + second.h) / 2 + (hueDistance(first.h, second.h) > 180 ? 180 : 0)),
    s: 0.3,
    l: 0.9,
  };
  const aRgb = hslToRgb(first);
  const bRgb = hslToRgb(second);
  const accentRgb = hslToRgb(accent);
  return {
    a: aRgb,
    b: bRgb,
    accent: accentRgb,
    background: hslToRgb({ h: first.h, s: 0.35, l: 0.04 }),
    hueA: first.h,
    hueB: second.h,
    cssA: rgbToHex(aRgb),
    cssB: rgbToHex(bRgb),
    cssAccent: rgbToHex(accentRgb),
  };
}
