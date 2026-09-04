/// <reference types="audioworklet" />
/**
 * Look-ahead brick-wall limiter (5 ms look-ahead, instant attack, 80 ms release, stereo linked).
 * The sliding-window minimum of the required gain uses a monotonic deque, so the cost per
 * sample is O(1) amortised.
 */
import type { LimiterReport, WorkletParamDescriptor } from "../messages";

const LOOKAHEAD_SECONDS = 0.005;
const RELEASE_SECONDS = 0.08;
const REPORT_FRAMES = 2048;

class LimiterProcessor extends AudioWorkletProcessor {
  private readonly lookahead: number;
  private readonly window: number;
  private readonly delay: [Float32Array, Float32Array];
  private writeIndex = 0;
  private readonly gains: Float32Array;
  private readonly deque: Float64Array;
  private readonly dequeCapacity: number;
  private dequeHead = 0;
  private dequeTail = 0;
  private sampleCounter = 0;
  private envelope = 1;
  private minEnvelope = 1;
  private framesSinceReport = 0;
  private readonly releaseRate: number;

  static get parameterDescriptors(): WorkletParamDescriptor[] {
    return [{ name: "ceiling", defaultValue: 0.891, minValue: 0.05, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.lookahead = Math.max(1, Math.round(sampleRate * LOOKAHEAD_SECONDS));
    this.window = this.lookahead + 1;
    this.delay = [new Float32Array(this.lookahead), new Float32Array(this.lookahead)];
    this.gains = new Float32Array(this.window);
    this.dequeCapacity = this.window + 1;
    this.deque = new Float64Array(this.dequeCapacity);
    this.releaseRate = 1 - Math.exp(-1 / (sampleRate * RELEASE_SECONDS));
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const output = outputs[0];
    const outLeft = output?.[0];
    if (!output || !outLeft) return true;
    const outRight = output[1] ?? outLeft;
    const input = inputs[0];
    const inLeft = input?.[0];
    const inRight = input?.[1] ?? inLeft;
    const frames = outLeft.length;
    const ceiling = parameters.ceiling?.[0] ?? 0.891;
    const capacity = this.dequeCapacity;
    const window = this.window;
    const delayLeft = this.delay[0];
    const delayRight = this.delay[1];

    for (let i = 0; i < frames; i += 1) {
      const xLeft = inLeft?.[i] ?? 0;
      const xRight = inRight?.[i] ?? 0;
      const peak = Math.max(Math.abs(xLeft), Math.abs(xRight));
      const required = peak > ceiling ? ceiling / peak : 1;

      const n = this.sampleCounter;
      this.gains[n % window] = required;
      while (this.dequeTail > this.dequeHead) {
        const tailIndex = this.deque[(this.dequeTail - 1) % capacity] ?? 0;
        if ((this.gains[tailIndex % window] ?? 1) >= required) this.dequeTail -= 1;
        else break;
      }
      this.deque[this.dequeTail % capacity] = n;
      this.dequeTail += 1;
      while ((this.deque[this.dequeHead % capacity] ?? 0) <= n - window) this.dequeHead += 1;
      const windowMin = this.gains[(this.deque[this.dequeHead % capacity] ?? 0) % window] ?? 1;

      if (windowMin < this.envelope) this.envelope = windowMin;
      else this.envelope += (1 - this.envelope) * this.releaseRate;
      if (this.envelope < this.minEnvelope) this.minEnvelope = this.envelope;

      const w = this.writeIndex;
      outLeft[i] = (delayLeft[w] ?? 0) * this.envelope;
      if (outRight !== outLeft) outRight[i] = (delayRight[w] ?? 0) * this.envelope;
      delayLeft[w] = xLeft;
      delayRight[w] = xRight;
      this.writeIndex = w + 1 >= this.lookahead ? 0 : w + 1;
      this.sampleCounter += 1;
    }

    this.framesSinceReport += frames;
    if (this.framesSinceReport >= REPORT_FRAMES) {
      this.framesSinceReport = 0;
      const report: LimiterReport = { type: "limiter", reduction: 1 - this.minEnvelope };
      this.port.postMessage(report);
      this.minEnvelope = 1;
    }
    return true;
  }
}

registerProcessor("mixerx-limiter", LimiterProcessor);
