import type { EngineFrame } from "../engine/audio-engine";
import type { Session } from "../state/session";

export type GuideTargetId =
  | "library"
  | "deck-A-header"
  | "calibration"
  | "deck-A-play"
  | "enter"
  | "nudge-B"
  | "crossfader"
  | "eq-low-A"
  | "score";

export type LockId = "crossfader" | "play-B" | "strips";

export interface LessonScore {
  alignmentMs: number;
  blendBars: number;
  bassSwapOnBeatOne: boolean;
}

export interface LessonContext {
  session: Session;
  frame: EngineFrame | null;
  now: number; // ms, monotonic
  stepEnteredAt: number; // ms
}

/** What a step may do besides reading state. */
export interface LessonApi {
  memory: Record<string, unknown>;
  reveal(feature: "phaseMeter"): void;
  setScore(score: LessonScore): void;
}

export interface LessonStep {
  id: string;
  target: GuideTargetId;
  instruction: string; // locale key
  hint?: string; // locale key
  locks: LockId[];
  /** Steps whose own card carries the control (calibration, ENTER, score). */
  cardControls?: "calibration" | "enter" | "score";
  demo?: boolean; // "Show me" is offered on this step
  onEnter?(context: LessonContext, api: LessonApi): void;
  onTick?(context: LessonContext, api: LessonApi): void;
  isComplete(context: LessonContext, api: LessonApi): boolean;
  onLeave?(context: LessonContext, api: LessonApi): void;
}

export interface Lesson {
  id: string;
  title: string; // locale key
  steps: LessonStep[];
  /** Runs every tick regardless of the current step (e.g. time-based reveals). */
  onTick?(context: LessonContext, api: LessonApi): void;
  /** Step index to return to after a demonstration or a replay. */
  replayStep: number;
}
