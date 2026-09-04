/**
 * Full offline analysis of one decoded track → TrackAnalysis.
 * Pure and synchronous so it runs identically in the worker and in unit tests.
 */
import type { TrackAnalysis } from "../state/session";
import { fitConstantGrid, gridBeatFrames, gridFromFit, trackBeats } from "./beats";
import {
  extractFineChroma,
  extractFrameFeatures,
  frameToSec,
  onsetEnvelope,
  secToFrame,
} from "./dsp/features";
import { downmix, resampleMono } from "./dsp/resample";
import { estimateKey } from "./key";
import { measureLoudness } from "./loudness";
import {
  beatSynchronous,
  energyPerBar,
  estimateDownbeat,
  labelSections,
  noveltyCurve,
  segmentBoundaries,
} from "./structure";
import { estimateTempo } from "./tempo";
import { computeWaveform, type WaveformSummary } from "./waveform";

export const ANALYSIS_RATE = 22050;

export interface AnalyseOptions {
  trackId: string;
  sampleRate: number;
  channels: Float32Array[];
  onWaveform?: (waveform: WaveformSummary) => void;
  onStage?: (stage: string) => void;
  now?: () => number;
}

export function analyseTrack(options: AnalyseOptions): TrackAnalysis {
  const { trackId, sampleRate, channels } = options;
  const stage = options.onStage ?? (() => {});
  const now = options.now ?? (() => Date.now());

  stage("waveform");
  const mono = downmix(channels);
  const waveform = computeWaveform(mono, sampleRate);
  options.onWaveform?.(waveform);

  stage("features");
  const analysisSignal = resampleMono(mono, sampleRate, ANALYSIS_RATE);
  const features = extractFrameFeatures(analysisSignal, ANALYSIS_RATE);
  const onset = onsetEnvelope(features);

  stage("tempo");
  const tempo = estimateTempo(onset, features.kick, features.fps);
  const bpmForTracking = tempo.bpm > 0 ? tempo.bpm : 120;

  stage("beats");
  const tracked = trackBeats(onset, bpmForTracking, features.fps, (frame) => frameToSec(features, frame));
  const fit = fitConstantGrid(tracked, bpmForTracking);
  const beatFrames = fit.constant
    ? gridBeatFrames(fit, (sec) => secToFrame(features, sec), features.frames)
    : tracked.beatFrames;
  const sync = beatSynchronous(features, onset, beatFrames);
  const downbeat = estimateDownbeat(sync);
  const gridConfidence = Math.max(
    0,
    Math.min(
      1,
      0.35 * tempo.confidence + 0.4 * (fit.constant ? fit.inlierFraction : 0.5) + 0.25 * downbeat.confidence,
    ),
  );
  const grid = gridFromFit(fit, tracked, downbeat.offset, gridConfidence, tempo.candidates);

  stage("structure");
  const novelty = sync.beats >= 64 ? noveltyCurve(sync, features.melBands) : new Float32Array(sync.beats);
  const boundaries = segmentBoundaries(novelty, { downbeatOffset: downbeat.offset });
  const sections = labelSections(sync, boundaries, downbeat.offset);
  const barEnergy = energyPerBar(sync, downbeat.offset);

  stage("key");
  const key = estimateKey(extractFineChroma(analysisSignal, ANALYSIS_RATE));

  stage("loudness");
  const loudness = measureLoudness(channels, sampleRate);

  return {
    schemaVersion: 2,
    trackId,
    grid,
    key: { camelot: key.camelot, name: key.name, confidence: Math.round(key.confidence * 1000) / 1000 },
    loudness,
    energyPerBar: barEnergy,
    sections,
    waveform: { hop: waveform.hop, bins: waveform.bins, overview: waveform.overview },
    analysedAt: now(),
  };
}
