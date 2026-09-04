/**
 * What the command palette can do. Three sources, in this order:
 *
 * 1. **Tools** — the registry's own tools for the current mode and autonomy level, run through
 *    `registry.invoke`, so the policy, the proposals and the activity log all apply exactly as
 *    they do for an agent. A tool that needs one argument asks for it in the palette itself.
 * 2. **The console** — the things the DJ would otherwise reach for with a mouse.
 * 3. **Tracks** — the library, fuzzy-matched; Enter loads to the free deck, ⌘Enter to B.
 *
 * Everything here is data. The component does the rendering and the keyboard.
 */
import { registry } from "../../agent";
import { SCENES } from "../../agent/scenes";
import { permitted, type ToolDefinition } from "../../agent/types";
import { t } from "../../app/i18n-core";
import { libraryStore } from "../../library/library-store";
import type { LibraryTrack } from "../../library/types";
import type { Autonomy, DeckId, SessionMode } from "../../state/session";
import { sessionStore } from "../../state/session-store";
import { readJson, safeStorage, writeJson } from "../../state/store";
import type { Rankable } from "./matcher";

export const PALETTE_RECENT_KEY = "mixerx.v2.palette.recent";
const RECENT_CAP = 12;

export type CommandGroup = "tool" | "console" | "track";

export interface Command extends Rankable {
  id: string;
  group: CommandGroup;
  label: string;
  /** Right-hand detail: the key, the tempo, the reason it is here. */
  hint?: string;
  /** Asks for one value before running (a scene name, a search query, a preset). */
  prompt?: { label: string; suggestions?: { value: string; label: string }[] };
  run(value: string, modifier: boolean): Promise<unknown> | undefined;
}

export interface CommandContext {
  mode: SessionMode;
  autonomy: Autonomy;
  actions: ConsoleActions;
}

/** The console's own doors, handed in by the page that owns them. */
export interface ConsoleActions {
  toggleLibrary(): void;
  openAudioSetup(): void;
  openKeyboardMap(): void;
  openRecap(): void;
  openStudio(): void;
  openDisplay(): void;
  openPreview(): void;
  toggleBlackout(): void;
  setMode(mode: SessionMode): void;
  applyPreset(index: number): void;
  presetNames(): string[];
}

/** Tools that take exactly one obvious argument get a prompt; the rest run as they are. */
function promptFor(tool: ToolDefinition, context: CommandContext): Command["prompt"] {
  switch (tool.name) {
    case "apply-scene":
      return {
        label: t("palette.prompt.scene"),
        suggestions: SCENES.map((scene) => ({ value: scene.id, label: scene.title })),
      };
    case "apply-preset":
      return {
        label: t("palette.prompt.preset"),
        suggestions: context.actions.presetNames().map((name) => ({ value: name, label: name })),
      };
    case "search-library":
      return { label: t("palette.prompt.search") };
    case "get-track":
      return { label: t("palette.prompt.trackId") };
    default:
      return undefined;
  }
}

function inputFor(tool: ToolDefinition, value: string): unknown {
  switch (tool.name) {
    case "apply-scene":
      return { sceneId: value };
    case "apply-preset":
      return { name: value };
    case "search-library":
      return { query: value, limit: 10 };
    case "get-track":
      return { trackId: value };
    case "enter-deck":
      return { deck: "B" as DeckId };
    default:
      return {};
  }
}

/** A tool the palette cannot call without more than one argument stays out of the list. */
const HIDDEN_TOOLS = new Set(["load-deck", "set-queue", "preview-cue"]);

/**
 * The palette is the DJ's own hand, so it lists only what the current autonomy level runs outright.
 * An agent may offer an act tool at any level and have it come back as a card to confirm; asking
 * the DJ to confirm a card they raised themselves one keystroke ago would be a loop, not a check.
 */
export function toolCommands(context: CommandContext): Command[] {
  return registry
    .forContext(context.mode, context.autonomy)
    .filter((tool) => !HIDDEN_TOOLS.has(tool.name) && permitted(tool.access, context.autonomy))
    .map((tool) => ({
      id: `tool:${tool.name}`,
      group: "tool" as const,
      label: tool.title,
      hint: tool.name,
      haystack: `${tool.title} ${tool.name} ${tool.description}`,
      prompt: promptFor(tool, context),
      run: (value: string) => registry.invoke(tool.name, inputFor(tool, value), { caller: "local" }),
    }));
}

export function consoleCommands(context: CommandContext): Command[] {
  const { actions } = context;
  const entry = (id: string, label: string, act: () => void, hint?: string): Command => ({
    id: `ui:${id}`,
    group: "console",
    label,
    ...(hint ? { hint } : {}),
    haystack: `${label} ${hint ?? ""} ${id}`,
    run: () => {
      act();
      return undefined;
    },
  });
  const presets = actions.presetNames();
  return [
    entry("library", t("palette.library"), actions.toggleLibrary, "L"),
    entry("audio", t("routing.setup"), actions.openAudioSetup),
    entry("keys", t("keys.title"), actions.openKeyboardMap, "?"),
    entry("recap", t("recap.open"), actions.openRecap),
    entry("studio", t("stage.menu.open"), actions.openStudio),
    entry("display", t("stage.menu.display"), actions.openDisplay),
    entry("preview", t("stage.menu.preview"), actions.openPreview),
    entry("blackout", t("stage.menu.blackout"), actions.toggleBlackout),
    ...(["learn", "mix", "perform"] as SessionMode[]).map((mode) =>
      entry(`mode-${mode}`, t("palette.mode", { mode: t(`mode.${mode}`) }), () => actions.setMode(mode)),
    ),
    ...presets.map((name, index) =>
      entry(
        `preset-${index}`,
        t("palette.preset", { name }),
        () => actions.applyPreset(index),
        `⇧${index + 1}`,
      ),
    ),
  ];
}

/** The deck a track should land on: the one that is free, else A. */
export function idleDeck(): DeckId {
  const { decks } = sessionStore.getState();
  if (!decks.A.track || (!decks.A.playing && !decks.A.onAir)) return "A";
  if (!decks.B.track || (!decks.B.playing && !decks.B.onAir)) return "B";
  return "A";
}

export function trackCommands(): Command[] {
  const tracks = libraryStore.getState().tracks as LibraryTrack[];
  return tracks.map((track) => ({
    id: `track:${track.id}`,
    group: "track" as const,
    label: track.title,
    hint: [track.artist, track.camelot, track.bpm ? `${track.bpm.toFixed(1)} BPM` : ""]
      .filter(Boolean)
      .join(" · "),
    haystack: `${track.title} ${track.artist} ${track.camelot ?? ""} ${track.bpm ?? ""}`,
    run: (_value: string, modifier: boolean) =>
      registry.invoke(
        "load-deck",
        { deck: modifier ? "B" : idleDeck(), trackId: track.id },
        { caller: "local" },
      ),
  }));
}

export function allCommands(context: CommandContext): Command[] {
  const recent = readRecent();
  const weigh = (command: Command): Command => {
    const index = recent.indexOf(command.id);
    return index < 0 ? command : { ...command, weight: (recent.length - index) * 3 };
  };
  return [
    ...toolCommands(context).map(weigh),
    ...consoleCommands(context).map(weigh),
    ...trackCommands().map(weigh),
  ];
}

/** Ids only — the palette remembers what the DJ reaches for, never what they typed. */
export function readRecent(): string[] {
  const stored = readJson<unknown>(safeStorage(), PALETTE_RECENT_KEY);
  return Array.isArray(stored)
    ? stored.filter((id): id is string => typeof id === "string").slice(0, RECENT_CAP)
    : [];
}

export function rememberRecent(id: string): void {
  const next = [id, ...readRecent().filter((entry) => entry !== id)].slice(0, RECENT_CAP);
  writeJson(safeStorage(), PALETTE_RECENT_KEY, next);
}
