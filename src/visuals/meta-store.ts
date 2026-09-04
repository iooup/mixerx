/**
 * What the Stage knows about the night: the track on air (for the lower third) and the running
 * order (for the night sky and the recap). It arrives on the session channel as a `meta` message —
 * titles, artists, keys, tempos and a small artwork thumbnail, never a path, a URL or any audio.
 */
import { createStore, useStore } from "../state/store";
import type { NightEntry, NowPlaying } from "./protocol";

export interface StageMeta {
  now: NowPlaying | null;
  night: NightEntry[];
  eventName: string;
}

export type StageMetaEvent = { type: "meta/set"; meta: StageMeta };

export const initialStageMeta: StageMeta = { now: null, night: [], eventName: "" };

export function reduceStageMeta(state: StageMeta, event: StageMetaEvent): StageMeta {
  const next = event.meta;
  if (
    state.eventName === next.eventName &&
    state.night.length === next.night.length &&
    state.now?.title === next.now?.title &&
    state.now?.deck === next.now?.deck &&
    state.now?.artwork === next.now?.artwork &&
    (state.night.at(-1)?.id ?? null) === (next.night.at(-1)?.id ?? null)
  )
    return state;
  return next;
}

export const stageMetaStore = createStore<StageMeta, StageMetaEvent>(initialStageMeta, reduceStageMeta);

const identity = (state: StageMeta) => state;

export function useStageMeta(): StageMeta {
  return useStore(stageMetaStore, identity);
}
