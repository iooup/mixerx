import { createStore, useStore } from "../state/store";
import type { LessonScore, LockId } from "./types";

export type GuideStatus = "idle" | "running" | "demo" | "demo-done" | "finished";

export interface GuideState {
  lessonId: string | null;
  stepIndex: number;
  stepCount: number;
  status: GuideStatus;
  locks: LockId[];
  phaseMeterRevealed: boolean;
  score: LessonScore | null;
  /** Calibration card state (step 3). */
  calibration: { downbeatOffset: number; gridOffsetMs: number; looping: boolean } | null;
  /** Live detail for the current step card, e.g. aligned beats so far. */
  progress: Record<string, number | string | boolean>;
}

export type GuideEvent =
  | { type: "guide/start"; lessonId: string; stepCount: number }
  | { type: "guide/step"; index: number; locks: LockId[] }
  | { type: "guide/status"; status: GuideStatus }
  | { type: "guide/reveal"; feature: "phaseMeter" }
  | { type: "guide/score"; score: LessonScore }
  | { type: "guide/calibration"; calibration: GuideState["calibration"] }
  | { type: "guide/progress"; progress: Record<string, number | string | boolean> }
  | { type: "guide/stop" };

export function createInitialGuide(): GuideState {
  return {
    lessonId: null,
    stepIndex: 0,
    stepCount: 0,
    status: "idle",
    locks: [],
    phaseMeterRevealed: false,
    score: null,
    calibration: null,
    progress: {},
  };
}

export function reduceGuide(state: GuideState, event: GuideEvent): GuideState {
  switch (event.type) {
    case "guide/start":
      return {
        ...createInitialGuide(),
        lessonId: event.lessonId,
        stepCount: event.stepCount,
        status: "running",
      };
    case "guide/step":
      return { ...state, stepIndex: event.index, locks: event.locks, progress: {}, calibration: null };
    case "guide/status":
      return state.status === event.status ? state : { ...state, status: event.status };
    case "guide/reveal":
      return state.phaseMeterRevealed ? state : { ...state, phaseMeterRevealed: true };
    case "guide/score":
      return { ...state, score: event.score };
    case "guide/calibration":
      return { ...state, calibration: event.calibration };
    case "guide/progress": {
      const keys = Object.keys(event.progress);
      if (keys.every((key) => state.progress[key] === event.progress[key])) return state;
      return { ...state, progress: { ...state.progress, ...event.progress } };
    }
    case "guide/stop":
      return createInitialGuide();
    default:
      return state;
  }
}

export const guideStore = createStore(createInitialGuide(), reduceGuide);

const identity = (state: GuideState) => state;
export function useGuide(): GuideState {
  return useStore(guideStore, identity);
}
