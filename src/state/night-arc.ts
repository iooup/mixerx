/**
 * The energy arc of the night: what the audience actually heard, sampled every two seconds for an
 * hour. It is the shape of a set — where it rose, where it broke, where the records changed — and
 * it feeds both the band under the ON-AIR strip and the end-of-set recap.
 *
 * A plain ring buffer: no history beyond the hour, nothing persisted, nothing leaves the machine.
 */
import type { SectionKind } from "./session";

export const ARC_INTERVAL_MS = 2000;
export const ARC_MINUTES = 60;
export const ARC_CAP = (ARC_MINUTES * 60 * 1000) / ARC_INTERVAL_MS;

export interface ArcSample {
  /** Absolute milliseconds. */
  t: number;
  /** 0..1 — the on-air deck's energy at that moment. */
  energy: number;
  section: SectionKind | "none";
  /** Track on air, or null when the room was silent. */
  trackId: string | null;
  /** True on the first sample of a new track: the ticks under the band. */
  boundary: boolean;
}

export class NightArc {
  private readonly ring: ArcSample[] = [];
  /** Negative infinity, so the very first sample always lands whatever the clock says. */
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastTrack: string | null = null;

  /** Adds a sample if `ARC_INTERVAL_MS` has passed. Returns true when one was taken. */
  sample(now: number, energy: number, section: SectionKind | "none", trackId: string | null): boolean {
    if (now - this.lastAt < ARC_INTERVAL_MS) return false;
    this.lastAt = now;
    const boundary = trackId !== null && trackId !== this.lastTrack;
    this.lastTrack = trackId;
    this.ring.push({
      t: now,
      energy: Math.min(1, Math.max(0, energy)),
      section,
      trackId,
      boundary,
    });
    while (this.ring.length > ARC_CAP) this.ring.shift();
    return true;
  }

  get samples(): readonly ArcSample[] {
    return this.ring;
  }

  get length(): number {
    return this.ring.length;
  }

  /** Mean energy of one track's airtime, or null when it was never sampled. */
  energyOf(trackId: string): number | null {
    let total = 0;
    let count = 0;
    for (const sample of this.ring) {
      if (sample.trackId !== trackId) continue;
      total += sample.energy;
      count += 1;
    }
    return count ? total / count : null;
  }

  clear(): void {
    this.ring.length = 0;
    this.lastAt = Number.NEGATIVE_INFINITY;
    this.lastTrack = null;
  }
}

/** One arc per console tab, filled by the Stage bridge (which runs from the moment the page opens). */
export const nightArc = new NightArc();
