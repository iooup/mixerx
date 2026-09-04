/**
 * Guide engine: runs a declarative lesson against live engine state (100 ms tick), owns the
 * calibration loop (step 3), the ENTER action (step 5), and the "Show me" demonstration.
 */
import { deckActions, mixerActions } from "../engine/actions";
import { beatPeriodSec, EQ_MIN_DB, nextDownbeatSec } from "../engine/beat-math";
import { getEngine } from "../engine/index";
import { getLibrary } from "../library/library";
import { sessionStore } from "../state/session-store";
import { readJson, safeStorage, writeJson } from "../state/store";
import { guideStore } from "./guide-store";
import type { Lesson, LessonApi, LessonContext, LessonScore, LessonStep } from "./types";

const TICK_MS = 100;

export class GuideEngine {
  private lesson: Lesson | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stepEnteredAt = 0;
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private readonly api: LessonApi = {
    memory: {},
    reveal: (feature) => guideStore.dispatch({ type: "guide/reveal", feature }),
    setScore: (score: LessonScore) => {
      guideStore.dispatch({ type: "guide/score", score });
      // A finished lesson earns its badges and extends the practice streak. Local, like everything
      // else: `mixerx.v2.badges` never leaves this machine, and nothing is ever locked behind one.
      void import("../ui/recap/recap-model").then(({ awardLesson, BADGES_KEY, emptyBadges }) => {
        const storage = safeStorage();
        const current = readJson<Parameters<typeof awardLesson>[0]>(storage, BADGES_KEY) ?? emptyBadges();
        writeJson(storage, BADGES_KEY, awardLesson(current, score, Date.now()));
      });
    },
  };

  get current(): LessonStep | null {
    return this.lesson?.steps[guideStore.getState().stepIndex] ?? null;
  }

  start(lesson: Lesson): void {
    this.stop();
    this.lesson = lesson;
    this.api.memory = {};
    guideStore.dispatch({ type: "guide/start", lessonId: lesson.id, stepCount: lesson.steps.length });
    this.enter(0);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopDemo();
    if (this.lesson && guideStore.getState().status !== "idle") {
      this.current?.onLeave?.(this.context(), this.api);
      void this.endCalibration(false);
    }
    this.lesson = null;
    guideStore.dispatch({ type: "guide/stop" });
  }

  /** Restart at the lesson's replay step (decks stopped at their cue points, mixer neutral). */
  async replay(): Promise<void> {
    const lesson = this.lesson;
    if (!lesson) return;
    this.stopDemo();
    await this.resetMix();
    this.api.memory = { confirmed: this.api.memory.confirmed };
    guideStore.dispatch({ type: "guide/status", status: "running" });
    this.enter(lesson.replayStep);
  }

  private context(): LessonContext {
    const engine = getEngine();
    return {
      session: sessionStore.getState(),
      frame: engine ? engine.frame() : null,
      now: performance.now(),
      stepEnteredAt: this.stepEnteredAt,
    };
  }

  private enter(index: number): void {
    const lesson = this.lesson;
    const step = lesson?.steps[index];
    if (!lesson || !step) return;
    this.stepEnteredAt = performance.now();
    guideStore.dispatch({ type: "guide/step", index, locks: step.locks });
    step.onEnter?.(this.context(), this.api);
    if (step.cardControls === "calibration") void this.beginCalibration();
  }

  private tick(): void {
    const lesson = this.lesson;
    const state = guideStore.getState();
    if (!lesson || state.status !== "running") return;
    const step = lesson.steps[state.stepIndex];
    if (!step) return;
    const context = this.context();
    lesson.onTick?.(context, this.api);
    step.onTick?.(context, this.api);
    this.publishProgress(step, context);
    if (!step.isComplete(context, this.api)) return;
    step.onLeave?.(context, this.api);
    if (state.stepIndex + 1 < lesson.steps.length) this.enter(state.stepIndex + 1);
    else guideStore.dispatch({ type: "guide/status", status: "finished" });
  }

  private publishProgress(step: LessonStep, context: LessonContext): void {
    const memory = this.api.memory;
    if (step.id === "check") {
      guideStore.dispatch({
        type: "guide/progress",
        progress: { alignedBeats: Number(memory.alignedStreak ?? 0) },
      });
    } else if (step.id === "blend") {
      const since = memory.zoneSince;
      const analysis = context.session.decks.A.analysis;
      const bar = analysis
        ? (4 * beatPeriodSec(analysis.grid, context.frame?.decks.A.positionSec ?? 0)) /
          (context.frame?.decks.A.rate || 1)
        : 2;
      const bars = typeof since === "number" ? Math.floor((context.now - since) / (bar * 1000)) : 0;
      guideStore.dispatch({ type: "guide/progress", progress: { barsInZone: bars } });
    } else if (step.id === "score") {
      // nothing live
    }
  }

  // ---------- Step 3: calibration loop on CUE ----------

  private calibrationActive = false;

  private async beginCalibration(): Promise<void> {
    const session = sessionStore.getState();
    const analysis = session.decks.B.analysis;
    const track = session.decks.B.track;
    if (!analysis || !track) return;
    if (analysis.grid.downbeatConfirmed) {
      this.api.memory.confirmed = true;
      return;
    }
    const userData = await getLibrary().getUserData(track.id);
    guideStore.dispatch({
      type: "guide/calibration",
      calibration: {
        downbeatOffset: analysis.grid.downbeatOffset,
        gridOffsetMs: userData?.gridOffsetMs ?? 0,
        looping: false,
      },
    });
  }

  /** Loops the first 4 beats from B's first downbeat through the CUE bus (PFL on, fader down). */
  async toggleCalibrationLoop(): Promise<void> {
    const state = guideStore.getState();
    if (!state.calibration) return;
    if (state.calibration.looping) {
      await this.endCalibration(false);
      guideStore.dispatch({
        type: "guide/calibration",
        calibration: { ...state.calibration, looping: false },
      });
      return;
    }
    const engine = getEngine();
    const session = sessionStore.getState();
    const analysis = session.decks.B.analysis;
    if (!engine || !analysis) return;
    this.calibrationActive = true;
    this.api.memory.faderB = session.mixer.b.fader;
    this.api.memory.pflB = session.mixer.b.pfl;
    await mixerActions.setStrip("B", "fader", 0);
    await mixerActions.setStrip("B", "pfl", true);
    this.applyCalibrationLoop();
    engine.decks.B.play();
    guideStore.dispatch({ type: "guide/calibration", calibration: { ...state.calibration, looping: true } });
  }

  private applyCalibrationLoop(): void {
    const engine = getEngine();
    const analysis = sessionStore.getState().decks.B.analysis;
    if (!engine || !analysis) return;
    const start = Math.max(0, nextDownbeatSec(analysis.grid, -0.001, 0));
    const end = start + 4 * beatPeriodSec(analysis.grid, start);
    engine.decks.B.setLoop({ startSec: start, endSec: end });
    engine.decks.B.seekSec(start);
  }

  async adjustCalibration(patch: { beats?: -1 | 1; ms?: -10 | 10 }): Promise<void> {
    const state = guideStore.getState();
    const track = sessionStore.getState().decks.B.track;
    if (!state.calibration || !track) return;
    const next = { ...state.calibration };
    if (patch.beats) next.downbeatOffset = (((next.downbeatOffset + patch.beats) % 4) + 4) % 4;
    if (patch.ms) next.gridOffsetMs = Math.max(-200, Math.min(200, next.gridOffsetMs + patch.ms));
    await getLibrary().updateUserData(track.id, {
      downbeatOffset: next.downbeatOffset as 0 | 1 | 2 | 3,
      gridOffsetMs: next.gridOffsetMs,
    });
    guideStore.dispatch({ type: "guide/calibration", calibration: next });
    if (next.looping) this.applyCalibrationLoop();
  }

  async confirmCalibration(): Promise<void> {
    const track = sessionStore.getState().decks.B.track;
    if (!track) return;
    await this.endCalibration(true);
    await getLibrary().updateUserData(track.id, { downbeatConfirmed: true });
    this.api.memory.confirmed = true;
  }

  private async endCalibration(confirmed: boolean): Promise<void> {
    if (!this.calibrationActive) return;
    this.calibrationActive = false;
    const engine = getEngine();
    if (engine) {
      engine.decks.B.stop();
      engine.decks.B.setLoop(null);
      engine.decks.B.seekSec(engine.decks.B.cueSec);
    }
    sessionStore.dispatch({ type: "deck/loop", deck: "B", loop: null });
    const fader = typeof this.api.memory.faderB === "number" ? this.api.memory.faderB : 1;
    await mixerActions.setStrip("B", "fader", fader);
    await mixerActions.setStrip("B", "pfl", Boolean(this.api.memory.pflB) && !confirmed);
  }

  // ---------- Step 5: ENTER ----------

  async enterB(): Promise<void> {
    const event = await deckActions.enterOnNextBar("B", { sync: true });
    if (event?.atContextFrame !== undefined) this.api.memory.enterFrame = event.atContextFrame;
  }

  // ---------- "Show me": steps 7–9 automated, then "Your turn" ----------

  showMe(): void {
    const engine = getEngine();
    const session = sessionStore.getState();
    const analysis = session.decks.A.analysis;
    if (!engine || !analysis || !engine.decks.A.playing || !engine.decks.B.playing) return;
    this.stopDemo();
    guideStore.dispatch({ type: "guide/status", status: "demo" });
    const startedAt = performance.now();
    const bar = (4 * beatPeriodSec(analysis.grid, engine.decks.A.positionSec())) / engine.decks.A.currentRate;
    const blendMs = 8 * bar * 1000;
    const swapMs = bar * 1000; // one bar for the bass swap
    const finishMs = 4 * bar * 1000;
    const from = session.mixer.crossfader;
    let phase: "blend" | "swap" | "finish" | "done" = "blend";
    let phaseStart = startedAt;
    const lowA0 = session.mixer.a.eqLow;
    const lowB0 = session.mixer.b.eqLow;
    this.demoTimer = setInterval(() => {
      const now = performance.now();
      const t = (now - phaseStart) / (phase === "blend" ? blendMs : phase === "swap" ? swapMs : finishMs);
      const eased = Math.min(1, t);
      if (phase === "blend") {
        void mixerActions.setCrossfader(from + (0.5 - from) * eased);
        if (eased >= 1) {
          phase = "swap";
          phaseStart = now;
        }
      } else if (phase === "swap") {
        void mixerActions.setStrip("A", "eqLow", lowA0 + (EQ_MIN_DB - lowA0) * eased);
        void mixerActions.setStrip("B", "eqLow", lowB0 + (0 - lowB0) * eased);
        if (eased >= 1) {
          phase = "finish";
          phaseStart = now;
        }
      } else if (phase === "finish") {
        void mixerActions.setCrossfader(0.5 + 0.5 * eased);
        if (eased >= 1) {
          phase = "done";
          void deckActions.stop("A");
          this.stopDemo(false);
          guideStore.dispatch({ type: "guide/status", status: "demo-done" });
        }
      }
    }, 50);
  }

  private stopDemo(resetStatus = true): void {
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = null;
    if (resetStatus && guideStore.getState().status === "demo")
      guideStore.dispatch({ type: "guide/status", status: "running" });
  }

  /** After the demonstration: back to "Play A" with everything reset. */
  async yourTurn(): Promise<void> {
    await this.replay();
  }

  private async resetMix(): Promise<void> {
    const engine = getEngine();
    if (engine) {
      engine.decks.A.stop();
      engine.decks.B.stop();
      engine.decks.A.setLoop(null);
      engine.decks.B.setLoop(null);
      engine.decks.A.seekSec(engine.decks.A.cueSec);
      engine.decks.B.seekSec(engine.decks.B.cueSec);
    }
    await mixerActions.setCrossfader(0);
    await mixerActions.setStrip("A", "eqLow", 0);
    await mixerActions.setStrip("B", "eqLow", 0);
    await mixerActions.setStrip("B", "pfl", false);
    await mixerActions.setStrip("B", "fader", 1);
    await mixerActions.setStrip("A", "fader", 1);
  }
}

export const guide = new GuideEngine();
