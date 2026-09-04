import { describe, expect, it } from "vitest";
import { sectionAt } from "../../src/engine/beat-math";
import type { BeatGrid, Section } from "../../src/state/session";
import { createInitialSession, reduceSession } from "../../src/state/session-store";

const grid: BeatGrid = {
  kind: "constant",
  bpm: 120,
  firstBeatSec: 0,
  downbeatOffset: 0,
  downbeatConfirmed: false,
  confidence: 0.9,
  candidates: [],
};

describe("section lookup", () => {
  const sections: Section[] = [
    { kind: "intro", startBar: 0, endBar: 8, energy: 0.3 },
    { kind: "drop", startBar: 8, endBar: 24, energy: 0.9 },
  ];
  it("reports the current section and whole bars to the next", () => {
    // 120 BPM → 2 s per bar; 5.1 s is bar 2.55 → 6 bars (ceil of 5.45) to bar 8
    expect(sectionAt(sections, grid, 5.1)).toEqual({ kind: "intro", bar: 2, barsToNext: 6, next: "drop" });
    expect(sectionAt(sections, grid, 20)).toEqual({ kind: "drop", bar: 10, barsToNext: null, next: null });
    expect(sectionAt(sections, grid, 60)).toBeNull();
    expect(sectionAt([], grid, 1)).toBeNull();
  });
});

describe("session events (phase 2)", () => {
  it("stores scheduled events and hot cues per deck", () => {
    let state = createInitialSession();
    state = reduceSession(state, {
      type: "scheduled/set",
      scheduled: [
        {
          id: "enter-1",
          kind: "enter",
          targetDeck: "B",
          referenceDeck: "A",
          atBeatIndex: 64,
          label: "B enters on bar 1",
          cancellable: true,
        },
      ],
    });
    expect(state.scheduled[0]?.atBeatIndex).toBe(64);
    const hotCues = [1.5, null, null, null, null, null, null, null];
    state = reduceSession(state, { type: "deck/hotCues", deck: "A", hotCues });
    expect(state.decks.A.hotCues[0]).toBe(1.5);
    expect(state.decks.B.hotCues[0]).toBeNull();
  });

  it("keeps the queue in preferences", () => {
    const state = createInitialSession({ queue: ["t-1", "t-2"] });
    expect(state.queue).toEqual(["t-1", "t-2"]);
  });
});
