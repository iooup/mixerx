/// <reference types="audioworklet" />
/**
 * Deck playback processor. Holds the decoded track, plays it at a fractional rate with
 * 4-point Hermite interpolation, executes sample-accurate play/stop at a requested context
 * frame, and loops inside the render quantum (no main-thread seeking).
 */
import type { DeckCommand, DeckReport, LoopFrames, WorkletParamDescriptor } from "../messages";

const DEFAULT_REPORT_FRAMES = 1024;

function hermite(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + y1;
}

class DeckProcessor extends AudioWorkletProcessor {
  private channels: Float32Array[] = [];
  private trackId: string | null = null;
  private length = 0;
  private trackRate = sampleRate;
  private position = 0;
  private playing = false;
  private pendingPlayAt: number | null = null;
  private pendingStopAt: number | null = null;
  private loop: LoopFrames | null = null;
  private reportEvery = DEFAULT_REPORT_FRAMES;
  private framesSinceReport = 0;
  private lastRate = 1;
  private readonly log: string[] = [];

  static get parameterDescriptors(): WorkletParamDescriptor[] {
    return [{ name: "rate", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<DeckCommand>) => this.handle(event.data);
  }

  private post(report: DeckReport): void {
    this.port.postMessage(report);
  }

  private handle(command: DeckCommand): void {
    if (this.log.length < 32) this.log.push(`${command.type}@${currentFrame}`);
    switch (command.type) {
      case "load":
        this.channels = command.channels;
        this.trackId = command.trackId;
        this.length = command.channels[0]?.length ?? 0;
        this.trackRate = command.sampleRate > 0 ? command.sampleRate : sampleRate;
        this.position = 0;
        this.playing = false;
        this.pendingPlayAt = null;
        this.pendingStopAt = null;
        this.loop = null;
        this.post({ type: "loaded", trackId: command.trackId, length: this.length });
        break;
      case "unload":
        this.channels = [];
        this.trackId = null;
        this.length = 0;
        this.position = 0;
        this.playing = false;
        this.pendingPlayAt = null;
        this.pendingStopAt = null;
        this.loop = null;
        break;
      case "play":
        if (command.atFrame === undefined) this.pendingStopAt = null;
        this.pendingPlayAt =
          command.atFrame === undefined ? currentFrame : Math.max(currentFrame, command.atFrame);
        break;
      case "stop":
        if (command.atFrame === undefined) this.pendingPlayAt = null;
        this.pendingStopAt =
          command.atFrame === undefined ? currentFrame : Math.max(currentFrame, command.atFrame);
        break;
      case "seek":
        this.position = Math.min(Math.max(0, command.frame), Math.max(0, this.length - 1));
        break;
      case "loop":
        this.loop =
          command.loop && command.loop.endFrame > command.loop.startFrame
            ? {
                startFrame: Math.max(0, command.loop.startFrame),
                endFrame: Math.min(this.length, command.loop.endFrame),
              }
            : null;
        break;
      case "report":
        this.reportEvery = Math.max(128, command.everyFrames);
        break;
      case "inspect":
        this.post({
          type: "state",
          currentFrame,
          position: this.position,
          playing: this.playing,
          pendingPlayAt: this.pendingPlayAt,
          pendingStopAt: this.pendingStopAt,
          length: this.length,
          trackId: this.trackId,
          log: this.log.slice(),
        });
        break;
      default:
        break;
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const output = outputs[0];
    const left = output?.[0];
    if (!output || !left) return true;
    const right = output[1] ?? left;
    const frames = left.length;
    left.fill(0);
    if (right !== left) right.fill(0);

    const rates = parameters.rate;
    const blockStart = currentFrame;
    const ratio = this.trackRate / sampleRate;
    const source0 = this.channels[0];
    const source1 = this.channels[1] ?? source0;

    for (let i = 0; i < frames; i += 1) {
      const frame = blockStart + i;
      if (this.pendingPlayAt !== null && frame >= this.pendingPlayAt) {
        this.pendingPlayAt = null;
        if (source0 && this.trackId) {
          this.playing = true;
          this.post({ type: "started", trackId: this.trackId, atFrame: frame, frame: this.position });
        }
      }
      if (this.pendingStopAt !== null && frame >= this.pendingStopAt) {
        this.pendingStopAt = null;
        if (this.playing && this.trackId) {
          this.playing = false;
          this.post({ type: "stopped", trackId: this.trackId, atFrame: frame, frame: this.position });
        }
      }
      if (!this.playing || !source0 || !source1) continue;

      if (this.loop && this.position >= this.loop.endFrame) {
        const span = this.loop.endFrame - this.loop.startFrame;
        this.position =
          span > 0
            ? this.loop.startFrame + ((this.position - this.loop.startFrame) % span)
            : this.loop.startFrame;
      }
      if (this.position >= this.length - 2) {
        this.playing = false;
        this.position = Math.max(0, this.length - 1);
        if (this.trackId) this.post({ type: "ended", trackId: this.trackId, atFrame: frame });
        continue;
      }

      const rate = rates && rates.length > 1 ? (rates[i] ?? 1) : (rates?.[0] ?? 1);
      this.lastRate = rate;
      const index = Math.floor(this.position);
      const t = this.position - index;
      const i0 = index > 0 ? index - 1 : 0;
      const i2 = index + 1 < this.length ? index + 1 : index;
      const i3 = index + 2 < this.length ? index + 2 : i2;
      left[i] = hermite(source0[i0] ?? 0, source0[index] ?? 0, source0[i2] ?? 0, source0[i3] ?? 0, t);
      if (right !== left) {
        right[i] = hermite(source1[i0] ?? 0, source1[index] ?? 0, source1[i2] ?? 0, source1[i3] ?? 0, t);
      }
      this.position += ratio * rate;
    }

    this.framesSinceReport += frames;
    if (this.framesSinceReport >= this.reportEvery) {
      this.framesSinceReport = 0;
      this.post({
        type: "position",
        trackId: this.trackId,
        frame: this.position,
        playing: this.playing,
        contextFrame: blockStart + frames,
        rate: this.lastRate,
      });
    }
    return true;
  }
}

registerProcessor("mixerx-deck", DeckProcessor);
