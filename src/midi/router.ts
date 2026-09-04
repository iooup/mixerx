/**
 * Web MIDI: opening the ports, learning a control, and turning a message into a console action.
 * The whole module is lazy — a DJ who never plugs a controller in never loads it — and it is
 * strictly opt-in: nothing calls `requestMIDIAccess` until the switch in the settings popover is
 * turned on.
 *
 * `sysex: false`, and no message is ever sent back to a device: this is a controller reading, not
 * a controller talking. The mapping lives in `mixerx.v2.midi`, keyed by the port's own name.
 */
import { deckActions, mixerActions } from "../engine/actions";
import type { ChannelStripState, DeckId } from "../state/session";
import { sessionStore } from "../state/session-store";
import { createStore, readJson, safeStorage, useStore, writeJson } from "../state/store";
import {
  bindingOf,
  decodeMessage,
  initialTakeover,
  MIDI_STORAGE_KEY,
  type MidiBinding,
  type MidiMap,
  type MidiMaps,
  type MidiMessage,
  sanitiseMaps,
  scaleForTarget,
  softTakeover,
  type TakeoverState,
  targetById,
  targetFor,
  unitForTarget,
  value01,
} from "./mapping";

export type MidiStatus = "off" | "unsupported" | "denied" | "on";

export interface MidiState {
  status: MidiStatus;
  /** Names of the inputs that are open. */
  ports: string[];
  /** Target id the DJ is teaching right now, or null. */
  learning: string | null;
  maps: MidiMaps;
  /** The last message seen, for the "it is alive" line in the panel. */
  lastMessage: string | null;
  error: string | null;
}

type MidiEvent = { type: "midi/patch"; patch: Partial<MidiState> };

const initial: MidiState = {
  status: "off",
  ports: [],
  learning: null,
  maps: {},
  lastMessage: null,
  error: null,
};

export const midiStore = createStore<MidiState, MidiEvent>(initial, (state, event) => {
  const next = { ...state, ...event.patch };
  return (Object.keys(event.patch) as (keyof MidiState)[]).every((key) => state[key] === next[key])
    ? state
    : next;
});

const identity = (state: MidiState) => state;
export const useMidi = (): MidiState => useStore(midiStore, identity);

const patch = (value: Partial<MidiState>): void => {
  midiStore.dispatch({ type: "midi/patch", patch: value });
};

// ---------- applying a message ----------

const takeovers = new Map<string, TakeoverState>();

/** The console's own value for a continuous target, 0..1, for the soft takeover comparison. */
function currentUnit(id: string): number {
  const session = sessionStore.getState();
  if (id === "mixer.crossfader") return session.mixer.crossfader;
  if (id === "mixer.master") return session.mixer.master;
  if (id === "mixer.cueLevel") return session.mixer.cueLevel;
  if (id === "stage.intensity") return stageIntensity;
  const [, deck, key] = id.split(".") as [string, DeckId, keyof ChannelStripState];
  const strip = session.mixer[deck === "A" ? "a" : "b"];
  const value = strip[key];
  return unitForTarget(id, typeof value === "number" ? value : 0);
}

/** Mirrored from the Stage settings so the router stays synchronous (≤ 2 ms per message). */
let stageIntensity = 0.8;
let stagePatch: ((value: Record<string, unknown>) => void) | null = null;
let stageToggleCrowd: (() => void) | null = null;
let sceneIds: string[] = [];

/** Loads the Stage bridge once, so a message can reach the visuals without awaiting anything. */
async function primeStage(): Promise<void> {
  if (stagePatch) return;
  const [bridge, store, scenes, protocol] = await Promise.all([
    import("../visuals/console-bridge"),
    import("../visuals/settings-store"),
    import("../agent/scenes"),
    import("../visuals/protocol"),
  ]);
  const read = () => {
    const settings = store.stageSettingsStore.getState();
    stageIntensity = settings.intensity;
    sceneIds = scenes.scenesInCategory(scenes.sceneCategory(settings.sceneId)).map((scene) => scene.id);
  };
  read();
  store.stageSettingsStore.subscribe(read);
  stagePatch = (value) =>
    bridge
      .startStageBridge()
      .patch(value as Parameters<ReturnType<typeof bridge.startStageBridge>["patch"]>[0]);
  stageToggleCrowd = () => {
    const settings = store.stageSettingsStore.getState();
    const scene = settings.sceneId;
    const has = settings.crowdScenes.includes(scene);
    stagePatch?.({
      crowdScenes: has ? settings.crowdScenes.filter((id) => id !== scene) : [...settings.crowdScenes, scene],
    });
  };
  // `presetPatch` is needed by the preset triggers.
  presetPatch = protocol.presetPatch;
  settingsStore = store.stageSettingsStore;
}

let presetPatch: typeof import("../visuals/protocol").presetPatch | null = null;
let settingsStore: typeof import("../visuals/settings-store").stageSettingsStore | null = null;

/**
 * Turns one decoded message into a console action. Synchronous: the engine actions are fire and
 * forget, so the path from a knob to an AudioParam is a store dispatch and a setter.
 */
export function applyMessage(target: string, message: MidiMessage): void {
  const info = targetById(target);
  if (!info) return;
  if (info.kind === "continuous") {
    if (message.kind !== "cc") return;
    const unit = value01(message.value);
    const state = takeovers.get(target) ?? initialTakeover();
    const result = softTakeover(state, unit, currentUnit(target));
    takeovers.set(target, result.state);
    if (result.value === null) return;
    const scaled = scaleForTarget(target, result.value);
    if (target === "mixer.crossfader") void mixerActions.setCrossfader(scaled);
    else if (target === "mixer.master") void mixerActions.setMaster(scaled);
    else if (target === "mixer.cueLevel") void mixerActions.setCueLevel(scaled);
    else if (target === "stage.intensity") stagePatch?.({ intensity: scaled });
    else {
      const [, deck, key] = target.split(".") as [string, DeckId, keyof ChannelStripState];
      void mixerActions.setStrip(deck, key, scaled);
    }
    return;
  }
  // Triggers and toggles fire on a note-on or a non-zero control change, and ignore the release.
  const pressed = message.kind === "note-on" || (message.kind === "cc" && message.value >= 64);
  if (!pressed) return;
  if (target.startsWith("deck.")) {
    const [, deck, action, slot] = target.split(".") as [string, DeckId, string, string | undefined];
    if (action === "play") void deckActions.togglePlay(deck);
    else if (action === "cue") void deckActions.cue(deck);
    else if (action === "sync") void deckActions.sync(deck);
    else if (action === "hotcue") void deckActions.triggerHotCue(deck, Number(slot ?? 0));
    return;
  }
  if (target === "stage.blackout") stagePatch?.({ blackout: !sessionStore.getState().visuals.blackout });
  else if (target === "stage.crowd") stageToggleCrowd?.();
  else if (target.startsWith("stage.scene.")) {
    const id = sceneIds[Number(target.slice("stage.scene.".length))];
    if (id) stagePatch?.({ sceneId: id });
  } else if (target.startsWith("stage.preset.")) {
    const index = Number(target.slice("stage.preset.".length));
    const settings = settingsStore?.getState();
    const preset = settings?.presets[index];
    if (preset && settings && presetPatch) stagePatch?.(presetPatch(preset, settings));
  }
}

// ---------- ports and learning ----------

type MidiInputLike = { name?: string | null; id: string; onmidimessage: ((event: unknown) => void) | null };
type MidiAccessLike = {
  inputs: { values(): IterableIterator<MidiInputLike> };
  onstatechange: ((event: unknown) => void) | null;
};

let access: MidiAccessLike | null = null;

const portName = (input: MidiInputLike): string => (input.name ?? input.id).slice(0, 80);

export function readMaps(): MidiMaps {
  return sanitiseMaps(readJson<unknown>(safeStorage(), MIDI_STORAGE_KEY));
}

function saveMaps(maps: MidiMaps): void {
  writeJson(safeStorage(), MIDI_STORAGE_KEY, maps);
  patch({ maps });
}

/** Public entry point for a message, used by the ports and by the development harness. */
export function handleRaw(port: string, data: Uint8Array | number[]): void {
  const message = decodeMessage(data);
  if (!message) return;
  const state = midiStore.getState();
  patch({
    lastMessage: `${port} · ${message.kind} ${message.number} = ${message.value}`,
  });
  if (state.learning) {
    // Learning: the first message that moves binds, and a binding replaces any other on that
    // control, so one knob never drives two things by accident.
    const binding: MidiBinding = bindingOf(message);
    if (message.kind === "cc" && message.value === 0) return; // a knob at rest says nothing
    const map: MidiMap = { ...(state.maps[port] ?? {}) };
    for (const [id, existing] of Object.entries(map))
      if (
        existing.kind === binding.kind &&
        existing.channel === binding.channel &&
        existing.number === binding.number
      )
        delete map[id];
    map[state.learning] = binding;
    takeovers.delete(state.learning);
    saveMaps({ ...state.maps, [port]: map });
    patch({ learning: null });
    return;
  }
  const map = state.maps[port];
  if (!map) return;
  const target = targetFor(map, message);
  if (target) applyMessage(target, message);
}

/** Turns the controller on. Idempotent; reports the honest reason when it cannot. */
export async function enableMidi(): Promise<MidiStatus> {
  if (access) return "on";
  const request = (
    navigator as Navigator & { requestMIDIAccess?: (options: { sysex: boolean }) => Promise<MidiAccessLike> }
  ).requestMIDIAccess;
  if (typeof request !== "function") {
    patch({ status: "unsupported" });
    return "unsupported";
  }
  await primeStage();
  try {
    access = await request.call(navigator, { sysex: false });
  } catch (error) {
    patch({ status: "denied", error: error instanceof Error ? error.message : String(error) });
    return "denied";
  }
  patch({ maps: readMaps(), status: "on", error: null });
  const attach = () => {
    const ports: string[] = [];
    for (const input of access?.inputs.values() ?? []) {
      const name = portName(input);
      ports.push(name);
      input.onmidimessage = (event: unknown) => {
        const data = (event as { data?: Uint8Array }).data;
        if (data) handleRaw(name, data);
      };
    }
    patch({ ports });
  };
  attach();
  if (access) access.onstatechange = attach;
  return "on";
}

export function disableMidi(): void {
  for (const input of access?.inputs.values() ?? []) input.onmidimessage = null;
  if (access) access.onstatechange = null;
  access = null;
  takeovers.clear();
  patch({ status: "off", ports: [], learning: null, lastMessage: null });
}

export const learn = (target: string | null): void => {
  patch({ learning: target });
};

export function forget(port: string, target: string): void {
  const maps = midiStore.getState().maps;
  const map = { ...(maps[port] ?? {}) };
  delete map[target];
  saveMaps({ ...maps, [port]: map });
}

/** Development only: a virtual controller for the harness and the end-to-end tests. */
export function installVirtualMidi(): void {
  (globalThis as { mixerxMidi?: unknown }).mixerxMidi = {
    send: (data: number[], port = "Virtual controller") => handleRaw(port, data),
    connect: async (port = "Virtual controller") => {
      await primeStage();
      patch({ status: "on", ports: [port], maps: readMaps() });
    },
    state: () => midiStore.getState(),
    learn,
  };
}
