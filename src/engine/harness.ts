/**
 * Offline-rendering harness used by the Playwright engine tests. It renders the real worklets
 * through an OfflineAudioContext so sample accuracy can be asserted without audio hardware.
 * Commands are acknowledged (deck.sync) before rendering starts, because an offline render
 * thread may otherwise begin before queued port messages are delivered. Not product code.
 */
import type { CrossfaderCurve } from "../state/session";
import { loadWorklets } from "./audio-engine";
import { Deck } from "./deck";
import { MixerGraph } from "./mixer-graph";

const RATE = 44100;

function constantTrack(frames: number, value: number): Float32Array[] {
  const channel = new Float32Array(frames).fill(value);
  return [channel, new Float32Array(channel)];
}

function rampTrack(frames: number): Float32Array[] {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) channel[i] = i / frames;
  return [channel, new Float32Array(channel)];
}

function sineTrack(frames: number, amplitude: number, hz = 1000): Float32Array[] {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) channel[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  return [channel, new Float32Array(channel)];
}

async function renderDeck(
  setup: (context: OfflineAudioContext, deck: Deck) => void,
  frames = RATE / 2,
): Promise<Float32Array> {
  const context = new OfflineAudioContext(2, frames, RATE);
  await loadWorklets(context);
  const deck = new Deck(context, "A");
  deck.node.connect(context.destination);
  setup(context, deck);
  await deck.sync();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

export async function deckStartsAtFrame(
  startAtFrame: number,
): Promise<{ firstNonZero: number; valueAtStart: number }> {
  const output = await renderDeck((_context, deck) => {
    deck.load(constantTrack(RATE, 0.5), RATE, "constant");
    deck.play(startAtFrame);
  });
  const firstNonZero = output.findIndex((sample) => sample !== 0);
  return { firstNonZero, valueAtStart: output[startAtFrame] ?? Number.NaN };
}

export async function deckStopsAtFrame(stopAtFrame: number): Promise<{ lastNonZero: number }> {
  const output = await renderDeck((_context, deck) => {
    deck.load(constantTrack(RATE, 0.5), RATE, "constant");
    deck.play(0);
    deck.stop(stopAtFrame);
  });
  let lastNonZero = -1;
  for (let i = 0; i < output.length; i += 1) if (output[i] !== 0) lastNonZero = i;
  return { lastNonZero };
}

export async function deckLoops(): Promise<{ samples: number[] }> {
  const output = await renderDeck((_context, deck) => {
    deck.load(rampTrack(RATE), RATE, "ramp");
    deck.seekSec(1000 / RATE);
    deck.setLoop({ startSec: 1000 / RATE, endSec: 1200 / RATE });
    deck.play(0);
  }, 2048);
  return { samples: Array.from(output.slice(0, 1024)) };
}

export async function deckRate(rate: number): Promise<{ slopePerFrame: number }> {
  const output = await renderDeck((_context, deck) => {
    deck.rate.value = rate;
    deck.load(rampTrack(RATE), RATE, "ramp");
    deck.play(0);
  }, 4096);
  const a = output[1000] ?? 0;
  const b = output[3000] ?? 0;
  return { slopePerFrame: ((b - a) / 2000) * RATE };
}

export async function limiterCeiling(amplitude: number): Promise<{ peak: number; steadyGain: number }> {
  const frames = RATE / 2;
  const context = new OfflineAudioContext(2, frames, RATE);
  await loadWorklets(context);
  const deck = new Deck(context, "A");
  const limiter = new AudioWorkletNode(context, "mixerx-limiter", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  deck.node.connect(limiter);
  limiter.connect(context.destination);
  deck.load(sineTrack(frames, amplitude), RATE, "sine");
  deck.play(0);
  await deck.sync();
  const rendered = await context.startRendering();
  const output = rendered.getChannelData(0);
  let peak = 0;
  for (let i = 2000; i < output.length; i += 1) peak = Math.max(peak, Math.abs(output[i] ?? 0));
  return { peak, steadyGain: peak / amplitude };
}

export async function mixerCrossfade(position: number, curve: CrossfaderCurve): Promise<{ level: number }> {
  const frames = RATE / 4;
  const context = new OfflineAudioContext(2, frames, RATE);
  await loadWorklets(context);
  const mixer = new MixerGraph(context, { limiter: false });
  mixer.setMasterLevel(1);
  const deckA = new Deck(context, "A");
  const deckB = new Deck(context, "B");
  deckA.node.connect(mixer.strips.A.input);
  deckB.node.connect(mixer.strips.B.input);
  mixer.masterOut.connect(context.destination);
  mixer.setCurve(curve);
  mixer.setCrossfader(position);
  deckA.load(sineTrack(frames, 0.25, 100), RATE, "a");
  deckB.load(sineTrack(frames, 0.25, 100), RATE, "b");
  deckA.play(0);
  deckB.play(0);
  await Promise.all([deckA.sync(), deckB.sync()]);
  const rendered = await context.startRendering();
  const output = rendered.getChannelData(0);
  let peak = 0;
  const start = Math.floor(frames * 0.5);
  for (let i = start; i < frames; i += 1) peak = Math.max(peak, Math.abs(output[i] ?? 0));
  return { level: peak };
}
