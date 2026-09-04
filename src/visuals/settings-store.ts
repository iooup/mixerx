/**
 * Stage settings store. The console owns the truth and persists it; Stage windows keep a mirror
 * that applies patches optimistically and is replaced by the console's next full broadcast.
 */
import { createStore, readJson, useStore, writeJson } from "../state/store";
import { DEFAULT_STAGE_SETTINGS, type StageSettings, sanitiseSettings } from "./protocol";

export const STAGE_STORAGE_KEY = "mixerx.v2.stage";

export type StageSettingsEvent =
  | { type: "stage/patch"; patch: Partial<StageSettings> }
  | { type: "stage/replace"; settings: StageSettings };

export function reduceStageSettings(state: StageSettings, event: StageSettingsEvent): StageSettings {
  switch (event.type) {
    case "stage/patch": {
      const entries = Object.entries(event.patch) as [keyof StageSettings, unknown][];
      if (
        entries.every(([key, value]) =>
          key === "custom" ||
          key === "crowdScenes" ||
          key === "crowdStyles" ||
          key === "crowdLayouts" ||
          key === "presets" ||
          key === "morph"
            ? JSON.stringify(state[key]) === JSON.stringify(value)
            : state[key] === value,
        )
      )
        return state;
      return sanitiseSettings({ ...state, ...event.patch }, state);
    }
    case "stage/replace": {
      const next = sanitiseSettings(event.settings, state);
      return JSON.stringify(next) === JSON.stringify(state) ? state : next;
    }
    default:
      return state;
  }
}

export function readStoredStageSettings(storage: Storage | null): StageSettings {
  const stored = readJson<unknown>(storage, STAGE_STORAGE_KEY);
  // Blackout and the test signal are live states, never restored from storage.
  return { ...sanitiseSettings(stored), blackout: false, testSignal: false };
}

let lastPersisted: string | null = null;

export function persistStageSettings(storage: Storage | null, settings: StageSettings): void {
  const { blackout: _blackout, testSignal: _testSignal, ...rest } = settings;
  const serialised = JSON.stringify(rest);
  if (serialised === lastPersisted) return;
  lastPersisted = serialised;
  writeJson(storage, STAGE_STORAGE_KEY, rest);
}

export const stageSettingsStore = createStore<StageSettings, StageSettingsEvent>(
  { ...DEFAULT_STAGE_SETTINGS },
  reduceStageSettings,
);

const identity = (settings: StageSettings) => settings;

export function useStageSettings(): StageSettings {
  return useStore(stageSettingsStore, identity);
}
