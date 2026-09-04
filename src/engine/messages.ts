/**
 * Messages exchanged with the AudioWorklet processors and the feature worker.
 * Frames are integers in the sample-rate domain named in each message: `frame` values on a
 * deck are track frames; `atFrame`/`contextFrame` values are AudioContext frames.
 */

export interface LoopFrames {
  startFrame: number;
  endFrame: number;
}

export type DeckCommand =
  | { type: "load"; trackId: string; sampleRate: number; channels: Float32Array[] }
  | { type: "unload" }
  | { type: "play"; atFrame?: number }
  | { type: "stop"; atFrame?: number }
  | { type: "seek"; frame: number }
  | { type: "loop"; loop: LoopFrames | null }
  | { type: "report"; everyFrames: number }
  | { type: "inspect" };

export type DeckReport =
  | { type: "loaded"; trackId: string; length: number }
  | {
      type: "position";
      trackId: string | null;
      frame: number;
      playing: boolean;
      contextFrame: number;
      rate: number;
    }
  | { type: "started"; trackId: string; atFrame: number; frame: number }
  | { type: "stopped"; trackId: string; atFrame: number; frame: number }
  | { type: "ended"; trackId: string; atFrame: number }
  | {
      type: "state";
      currentFrame: number;
      position: number;
      playing: boolean;
      pendingPlayAt: number | null;
      pendingStopAt: number | null;
      length: number;
      trackId: string | null;
      log: string[];
    };

export interface MeterLevels {
  peak: number;
  rms: number;
}

export interface MeterReport {
  type: "meters";
  contextFrame: number;
  master: MeterLevels;
  a: MeterLevels;
  b: MeterLevels;
  cue: MeterLevels;
}

export interface LimiterReport {
  type: "limiter";
  reduction: number; // 0..1, peak gain reduction since the previous report
}

export type TapCommand = { type: "feature-port"; port: MessagePort };

export type FeatureCommand = { type: "config"; sampleRate: number; blockSize: number; port: MessagePort };

/** Layout of the feature frame shared with StageFrame.f. */
export const FEATURE_FRAME_LENGTH = 85;
export const FEATURE_INDEX = Object.freeze({
  rms: 0,
  peak: 1,
  lufsShort: 2,
  kick: 3,
  snare: 4,
  hat: 5,
  centroid: 6,
  flux: 7,
  crossfader: 8,
  gainA: 9,
  gainB: 10,
  beatPhase: 11,
  barPhase: 12,
  phrasePhase: 13,
  bpm: 14,
  barsToNextSection: 15,
  energy: 16,
  lowA: 17,
  lowB: 18,
  filterA: 19,
  filterB: 20,
  spectrumStart: 21,
  spectrumBins: 64,
});

/** Shape returned by `parameterDescriptors` (lib.dom's AudioParamDescriptor is not visible in worklet files). */
export interface WorkletParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: "a-rate" | "k-rate";
}
