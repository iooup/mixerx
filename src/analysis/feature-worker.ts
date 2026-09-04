/**
 * Real-time feature worker. Receives 512-sample mono blocks of the master signal from the tap
 * processor over a MessagePort and publishes one feature frame per block (≈ 86 Hz at 44.1 kHz)
 * in the feature-frame layout from engine/messages.ts. Engine-side fields (crossfader, phases, …) are filled by the console.
 */
import { FEATURE_FRAME_LENGTH, FEATURE_INDEX, type FeatureCommand } from "../engine/messages";
import { FFT, hannWindow, magnitudeSpectrum } from "./dsp/fft";

const FFT_SIZE = 2048;
const BANDS = FEATURE_INDEX.spectrumBins;
const LOUDNESS_WINDOW_SECONDS = 3;
const workerScope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };

let sampleRate = 44100;
let blockSize = 512;
const fft = new FFT(FFT_SIZE);
const window = hannWindow(FFT_SIZE);
const real = new Float32Array(FFT_SIZE);
const imag = new Float32Array(FFT_SIZE);
const magnitudes = new Float32Array(FFT_SIZE / 2 + 1);
const ring = new Float32Array(FFT_SIZE * 2);
let ringWrite = 0;
let filled = 0;
const bandEdges = new Uint16Array(BANDS + 1);
const bandLevels = new Float32Array(BANDS);
const previousBandLevels = new Float32Array(BANDS);
let fluxPeak = 1e-3;
let kickPeak = 1e-3;
let snarePeak = 1e-3;
let hatPeak = 1e-3;
let rmsHistory = new Float32Array(1);
let rmsHistoryIndex = 0;

function configureBands(): void {
  const nyquist = sampleRate / 2;
  const low = 30;
  const high = Math.min(16000, nyquist);
  const bins = FFT_SIZE / 2;
  for (let band = 0; band <= BANDS; band += 1) {
    const hz = low * (high / low) ** (band / BANDS);
    bandEdges[band] = Math.min(bins, Math.max(1, Math.round((hz / nyquist) * bins)));
  }
  rmsHistory = new Float32Array(Math.max(1, Math.round((LOUDNESS_WINDOW_SECONDS * sampleRate) / blockSize)));
  rmsHistoryIndex = 0;
}

function bandFlux(lowHz: number, highHz: number): number {
  const nyquist = sampleRate / 2;
  const bins = FFT_SIZE / 2;
  const start = Math.max(1, Math.round((lowHz / nyquist) * bins));
  const end = Math.min(bins, Math.round((highHz / nyquist) * bins));
  let flux = 0;
  for (let band = 0; band < BANDS; band += 1) {
    const bandStart = bandEdges[band] ?? 0;
    const bandEnd = bandEdges[band + 1] ?? bandStart;
    if (bandEnd <= start || bandStart >= end) continue;
    const delta = (bandLevels[band] ?? 0) - (previousBandLevels[band] ?? 0);
    if (delta > 0) flux += delta;
  }
  return flux;
}

function decayPeak(current: number, value: number): number {
  return Math.max(value, current * 0.995, 1e-3);
}

function ingest(block: Float32Array): void {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < block.length; i += 1) {
    const sample = block[i] ?? 0;
    ring[ringWrite] = sample;
    ringWrite = ringWrite + 1 >= ring.length ? 0 : ringWrite + 1;
    sumSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  filled = Math.min(ring.length, filled + block.length);
  const rms = Math.sqrt(sumSquares / Math.max(1, block.length));
  rmsHistory[rmsHistoryIndex] = rms * rms;
  rmsHistoryIndex = rmsHistoryIndex + 1 >= rmsHistory.length ? 0 : rmsHistoryIndex + 1;

  const frame = new Float32Array(FEATURE_FRAME_LENGTH);
  frame[FEATURE_INDEX.rms] = rms;
  frame[FEATURE_INDEX.peak] = peak;
  let meanSquare = 0;
  for (let i = 0; i < rmsHistory.length; i += 1) meanSquare += rmsHistory[i] ?? 0;
  meanSquare /= rmsHistory.length;
  frame[FEATURE_INDEX.lufsShort] = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -100;

  if (filled >= FFT_SIZE) {
    // Gather the most recent FFT_SIZE samples in order.
    const start = (ringWrite - FFT_SIZE + ring.length) % ring.length;
    if (start + FFT_SIZE <= ring.length) {
      magnitudeSpectrum(fft, ring, start, window, real, imag, magnitudes);
    } else {
      const scratch = new Float32Array(FFT_SIZE);
      const firstPart = ring.length - start;
      scratch.set(ring.subarray(start), 0);
      scratch.set(ring.subarray(0, FFT_SIZE - firstPart), firstPart);
      magnitudeSpectrum(fft, scratch, 0, window, real, imag, magnitudes);
    }
    previousBandLevels.set(bandLevels);
    let weightedSum = 0;
    let magnitudeSum = 0;
    const nyquist = sampleRate / 2;
    const bins = FFT_SIZE / 2;
    for (let band = 0; band < BANDS; band += 1) {
      const startBin = bandEdges[band] ?? 0;
      const endBin = Math.max(startBin + 1, bandEdges[band + 1] ?? startBin + 1);
      let power = 0;
      for (let bin = startBin; bin < endBin; bin += 1) {
        const magnitude = magnitudes[bin] ?? 0;
        power += magnitude * magnitude;
        weightedSum += magnitude * (bin / bins) * nyquist;
        magnitudeSum += magnitude;
      }
      const magnitude = Math.sqrt(power / (endBin - startBin)) / (FFT_SIZE / 4);
      const db = 20 * Math.log10(magnitude + 1e-6);
      bandLevels[band] = Math.min(1, Math.max(0, (db + 60) / 60));
      frame[FEATURE_INDEX.spectrumStart + band] = bandLevels[band] ?? 0;
    }
    let flux = 0;
    for (let band = 0; band < BANDS; band += 1) {
      const delta = (bandLevels[band] ?? 0) - (previousBandLevels[band] ?? 0);
      if (delta > 0) flux += delta;
    }
    fluxPeak = decayPeak(fluxPeak, flux);
    const kick = bandFlux(30, 150);
    const snare = bandFlux(150, 1500);
    const hat = bandFlux(2000, 8000);
    kickPeak = decayPeak(kickPeak, kick);
    snarePeak = decayPeak(snarePeak, snare);
    hatPeak = decayPeak(hatPeak, hat);
    frame[FEATURE_INDEX.flux] = Math.min(1, flux / fluxPeak);
    frame[FEATURE_INDEX.kick] = Math.min(1, kick / kickPeak);
    frame[FEATURE_INDEX.snare] = Math.min(1, snare / snarePeak);
    frame[FEATURE_INDEX.hat] = Math.min(1, hat / hatPeak);
    frame[FEATURE_INDEX.centroid] = magnitudeSum > 0 ? Math.min(1, weightedSum / magnitudeSum / 8000) : 0;
  }

  workerScope.postMessage(frame, [frame.buffer]);
}

self.onmessage = (event: MessageEvent<FeatureCommand>) => {
  const command = event.data;
  if (command?.type !== "config") return;
  sampleRate = command.sampleRate;
  blockSize = command.blockSize;
  configureBands();
  command.port.onmessage = (blockEvent: MessageEvent<Float32Array>) => {
    if (blockEvent.data instanceof Float32Array) ingest(blockEvent.data);
  };
};
