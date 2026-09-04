/**
 * MIDI mapping (docs/midi.md). Everything here is pure: what a controller's message means, which
 * console control it drives, and the soft takeover that stops a fader jumping when the hardware
 * and the software disagree. The side effects live in `router.ts`.
 *
 * Web MIDI is local hardware. Access is requested without sysex, no message is ever sent back to a
 * device in this phase, and the mapping is stored in this browser under `mixerx.v2.midi`.
 */
import { EQ_MAX_DB, EQ_MIN_DB } from "../engine/beat-math";
import type { DeckId } from "../state/session";

export const MIDI_STORAGE_KEY = "mixerx.v2.midi";

/**
 * How a target answers a message.
 * - `continuous` follows a knob or fader, with soft takeover.
 * - `trigger` fires once on a note-on or a non-zero CC (play, cue, a hot cue, a scene).
 * - `toggle` flips on a note-on or a non-zero CC (blackout, the crowd).
 */
export type MidiTargetKind = "continuous" | "trigger" | "toggle";

export interface MidiTarget {
  id: string;
  kind: MidiTargetKind;
  /** Locale key of the control's name. */
  label: string;
  /** Group heading in the learn list. */
  group: "mixer" | "deck" | "stage";
  /** Deck letter, for the ones that have one. */
  deck?: DeckId;
}

const decks: DeckId[] = ["A", "B"];

const stripTargets: { key: string; label: string }[] = [
  { key: "trim", label: "midi.target.trim" },
  { key: "eqHigh", label: "midi.target.eqHigh" },
  { key: "eqMid", label: "midi.target.eqMid" },
  { key: "eqLow", label: "midi.target.eqLow" },
  { key: "filter", label: "midi.target.filter" },
  { key: "fader", label: "midi.target.fader" },
];

/** Every control a controller can drive. Ids are stable: a saved mapping outlives an update. */
export const MIDI_TARGETS: MidiTarget[] = [
  { id: "mixer.crossfader", kind: "continuous", label: "midi.target.crossfader", group: "mixer" },
  { id: "mixer.master", kind: "continuous", label: "midi.target.master", group: "mixer" },
  { id: "mixer.cueLevel", kind: "continuous", label: "midi.target.cueLevel", group: "mixer" },
  ...decks.flatMap((deck) =>
    stripTargets.map(({ key, label }) => ({
      id: `strip.${deck}.${key}`,
      kind: "continuous" as const,
      label,
      group: "mixer" as const,
      deck,
    })),
  ),
  ...decks.flatMap((deck) => [
    {
      id: `deck.${deck}.play`,
      kind: "trigger" as const,
      label: "midi.target.play",
      group: "deck" as const,
      deck,
    },
    {
      id: `deck.${deck}.cue`,
      kind: "trigger" as const,
      label: "midi.target.cue",
      group: "deck" as const,
      deck,
    },
    {
      id: `deck.${deck}.sync`,
      kind: "trigger" as const,
      label: "midi.target.sync",
      group: "deck" as const,
      deck,
    },
    ...Array.from({ length: 8 }, (_value, slot) => ({
      id: `deck.${deck}.hotcue.${slot}`,
      kind: "trigger" as const,
      label: "midi.target.hotCue",
      group: "deck" as const,
      deck,
    })),
  ]),
  { id: "stage.intensity", kind: "continuous", label: "midi.target.intensity", group: "stage" },
  { id: "stage.blackout", kind: "toggle", label: "midi.target.blackout", group: "stage" },
  { id: "stage.crowd", kind: "toggle", label: "midi.target.crowd", group: "stage" },
  ...Array.from({ length: 9 }, (_value, index) => ({
    id: `stage.scene.${index}`,
    kind: "trigger" as const,
    label: "midi.target.scene",
    group: "stage" as const,
  })),
  ...Array.from({ length: 9 }, (_value, index) => ({
    id: `stage.preset.${index}`,
    kind: "trigger" as const,
    label: "midi.target.preset",
    group: "stage" as const,
  })),
];

export const targetById = (id: string): MidiTarget | undefined =>
  MIDI_TARGETS.find((target) => target.id === id);

export interface MidiBinding {
  /** Control change or note; nothing else is bound in this phase. */
  kind: "cc" | "note";
  channel: number; // 0..15
  number: number; // CC number or note number
}

/** One controller's mapping: target id → the message that drives it. */
export type MidiMap = Record<string, MidiBinding>;
/** Every controller the DJ has taught, keyed by the port's own name. */
export type MidiMaps = Record<string, MidiMap>;

export interface MidiMessage {
  kind: "cc" | "note-on" | "note-off";
  channel: number;
  number: number;
  /** 0..127 */
  value: number;
}

/** Decodes a raw MIDI message; null for anything this phase does not map. */
export function decodeMessage(data: Uint8Array | number[]): MidiMessage | null {
  const status = data[0] ?? 0;
  const type = status & 0xf0;
  const channel = status & 0x0f;
  const number = data[1] ?? 0;
  const value = data[2] ?? 0;
  if (type === 0xb0) return { kind: "cc", channel, number, value };
  // A note-on with velocity 0 is a note-off; every controller does this.
  if (type === 0x90) return { kind: value === 0 ? "note-off" : "note-on", channel, number, value };
  if (type === 0x80) return { kind: "note-off", channel, number, value };
  return null;
}

export const bindingOf = (message: MidiMessage): MidiBinding => ({
  kind: message.kind === "cc" ? "cc" : "note",
  channel: message.channel,
  number: message.number,
});

export const bindingsEqual = (a: MidiBinding, b: MidiBinding): boolean =>
  a.kind === b.kind && a.channel === b.channel && a.number === b.number;

/** The target this message is bound to in `map`, or null. */
export function targetFor(map: MidiMap, message: MidiMessage): string | null {
  const wanted = bindingOf(message);
  for (const [target, binding] of Object.entries(map)) if (bindingsEqual(binding, wanted)) return target;
  return null;
}

export interface TakeoverState {
  armed: boolean;
  /** Last value seen from the hardware, 0..1; null before the first message. */
  last: number | null;
}

export const initialTakeover = (): TakeoverState => ({ armed: false, last: null });

/** How close the hardware must come to the software value before it takes control. */
export const TAKEOVER_TOLERANCE = 0.02;

/**
 * Soft takeover: a knob that is somewhere else than the software value does not jump the sound.
 * It takes control once it reaches that value, or crosses it. Pure — the caller keeps the state.
 */
export function softTakeover(
  state: TakeoverState,
  incoming: number,
  current: number,
  tolerance = TAKEOVER_TOLERANCE,
): { state: TakeoverState; value: number | null } {
  if (state.armed) return { state: { armed: true, last: incoming }, value: incoming };
  const near = Math.abs(incoming - current) <= tolerance;
  const crossed =
    state.last !== null &&
    Math.sign(state.last - current) !== Math.sign(incoming - current) &&
    incoming !== current;
  if (near || crossed) return { state: { armed: true, last: incoming }, value: incoming };
  return { state: { armed: false, last: incoming }, value: null };
}

/** 7-bit MIDI value to 0..1. */
export const value01 = (value: number): number => Math.min(1, Math.max(0, value / 127));

/** 0..1 to the range one continuous target actually uses. */
export function scaleForTarget(id: string, unit: number): number {
  if (id.endsWith(".trim")) return -12 + unit * 24; // dB
  if (id.endsWith(".eqHigh") || id.endsWith(".eqMid") || id.endsWith(".eqLow"))
    return EQ_MIN_DB + unit * (EQ_MAX_DB - EQ_MIN_DB);
  if (id.endsWith(".filter")) return unit * 2 - 1; // bipolar
  return unit; // faders, crossfader, master, cue level, Stage intensity
}

/** The 0..1 position a continuous target is at now, for the soft takeover comparison. */
export function unitForTarget(id: string, value: number): number {
  if (id.endsWith(".trim")) return Math.min(1, Math.max(0, (value + 12) / 24));
  if (id.endsWith(".eqHigh") || id.endsWith(".eqMid") || id.endsWith(".eqLow"))
    return Math.min(1, Math.max(0, (value - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)));
  if (id.endsWith(".filter")) return Math.min(1, Math.max(0, (value + 1) / 2));
  return Math.min(1, Math.max(0, value));
}

/** Only known targets and well-formed bindings survive a read from storage. */
export function sanitiseMaps(value: unknown): MidiMaps {
  if (typeof value !== "object" || value === null) return {};
  const maps: MidiMaps = {};
  for (const [port, map] of Object.entries(value as Record<string, unknown>)) {
    if (typeof map !== "object" || map === null) continue;
    const clean: MidiMap = {};
    for (const [target, binding] of Object.entries(map as Record<string, unknown>)) {
      if (!targetById(target) || typeof binding !== "object" || binding === null) continue;
      const entry = binding as Record<string, unknown>;
      if (entry.kind !== "cc" && entry.kind !== "note") continue;
      if (typeof entry.channel !== "number" || typeof entry.number !== "number") continue;
      if (entry.channel < 0 || entry.channel > 15 || entry.number < 0 || entry.number > 127) continue;
      clean[target] = { kind: entry.kind, channel: entry.channel, number: entry.number };
    }
    if (Object.keys(clean).length) maps[port.slice(0, 80)] = clean;
  }
  return maps;
}
