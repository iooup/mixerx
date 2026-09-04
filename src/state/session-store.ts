import type {
  Autonomy,
  ChannelStripState,
  DeckId,
  DeckLoop,
  DeckState,
  EngineState,
  MixerState,
  Proposal,
  RoutingState,
  ScheduledEvent,
  Session,
  SessionMode,
  TrackAnalysis,
  TrackRef,
  WebMcpStatus,
} from "./session";
import { createStore, readJson, safeStorage, useStore, writeJson } from "./store";

export const SESSION_STORAGE_KEY = "mixerx.v2.session";

export type SessionEvent =
  | { type: "mode/set"; mode: SessionMode }
  | { type: "autonomy/set"; autonomy: Autonomy }
  | { type: "privacy/csp"; enforced: boolean | null }
  | { type: "privacy/isolation"; isolated: boolean }
  | { type: "agent/webmcp"; status: WebMcpStatus; toolCount: number }
  | { type: "engine/state"; engine: Partial<EngineState> & { status: EngineState["status"] } }
  | { type: "deck/track"; deck: DeckId; track: TrackRef | null }
  | { type: "deck/analysis"; deck: DeckId; analysis: TrackAnalysis | null }
  | { type: "deck/transport"; deck: DeckId; playing: boolean }
  | { type: "deck/rate"; deck: DeckId; rate: number; tempoOffsetPct: number }
  | { type: "deck/loop"; deck: DeckId; loop: DeckLoop | null }
  | { type: "deck/cue"; deck: DeckId; cueSec: number }
  | { type: "deck/onAir"; deck: DeckId; onAir: boolean }
  | { type: "mixer/strip"; deck: DeckId; patch: Partial<ChannelStripState> }
  | { type: "mixer/patch"; patch: Partial<Omit<MixerState, "a" | "b">> }
  | { type: "routing/set"; routing: RoutingState }
  | { type: "queue/set"; queue: string[] }
  | { type: "scheduled/set"; scheduled: ScheduledEvent[] }
  | { type: "deck/hotCues"; deck: DeckId; hotCues: (number | null)[] }
  | { type: "proposal/add"; proposal: Proposal }
  | { type: "proposal/status"; id: string; status: Proposal["status"] }
  | { type: "proposal/prune"; keep: number }
  | { type: "visuals/set"; patch: Partial<Session["visuals"]> };

export const SESSION_MODES: readonly SessionMode[] = ["learn", "mix", "perform"];
export const AUTONOMY_LEVELS: readonly Autonomy[] = ["observe", "prepare", "copilot"];

export function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === "string" && (SESSION_MODES as readonly string[]).includes(value);
}

export function isAutonomy(value: unknown): value is Autonomy {
  return typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

export function neutralStrip(): ChannelStripState {
  return { trim: 0, eqHigh: 0, eqMid: 0, eqLow: 0, filter: 0, fader: 1, pfl: false };
}

export function emptyDeck(id: DeckId): DeckState {
  return {
    id,
    track: null,
    analysis: null,
    playing: false,
    positionSec: 0,
    rate: 1,
    tempoOffsetPct: 0,
    keylock: false,
    loop: null,
    cueSec: 0,
    hotCues: [null, null, null, null, null, null, null, null],
    slip: false,
    onAir: false,
    section: null,
    barsToNextSection: null,
    beat: { index: 0, phase: 0, barPhase: 0, phrasePhase: 0, phraseBars: 8 },
  };
}

export interface SessionPreferences {
  mode: SessionMode;
  autonomy: Autonomy;
  queue: string[];
}

export function createInitialSession(preferences: Partial<SessionPreferences> = {}): Session {
  return {
    mode: preferences.mode ?? "learn",
    engine: { status: "idle", sampleRate: null, latencyMs: null },
    decks: { A: emptyDeck("A"), B: emptyDeck("B") },
    mixer: {
      a: neutralStrip(),
      b: neutralStrip(),
      crossfader: 0,
      curve: "equal-power",
      master: 0.8,
      cueLevel: 0.8,
      cueBlend: 0,
      limiterActive: false,
    },
    routing: { mode: "single", configured: false, latencyMs: { master: 0, cue: 0 }, cueConnected: false },
    queue: preferences.queue ?? [],
    scheduled: [],
    autonomy: preferences.autonomy ?? "prepare",
    proposals: [],
    agent: { webmcp: "unavailable", toolCount: 0 },
    visuals: { connected: false, sceneId: "", blackout: false, displays: 0 },
    privacy: { cspEnforced: null, crossOriginIsolated: false },
  };
}

function patchDeck(state: Session, deck: DeckId, patch: Partial<DeckState>): Session {
  const current = state.decks[deck];
  const keys = Object.keys(patch) as (keyof DeckState)[];
  if (keys.every((key) => current[key] === patch[key])) return state;
  return { ...state, decks: { ...state.decks, [deck]: { ...current, ...patch } } };
}

export function reduceSession(state: Session, event: SessionEvent): Session {
  switch (event.type) {
    case "mode/set":
      return state.mode === event.mode ? state : { ...state, mode: event.mode };
    case "autonomy/set":
      return state.autonomy === event.autonomy ? state : { ...state, autonomy: event.autonomy };
    case "privacy/csp":
      return state.privacy.cspEnforced === event.enforced
        ? state
        : { ...state, privacy: { ...state.privacy, cspEnforced: event.enforced } };
    case "privacy/isolation":
      return state.privacy.crossOriginIsolated === event.isolated
        ? state
        : { ...state, privacy: { ...state.privacy, crossOriginIsolated: event.isolated } };
    case "agent/webmcp":
      return state.agent.webmcp === event.status && state.agent.toolCount === event.toolCount
        ? state
        : { ...state, agent: { webmcp: event.status, toolCount: event.toolCount } };
    case "engine/state": {
      const next: EngineState = { ...state.engine, ...event.engine };
      if (event.engine.error === undefined && event.engine.status !== "error") delete next.error;
      return { ...state, engine: next };
    }
    case "deck/track":
      return patchDeck(state, event.deck, {
        track: event.track,
        analysis: null,
        playing: false,
        positionSec: 0,
        loop: null,
        cueSec: 0,
        onAir: false,
        section: null,
        barsToNextSection: null,
      });
    case "deck/analysis":
      return patchDeck(state, event.deck, { analysis: event.analysis });
    case "deck/transport":
      return patchDeck(state, event.deck, { playing: event.playing });
    case "deck/rate":
      return patchDeck(state, event.deck, { rate: event.rate, tempoOffsetPct: event.tempoOffsetPct });
    case "deck/loop":
      return patchDeck(state, event.deck, { loop: event.loop });
    case "deck/cue":
      return patchDeck(state, event.deck, { cueSec: event.cueSec });
    case "deck/onAir":
      return patchDeck(state, event.deck, { onAir: event.onAir });
    case "mixer/strip": {
      const key = event.deck === "A" ? "a" : "b";
      const current = state.mixer[key];
      const entries = Object.entries(event.patch) as [keyof ChannelStripState, number | boolean][];
      if (entries.every(([name, value]) => current[name] === value)) return state;
      return { ...state, mixer: { ...state.mixer, [key]: { ...current, ...event.patch } } };
    }
    case "mixer/patch": {
      const entries = Object.entries(event.patch) as [keyof MixerState, unknown][];
      if (entries.every(([name, value]) => state.mixer[name] === value)) return state;
      return { ...state, mixer: { ...state.mixer, ...event.patch } };
    }
    case "routing/set":
      return { ...state, routing: event.routing };
    case "queue/set":
      return state.queue.length === event.queue.length &&
        state.queue.every((id, index) => id === event.queue[index])
        ? state
        : { ...state, queue: event.queue };
    case "scheduled/set":
      return { ...state, scheduled: event.scheduled };
    case "deck/hotCues":
      return patchDeck(state, event.deck, { hotCues: event.hotCues });
    case "proposal/add":
      return { ...state, proposals: [...state.proposals, event.proposal] };
    case "proposal/status": {
      const index = state.proposals.findIndex((proposal) => proposal.id === event.id);
      const current = state.proposals[index];
      if (!current || current.status === event.status) return state;
      const proposals = [...state.proposals];
      proposals[index] = { ...current, status: event.status };
      return { ...state, proposals };
    }
    case "proposal/prune": {
      const open = state.proposals.filter((proposal) => proposal.status === "open");
      const closed = state.proposals.filter((proposal) => proposal.status !== "open").slice(-event.keep);
      const proposals = [...closed, ...open].sort((left, right) => left.createdAt - right.createdAt);
      return proposals.length === state.proposals.length ? state : { ...state, proposals };
    }
    case "visuals/set": {
      const entries = Object.entries(event.patch) as [keyof Session["visuals"], unknown][];
      if (entries.every(([name, value]) => state.visuals[name] === value)) return state;
      return { ...state, visuals: { ...state.visuals, ...event.patch } };
    }
    default:
      return state;
  }
}

export function readStoredPreferences(storage: Storage | null): Partial<SessionPreferences> {
  const stored = readJson<Partial<SessionPreferences>>(storage, SESSION_STORAGE_KEY);
  const preferences: Partial<SessionPreferences> = {};
  if (stored && isSessionMode(stored.mode)) preferences.mode = stored.mode;
  if (stored && isAutonomy(stored.autonomy)) preferences.autonomy = stored.autonomy;
  if (stored && Array.isArray(stored.queue))
    preferences.queue = stored.queue.filter((id): id is string => typeof id === "string").slice(0, 200);
  return preferences;
}

let lastPersisted: string | null = null;

/** Writes only when a preference changed: a write for an unrelated store change could clobber a value another tab (or a test) just stored. */
export function persistPreferences(storage: Storage | null, session: Session): void {
  const preferences: SessionPreferences = {
    mode: session.mode,
    autonomy: session.autonomy,
    queue: session.queue,
  };
  const serialised = JSON.stringify(preferences);
  if (serialised === lastPersisted) return;
  lastPersisted = serialised;
  writeJson(storage, SESSION_STORAGE_KEY, preferences);
}

export const sessionStore = createStore(
  createInitialSession(readStoredPreferences(safeStorage())),
  reduceSession,
);

const identity = (session: Session) => session;

export function useSession(): Session {
  return useStore(sessionStore, identity);
}
