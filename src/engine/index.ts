/**
 * Engine singleton. Created on the first user gesture (AudioContext policy), bound to the
 * session store so deck transport and routing state are always mirrored into `Session`.
 */
import { libraryStore } from "../library/library-store";
import type { DeckId, RoutingState } from "../state/session";
import { sessionStore } from "../state/session-store";
import { readJson, safeStorage, writeJson } from "../state/store";
import { AudioEngine } from "./audio-engine";
import { faderGain, isOnAir } from "./beat-math";
import type { RoutingConfig } from "./routing";

export const ROUTING_STORAGE_KEY = "mixerx.v2.routing";

let instance: AudioEngine | null = null;
let starting: Promise<AudioEngine> | null = null;

export function getEngine(): AudioEngine | null {
  return instance;
}

export function recomputeOnAir(engine: AudioEngine = instance as AudioEngine): void {
  if (!engine) return;
  for (const deck of ["A", "B"] as DeckId[]) {
    const strip = engine.mixer.strips[deck];
    const gain = strip.audibleGain * faderGain(engine.mixer.masterLevel);
    const onAir = isOnAir(engine.decks[deck].playing, gain);
    if (sessionStore.getState().decks[deck].onAir !== onAir)
      sessionStore.dispatch({ type: "deck/onAir", deck, onAir });
  }
}

function routingToState(engine: AudioEngine): RoutingState {
  const status = engine.routing.status();
  const state: RoutingState = {
    mode: status.mode,
    configured: status.configured,
    latencyMs: status.latencyMs,
    cueConnected: status.cueConnected,
  };
  if (status.masterDeviceId) state.masterDeviceId = status.masterDeviceId;
  if (status.cueDeviceId) state.cueDeviceId = status.cueDeviceId;
  if (status.error) state.error = status.error;
  return state;
}

function bind(engine: AudioEngine): void {
  for (const deck of ["A", "B"] as DeckId[]) {
    engine.decks[deck].subscribe((report) => {
      if (report.type === "started") {
        sessionStore.dispatch({ type: "deck/transport", deck, playing: true });
        removeScheduled(deck);
      }
      if (report.type === "stopped" || report.type === "ended") {
        sessionStore.dispatch({ type: "deck/transport", deck, playing: false });
      }
      if (report.type !== "position") recomputeOnAir(engine);
    });
  }
  engine.preview.subscribe((report) => {
    if (report.type === "ended" || report.type === "stopped") {
      libraryStore.dispatch({ type: "library/preview", id: null });
    }
  });
  const refreshLatency = () => {
    if (engine.state !== "running") return;
    const latencyMs = engine.latencyMs();
    if (sessionStore.getState().engine.latencyMs !== latencyMs)
      sessionStore.dispatch({ type: "engine/state", engine: { status: "running", latencyMs } });
  };
  // outputLatency is only known once the output stream is running.
  setTimeout(refreshLatency, 500);
  setTimeout(refreshLatency, 2000);
  engine.context.addEventListener("statechange", () => {
    const status = engine.state === "running" ? "running" : engine.state === "closed" ? "idle" : "suspended";
    sessionStore.dispatch({ type: "engine/state", engine: { status, latencyMs: engine.latencyMs() } });
  });
}

/** Drops pending scheduled events for a deck (it started, was stopped, or was reloaded). */
export function removeScheduled(deck: DeckId): void {
  const scheduled = sessionStore.getState().scheduled;
  const next = scheduled.filter((event) => event.targetDeck !== deck);
  if (next.length !== scheduled.length) sessionStore.dispatch({ type: "scheduled/set", scheduled: next });
}

export function readStoredRouting(): RoutingConfig | null {
  const stored = readJson<RoutingConfig>(safeStorage(), ROUTING_STORAGE_KEY);
  if (!stored || typeof stored.mode !== "string") return null;
  return stored;
}

export async function applyRouting(config: RoutingConfig): Promise<RoutingState> {
  const engine = await ensureEngine();
  await engine.routing.apply(config);
  engine.mixer.setCueBlendEnabled(config.mode !== "single");
  const state = routingToState(engine);
  sessionStore.dispatch({ type: "routing/set", routing: state });
  if (state.configured) writeJson(safeStorage(), ROUTING_STORAGE_KEY, config);
  return state;
}

/** Creates and starts the engine (must be called from a user gesture the first time). */
export async function ensureEngine(): Promise<AudioEngine> {
  if (instance) {
    if (instance.state !== "running") {
      await instance.start();
      const state: AudioContextState = instance.context.state;
      sessionStore.dispatch({
        type: "engine/state",
        engine: { status: state === "running" ? "running" : "suspended", latencyMs: instance.latencyMs() },
      });
    }
    return instance;
  }
  if (!starting) {
    sessionStore.dispatch({ type: "engine/state", engine: { status: "starting" } });
    starting = AudioEngine.create()
      .then(async (engine) => {
        await engine.start();
        instance = engine;
        bind(engine);
        sessionStore.dispatch({
          type: "engine/state",
          engine: {
            status: engine.state === "running" ? "running" : "suspended",
            sampleRate: engine.context.sampleRate,
            latencyMs: engine.latencyMs(),
          },
        });
        const stored = readStoredRouting();
        if (stored) {
          await engine.routing.apply(stored);
          engine.mixer.setCueBlendEnabled(stored.mode !== "single");
          sessionStore.dispatch({ type: "routing/set", routing: routingToState(engine) });
        } else {
          sessionStore.dispatch({ type: "routing/set", routing: routingToState(engine) });
        }
        return engine;
      })
      .catch((error: unknown) => {
        starting = null;
        sessionStore.dispatch({
          type: "engine/state",
          engine: { status: "error", error: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      });
  }
  return starting;
}
