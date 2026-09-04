import type { DeckCommand, DeckReport, LoopFrames } from "./messages";

export interface DeckPositionReport {
  frame: number;
  playing: boolean;
  contextFrame: number;
  rate: number;
}

export type DeckListener = (report: DeckReport) => void;

/** Main-thread handle for one `mixerx-deck` worklet node. */
export class Deck {
  readonly node: AudioWorkletNode;
  readonly rate: AudioParam;
  trackId: string | null = null;
  trackRate = 44100;
  lengthFrames = 0;
  cueSec = 0;
  loop: { startSec: number; endSec: number } | null = null;
  /** Context frame of the last `started` report (for sample-accuracy checks). */
  lastStartFrame: number | null = null;
  private report: DeckPositionReport = { frame: 0, playing: false, contextFrame: 0, rate: 1 };
  private readonly listeners = new Set<DeckListener>();

  constructor(
    private readonly context: BaseAudioContext,
    readonly id: string,
  ) {
    this.node = new AudioWorkletNode(context, "mixerx-deck", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const rate = this.node.parameters.get("rate");
    if (!rate) throw new Error("deck-processor exposes no rate parameter");
    this.rate = rate;
    this.node.port.onmessage = (event: MessageEvent<DeckReport>) => this.handle(event.data);
  }

  private handle(report: DeckReport): void {
    switch (report.type) {
      case "position":
        this.report = {
          frame: report.frame,
          playing: report.playing,
          contextFrame: report.contextFrame,
          rate: report.rate,
        };
        break;
      case "started":
        this.report = { ...this.report, frame: report.frame, playing: true, contextFrame: report.atFrame };
        this.lastStartFrame = report.atFrame;
        break;
      case "stopped":
        this.report = { ...this.report, frame: report.frame, playing: false, contextFrame: report.atFrame };
        break;
      case "ended":
        this.report = {
          ...this.report,
          playing: false,
          contextFrame: report.atFrame,
          frame: Math.max(0, this.lengthFrames - 1),
        };
        break;
      default:
        break;
    }
    for (const listener of this.listeners) listener(report);
  }

  subscribe(listener: DeckListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves with the next report matching `predicate`, or rejects after `timeoutMs`. */
  waitFor<T extends DeckReport>(
    predicate: (report: DeckReport) => report is T,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`deck ${this.id}: no report within ${timeoutMs} ms`));
      }, timeoutMs);
      const unsubscribe = this.subscribe((report) => {
        if (!predicate(report)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(report);
      });
    });
  }

  /** Round-trips through the render thread so every command sent so far has been applied. */
  async sync(timeoutMs = 5000): Promise<Extract<DeckReport, { type: "state" }>> {
    const pending = this.waitFor(
      (report): report is Extract<DeckReport, { type: "state" }> => report.type === "state",
      timeoutMs,
    );
    this.send({ type: "inspect" });
    return pending;
  }

  private send(command: DeckCommand, transfer: Transferable[] = []): void {
    this.node.port.postMessage(command, transfer);
  }

  /** Transfers ownership of `channels` to the render thread. */
  load(channels: Float32Array[], sampleRate: number, trackId: string): void {
    this.trackId = trackId;
    this.trackRate = sampleRate;
    this.lengthFrames = channels[0]?.length ?? 0;
    this.cueSec = 0;
    this.loop = null;
    this.report = { frame: 0, playing: false, contextFrame: 0, rate: this.rate.value };
    this.send(
      { type: "load", trackId, sampleRate, channels },
      channels.map((channel) => channel.buffer),
    );
  }

  unload(): void {
    this.trackId = null;
    this.lengthFrames = 0;
    this.cueSec = 0;
    this.loop = null;
    this.report = { frame: 0, playing: false, contextFrame: 0, rate: this.rate.value };
    this.send({ type: "unload" });
  }

  play(atContextFrame?: number): void {
    if (atContextFrame === undefined) this.send({ type: "play" });
    else this.send({ type: "play", atFrame: atContextFrame });
  }

  stop(atContextFrame?: number): void {
    if (atContextFrame === undefined) this.send({ type: "stop" });
    else this.send({ type: "stop", atFrame: atContextFrame });
  }

  seekSec(sec: number): void {
    const frame = Math.min(Math.max(0, Math.round(sec * this.trackRate)), Math.max(0, this.lengthFrames - 1));
    this.send({ type: "seek", frame });
    this.report = {
      ...this.report,
      frame,
      contextFrame: Math.round(this.context.currentTime * this.context.sampleRate),
    };
  }

  setLoop(loop: { startSec: number; endSec: number } | null): void {
    this.loop = loop;
    const frames: LoopFrames | null = loop
      ? {
          startFrame: Math.round(loop.startSec * this.trackRate),
          endFrame: Math.round(loop.endSec * this.trackRate),
        }
      : null;
    this.send({ type: "loop", loop: frames });
  }

  setRate(rate: number, slewSeconds = 0.02): void {
    const now = this.context.currentTime;
    this.rate.cancelScheduledValues(now);
    this.rate.setValueAtTime(this.rate.value, now);
    this.rate.linearRampToValueAtTime(rate, now + Math.max(0.001, slewSeconds));
  }

  get playing(): boolean {
    return this.report.playing;
  }

  get currentRate(): number {
    return this.report.playing ? this.report.rate : this.rate.value;
  }

  get durationSec(): number {
    return this.trackRate > 0 ? this.lengthFrames / this.trackRate : 0;
  }

  /** Extrapolated position in seconds at context time `now`. */
  positionSec(now = this.context.currentTime): number {
    const report = this.report;
    const reportedAt = report.contextFrame / this.context.sampleRate;
    const elapsed = Math.max(0, now - reportedAt);
    const frame = report.playing ? report.frame + elapsed * this.trackRate * report.rate : report.frame;
    return this.trackRate > 0 ? Math.min(Math.max(0, frame), this.lengthFrames) / this.trackRate : 0;
  }
}
