/**
 * Stage protocol. Frames and settings cross a session-scoped
 * BroadcastChannel ("mixerx.stage.v2.<sessionId>"); the Stage never receives audio. Every window
 * that renders the Stage (studio, audience display, console preview) subscribes to the same
 * channel, so all of them draw the same scene from the same frames.
 */
import { SCENES } from "../agent/scenes";
import { FEATURE_FRAME_LENGTH, FEATURE_INDEX } from "../engine/messages";
import type { DeckId, SectionKind } from "../state/session";
import {
  type CrowdLayout,
  type CrowdLayouts,
  type CrowdStyle,
  type CrowdStyles,
  isCrowdStyle,
  sanitiseCrowdLayout,
} from "./crowd/characters";

export const STAGE_PROTOCOL_VERSION = 2 as const;
export const STAGE_SESSION_KEY = "mixerx.v2.stageSession";
export const STAGE_LAST_SESSION_KEY = "mixerx.v2.lastStageSession";

export const channelName = (sessionId: string): string => `mixerx.stage.v2.${sessionId}`;

/**
 * Absolute milliseconds on a clock every window on this machine shares. `performance.now()` is
 * relative to each document's own time origin, so it cannot be compared across the channel.
 */
export const absoluteNow = (): number =>
  typeof performance === "undefined" ? Date.now() : performance.timeOrigin + performance.now();

/** Float32Array layout of `StageFrame.f` (shared with the feature worker). */
export const F = FEATURE_INDEX;
export { FEATURE_FRAME_LENGTH };

export type StageEventKind =
  | "kick"
  | "snare"
  | "hat"
  | "beat"
  | "bar"
  | "phrase"
  | "section"
  | "drop"
  | "cue"
  | "loopOn"
  | "loopOff"
  | "deckStart"
  | "deckStop"
  | "faderCentre";

export const STAGE_EVENT_KINDS: readonly StageEventKind[] = [
  "kick",
  "snare",
  "hat",
  "beat",
  "bar",
  "phrase",
  "section",
  "drop",
  "cue",
  "loopOn",
  "loopOff",
  "deckStart",
  "deckStop",
  "faderCentre",
];

export interface StageEvent {
  t: number; // audio time (seconds) of the event
  kind: StageEventKind;
  deck?: DeckId;
}

export type OnAir = "A" | "B" | "both" | "none";
export type StageSection = SectionKind | "none";

export interface StageFrame {
  v: typeof STAGE_PROTOCOL_VERSION;
  sessionId: string;
  seq: number;
  tAudio: number;
  /**
   * Absolute milliseconds (`absoluteNow()`), not a per-document `performance.now()`: the Stage
   * extrapolates the beat phase from it and every window must read it on the same clock.
   */
  sentAt: number;
  f: Float32Array;
  section: StageSection;
  keyHue: number | null;
  onAir: OnAir;
  events: StageEvent[];
  /**
   * Kind of the *next* section on the on-air deck, "none" when unknown. The Stage telegraphs a
   * coming drop with it (Director `anticipation`); optional so an older console still validates.
   */
  next?: StageSection;
}

/** What the audience is hearing right now (the lower third). Artwork is a small data URL or absent. */
export interface NowPlaying {
  deck: DeckId;
  title: string;
  artist: string;
  camelot: string;
  keyName: string;
  bpm: number;
  /** 96×96 data URL ≤ 12 KB, produced on the console; never a file path or an object URL. */
  artwork?: string;
}

/** One track of the night, in the order it went on air (the night sky and the recap read this). */
export interface NightEntry {
  id: string;
  title: string;
  artist: string;
  camelot: string;
  bpm: number;
  /** Absolute milliseconds when it went on air. */
  startedAt: number;
  energy: number; // 1..10
}

export const NIGHT_CAP = 200;
export const nightStorageKey = (sessionId: string): string => `mixerx.v2.night.${sessionId}`;

/**
 * A vibe the DJ can recall in one keystroke: everything about the look except what the music is
 * doing. `builtin` marks the four we ship, so their names follow the interface language until the
 * DJ renames them.
 */
export interface Preset {
  name: string;
  builtin?: string;
  sceneId: string;
  palette: PaletteSource;
  custom?: [string, string];
  transition: TransitionStyle;
  intensity: number;
  crowd: boolean;
  crowdStyle?: CrowdStyle;
  crowdLayout?: CrowdLayout;
  lowerThird: boolean;
}

export const PRESET_CAP = 9;

export type NightSkyMode = "auto" | "always" | "off";
export type MorphMode = "off" | "hold" | "auto";

/** A message the Kick Field's particles assemble into. */
export interface MorphSettings {
  /** ≤ 24 characters, or the name of a built-in silhouette ("heart", "star", "mark"). */
  text: string;
  mode: MorphMode;
}

export type PaletteSource = "key" | "decks" | "custom";
export type TransitionStyle = "cut" | "dissolve" | "wipe";

/** Stage settings, including automatic following and per-scene crowd choices. */
export interface StageSettings {
  sceneId: string;
  intensity: number; // 0..1
  palette: PaletteSource;
  custom?: [string, string];
  photosensitiveSafe: boolean;
  reducedMotion: boolean;
  blackout: boolean;
  testSignal: boolean;
  transition: TransitionStyle;
  sectionReactions: boolean;
  /** Choose the scene from the on-air section automatically (apply-scene pins one until the next section). */
  follow: boolean;
  /** Scenes that carry a crowd layer; empty by default, added per scene by the DJ. */
  crowdScenes: string[];
  /** Remember the crowd character for each scene; missing entries keep the classic dancers. */
  crowdStyles: CrowdStyles;
  crowdLayouts: CrowdLayouts;
  /** Show the now-playing lower third when a track goes on air (6 s, then it slides away). */
  lowerThird: boolean;
  /** Shown in idle mode under the clock; ≤ 40 characters, the DJ's own words. */
  eventName: string;
  /** Up to nine vibes, applied with Shift+1…9 or from the console's STAGE menu. */
  presets: Preset[];
  /** When the set's constellation is drawn: in the quiet parts, always, or never. */
  nightSky: NightSkyMode;
  /** A word (or a built-in shape) the Kick Field's particles assemble into. */
  morph: MorphSettings;
}

const DEFAULTS: StageSettings = {
  sceneId: "body-pulse",
  intensity: 0.8,
  palette: "key",
  custom: ["#ffa03c", "#3fd5ff"],
  photosensitiveSafe: false,
  reducedMotion: false,
  blackout: false,
  testSignal: false,
  transition: "dissolve",
  sectionReactions: true,
  follow: true,
  crowdScenes: [],
  crowdStyles: {},
  crowdLayouts: {},
  lowerThird: true,
  eventName: "",
  presets: [
    {
      name: "Deep space",
      builtin: "deep-space",
      sceneId: "drop-burst",
      palette: "key",
      transition: "dissolve",
      intensity: 0.85,
      crowd: false,
      lowerThird: true,
    },
    {
      name: "Ink haze",
      builtin: "ink-haze",
      sceneId: "break-haze",
      palette: "decks",
      transition: "dissolve",
      intensity: 0.5,
      crowd: true,
      lowerThird: true,
    },
    {
      name: "Warm terrain",
      builtin: "warm-terrain",
      sceneId: "intro-lines",
      palette: "custom",
      custom: ["#ffb066", "#7c5cff"],
      transition: "dissolve",
      intensity: 0.6,
      crowd: false,
      lowerThird: true,
    },
    {
      name: "Cube lattice",
      builtin: "cube-lattice",
      sceneId: "cubes",
      palette: "key",
      transition: "wipe",
      intensity: 0.75,
      crowd: false,
      lowerThird: true,
    },
  ],
  nightSky: "auto",
  morph: { text: "", mode: "off" },
};

export const DEFAULT_STAGE_SETTINGS: StageSettings = Object.freeze(DEFAULTS) as StageSettings;

export type StageRole = "studio" | "display" | "preview";

export type StageMessage =
  | { type: "frame"; frame: StageFrame }
  | { type: "meta"; now: NowPlaying | null; night: NightEntry[]; eventName: string }
  | { type: "settings"; settings: StageSettings }
  | { type: "patch"; patch: Partial<StageSettings>; from: string }
  | { type: "hello"; from: string; role: StageRole }
  | { type: "presence"; from: string; role: StageRole }
  | { type: "bye"; from: string }
  | { type: "who" };

const SECTIONS: readonly StageSection[] = ["intro", "build", "drop", "break", "body", "outro", "none"];
const ON_AIR: readonly OnAir[] = ["A", "B", "both", "none"];
const PALETTES: readonly PaletteSource[] = ["key", "decks", "custom"];
const TRANSITIONS: readonly TransitionStyle[] = ["cut", "dissolve", "wipe"];
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function emptyFrame(sessionId: string): StageFrame {
  return {
    v: STAGE_PROTOCOL_VERSION,
    sessionId,
    seq: 0,
    tAudio: 0,
    sentAt: 0,
    f: new Float32Array(FEATURE_FRAME_LENGTH),
    section: "none",
    keyHue: null,
    onAir: "none",
    events: [],
    next: "none",
  };
}

export function isStageEvent(value: unknown): value is StageEvent {
  return (
    isRecord(value) &&
    typeof value.t === "number" &&
    typeof value.kind === "string" &&
    (STAGE_EVENT_KINDS as readonly string[]).includes(value.kind) &&
    (value.deck === undefined || value.deck === "A" || value.deck === "B")
  );
}

export function isStageFrame(value: unknown): value is StageFrame {
  if (!isRecord(value)) return false;
  return (
    value.v === STAGE_PROTOCOL_VERSION &&
    typeof value.sessionId === "string" &&
    typeof value.seq === "number" &&
    typeof value.tAudio === "number" &&
    typeof value.sentAt === "number" &&
    value.f instanceof Float32Array &&
    value.f.length === FEATURE_FRAME_LENGTH &&
    typeof value.section === "string" &&
    SECTIONS.includes(value.section as StageSection) &&
    (value.keyHue === null || typeof value.keyHue === "number") &&
    typeof value.onAir === "string" &&
    ON_AIR.includes(value.onAir as OnAir) &&
    Array.isArray(value.events) &&
    value.events.every(isStageEvent) &&
    (value.next === undefined || SECTIONS.includes(value.next as StageSection))
  );
}

const clamp01 = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** Merges unknown input (storage, another window) with the defaults; invalid fields fall back. */
export function sanitiseSettings(
  value: unknown,
  base: StageSettings = DEFAULT_STAGE_SETTINGS,
): StageSettings {
  const input = isRecord(value) ? value : {};
  const custom = Array.isArray(input.custom)
    ? (input.custom as unknown[]).filter(
        (entry): entry is string => typeof entry === "string" && HEX_COLOUR.test(entry),
      )
    : [];
  const customPair: [string, string] =
    custom.length === 2
      ? [custom[0] as string, custom[1] as string]
      : (base.custom ?? ["#ffa03c", "#3fd5ff"]);
  const sceneId =
    typeof input.sceneId === "string" && input.sceneId.length <= 40 ? input.sceneId : base.sceneId;
  return {
    // Retired Wave Lines selections reopen on the ocean instead of an unavailable scene.
    sceneId: sceneId === "waves" ? "intro-lines" : sceneId,
    intensity: clamp01(input.intensity, base.intensity),
    palette: PALETTES.includes(input.palette as PaletteSource)
      ? (input.palette as PaletteSource)
      : base.palette,
    custom: customPair,
    photosensitiveSafe: bool(input.photosensitiveSafe, base.photosensitiveSafe),
    reducedMotion: bool(input.reducedMotion, base.reducedMotion),
    blackout: bool(input.blackout, base.blackout),
    testSignal: bool(input.testSignal, base.testSignal),
    transition: TRANSITIONS.includes(input.transition as TransitionStyle)
      ? (input.transition as TransitionStyle)
      : base.transition,
    sectionReactions: bool(input.sectionReactions, base.sectionReactions),
    follow: bool(input.follow, base.follow),
    crowdScenes: Array.isArray(input.crowdScenes)
      ? SCENES.map((scene) => scene.id).filter((id) => (input.crowdScenes as unknown[]).includes(id))
      : [...base.crowdScenes],
    crowdStyles: isRecord(input.crowdStyles)
      ? Object.fromEntries(
          SCENES.flatMap(({ id }) => {
            const style = (input.crowdStyles as Record<string, unknown>)[id];
            return isCrowdStyle(style) ? [[id, style]] : [];
          }),
        )
      : { ...base.crowdStyles },
    crowdLayouts: isRecord(input.crowdLayouts)
      ? Object.fromEntries(
          SCENES.flatMap(({ id }) => {
            const layout = (input.crowdLayouts as Record<string, unknown>)[id];
            return isRecord(layout) ? [[id, sanitiseCrowdLayout(layout)]] : [];
          }),
        )
      : { ...base.crowdLayouts },
    lowerThird: bool(input.lowerThird, base.lowerThird),
    eventName: typeof input.eventName === "string" ? input.eventName.slice(0, 40).trim() : base.eventName,
    nightSky: NIGHT_SKY_MODES.includes(input.nightSky as NightSkyMode)
      ? (input.nightSky as NightSkyMode)
      : base.nightSky,
    morph: sanitiseMorph(input.morph, base.morph),
    presets: Array.isArray(input.presets)
      ? (input.presets as unknown[])
          .map(sanitisePreset)
          .filter((preset): preset is Preset => preset !== null)
          .slice(0, PRESET_CAP)
      : [...base.presets],
  };
}

const NIGHT_SKY_MODES: readonly NightSkyMode[] = ["auto", "always", "off"];
const MORPH_MODES: readonly MorphMode[] = ["off", "hold", "auto"];

export function sanitiseMorph(value: unknown, base: MorphSettings): MorphSettings {
  if (!isRecord(value)) return { ...base };
  return {
    text: typeof value.text === "string" ? value.text.slice(0, 24) : base.text,
    mode: MORPH_MODES.includes(value.mode as MorphMode) ? (value.mode as MorphMode) : base.mode,
  };
}

const SCENE_IDS = new Set(SCENES.map((scene) => scene.id));

/** One preset from unknown input; null when it does not name a scene we can render. */
export function sanitisePreset(value: unknown): Preset | null {
  if (!isRecord(value)) return null;
  const requestedScene = value.sceneId === "waves" ? "intro-lines" : value.sceneId;
  const sceneId = typeof requestedScene === "string" && SCENE_IDS.has(requestedScene) ? requestedScene : null;
  if (!sceneId) return null;
  const name = typeof value.name === "string" ? value.name.slice(0, 24).trim() : "";
  if (!name) return null;
  const custom = Array.isArray(value.custom)
    ? (value.custom as unknown[]).filter(
        (entry): entry is string => typeof entry === "string" && HEX_COLOUR.test(entry),
      )
    : [];
  return {
    name,
    ...(typeof value.builtin === "string" && value.builtin.length <= 32 ? { builtin: value.builtin } : {}),
    sceneId,
    palette: PALETTES.includes(value.palette as PaletteSource) ? (value.palette as PaletteSource) : "key",
    ...(custom.length === 2
      ? { custom: [custom[0] as string, custom[1] as string] as [string, string] }
      : {}),
    transition: TRANSITIONS.includes(value.transition as TransitionStyle)
      ? (value.transition as TransitionStyle)
      : "dissolve",
    intensity: clamp01(value.intensity, 0.8),
    crowd: bool(value.crowd, false),
    crowdStyle: isCrowdStyle(value.crowdStyle) ? value.crowdStyle : "classic",
    crowdLayout: sanitiseCrowdLayout(value.crowdLayout),
    lowerThird: bool(value.lowerThird, true),
  };
}

/**
 * The settings a preset changes and nothing else: the blackout, the test signal, the follow rule
 * and every other scene's crowd choice are the DJ's, not the preset's.
 */
export function presetPatch(preset: Preset, current: StageSettings): Partial<StageSettings> {
  const others = current.crowdScenes.filter((id) => id !== preset.sceneId);
  return {
    sceneId: preset.sceneId,
    palette: preset.palette,
    ...(preset.custom ? { custom: preset.custom } : {}),
    transition: preset.transition,
    intensity: preset.intensity,
    lowerThird: preset.lowerThird,
    crowdScenes: preset.crowd ? [...others, preset.sceneId] : others,
    crowdStyles: {
      ...current.crowdStyles,
      [preset.sceneId]: preset.crowdStyle ?? "classic",
    },
    crowdLayouts: {
      ...current.crowdLayouts,
      [preset.sceneId]: sanitiseCrowdLayout(preset.crowdLayout),
    },
  };
}

/** Only known keys with valid values survive; the result may be empty. */
export function sanitisePatch(value: unknown): Partial<StageSettings> {
  if (!isRecord(value)) return {};
  const full = sanitiseSettings(value);
  const patch: Partial<StageSettings> = {};
  for (const key of Object.keys(full) as (keyof StageSettings)[]) {
    if (!(key in value)) continue;
    (patch as Record<string, unknown>)[key] = full[key];
  }
  return patch;
}

export function isStageMessage(value: unknown): value is StageMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "frame":
      return isStageFrame(value.frame);
    case "meta":
      return (
        (value.now === null || isNowPlaying(value.now)) &&
        Array.isArray(value.night) &&
        value.night.every(isNightEntry) &&
        typeof value.eventName === "string"
      );
    case "settings":
      return isRecord(value.settings);
    case "patch":
      return isRecord(value.patch) && typeof value.from === "string";
    case "hello":
    case "presence":
      return typeof value.from === "string" && ["studio", "display", "preview"].includes(String(value.role));
    case "bye":
      return typeof value.from === "string";
    case "who":
      return true;
    default:
      return false;
  }
}

export function isNowPlaying(value: unknown): value is NowPlaying {
  return (
    isRecord(value) &&
    (value.deck === "A" || value.deck === "B") &&
    typeof value.title === "string" &&
    typeof value.artist === "string" &&
    typeof value.camelot === "string" &&
    typeof value.keyName === "string" &&
    typeof value.bpm === "number" &&
    (value.artwork === undefined ||
      (typeof value.artwork === "string" && value.artwork.startsWith("data:image/")))
  );
}

export function isNightEntry(value: unknown): value is NightEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.artist === "string" &&
    typeof value.camelot === "string" &&
    typeof value.bpm === "number" &&
    typeof value.startedAt === "number" &&
    typeof value.energy === "number"
  );
}

export function settingsEqual(a: StageSettings, b: StageSettings): boolean {
  return (Object.keys(a) as (keyof StageSettings)[]).every((key) => {
    if (
      key === "custom" ||
      key === "crowdScenes" ||
      key === "crowdStyles" ||
      key === "crowdLayouts" ||
      key === "presets" ||
      key === "morph"
    )
      return JSON.stringify(a[key]) === JSON.stringify(b[key]);
    return a[key] === b[key];
  });
}
/** A short random id for windows and sessions (no PII, not a secret). */
export function shortId(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function")
    crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
