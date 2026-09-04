/// <reference types="audioworklet" />
/**
 * Metering and feature tap. Input 0 (master) passes through to the output; inputs 1–3
 * (deck A post-fader, deck B post-fader, CUE) are metered only. A mono copy of the master
 * signal is streamed to the feature worker over a dedicated MessagePort in 512-sample blocks,
 * so feature extraction never touches the render thread or the main thread.
 */
import type { MeterReport, TapCommand } from "../messages";

const BLOCK = 512;
const INPUTS = 4;

class TapProcessor extends AudioWorkletProcessor {
  private featurePort: MessagePort | null = null;
  private mono = new Float32Array(BLOCK);
  private monoIndex = 0;
  private readonly sums = new Float64Array(INPUTS);
  private readonly peaks = new Float32Array(INPUTS);
  private counted = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<TapCommand>) => {
      if (event.data.type === "feature-port") this.featurePort = event.data.port;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const outLeft = output?.[0];
    if (!output || !outLeft) return true;
    const frames = outLeft.length;
    const master = inputs[0];
    const masterLeft = master?.[0];
    const masterRight = master?.[1] ?? masterLeft;

    for (let channel = 0; channel < output.length; channel += 1) {
      const destination = output[channel];
      if (!destination) continue;
      const source = master?.[channel] ?? masterLeft;
      if (source) destination.set(source);
      else destination.fill(0);
    }

    for (let k = 0; k < INPUTS; k += 1) {
      const input = inputs[k];
      const left = input?.[0];
      if (!left) continue;
      const right = input?.[1] ?? left;
      let peak = this.peaks[k] ?? 0;
      let sum = this.sums[k] ?? 0;
      for (let i = 0; i < frames; i += 1) {
        const l = left[i] ?? 0;
        const r = right[i] ?? 0;
        const magnitude = Math.max(Math.abs(l), Math.abs(r));
        if (magnitude > peak) peak = magnitude;
        sum += (l * l + r * r) * 0.5;
      }
      this.peaks[k] = peak;
      this.sums[k] = sum;
    }

    for (let i = 0; i < frames; i += 1) {
      this.mono[this.monoIndex] = masterLeft ? ((masterLeft[i] ?? 0) + (masterRight?.[i] ?? 0)) * 0.5 : 0;
      this.monoIndex += 1;
      if (this.monoIndex === BLOCK) {
        if (this.featurePort) {
          this.featurePort.postMessage(this.mono, [this.mono.buffer]);
          this.mono = new Float32Array(BLOCK);
        }
        this.monoIndex = 0;
      }
    }

    this.counted += frames;
    if (this.counted >= BLOCK) {
      const level = (k: number) => ({
        peak: this.peaks[k] ?? 0,
        rms: Math.sqrt((this.sums[k] ?? 0) / this.counted),
      });
      const report: MeterReport = {
        type: "meters",
        contextFrame: currentFrame + frames,
        master: level(0),
        a: level(1),
        b: level(2),
        cue: level(3),
      };
      this.port.postMessage(report);
      this.sums.fill(0);
      this.peaks.fill(0);
      this.counted = 0;
    }
    return true;
  }
}

registerProcessor("mixerx-tap", TapProcessor);
