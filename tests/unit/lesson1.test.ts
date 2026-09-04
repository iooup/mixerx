import { describe, expect, it } from "vitest";
import { LESSON1_STEP_IDS, lesson1, stepApiForTests } from "../../src/coach/lessons/lesson1";
import type { LessonContext } from "../../src/coach/types";
import type { EngineFrame } from "../../src/engine/audio-engine";
import type { TrackAnalysis, TrackRef } from "../../src/state/session";
import { createInitialSession, reduceSession } from "../../src/state/session-store";

const track = (id: string): TrackRef => ({
  id,
  title: id,
  artist: "",
  durationSec: 300,
  sizeBytes: 1,
  source: "manifest",
  hasArtwork: false,
});

const analysis = (trackId: string, bpm = 120): TrackAnalysis => ({
  schemaVersion: 2,
  trackId,
  grid: {
    kind: "constant",
    bpm,
    firstBeatSec: 0,
    downbeatOffset: 0,
    downbeatConfirmed: false,
    confidence: 1,
    candidates: [],
  },
  key: { camelot: "8A", name: "A minor", confidence: 0.8 },
  loudness: { integratedLufs: -10, truePeakDb: -1, gainSuggestionDb: -4 },
  energyPerBar: new Float32Array(0),
  sections: [],
  waveform: { hop: 1024, bins: new Uint8Array(0), overview: new Uint8Array(0) },
  analysedAt: 0,
});

function frame(
  patch: Partial<EngineFrame["decks"]["A"]> = {},
  patchB: Partial<EngineFrame["decks"]["B"]> = {},
): EngineFrame {
  const deck = { trackId: "a", positionSec: 0, durationSec: 300, playing: false, rate: 1 };
  return {
    time: 0,
    decks: { A: { ...deck, ...patch }, B: { ...deck, trackId: "b", ...patchB } },
    preview: deck,
    meters: {
      master: { peak: 0, rms: 0 },
      a: { peak: 0, rms: 0 },
      b: { peak: 0, rms: 0 },
      cue: { peak: 0, rms: 0 },
      limiterReduction: 0,
    },
    features: new Float32Array(0),
  };
}

function context(patch: Partial<LessonContext> = {}): LessonContext {
  return { session: createInitialSession(), frame: null, now: 0, stepEnteredAt: 0, ...patch };
}

const step = (id: string) => {
  const found = lesson1.steps.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("Lesson 1 conditions", () => {
  it("lists ten steps in the plan's order", () => {
    expect(LESSON1_STEP_IDS).toEqual([
      "pair",
      "analyse",
      "confirm",
      "playA",
      "enter",
      "check",
      "blend",
      "bass",
      "finish",
      "score",
    ]);
  });

  it("pair needs two different tracks; analyse needs both analyses", () => {
    let session = createInitialSession();
    const api = stepApiForTests();
    expect(step("pair").isComplete(context({ session }), api)).toBe(false);
    session = reduceSession(session, { type: "deck/track", deck: "A", track: track("a") });
    session = reduceSession(session, { type: "deck/track", deck: "B", track: track("a") });
    expect(step("pair").isComplete(context({ session }), api)).toBe(false);
    session = reduceSession(session, { type: "deck/track", deck: "B", track: track("b") });
    expect(step("pair").isComplete(context({ session }), api)).toBe(true);
    expect(step("analyse").isComplete(context({ session }), api)).toBe(false);
    session = reduceSession(session, { type: "deck/analysis", deck: "A", analysis: analysis("a") });
    session = reduceSession(session, { type: "deck/analysis", deck: "B", analysis: analysis("b") });
    expect(step("analyse").isComplete(context({ session }), api)).toBe(true);
  });

  it("play A needs A playing with the crossfader at A", () => {
    const api = stepApiForTests();
    let session = createInitialSession();
    expect(step("playA").isComplete(context({ session, frame: frame({ playing: true }) }), api)).toBe(true);
    session = reduceSession(session, { type: "mixer/patch", patch: { crossfader: 0.5 } });
    expect(step("playA").isComplete(context({ session, frame: frame({ playing: true }) }), api)).toBe(false);
  });

  it("check by ear counts consecutive aligned beats and reveals the meter after 4 bars", () => {
    const api = stepApiForTests();
    let revealed = false;
    api.reveal = () => {
      revealed = true;
    };
    let session = createInitialSession();
    session = reduceSession(session, { type: "deck/analysis", deck: "A", analysis: analysis("a") });
    session = reduceSession(session, { type: "deck/analysis", deck: "B", analysis: analysis("b") });
    const check = step("check");
    check.onEnter?.(context({ session }), api);
    api.memory.enteredAt = 0;
    // 120 BPM: one beat = 0.5 s. B lags by 5 ms (aligned) for 8 beats.
    for (let beat = 1; beat <= 8; beat += 1) {
      const positionA = beat * 0.5;
      const ctx = context({
        session,
        frame: frame(
          { playing: true, positionSec: positionA },
          { playing: true, positionSec: positionA - 0.005 },
        ),
      });
      check.onTick?.(ctx, api);
    }
    expect(check.isComplete(context({ session }), api)).toBe(true);
    lesson1.onTick?.(
      context({
        session,
        frame: frame({ playing: true, positionSec: 4 }, { playing: true, positionSec: 4 }),
      }),
      api,
    );
    expect(revealed).toBe(false);
    lesson1.onTick?.(
      context({
        session,
        frame: frame({ playing: true, positionSec: 9 }, { playing: true, positionSec: 9 }),
      }),
      api,
    );
    expect(revealed).toBe(true);
    // A 40 ms slip resets the streak.
    check.onTick?.(
      context({
        session,
        frame: frame({ playing: true, positionSec: 10 }, { playing: true, positionSec: 10.04 }),
      }),
      api,
    );
    expect(api.memory.alignedStreak).toBe(0);
  });

  it("blend needs 4 bars inside 40–60; bass swap and finish evaluate the mixer", () => {
    const api = stepApiForTests();
    let session = createInitialSession();
    session = reduceSession(session, { type: "deck/analysis", deck: "A", analysis: analysis("a") });
    const blend = step("blend");
    blend.onEnter?.(context({ session }), api);
    session = reduceSession(session, { type: "mixer/patch", patch: { crossfader: 0.5 } });
    blend.onTick?.(context({ session, now: 1000, frame: frame({ playing: true }) }), api);
    expect(blend.isComplete(context({ session, now: 5000, frame: frame({ playing: true }) }), api)).toBe(
      false,
    );
    // 4 bars at 120 BPM = 8 s
    expect(blend.isComplete(context({ session, now: 9100, frame: frame({ playing: true }) }), api)).toBe(
      true,
    );

    session = reduceSession(session, { type: "mixer/strip", deck: "A", patch: { eqLow: -26 } });
    expect(step("bass").isComplete(context({ session }), api)).toBe(true);

    session = reduceSession(session, { type: "mixer/patch", patch: { crossfader: 1 } });
    let score: unknown = null;
    api.setScore = (value) => {
      score = value;
    };
    api.memory.errors = [4, 6, 8];
    api.memory.blendStart = 1000;
    api.memory.blendEnd = 17000; // 16 s = 8 bars
    api.memory.bassSwapPhase = 0.5;
    expect(step("finish").isComplete(context({ session, frame: frame({ playing: false }) }), api)).toBe(true);
    expect(score).toEqual({ alignmentMs: 6, blendBars: 8, bassSwapOnBeatOne: true });
  });
});
