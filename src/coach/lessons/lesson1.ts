/**
 * Lesson 1 — Phrase entry blend. Every completion condition is
 * evaluated against real engine state; nothing is faked.
 */
import { deckActions, mixerActions } from "../../engine/actions";
import { beatPeriodSec, beatPosition, phaseErrorMs, wrap01 } from "../../engine/beat-math";
import { getEngine } from "../../engine/index";
import type { Lesson, LessonApi, LessonContext, LessonStep } from "../types";

const ALIGNED_MS = 15;
const ALIGNED_BEATS = 8;
const REVEAL_AFTER_BEATS = 16; // 4 bars
const BLEND_ZONE = { low: 0.4, high: 0.6 };
const BLEND_BARS = 4;

const bothLoaded = ({ session }: LessonContext) =>
  Boolean(
    session.decks.A.track && session.decks.B.track && session.decks.A.track.id !== session.decks.B.track.id,
  );

const bothAnalysed = ({ session }: LessonContext) =>
  Boolean(session.decks.A.analysis && session.decks.B.analysis);

function barSeconds(context: LessonContext): number {
  const analysis = context.session.decks.A.analysis;
  const position = context.frame?.decks.A.positionSec ?? 0;
  const rate = context.frame?.decks.A.rate || 1;
  return analysis ? (4 * beatPeriodSec(analysis.grid, position)) / rate : 2;
}

function phaseError(context: LessonContext): number | null {
  const a = context.session.decks.A.analysis;
  const b = context.session.decks.B.analysis;
  const frame = context.frame;
  if (!a || !b || !frame?.decks.A.playing || !frame.decks.B.playing) return null;
  return phaseErrorMs(a.grid, frame.decks.A.positionSec, b.grid, frame.decks.B.positionSec);
}

const pair: LessonStep = {
  id: "pair",
  target: "library",
  instruction: "guide.l1.s1",
  hint: "guide.l1.h1",
  locks: ["crossfader", "play-B", "strips"],
  isComplete: bothLoaded,
};

const analyse: LessonStep = {
  id: "analyse",
  target: "deck-A-header",
  instruction: "guide.l1.s2",
  locks: ["crossfader", "play-B", "strips"],
  isComplete: (context) => bothLoaded(context) && bothAnalysed(context),
};

const confirmBeatOne: LessonStep = {
  id: "confirm",
  target: "calibration",
  instruction: "guide.l1.s3",
  hint: "guide.l1.h3",
  locks: ["crossfader", "play-B", "strips"],
  cardControls: "calibration",
  isComplete: ({ session }, api) =>
    Boolean(session.decks.B.analysis?.grid.downbeatConfirmed) || api.memory.confirmed === true,
};

const playA: LessonStep = {
  id: "playA",
  target: "deck-A-play",
  instruction: "guide.l1.s4",
  locks: ["crossfader", "play-B", "strips"],
  onEnter: () => {
    void mixerActions.setCrossfader(0);
  },
  isComplete: ({ session, frame }) => Boolean(frame?.decks.A.playing) && session.mixer.crossfader <= 0.02,
};

const enterB: LessonStep = {
  id: "enter",
  target: "enter",
  instruction: "guide.l1.s5",
  hint: "guide.l1.h5",
  locks: ["crossfader", "play-B", "strips"],
  cardControls: "enter",
  isComplete: ({ session, frame }, api) => {
    if (!frame?.decks.B.playing) return false;
    const engine = getEngine();
    const scheduledFrame = api.memory.enterFrame;
    const startedAt = engine?.decks.B.lastStartFrame ?? null;
    if (typeof scheduledFrame === "number" && startedAt !== null) {
      api.memory.sampleAccurate = Math.abs(startedAt - scheduledFrame) <= 1;
    }
    api.memory.enteredAt = frame.decks.A.positionSec;
    return session.decks.B.playing;
  },
};

const checkByEar: LessonStep = {
  id: "check",
  target: "nudge-B",
  instruction: "guide.l1.s6",
  hint: "guide.l1.h6",
  locks: ["crossfader", "strips"],
  onEnter: (_context, api) => {
    api.memory.alignedStreak = 0;
    api.memory.lastBeat = -1;
    api.memory.errors = [];
  },
  onTick: (context, api) => {
    const error = phaseError(context);
    const analysis = context.session.decks.A.analysis;
    const frame = context.frame;
    if (error === null || !analysis || !frame) return;
    const beat = Math.floor(beatPosition(analysis.grid, frame.decks.A.positionSec));
    if (beat === api.memory.lastBeat) return;
    api.memory.lastBeat = beat;
    const errors = (api.memory.errors as number[]) ?? [];
    errors.push(Math.abs(error));
    api.memory.errors = errors;
    api.memory.alignedStreak = Math.abs(error) < ALIGNED_MS ? Number(api.memory.alignedStreak ?? 0) + 1 : 0;
  },
  isComplete: (_context, api) => Number(api.memory.alignedStreak ?? 0) >= ALIGNED_BEATS,
};

const blend: LessonStep = {
  id: "blend",
  target: "crossfader",
  instruction: "guide.l1.s7",
  hint: "guide.l1.h7",
  locks: ["strips"],
  demo: true,
  onEnter: (_context, api) => {
    api.memory.zoneSince = null;
    api.memory.blendStart = null;
  },
  onTick: (context, api) => {
    const value = context.session.mixer.crossfader;
    if (value > 0.05 && api.memory.blendStart === null) api.memory.blendStart = context.now;
    const inZone = value >= BLEND_ZONE.low && value <= BLEND_ZONE.high;
    if (inZone && api.memory.zoneSince === null) api.memory.zoneSince = context.now;
    if (!inZone) api.memory.zoneSince = null;
  },
  isComplete: (context, api) => {
    const since = api.memory.zoneSince;
    if (typeof since !== "number") return false;
    return context.now - since >= BLEND_BARS * barSeconds(context) * 1000;
  },
};

const bassSwap: LessonStep = {
  id: "bass",
  target: "eq-low-A",
  instruction: "guide.l1.s8",
  hint: "guide.l1.h8",
  locks: [],
  demo: true,
  onTick: (context, api) => {
    const lowA = context.session.mixer.a.eqLow;
    const analysis = context.session.decks.A.analysis;
    const frame = context.frame;
    if (lowA <= -12 && api.memory.bassSwapPhase === undefined && analysis && frame) {
      const beat = beatPosition(analysis.grid, frame.decks.A.positionSec) - analysis.grid.downbeatOffset;
      const barPhase = wrap01(beat / 4);
      api.memory.bassSwapPhase = Math.min(barPhase, 1 - barPhase) * 4; // beats from the nearest bar 1
    }
  },
  isComplete: ({ session }) => session.mixer.a.eqLow <= -12 && session.mixer.b.eqLow >= -1,
};

const finish: LessonStep = {
  id: "finish",
  target: "crossfader",
  instruction: "guide.l1.s9",
  locks: [],
  demo: true,
  onTick: (context, api) => {
    if (context.session.mixer.crossfader >= 0.99) {
      if (api.memory.blendEnd === undefined) api.memory.blendEnd = context.now;
      if (context.frame?.decks.A.playing && !api.memory.stoppingA) {
        api.memory.stoppingA = true;
        void deckActions.stop("A");
      }
    }
  },
  isComplete: (context, api) => {
    if (context.session.mixer.crossfader < 0.99 || context.frame?.decks.A.playing !== false) return false;
    const errors = (api.memory.errors as number[] | undefined) ?? [];
    const alignmentMs = errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : 0;
    const start = typeof api.memory.blendStart === "number" ? api.memory.blendStart : context.now;
    const end = typeof api.memory.blendEnd === "number" ? api.memory.blendEnd : context.now;
    const blendBars = Math.max(1, Math.round((end - start) / (barSeconds(context) * 1000)));
    const swapPhase = typeof api.memory.bassSwapPhase === "number" ? api.memory.bassSwapPhase : Number.NaN;
    api.setScore({
      alignmentMs: Math.round(alignmentMs),
      blendBars,
      bassSwapOnBeatOne: Number.isFinite(swapPhase) && swapPhase <= 1,
    });
    return true;
  },
};

const score: LessonStep = {
  id: "score",
  target: "score",
  instruction: "guide.l1.s10",
  locks: [],
  cardControls: "score",
  isComplete: () => false,
};

/** The phase meter is revealed 4 bars after B entered, whatever step the user is on by then. */
function revealPhaseMeter(context: LessonContext, api: LessonApi): void {
  const analysis = context.session.decks.A.analysis;
  const frame = context.frame;
  const enteredAt = api.memory.enteredAt;
  if (!analysis || !frame || typeof enteredAt !== "number") return;
  const beatsSinceEntry =
    beatPosition(analysis.grid, frame.decks.A.positionSec) - beatPosition(analysis.grid, enteredAt);
  if (beatsSinceEntry >= REVEAL_AFTER_BEATS) api.reveal("phaseMeter");
}

export const lesson1: Lesson = {
  id: "l1",
  title: "guide.l1.title",
  steps: [pair, analyse, confirmBeatOne, playA, enterB, checkByEar, blend, bassSwap, finish, score],
  replayStep: 3,
  onTick: revealPhaseMeter,
};

/** Test hook: the lesson's step ids in order. */
export const LESSON1_STEP_IDS = lesson1.steps.map((step) => step.id);

export function stepApiForTests(): LessonApi {
  return { memory: {}, reveal: () => {}, setScore: () => {} };
}
