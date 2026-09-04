/**
 * Stage-side client: subscribes to the session channel, keeps the latest frame and the events
 * since the last render, mirrors settings, and announces its presence so the console can count
 * displays. In demo mode it runs the deterministic test signal locally instead.
 */

import { sceneCategory } from "../agent/scenes";
import { safeStorage } from "../state/store";
import { followScene } from "./follow";
import { stageMetaStore } from "./meta-store";
import { FramePredictor, type PredictorState } from "./predict";
import {
  absoluteNow,
  channelName,
  emptyFrame,
  F,
  isStageMessage,
  STAGE_LAST_SESSION_KEY,
  type StageEvent,
  type StageFrame,
  type StageMessage,
  type StageRole,
  type StageSettings,
  sanitisePatch,
  sanitiseSettings,
  shortId,
} from "./protocol";
import { stageSettingsStore } from "./settings-store";
import { stageStatusStore } from "./stage-status";
import { TestSignal } from "./test-signal";

export interface StageClientState {
  connected: boolean; // frames arrived within the last 1.5 s (or demo running)
  demo: boolean;
  sessionId: string | null;
  lastFrameAt: number;
  frameRate: number; // incoming frames per second
}

export interface StageClientOptions {
  role: StageRole;
  demo?: boolean;
  /** Demo speed multiplier (tests run the 32 bars faster). */
  speed?: number;
}

const CONNECTION_TIMEOUT_MS = 1500;
const PRESENCE_INTERVAL_MS = 1000;

export class StageClient {
  readonly id = shortId();
  private channel: BroadcastChannel | null = null;
  private frame: StageFrame;
  private events: StageEvent[] = [];
  private state: StageClientState;
  private readonly listeners = new Set<() => void>();
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private demoSignal: TestSignal | null = null;
  private demoLast = 0;
  private frameTimes: number[] = [];
  private lastSection: string = "none";
  private started = false;
  private readonly predictor: FramePredictor;

  constructor(
    readonly sessionId: string | null,
    private readonly options: StageClientOptions,
  ) {
    this.frame = emptyFrame(sessionId ?? "demo");
    this.predictor = new FramePredictor(this.frame, options.demo ? (options.speed ?? 1) : 1);
    this.state = { connected: false, demo: Boolean(options.demo), sessionId, lastFrameAt: 0, frameRate: 0 };
  }

  getState(): StageClientState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<StageClientState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(patch) as (keyof StageClientState)[]).some(
      (key) => this.state[key] !== next[key],
    );
    if (!changed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.options.demo) {
      this.demoSignal = new TestSignal("demo");
      this.demoLast = performance.now();
      this.setState({ connected: true });
      return;
    }
    if (!this.sessionId || typeof BroadcastChannel === "undefined") return;
    this.channel = new BroadcastChannel(channelName(this.sessionId));
    this.channel.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    this.post({ type: "hello", from: this.id, role: this.options.role });
    this.presenceTimer = setInterval(
      () => this.post({ type: "presence", from: this.id, role: this.options.role }),
      PRESENCE_INTERVAL_MS,
    );
    this.watchdog = setInterval(() => {
      const stale = performance.now() - this.state.lastFrameAt > CONNECTION_TIMEOUT_MS;
      if (stale && this.state.connected) this.setState({ connected: false, frameRate: 0 });
    }, 500);
    try {
      safeStorage()?.setItem(STAGE_LAST_SESSION_KEY, this.sessionId);
    } catch {
      // Storage is optional.
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.presenceTimer = null;
    this.watchdog = null;
    if (this.channel) {
      this.post({ type: "bye", from: this.id });
      this.channel.close();
      this.channel = null;
    }
    this.demoSignal = null;
  }

  private post(message: StageMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // A closed channel is not an error for the Stage.
    }
  }

  private receive(data: unknown): void {
    if (!isStageMessage(data)) return;
    switch (data.type) {
      case "frame":
        this.acceptFrame(data.frame);
        break;
      case "settings":
        stageSettingsStore.dispatch({ type: "stage/replace", settings: sanitiseSettings(data.settings) });
        break;
      case "meta":
        stageMetaStore.dispatch({
          type: "meta/set",
          meta: { now: data.now, night: data.night, eventName: data.eventName },
        });
        break;
      case "patch":
        if (data.from !== this.id)
          stageSettingsStore.dispatch({ type: "stage/patch", patch: sanitisePatch(data.patch) });
        break;
      case "who":
        this.post({ type: "presence", from: this.id, role: this.options.role });
        break;
      default:
        break;
    }
  }

  private acceptFrame(frame: StageFrame): void {
    if (frame.seq < this.frame.seq && frame.seq !== 0 && this.frame.seq - frame.seq < 1000) return; // out of order
    this.frame = frame;
    this.predictor.push(frame, absoluteNow());
    if (frame.events.length) this.events.push(...frame.events);
    const now = performance.now();
    this.frameTimes.push(now);
    while (this.frameTimes.length && (this.frameTimes[0] as number) < now - 1000) this.frameTimes.shift();
    this.setState({ connected: true, lastFrameAt: now, frameRate: this.frameTimes.length });
  }

  /** Applies a settings change locally and tells the console (which rebroadcasts the full state). */
  patch(patch: Partial<StageSettings>): void {
    stageSettingsStore.dispatch({ type: "stage/patch", patch });
    this.post({ type: "patch", patch, from: this.id });
  }

  /**
   * The frame to render at `nowMs` and every event since the previous call (the render loop's
   * input). The frame is the prediction, not the last one received: it advances the beat phase and
   * smooths the continuous features between the ≤ 60 Hz frames so 120 Hz rendering is fluid.
   */
  take(nowMs: number, dt: number): { frame: StageFrame; events: StageEvent[] } {
    if (this.demoSignal) {
      const now = performance.now();
      const step = ((now - this.demoLast) / 1000) * (this.options.speed ?? 1);
      this.demoLast = now;
      const frame = this.demoSignal.next(step);
      this.frame = frame;
      this.predictor.push(frame, nowMs);
      this.events.push(...frame.events);
      this.setState({ connected: true, lastFrameAt: now, frameRate: 60 });
      this.applyFollowLocally();
    }
    const events = this.events;
    this.events = [];
    return { frame: this.predictor.sample(nowMs, dt), events };
  }

  /** Age of the prediction's source frame and whether it is holding (studio read-out, perf hook). */
  prediction(nowMs: number): PredictorState {
    return this.predictor.state(nowMs);
  }

  /** Demo only: the console is absent, so the follow rule runs here. */
  private applyFollowLocally(): void {
    const settings = stageSettingsStore.getState();
    if (this.frame.section === this.lastSection) return;
    this.lastSection = this.frame.section;
    if (!settings.follow || settings.blackout) return;
    const next = followScene(
      this.frame.section,
      this.frame.f[F.energy] ?? 0.5,
      0,
      sceneCategory(settings.sceneId),
    );
    if (next && next !== settings.sceneId)
      stageSettingsStore.dispatch({ type: "stage/patch", patch: { sceneId: next } });
  }
}

/** Adds the crowd to the scene on screen, or removes it from it (the DJ's button and the C key). */
export function toggleCrowd(client: StageClient): void {
  const settings = stageSettingsStore.getState();
  const scene = stageStatusStore.getState().sceneId || settings.sceneId;
  if (!scene || scene === "blackout") return;
  const has = settings.crowdScenes.includes(scene);
  client.patch({
    crowdScenes: has ? settings.crowdScenes.filter((id) => id !== scene) : [...settings.crowdScenes, scene],
  });
}
