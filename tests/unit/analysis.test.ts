import { describe, expect, it } from "vitest";
import { analyseTrack } from "../../src/analysis/analyse";
import { Biquad, kWeightingHighpass, kWeightingShelf } from "../../src/analysis/dsp/biquad";
import { resampleMono } from "../../src/analysis/dsp/resample";
import { estimateKeyFromChroma } from "../../src/analysis/key";
import { integratedLoudness, truePeakDb } from "../../src/analysis/loudness";
import { computeWaveform } from "../../src/analysis/waveform";

const RATE = 22050;

/** Synthetic techno: kick on every beat (louder on beat 1), hats on off-beats, a bass tone, optional break. */
function synthesise(
  bpm: number,
  seconds: number,
  options: { firstBeatSec?: number; breakAt?: [number, number]; sampleRate?: number } = {},
): Float32Array {
  const sampleRate = options.sampleRate ?? RATE;
  const length = Math.round(seconds * sampleRate);
  const signal = new Float32Array(length);
  const period = 60 / bpm;
  const firstBeat = options.firstBeatSec ?? 0.25;
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let beat = 0; ; beat += 1) {
    const time = firstBeat + beat * period;
    if (time >= seconds) break;
    const inBreak = options.breakAt ? time >= options.breakAt[0] && time < options.breakAt[1] : false;
    const start = Math.round(time * sampleRate);
    const kickGain = inBreak ? 0 : beat % 4 === 0 ? 1 : 0.7;
    const kickLength = Math.round(0.12 * sampleRate);
    for (let i = 0; i < kickLength && start + i < length; i += 1) {
      const t = i / sampleRate;
      const envelope = Math.exp(-t * 28);
      const pitch = 55 + 80 * Math.exp(-t * 40);
      signal[start + i] = (signal[start + i] ?? 0) + kickGain * envelope * Math.sin(2 * Math.PI * pitch * t);
    }
    const hatStart = Math.round((time + period / 2) * sampleRate);
    const hatLength = Math.round(0.04 * sampleRate);
    for (let i = 0; i < hatLength && hatStart + i < length; i += 1) {
      const envelope = Math.exp(-(i / sampleRate) * 90);
      signal[hatStart + i] = (signal[hatStart + i] ?? 0) + 0.25 * envelope * noise();
    }
  }
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const inBreak = options.breakAt ? t >= options.breakAt[0] && t < options.breakAt[1] : false;
    // A minor triad pad (A2, C3, E3, plus A3) at low level so the key is defined.
    const pad =
      0.05 * Math.sin(2 * Math.PI * 110 * t) +
      0.05 * Math.sin(2 * Math.PI * 130.81 * t) +
      0.05 * Math.sin(2 * Math.PI * 164.81 * t) +
      0.03 * Math.sin(2 * Math.PI * 220 * t);
    signal[i] = (signal[i] ?? 0) + pad * (inBreak ? 0.5 : 1);
  }
  return signal;
}

describe("analysis pipeline", () => {
  it("recovers tempo, beat phase, downbeat, key, and sections from a synthetic techno track", () => {
    const bpm = 128;
    const signal = synthesise(bpm, 60, { firstBeatSec: 0.25, breakAt: [30, 37.5] });
    const analysis = analyseTrack({
      trackId: "synthetic",
      sampleRate: RATE,
      channels: [signal, new Float32Array(signal)],
      now: () => 1,
    });

    expect(analysis.grid.kind).toBe("constant");
    expect(Math.abs(analysis.grid.bpm - bpm)).toBeLessThan(0.5);
    // The fitted first beat should sit within 20 ms of a real beat.
    const period = 60 / bpm;
    const phaseError = ((((analysis.grid.firstBeatSec - 0.25) % period) + period) % period) / period;
    const wrapped = Math.min(phaseError, 1 - phaseError);
    expect(wrapped * period).toBeLessThan(0.02);
    // Beat 0 of the tracked grid lands on a bar start (the first synthetic kick is a downbeat).
    const beatIndexOfFirstKick = Math.round((0.25 - analysis.grid.firstBeatSec) / period);
    expect((((beatIndexOfFirstKick - analysis.grid.downbeatOffset) % 4) + 4) % 4).toBe(0);
    expect(analysis.grid.confidence).toBeGreaterThan(0.6);
    expect(analysis.grid.candidates[0]?.bpm).toBeCloseTo(bpm, 0);

    expect(analysis.key.name).toBe("A minor");
    expect(analysis.key.camelot).toBe("8A");

    expect(analysis.sections.length).toBeGreaterThanOrEqual(2);
    const breakSection = analysis.sections.find((section) => section.kind === "break");
    expect(breakSection).toBeDefined();
    const breakStartSec =
      analysis.grid.firstBeatSec +
      ((breakSection?.startBar ?? 0) * 4 + analysis.grid.downbeatOffset) * period;
    expect(Math.abs(breakStartSec - 30)).toBeLessThan(period * 8);

    expect(analysis.energyPerBar.length).toBeGreaterThan(20);
    expect(analysis.waveform.bins.length % 4).toBe(0);
    expect(analysis.loudness.integratedLufs).toBeLessThan(0);
    expect(analysis.loudness.integratedLufs).toBeGreaterThan(-40);
  }, 30000);

  it("estimates tempo correctly on a different tempo and a 44.1 kHz source", () => {
    const signal = synthesise(140, 40, { firstBeatSec: 0.5, sampleRate: 44100 });
    const analysis = analyseTrack({ trackId: "fast", sampleRate: 44100, channels: [signal] });
    expect(Math.abs(analysis.grid.bpm - 140)).toBeLessThan(0.5);
  }, 30000);
});

describe("key profiles", () => {
  it("identifies C major and A minor chroma", () => {
    const cMajor = [1, 0, 0.6, 0, 0.8, 0.5, 0, 0.9, 0, 0.4, 0, 0.3];
    expect(estimateKeyFromChroma(cMajor).name).toBe("C major");
    expect(estimateKeyFromChroma(cMajor).camelot).toBe("8B");
    const aMinor = [0.6, 0, 0.4, 0, 0.8, 0.3, 0, 0.5, 0.2, 1, 0, 0.4];
    expect(estimateKeyFromChroma(aMinor).name).toBe("A minor");
  });
});

describe("loudness", () => {
  it("K-weighting passes 997 Hz at about +0.69 dB so that a −23 dBFS stereo sine reads −23 LUFS", () => {
    const sampleRate = 48000;
    const seconds = 5;
    const amplitude = 10 ** (-23 / 20);
    const channel = new Float32Array(sampleRate * seconds);
    for (let i = 0; i < channel.length; i += 1)
      channel[i] = amplitude * Math.sin((2 * Math.PI * 997 * i) / sampleRate);
    const shelf = new Biquad(kWeightingShelf(sampleRate));
    const hp = new Biquad(kWeightingHighpass(sampleRate));
    let power = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const y = hp.process(shelf.process(channel[i] ?? 0));
      if (i > sampleRate) power += y * y;
    }
    const gainDb = 10 * Math.log10(power / (channel.length - sampleRate) / (amplitude ** 2 / 2));
    expect(gainDb).toBeCloseTo(0.691, 1);
    expect(integratedLoudness([channel, new Float32Array(channel)], sampleRate)).toBeCloseTo(-23, 0);
  });

  it("measures over-sampled peaks and silence", () => {
    const sampleRate = 44100;
    const channel = new Float32Array(sampleRate);
    for (let i = 0; i < channel.length; i += 1)
      channel[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    expect(truePeakDb([channel])).toBeCloseTo(20 * Math.log10(0.5), 0);
    expect(integratedLoudness([new Float32Array(sampleRate)], sampleRate)).toBe(-100);
  });
});

describe("waveform and resampling", () => {
  it("summarises peaks and bands and builds an overview", () => {
    const sampleRate = 44100;
    const mono = new Float32Array(sampleRate * 2);
    for (let i = 0; i < mono.length; i += 1) mono[i] = 0.8 * Math.sin((2 * Math.PI * 60 * i) / sampleRate);
    const waveform = computeWaveform(mono, sampleRate);
    expect(waveform.bins.length).toBe(Math.ceil(mono.length / 1024) * 4);
    expect(waveform.overview.length).toBe(
      Math.ceil(Math.ceil(mono.length / 1024) / Math.round(sampleRate / 1024 / 8)) * 4,
    );
    expect(waveform.bins[4]).toBeGreaterThan(180); // peak ≈ 0.8
    expect(waveform.bins[5]).toBeGreaterThan(waveform.bins[7] ?? 0); // low band dominates a 60 Hz tone
  });

  it("halves the length when resampling 44.1 kHz to 22.05 kHz", () => {
    const input = new Float32Array(44100);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    const output = resampleMono(input, 44100, 22050);
    expect(output.length).toBe(22050);
    let peak = 0;
    for (let i = 1000; i < output.length; i += 1) peak = Math.max(peak, Math.abs(output[i] ?? 0));
    expect(peak).toBeGreaterThan(0.9);
  });
});
