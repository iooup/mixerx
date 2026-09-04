import { createStore, useStore } from "../state/store";
import { type Compatibility, compatibility, keyRelation, parseCamelot } from "./compatibility";
import type { LibrarySource, LibraryTrack } from "./types";

export type EnergyBand = "all" | "low" | "mid" | "high";
export type LibrarySort = "default" | "compat" | "bpm" | "energy" | "title";

export interface LibraryFilters {
  sourceId: string | null;
  keyCompatible: boolean;
  tempoWindow: boolean;
  energyBand: EnergyBand;
}

export const DEFAULT_FILTERS: LibraryFilters = {
  sourceId: null,
  keyCompatible: false,
  tempoWindow: false,
  energyBand: "all",
};

export interface LibraryState {
  ready: boolean;
  filters: LibraryFilters;
  sort: LibrarySort;
  sources: LibrarySource[];
  tracks: LibraryTrack[];
  selectedId: string | null;
  previewId: string | null;
  query: string;
  scanning: boolean;
  analysing: number; // queued + active analyses
  error?: string;
}

export type LibraryEvent =
  | { type: "library/ready"; sources: LibrarySource[]; tracks: LibraryTrack[] }
  | { type: "library/scanning"; scanning: boolean }
  | { type: "library/sources"; sources: LibrarySource[] }
  | { type: "library/tracks"; tracks: LibraryTrack[] }
  | { type: "library/track"; track: LibraryTrack }
  | { type: "library/select"; id: string | null }
  | { type: "library/preview"; id: string | null }
  | { type: "library/filters"; filters: Partial<LibraryFilters> }
  | { type: "library/sort"; sort: LibrarySort }
  | { type: "library/query"; query: string }
  | { type: "library/analysing"; count: number }
  | { type: "library/error"; error?: string };

export function createInitialLibrary(): LibraryState {
  return {
    ready: false,
    filters: DEFAULT_FILTERS,
    sort: "default",
    sources: [],
    tracks: [],
    selectedId: null,
    previewId: null,
    query: "",
    scanning: false,
    analysing: 0,
  };
}

export function reduceLibrary(state: LibraryState, event: LibraryEvent): LibraryState {
  switch (event.type) {
    case "library/ready":
      return { ...state, ready: true, sources: event.sources, tracks: event.tracks };
    case "library/scanning":
      return state.scanning === event.scanning ? state : { ...state, scanning: event.scanning };
    case "library/sources":
      return { ...state, sources: event.sources };
    case "library/tracks":
      return { ...state, tracks: event.tracks };
    case "library/track": {
      const index = state.tracks.findIndex((track) => track.id === event.track.id);
      if (index < 0) return { ...state, tracks: [...state.tracks, event.track] };
      const tracks = state.tracks.slice();
      tracks[index] = event.track;
      return { ...state, tracks };
    }
    case "library/select":
      return state.selectedId === event.id ? state : { ...state, selectedId: event.id };
    case "library/preview":
      return state.previewId === event.id ? state : { ...state, previewId: event.id };
    case "library/filters":
      return { ...state, filters: { ...state.filters, ...event.filters } };
    case "library/sort":
      return state.sort === event.sort ? state : { ...state, sort: event.sort };
    case "library/query":
      return state.query === event.query ? state : { ...state, query: event.query };
    case "library/analysing":
      return state.analysing === event.count ? state : { ...state, analysing: event.count };
    case "library/error": {
      if (event.error === undefined) {
        if (state.error === undefined) return state;
        const { error: _dropped, ...rest } = state;
        return rest;
      }
      return { ...state, error: event.error };
    }
    default:
      return state;
  }
}

export const libraryStore = createStore(createInitialLibrary(), reduceLibrary);

const identity = (state: LibraryState) => state;

export function useLibrary(): LibraryState {
  return useStore(libraryStore, identity);
}

export interface CompatibilityReference {
  camelot?: string;
  bpm?: number;
  energy?: number;
}

export const TEMPO_WINDOW_PCT = 6;

export function energyBandOf(energy: number | undefined): EnergyBand | null {
  if (energy === undefined) return null;
  return energy <= 4 ? "low" : energy <= 7 ? "mid" : "high";
}

export function compatibilityOf(
  track: LibraryTrack,
  reference: CompatibilityReference | null,
): Compatibility | null {
  if (!reference) return null;
  return compatibility({ camelot: track.camelot, bpm: track.bpm, energy: track.energy }, reference);
}

export function filterTracks(
  tracks: LibraryTrack[],
  query: string,
  filters: LibraryFilters = DEFAULT_FILTERS,
  reference: CompatibilityReference | null = null,
  sort: LibrarySort = "default",
): LibraryTrack[] {
  const needle = query.trim().toLowerCase();
  const referenceKey = parseCamelot(reference?.camelot);
  const filtered = tracks.filter((track) => {
    if (needle) {
      const haystack = [
        track.title,
        track.artist,
        track.camelot ?? "",
        track.bpm ? String(track.bpm) : "",
        track.relativePath,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filters.sourceId && track.sourceId !== filters.sourceId) return false;
    if (filters.energyBand !== "all" && energyBandOf(track.energy) !== filters.energyBand) return false;
    if (filters.keyCompatible) {
      const key = parseCamelot(track.camelot);
      if (!referenceKey || !key) return false;
      if (keyRelation(key, referenceKey) === "clash") return false;
    }
    if (filters.tempoWindow) {
      const compat = compatibilityOf(track, reference);
      if (!compat || compat.tempoDeltaPct === null || Math.abs(compat.tempoDeltaPct) > TEMPO_WINDOW_PCT)
        return false;
    }
    return true;
  });
  const score = (track: LibraryTrack) => compatibilityOf(track, reference)?.score ?? 0;
  switch (sort) {
    case "compat":
      return [...filtered].sort((left, right) => score(right) - score(left));
    case "bpm":
      return [...filtered].sort((left, right) => (left.bpm ?? 0) - (right.bpm ?? 0));
    case "energy":
      return [...filtered].sort((left, right) => (right.energy ?? 0) - (left.energy ?? 0));
    case "title":
      return [...filtered].sort((left, right) => left.title.localeCompare(right.title));
    default:
      return filtered;
  }
}
