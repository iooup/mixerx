/**
 * The night sky: one star per track the audience has heard, in the order they heard it. Placement
 * is deterministic — the same set of tracks always draws the same constellation, in every window —
 * and lives in a band across the top of the frame so it never fights the scene underneath.
 *
 * Stars are spread with a golden-ratio sequence over the running order and jittered by a hash of
 * the track id: a pure hash alone piles stars on top of each other often enough to look like a bug.
 */
import { camelotHue } from "../palette";
import type { NightEntry } from "../protocol";

export interface Star {
  id: string;
  /** 0..1 across the frame. */
  x: number;
  /** 0..1 down the frame; always inside the sky band. */
  y: number;
  /** Radius in fractions of the frame height. */
  r: number;
  /** Hue in degrees from the track's Camelot key, or null when it has none. */
  hue: number | null;
  index: number;
}

/** The sky band: the top 45 % of the frame, inset from the very edge. */
export const SKY_TOP = 0.06;
export const SKY_BOTTOM = 0.45;

const GOLDEN = 0.618_033_988_75;

/** FNV-1a over the id; the same track always lands in the same place. */
export function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

export function placeStars(night: readonly NightEntry[]): Star[] {
  return night.map((entry, index) => {
    const jitter = hashId(entry.id);
    const x = 0.05 + 0.9 * (((index + 1) * GOLDEN + jitter * 0.07) % 1);
    const y = SKY_TOP + (SKY_BOTTOM - SKY_TOP) * ((jitter * 7.13) % 1);
    const energy = Math.min(10, Math.max(1, entry.energy)) / 10;
    return {
      id: entry.id,
      x,
      y,
      r: 0.004 + 0.011 * energy,
      hue: camelotHue(entry.camelot),
      index,
    };
  });
}

/** The night sky shows itself in the quiet parts of a set, and whenever the DJ asks for it. */
export function skyVisible(mode: "auto" | "always" | "off", section: string, idle: number): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  return section === "break" || section === "outro" || idle > 0.2;
}
