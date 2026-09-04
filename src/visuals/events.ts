/**
 * Discrete Stage events derived from continuous data: kick / snare /
 * hat onsets from the feature envelopes with a refractory time, beat / bar / phrase from index
 * changes, section changes and drops, loops, deck start/stop, and the crossfader crossing the
 * centre. Cue hits are pushed by the engine actions. Pure and unit-tested.
 */
import type { DeckId } from "../state/session";
import type { StageEvent, StageSection } from "./protocol";

export interface DetectorSample {
  t: number;
  beatIndex: number | null;
  barIndex: number | null;
  phraseIndex: number | null;
  kick: number;
  snare: number;
  hat: number;
  section: StageSection;
  crossfader: number;
  loop: Record<DeckId, boolean>;
  playing: Record<DeckId, boolean>;
}

const ONSETS: { kind: "kick" | "snare" | "hat"; threshold: number; refractorySec: number }[] = [
  { kind: "kick", threshold: 0.5, refractorySec: 0.09 },
  { kind: "snare", threshold: 0.5, refractorySec: 0.12 },
  { kind: "hat", threshold: 0.45, refractorySec: 0.06 },
];

export class EventDetector {
  private previous: DetectorSample | null = null;
  private readonly lastOnset: Record<"kick" | "snare" | "hat", number> = { kick: -1, snare: -1, hat: -1 };
  private readonly armed: Record<"kick" | "snare" | "hat", boolean> = { kick: true, snare: true, hat: true };
  private pending: StageEvent[] = [];

  /** External events (cue hits) are queued until the next `next()`. */
  push(event: StageEvent): void {
    this.pending.push(event);
  }

  reset(): void {
    this.previous = null;
    this.pending = [];
  }

  next(sample: DetectorSample): StageEvent[] {
    const events: StageEvent[] = this.pending;
    this.pending = [];
    const previous = this.previous;
    const t = sample.t;
    for (const onset of ONSETS) {
      const value = sample[onset.kind];
      if (value < onset.threshold * 0.5) this.armed[onset.kind] = true;
      if (
        this.armed[onset.kind] &&
        value >= onset.threshold &&
        t - this.lastOnset[onset.kind] >= onset.refractorySec
      ) {
        this.lastOnset[onset.kind] = t;
        this.armed[onset.kind] = false;
        events.push({ t, kind: onset.kind });
      }
    }
    if (previous) {
      if (sample.beatIndex !== null && previous.beatIndex !== null && sample.beatIndex !== previous.beatIndex)
        events.push({ t, kind: "beat" });
      if (sample.barIndex !== null && previous.barIndex !== null && sample.barIndex !== previous.barIndex)
        events.push({ t, kind: "bar" });
      if (
        sample.phraseIndex !== null &&
        previous.phraseIndex !== null &&
        sample.phraseIndex !== previous.phraseIndex
      )
        events.push({ t, kind: "phrase" });
      if (sample.section !== previous.section && sample.section !== "none") {
        events.push({ t, kind: "section" });
        if (sample.section === "drop") events.push({ t, kind: "drop" });
      }
      for (const deck of ["A", "B"] as DeckId[]) {
        if (sample.loop[deck] !== previous.loop[deck])
          events.push({ t, kind: sample.loop[deck] ? "loopOn" : "loopOff", deck });
        if (sample.playing[deck] !== previous.playing[deck])
          events.push({ t, kind: sample.playing[deck] ? "deckStart" : "deckStop", deck });
      }
      const wasLeft = previous.crossfader < 0.5;
      const isLeft = sample.crossfader < 0.5;
      if (wasLeft !== isLeft) events.push({ t, kind: "faderCentre" });
    }
    this.previous = sample;
    return events;
  }
}
