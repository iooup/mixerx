/**
 * Shared session contracts for the engine, Console, lessons, and agent tools.
 * Preserve persisted-data compatibility when extending these types.
 */

export type DeckId = "A" | "B";
export type SessionMode = "learn" | "mix" | "perform";
export type Autonomy = "observe" | "prepare" | "copilot";
export type SectionKind = "intro" | "build" | "drop" | "break" | "body" | "outro";
export type WebMcpStatus = "registered" | "available" | "unavailable";
export type EngineStatus = "idle" | "starting" | "running" | "suspended" | "error";

// ---------- Library / analysis ----------

export interface TrackRef {
  id: string; // stable hash of {name, size, lastModified}
  title: string;
  artist: string;
  durationSec: number;
  sizeBytes: number;
  source: "folder" | "drop" | "manifest";
  hasArtwork: boolean;
}

export interface BeatGrid {
  kind: "constant" | "list";
  bpm: number; // for constant
  firstBeatSec: number; // for constant
  beatsSec?: Float32Array; // for list
  downbeatOffset: 0 | 1 | 2 | 3;
  downbeatConfirmed: boolean; // user confirmation
  confidence: number; // 0..1
  candidates: { bpm: number; score: number }[]; // runner-ups for ×2/÷2 UI
}

export interface Section {
  kind: SectionKind;
  startBar: number;
  endBar: number;
  energy: number;
}

export interface TrackAnalysis {
  schemaVersion: 2;
  trackId: string;
  grid: BeatGrid;
  key: { camelot: string; name: string; confidence: number };
  loudness: { integratedLufs: number; truePeakDb: number; gainSuggestionDb: number };
  energyPerBar: Float32Array; // 0..1
  sections: Section[];
  waveform: {
    hop: 1024; // samples per bin at the original rate
    bins: Uint8Array; // 4 bytes per bin: peak, low, mid, high
    overview: Uint8Array; // 8 bins/s, same layout
  };
  analysedAt: number;
}

// ---------- Engine ----------

export interface DeckBeat {
  index: number;
  phase: number;
  barPhase: number;
  phrasePhase: number;
  phraseBars: 8 | 16;
}

export interface DeckLoop {
  startSec: number;
  endSec: number;
  beats: number;
}

export interface DeckState {
  id: DeckId;
  track: TrackRef | null;
  analysis: TrackAnalysis | null;
  playing: boolean;
  positionSec: number; // live (read from the engine, not stored)
  rate: number; // 1.0 = original
  tempoOffsetPct: number; // user tempo slider
  keylock: boolean;
  loop: DeckLoop | null;
  cueSec: number; // the CUE point
  hotCues: (number | null)[]; // 8 slots, seconds
  slip: boolean;
  onAir: boolean; // post-fader gain > -60 dB and playing
  section: SectionKind | null;
  barsToNextSection: number | null;
  beat: DeckBeat;
}

export interface ChannelStripState {
  trim: number;
  eqHigh: number;
  eqMid: number;
  eqLow: number;
  filter: number;
  fader: number;
  pfl: boolean;
}

export type CrossfaderCurve = "equal-power" | "linear" | "cut";

export interface MixerState {
  a: ChannelStripState;
  b: ChannelStripState;
  crossfader: number; // 0..1
  curve: CrossfaderCurve;
  master: number;
  cueLevel: number;
  cueBlend: number;
  limiterActive: boolean;
}

export type RoutingMode = "two-devices" | "split-4ch" | "mono-split" | "single";

export interface RoutingState {
  mode: RoutingMode;
  configured: boolean; // false until the user completes Audio Setup
  masterDeviceId?: string;
  cueDeviceId?: string;
  latencyMs: { master: number; cue: number };
  cueConnected: boolean;
  error?: string;
}

export interface EngineState {
  status: EngineStatus;
  sampleRate: number | null;
  latencyMs: number | null;
  error?: string;
}

export interface ScheduledEvent {
  id: string;
  kind: "enter" | "transition" | "loop" | "scene";
  targetDeck: DeckId;
  referenceDeck: DeckId; // whose beat grid `atBeatIndex` refers to
  atBeatIndex: number;
  atContextFrame?: number; // engine frame the start is scheduled for
  label: string;
  cancellable: boolean;
}

export interface TransitionPlan {
  fromDeck: DeckId;
  toDeck: DeckId;
  entryBarOnFrom: number; // bar index on the on-air deck where B starts
  startCueSecOnTo: number; // where B starts (its downbeat)
  lengthBars: 8 | 16 | 32;
  faderCurve: "equal-power" | "linear";
  eqMoves: { atBar: number; deck: DeckId; band: "low" | "mid" | "high"; toDb: number }[];
  reasons: string[]; // short, numeric
}

// ---------- Agent ----------

export type ProposalKind = "load" | "queue" | "transition" | "enter" | "scene";

export interface Proposal {
  id: string;
  createdAt: number;
  source: "webmcp" | "local";
  kind: ProposalKind;
  title: string;
  reasons: string[];
  payload: unknown; // e.g. TransitionPlan
  status: "open" | "accepted" | "dismissed" | "expired";
  undoToken?: string;
}

// ---------- Session ----------

export interface Session {
  mode: SessionMode;
  engine: EngineState;
  decks: Record<DeckId, DeckState>;
  mixer: MixerState;
  routing: RoutingState;
  queue: string[]; // track ids
  scheduled: ScheduledEvent[];
  autonomy: Autonomy;
  proposals: Proposal[];
  agent: { webmcp: WebMcpStatus; toolCount: number };
  visuals: { connected: boolean; sceneId: string; blackout: boolean; displays: number };
  privacy: { cspEnforced: boolean | null; crossOriginIsolated: boolean }; // null while probing
}
