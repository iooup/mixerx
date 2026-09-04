/** The v2 tool set. Handlers reuse the console's own actions. */
import { deckActions, previewActions } from "../engine/actions";
import { sectionAt } from "../engine/beat-math";
import { getEngine } from "../engine/index";
import { getLibrary } from "../library/library";
import {
  type CompatibilityReference,
  compatibilityOf,
  filterTracks,
  libraryStore,
} from "../library/library-store";
import type { DeckId, TransitionPlan } from "../state/session";
import { sessionStore } from "../state/session-store";
import { redactSession, summariseAnalysis } from "./redact";
import type { ToolRegistry } from "./registry";
import { SCENES, sceneCategory, sceneFor } from "./scenes";
import { averageEnergy, planSet, planTransition, type SetTarget } from "./transition";
import { type ToolDefinition, ToolError } from "./types";

const DECKS: DeckId[] = ["A", "B"];
const otherDeck = (deck: DeckId): DeckId => (deck === "A" ? "B" : "A");

function onAirDeck(): DeckId | null {
  const { decks } = sessionStore.getState();
  return decks.A.onAir ? "A" : decks.B.onAir ? "B" : null;
}

function referenceFor(deck: DeckId | null): CompatibilityReference | null {
  if (!deck) return null;
  const track = sessionStore.getState().decks[deck].track;
  const entry = track
    ? libraryStore.getState().tracks.find((candidate) => candidate.id === track.id)
    : undefined;
  return entry ? { camelot: entry.camelot, bpm: entry.bpm, energy: entry.energy } : null;
}

function livePosition(deck: DeckId): number {
  return getEngine()?.frame().decks[deck].positionSec ?? sessionStore.getState().decks[deck].positionSec;
}

function requireTrack(trackId: string) {
  const track = libraryStore.getState().tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new ToolError(`Unknown track id "${trackId}"; call search-library for valid ids.`);
  return track;
}

function transitionFor(from: DeckId, to: DeckId, minLeadBars?: number): TransitionPlan {
  const { decks } = sessionStore.getState();
  const fromAnalysis = decks[from].analysis;
  const toAnalysis = decks[to].analysis;
  if (!decks[from].track || !fromAnalysis)
    throw new ToolError(`Deck ${from} has no analysed track; load one with load-deck and wait for analysis.`);
  if (!decks[to].track || !toAnalysis)
    throw new ToolError(`Deck ${to} has no analysed track; call search-library then load-deck ${to}.`);
  const options: Parameters<typeof planTransition>[0] = {
    from,
    to,
    fromAnalysis,
    toAnalysis,
    fromPositionSec: livePosition(from),
    toCueSec: decks[to].cueSec,
  };
  if (minLeadBars !== undefined) options.minLeadBars = minLeadBars;
  return planTransition(options);
}

const deckSchema = { type: "string" as const, enum: ["A", "B"], description: "Deck id" };

export const getSession: ToolDefinition<Record<string, never>, ReturnType<typeof redactSession>> = {
  name: "get-session",
  title: "Get session",
  description:
    "Current DJ session: decks (track, analysis summary, transport), mixer, routing, queue, scheduled events, open proposals, autonomy level. No file paths or audio.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  access: "read",
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  contexts: ["learn", "mix", "perform"],
  handler: async () => ({ data: redactSession(sessionStore.getState()) }),
};

interface SearchInput {
  query?: string;
  keyCompatible?: boolean;
  tempoWindow?: boolean;
  energyBand?: "all" | "low" | "mid" | "high";
  limit?: number;
}

export const searchLibrary: ToolDefinition<SearchInput, unknown> = {
  name: "search-library",
  title: "Search library",
  description:
    "Search analysed tracks by text and filters. Results carry BPM, Camelot key, energy (1-10), sections, and fit to the on-air deck (key relation, tempo delta %, energy delta).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 200, description: "Text over title, artist, key, BPM" },
      keyCompatible: { type: "boolean", description: "Only keys that mix with the on-air deck" },
      tempoWindow: { type: "boolean", description: "Only tempos within ±6 % of the on-air deck" },
      energyBand: { type: "string", enum: ["all", "low", "mid", "high"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  access: "read",
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  contexts: ["learn", "mix", "perform"],
  handler: async (input) => {
    const deck = onAirDeck() ?? (sessionStore.getState().decks.A.track ? "A" : null);
    const reference = referenceFor(deck);
    const tracks = filterTracks(
      libraryStore.getState().tracks,
      input.query ?? "",
      {
        sourceId: null,
        keyCompatible: Boolean(input.keyCompatible),
        tempoWindow: Boolean(input.tempoWindow),
        energyBand: input.energyBand ?? "all",
      },
      reference,
      reference ? "compat" : "default",
    ).slice(0, input.limit ?? 20);
    return {
      data: {
        reference: deck && reference ? { deck, ...reference } : null,
        tracks: tracks.map((track) => ({
          id: track.id,
          title: track.title,
          artist: track.artist,
          durationSec: track.durationSec,
          analysisState: track.analysisState,
          bpm: track.bpm ?? null,
          camelot: track.camelot ?? null,
          keyName: track.keyName ?? null,
          energy: track.energy ?? null,
          sections:
            track.sections?.map((section) => ({
              kind: section.kind,
              bars: section.endBar - section.startBar,
            })) ?? [],
          fit: compatibilityOf(track, reference),
        })),
      },
    };
  },
};

export const getTrack: ToolDefinition<{ trackId: string }, unknown> = {
  name: "get-track",
  title: "Get track analysis",
  description: "Full analysis for one track id: beat grid summary, key, loudness, energy per bar, sections.",
  inputSchema: {
    type: "object",
    properties: { trackId: { type: "string", maxLength: 64 } },
    required: ["trackId"],
    additionalProperties: false,
  },
  access: "read",
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  contexts: ["learn", "mix", "perform"],
  handler: async ({ trackId }) => {
    const track = requireTrack(trackId);
    const analysis = getLibrary().getAnalysis(trackId);
    if (!analysis)
      throw new ToolError(
        `Track "${track.title}" is ${track.analysisState}; analysis runs locally, call again shortly.`,
      );
    return {
      data: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        durationSec: track.durationSec,
        ...summariseAnalysis(analysis),
      },
    };
  },
};

export const proposeTransition: ToolDefinition<{ fromDeck?: DeckId; toDeck?: DeckId }, TransitionPlan> = {
  name: "propose-transition",
  title: "Propose transition",
  description:
    "Plans a phrase-aligned transition from the on-air deck to the other deck: entry bar, start cue, blend length, EQ moves, reasons. No side effects.",
  inputSchema: {
    type: "object",
    properties: { fromDeck: deckSchema, toDeck: deckSchema },
    additionalProperties: false,
  },
  access: "read",
  annotations: { readOnlyHint: true },
  contexts: ["mix", "perform"],
  handler: async (input) => {
    const from = input.fromDeck ?? onAirDeck() ?? "A";
    const to = input.toDeck ?? otherDeck(from);
    if (from === to) throw new ToolError("fromDeck and toDeck must differ.");
    return { data: transitionFor(from, to) };
  },
};

export const planSetTool: ToolDefinition<{ trackIds: string[]; target?: SetTarget }, unknown> = {
  name: "plan-set",
  title: "Plan set",
  description: "Orders candidate track ids into an energy arc (rise, peak, or release) with reasons.",
  inputSchema: {
    type: "object",
    properties: {
      trackIds: { type: "array", items: { type: "string", maxLength: 64 }, minItems: 1, maxItems: 50 },
      target: { type: "string", enum: ["rise", "peak", "release"] },
    },
    required: ["trackIds"],
    additionalProperties: false,
  },
  access: "read",
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  contexts: ["mix", "perform"],
  handler: async ({ trackIds, target }) => {
    const candidates = trackIds.map((id) => {
      const track = requireTrack(id);
      return { id, title: track.title, energy: track.energy, bpm: track.bpm, camelot: track.camelot };
    });
    return { data: planSet(candidates, target ?? "peak") };
  },
};

export const proposeScene: ToolDefinition<Record<string, never>, unknown> = {
  name: "propose-scene",
  title: "Propose scene",
  description:
    "Suggests a Stage scene id from the on-air deck's section and energy, with the current visuals state.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  access: "read",
  annotations: { readOnlyHint: true },
  contexts: ["mix", "perform"],
  handler: async () => {
    const session = sessionStore.getState();
    const deck = onAirDeck();
    const analysis = deck ? session.decks[deck].analysis : null;
    const position = deck ? livePosition(deck) : 0;
    const section = analysis ? sectionAt(analysis.sections, analysis.grid, position) : null;
    const energy = analysis ? averageEnergy(analysis) : 3;
    const scene = sceneFor(section?.kind ?? null, energy, sceneCategory(session.visuals.sceneId));
    const reasons = [
      deck ? `on air: ${deck}` : "nothing on air",
      section
        ? `section ${section.kind}${section.next ? `, ${section.next} in ${section.barsToNext} bars` : ""}`
        : "no section data",
      `energy ${energy}`,
    ];
    return {
      data: {
        sceneId: scene.id,
        title: scene.title,
        reasons,
        current: session.visuals,
        scenes: SCENES.map((entry) => entry.id),
      },
    };
  },
};

export const loadDeck: ToolDefinition<{ deck: DeckId; trackId: string }, unknown> = {
  name: "load-deck",
  title: "Load deck",
  description: "Loads a track into a stopped deck. Refuses when the deck is on air.",
  inputSchema: {
    type: "object",
    properties: { deck: deckSchema, trackId: { type: "string", maxLength: 64 } },
    required: ["deck", "trackId"],
    additionalProperties: false,
  },
  access: "prepare",
  annotations: { readOnlyHint: false, untrustedContentHint: true },
  contexts: ["mix", "perform"],
  precheck: ({ deck, trackId }) => {
    const state = sessionStore.getState().decks[deck];
    if (state.onAir || state.playing)
      throw new ToolError(
        `Deck ${deck} is on air; call propose-transition or wait for the fader to reach ${otherDeck(deck)}.`,
      );
    requireTrack(trackId);
  },
  describe: ({ deck, trackId }) => {
    const track = libraryStore.getState().tracks.find((candidate) => candidate.id === trackId);
    return { kind: "load", title: `Load ${track?.title ?? trackId} → ${deck}`, reasons: [] };
  },
  handler: async ({ deck, trackId }) => {
    const state = sessionStore.getState().decks[deck];
    if (state.onAir || state.playing)
      throw new ToolError(
        `Deck ${deck} is on air; call propose-transition or wait for the fader to reach ${otherDeck(deck)}.`,
      );
    const track = requireTrack(trackId);
    const previous = state.track?.id ?? null;
    await deckActions.load(deck, trackId);
    return {
      data: { deck, trackId, title: track.title },
      undo: {
        label: previous ? `Reload previous track on ${deck}` : `Unload ${deck}`,
        run: async () => {
          if (previous) await deckActions.load(deck, previous);
          else {
            getEngine()?.decks[deck].unload();
            sessionStore.dispatch({ type: "deck/track", deck, track: null });
          }
        },
      },
    };
  },
};

export const setQueue: ToolDefinition<{ trackIds: string[] }, unknown> = {
  name: "set-queue",
  title: "Set queue",
  description: "Replaces or reorders the queue with track ids.",
  inputSchema: {
    type: "object",
    properties: { trackIds: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 100 } },
    required: ["trackIds"],
    additionalProperties: false,
  },
  access: "prepare",
  annotations: { readOnlyHint: false },
  contexts: ["mix", "perform"],
  describe: ({ trackIds }) => ({
    kind: "queue",
    title: `Set queue (${trackIds.length} tracks)`,
    reasons: [],
  }),
  handler: async ({ trackIds }) => {
    for (const id of trackIds) requireTrack(id);
    const previous = sessionStore.getState().queue;
    sessionStore.dispatch({ type: "queue/set", queue: [...new Set(trackIds)] });
    return {
      data: { queue: sessionStore.getState().queue },
      undo: {
        label: "Restore previous queue",
        run: async () => {
          sessionStore.dispatch({ type: "queue/set", queue: previous });
        },
      },
    };
  },
};

export const previewCue: ToolDefinition<{ trackId: string }, unknown> = {
  name: "preview-cue",
  title: "Preview on CUE",
  description:
    "Plays a track on the CUE bus only. Refuses when CUE is not routed separately from the master.",
  inputSchema: {
    type: "object",
    properties: { trackId: { type: "string", maxLength: 64 } },
    required: ["trackId"],
    additionalProperties: false,
  },
  access: "prepare",
  annotations: { readOnlyHint: false },
  contexts: ["mix", "perform"],
  precheck: ({ trackId }) => {
    const routing = sessionStore.getState().routing;
    if (routing.mode === "single" || !routing.cueConnected)
      throw new ToolError(
        "CUE is not routed separately (single output); the audience would hear it. Ask the user to choose two devices or a 4-channel interface in Audio Setup.",
      );
    requireTrack(trackId);
  },
  describe: ({ trackId }) => ({ kind: "load", title: `Preview ${trackId} on CUE`, reasons: [] }),
  handler: async ({ trackId }) => {
    const routing = sessionStore.getState().routing;
    if (routing.mode === "single" || !routing.cueConnected)
      throw new ToolError(
        "CUE is not routed separately (single output); the audience would hear it. Ask the user to choose two devices or a 4-channel interface in Audio Setup.",
      );
    requireTrack(trackId);
    await previewActions.toggle(trackId);
    return {
      data: { previewing: libraryStore.getState().previewId },
      undo: { label: "Stop preview", run: () => previewActions.stop() },
    };
  },
};

interface ArmInput {
  toDeck?: DeckId;
  entryBarOnFrom?: number;
}

export const armTransition: ToolDefinition<ArmInput, unknown> = {
  name: "arm-transition",
  title: "Arm transition",
  description:
    "Arms the planned transition: the other deck starts on the chosen bar of the on-air deck, tempo matched. Below Co-DJ autonomy this becomes a proposal.",
  inputSchema: {
    type: "object",
    properties: {
      toDeck: deckSchema,
      entryBarOnFrom: {
        type: "integer",
        minimum: 0,
        description: "0-based bar on the on-air deck; default from propose-transition",
      },
    },
    additionalProperties: false,
  },
  access: "act",
  annotations: { readOnlyHint: false },
  contexts: ["mix", "perform"],
  precheck: (input) => {
    const from = onAirDeck();
    if (!from) throw new ToolError("Nothing is on air; play a deck first, then call propose-transition.");
    const to = input.toDeck ?? otherDeck(from);
    if (to === from) throw new ToolError(`Deck ${to} is the on-air deck; arm the other deck.`);
    if (!sessionStore.getState().decks[to].track)
      throw new ToolError(`Deck ${to} has no track; call search-library then load-deck ${to}.`);
  },
  describe: (input) => {
    try {
      const from = onAirDeck() ?? "A";
      const to = input.toDeck ?? otherDeck(from);
      const plan = transitionFor(from, to, 8);
      const bar = (input.entryBarOnFrom ?? plan.entryBarOnFrom) + 1;
      return {
        kind: "transition",
        title: `Arm: ${to} enters at bar ${bar} of ${from}`,
        reasons: plan.reasons,
      };
    } catch (error) {
      return {
        kind: "transition",
        title: "Arm transition",
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
  },
  handler: async (input) => {
    const from = onAirDeck();
    if (!from) throw new ToolError("Nothing is on air; play a deck first, then call propose-transition.");
    const to = input.toDeck ?? otherDeck(from);
    if (to === from) throw new ToolError(`Deck ${to} is the on-air deck; arm the other deck.`);
    const plan = transitionFor(from, to, 8);
    const bar = input.entryBarOnFrom ?? plan.entryBarOnFrom;
    const event = await deckActions.enterAtBar(to, bar, {
      sync: true,
      label: `${to} enters at bar ${bar + 1}`,
    });
    if (!event)
      throw new ToolError(
        `Bar ${bar + 1} of ${from} has passed or ${from} is not playing; call propose-transition again.`,
      );
    return {
      data: { scheduled: event, plan },
      liveOutputChanged: true,
      undo: { label: `Cancel ${to} entry`, run: () => deckActions.cancelScheduled(event.id) },
    };
  },
};

export const enterDeck: ToolDefinition<{ deck?: DeckId }, unknown> = {
  name: "enter-deck",
  title: "Enter deck",
  description:
    "Starts the other deck on the on-air deck's next bar 1 (tempo matched). Below Co-DJ autonomy this becomes a proposal.",
  inputSchema: { type: "object", properties: { deck: deckSchema }, additionalProperties: false },
  access: "act",
  annotations: { readOnlyHint: false },
  contexts: ["mix", "perform"],
  precheck: (input) => {
    const from = onAirDeck();
    if (!from) throw new ToolError("Nothing is on air; play a deck first.");
    const deck = input.deck ?? otherDeck(from);
    if (deck === from) throw new ToolError(`Deck ${deck} is already on air.`);
    if (!sessionStore.getState().decks[deck].track)
      throw new ToolError(`Deck ${deck} has no track; call search-library then load-deck ${deck}.`);
  },
  describe: (input) => {
    const from = onAirDeck() ?? "A";
    const deck = input.deck ?? otherDeck(from);
    return {
      kind: "enter",
      title: `Enter ${deck} on ${from}'s next bar 1`,
      reasons: ["tempo matched first", "sample-accurate start"],
    };
  },
  handler: async (input) => {
    const from = onAirDeck();
    if (!from) throw new ToolError("Nothing is on air; play a deck first.");
    const deck = input.deck ?? otherDeck(from);
    if (deck === from) throw new ToolError(`Deck ${deck} is already on air.`);
    const event = await deckActions.enterOnNextBar(deck, { sync: true });
    if (!event)
      throw new ToolError(`Deck ${deck} has no track or ${from} is not playing; call load-deck first.`);
    return {
      data: { scheduled: event },
      liveOutputChanged: true,
      undo: { label: `Cancel ${deck} entry`, run: () => deckActions.cancelScheduled(event.id) },
    };
  },
};

export const applyScene: ToolDefinition<{ sceneId: string }, unknown> = {
  name: "apply-scene",
  title: "Apply scene",
  description:
    "Selects the Stage scene (rendered by the Stage window). Below Co-DJ autonomy this becomes a proposal.",
  inputSchema: {
    type: "object",
    properties: { sceneId: { type: "string", enum: SCENES.map((scene) => scene.id) } },
    required: ["sceneId"],
    additionalProperties: false,
  },
  access: "act",
  annotations: { readOnlyHint: false },
  contexts: ["mix", "perform"],
  describe: ({ sceneId }) => ({ kind: "scene", title: `Apply scene ${sceneId}`, reasons: [] }),
  handler: async ({ sceneId }) => {
    const previous = sessionStore.getState().visuals.sceneId;
    sessionStore.dispatch({ type: "visuals/set", patch: { sceneId } });
    return {
      data: { sceneId },
      liveOutputChanged: true,
      undo: {
        label: previous ? `Back to scene ${previous}` : "Clear scene",
        run: async () => {
          sessionStore.dispatch({ type: "visuals/set", patch: { sceneId: previous } });
        },
      },
    };
  },
};

export const applyPreset: ToolDefinition<{ name: string }, unknown> = {
  name: "apply-preset",
  title: "Apply preset",
  description:
    "Applies one of the DJ's saved Stage presets by name (scene, palette, transition, intensity, crowd and lower third). Below Co-DJ autonomy this becomes a proposal.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", maxLength: 24 } },
    required: ["name"],
    additionalProperties: false,
  },
  access: "act",
  annotations: { readOnlyHint: false },
  contexts: ["mix", "perform"],
  describe: ({ name }) => ({ kind: "scene", title: `Apply preset ${name}`, reasons: [] }),
  handler: async ({ name }) => {
    // The Stage lives in its own chunk; the console entry never pulls it in for one tool.
    const [bridge, store, protocol] = await Promise.all([
      import("../visuals/console-bridge"),
      import("../visuals/settings-store"),
      import("../visuals/protocol"),
    ]);
    const settings = store.stageSettingsStore.getState();
    const wanted = name.trim().toLowerCase();
    const preset = settings.presets.find((entry) => entry.name.trim().toLowerCase() === wanted);
    if (!preset) {
      const known = settings.presets.map((entry) => entry.name).join(", ");
      throw new ToolError(
        known
          ? `No preset named "${name}". Saved presets: ${known}.`
          : `No preset named "${name}". The DJ has not saved any presets yet.`,
      );
    }
    const previous = {
      sceneId: settings.sceneId,
      palette: settings.palette,
      custom: settings.custom,
      transition: settings.transition,
      intensity: settings.intensity,
      lowerThird: settings.lowerThird,
      crowdScenes: [...settings.crowdScenes],
    };
    bridge.getStageBridge().patch(protocol.presetPatch(preset, settings));
    return {
      data: { name: preset.name, sceneId: preset.sceneId },
      liveOutputChanged: true,
      undo: {
        label: `Back to scene ${previous.sceneId}`,
        run: async () => {
          const back = await import("../visuals/console-bridge");
          back.getStageBridge().patch(previous);
        },
      },
    };
  },
};

export const ALL_TOOLS: ToolDefinition[] = [
  getSession,
  searchLibrary,
  getTrack,
  proposeTransition,
  planSetTool,
  proposeScene,
  loadDeck,
  setQueue,
  previewCue,
  armTransition,
  enterDeck,
  applyScene,
  applyPreset,
] as ToolDefinition[];

export function registerAllTools(registry: ToolRegistry): void {
  for (const tool of ALL_TOOLS) registry.register(tool);
}

export { DECKS };
