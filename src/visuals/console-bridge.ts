/**
 * Console side of the Stage: builds `StageFrame`s from the feature
 * worker and the engine/session state, detects discrete events, and posts them on the session
 * channel; owns the settings (persisted) and mirrors them into `session.visuals`; counts the
 * connected Stage windows from their presence messages; opens the Stage/Display windows.
 *
 * Frames tick on feature-worker messages (they keep arriving while the console tab is hidden,
 * unlike requestAnimationFrame) with a timer fallback while the engine is off or the test signal
 * is on. Nothing but frames and settings crosses the channel; audio never does.
 */
import { sceneById, sceneCategory } from "../agent/scenes";
import type { AudioEngine } from "../engine/audio-engine";
import { beatInfo, crossfaderGains, EQ_MIN_DB, faderGain, sectionAt } from "../engine/beat-math";
import { onGesture } from "../engine/events";
import { getEngine } from "../engine/index";
import { getLibrary } from "../library/library";
import { ARC_INTERVAL_MS, nightArc } from "../state/night-arc";
import type { DeckId, Session } from "../state/session";
import { sessionStore } from "../state/session-store";
import { safeStorage } from "../state/store";
import { type DetectorSample, EventDetector } from "./events";
import { followScene } from "./follow";
import { camelotHue } from "./palette";
import {
  absoluteNow,
  channelName,
  F,
  FEATURE_FRAME_LENGTH,
  isNightEntry,
  isStageMessage,
  NIGHT_CAP,
  type NightEntry,
  type NowPlaying,
  nightStorageKey,
  STAGE_LAST_SESSION_KEY,
  STAGE_PROTOCOL_VERSION,
  STAGE_SESSION_KEY,
  type StageFrame,
  type StageMessage,
  type StageRole,
  type StageSettings,
  sanitisePatch,
  shortId,
} from "./protocol";
import { persistStageSettings, readStoredStageSettings, stageSettingsStore } from "./settings-store";
import { TestSignal } from "./test-signal";

const MIN_FRAME_INTERVAL_MS = 15;
const IDLE_TIMER_MS = 33;
const TEST_TIMER_MS = 16;
const PEER_TIMEOUT_MS = 3500;
const PUBLISH_GRACE_MS = 5000;

interface Peer {
  role: StageRole;
  lastSeen: number;
}

/** One id per console tab, so two consoles on one machine never share a channel. */
export function getStageSessionId(): string {
  try {
    const stored = sessionStorage.getItem(STAGE_SESSION_KEY);
    if (stored && /^[0-9a-f]{12}$/.test(stored)) return stored;
    const created = shortId();
    sessionStorage.setItem(STAGE_SESSION_KEY, created);
    return created;
  } catch {
    return shortId();
  }
}

export function stageUrl(sessionId: string, mode: "studio" | "display" | "preview"): string {
  const params = new URLSearchParams({ session: sessionId });
  if (mode === "display") params.set("mode", "display");
  if (mode === "preview") {
    params.set("mode", "display");
    params.set("preview", "1");
  }
  return `/stage?${params.toString()}`;
}

/** Deck whose grid drives the phases: on air first, then playing, then loaded. */
function referenceDeck(session: Session): DeckId | null {
  const { A, B } = session.decks;
  if (A.onAir && B.onAir) return A.analysis ? "A" : "B";
  if (A.onAir) return "A";
  if (B.onAir) return "B";
  if (A.playing) return "A";
  if (B.playing) return "B";
  if (A.track) return "A";
  if (B.track) return "B";
  return null;
}

const lowGain = (db: number): number => Math.min(1, Math.max(0, (db - EQ_MIN_DB) / (0 - EQ_MIN_DB)));

const ARTWORK_SIZE = 96;
const ARTWORK_MAX_BYTES = 12 * 1024;

/**
 * A 96×96 thumbnail of the track's embedded artwork as a data URL, small enough to cross the
 * channel on every track change. The image never leaves the machine: it is decoded from the file's
 * own tag, drawn into an `OffscreenCanvas` here and sent as pixels, never as a path or a URL.
 */
async function artworkThumbnail(trackId: string): Promise<string | undefined> {
  if (typeof OffscreenCanvas === "undefined" || typeof Image === "undefined") return undefined;
  const url = await getLibrary().artworkUrl(trackId);
  if (!url) return undefined;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = new OffscreenCanvas(ARTWORK_SIZE, ARTWORK_SIZE);
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    // Cover: crop to a square so covers of any shape fill the chip.
    const side = Math.min(image.naturalWidth, image.naturalHeight) || ARTWORK_SIZE;
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      ARTWORK_SIZE,
      ARTWORK_SIZE,
    );
    for (const quality of [0.8, 0.6, 0.4]) {
      const blob = await canvas.convertToBlob({ type: "image/webp", quality });
      if (blob.size > ARTWORK_MAX_BYTES) continue;
      return await new Promise<string | undefined>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(blob);
      });
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class ConsoleStageBridge {
  readonly sessionId: string;
  private channel: BroadcastChannel | null = null;
  private readonly peers = new Map<string, Peer>();
  private seq = 0;
  private lastPublishAt = 0;
  private lastPeerAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private timerMs = 0;
  private unsubscribeFeatures: (() => void) | null = null;
  private boundEngine: AudioEngine | null = null;
  private readonly detector = new EventDetector();
  private testSignal: TestSignal | null = null;
  private testLast = 0;
  private lastSection = "none";
  private followVariant = 0;
  private lastVisualsScene = "";
  private lastVisualsBlackout = false;
  private night: NightEntry[] = [];
  private now: NowPlaying | null = null;
  private lastNowKey = "";
  private lastOnAir: DeckId | null = null;
  private readonly onAirSince: Record<DeckId, boolean> = { A: false, B: false };
  private readonly unsubscribers: (() => void)[] = [];
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private arcTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(sessionId = getStageSessionId()) {
    this.sessionId = sessionId;
  }

  start(): void {
    if (this.started || typeof BroadcastChannel === "undefined") return;
    this.started = true;
    const storage = safeStorage();
    stageSettingsStore.dispatch({ type: "stage/replace", settings: readStoredStageSettings(storage) });
    try {
      storage?.setItem(STAGE_LAST_SESSION_KEY, this.sessionId);
    } catch {
      // Storage is optional.
    }
    this.channel = new BroadcastChannel(channelName(this.sessionId));
    this.channel.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    this.post({ type: "who" });
    this.mirrorVisuals(stageSettingsStore.getState());
    this.unsubscribers.push(
      stageSettingsStore.subscribe(() => {
        const settings = stageSettingsStore.getState();
        persistStageSettings(storage, settings);
        this.post({ type: "settings", settings });
        this.mirrorVisuals(settings);
        this.syncTimer();
      }),
      stageSettingsStore.subscribe(() => {
        // The event name rides with the meta so an idle display can show it without the settings.
        if (stageSettingsStore.getState().eventName !== this.lastEventName) this.postMeta();
      }),
      sessionStore.subscribe(() => this.onSession()),
      onGesture((gesture) => {
        if (gesture.kind === "cue")
          this.detector.push({ t: this.audioTime(), kind: "cue", deck: gesture.deck });
      }),
    );
    this.pruneTimer = setInterval(() => this.prunePeers(), 1000);
    this.arcTimer = setInterval(() => this.sampleArc(), ARC_INTERVAL_MS);
    this.sampleArc();
    this.night = readNight(this.sessionId);
    this.onSession();
    this.syncTimer();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.unsubscribeFeatures?.();
    this.unsubscribeFeatures = null;
    this.boundEngine = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.arcTimer) clearInterval(this.arcTimer);
    this.arcTimer = null;
    this.channel?.close();
    this.channel = null;
  }

  /** The night's running order (the recap reads it; the Stage gets it through `meta`). */
  nightEntries(): NightEntry[] {
    return this.night;
  }

  get displays(): number {
    return [...this.peers.values()].filter((peer) => peer.role === "display").length;
  }

  get connected(): boolean {
    return this.peers.size > 0;
  }

  /** Applies a settings change from the console UI or a tool (persisted + broadcast by the subscription). */
  patch(patch: Partial<StageSettings>): void {
    stageSettingsStore.dispatch({ type: "stage/patch", patch });
  }

  private post(message: StageMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // Nothing to do: the channel is closed.
    }
  }

  private receive(data: unknown): void {
    if (!isStageMessage(data)) return;
    switch (data.type) {
      case "hello":
        this.peers.set(data.from, { role: data.role, lastSeen: performance.now() });
        this.lastPeerAt = performance.now();
        this.post({ type: "settings", settings: stageSettingsStore.getState() });
        this.postMeta();
        this.updatePresence();
        this.syncTimer();
        break;
      case "presence":
        this.peers.set(data.from, { role: data.role, lastSeen: performance.now() });
        this.lastPeerAt = performance.now();
        this.updatePresence();
        this.syncTimer();
        break;
      case "bye":
        this.peers.delete(data.from);
        this.updatePresence();
        break;
      case "patch":
        this.patch(sanitisePatch(data.patch));
        break;
      default:
        break;
    }
  }

  private prunePeers(): void {
    const now = performance.now();
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.updatePresence();
    this.syncTimer();
  }

  private updatePresence(): void {
    const visuals = sessionStore.getState().visuals;
    const connected = this.connected;
    const displays = this.displays;
    if (visuals.connected !== connected || visuals.displays !== displays)
      sessionStore.dispatch({ type: "visuals/set", patch: { connected, displays } });
  }

  private mirrorVisuals(settings: StageSettings): void {
    this.lastVisualsScene = settings.sceneId;
    this.lastVisualsBlackout = settings.blackout;
    const visuals = sessionStore.getState().visuals;
    if (visuals.sceneId !== settings.sceneId || visuals.blackout !== settings.blackout)
      sessionStore.dispatch({
        type: "visuals/set",
        patch: { sceneId: settings.sceneId, blackout: settings.blackout },
      });
  }

  /** `apply-scene` (and Undo) write `session.visuals`; the settings follow. */
  private lastEventName = "";

  /** Sends the night's running order and the track on air; the Stage keeps no other library data. */
  private postMeta(): void {
    this.lastEventName = stageSettingsStore.getState().eventName;
    this.post({
      type: "meta",
      now: this.now,
      night: this.night,
      eventName: this.lastEventName,
    });
  }

  /**
   * Follows what the audience is hearing: a track that goes on air becomes the lower third and is
   * appended to the night. Artwork is fetched once per track and the message is sent when it lands.
   */
  private updateNowPlaying(session: Session): void {
    const onAir: DeckId | null = session.decks.A.onAir
      ? "A"
      : session.decks.B.onAir
        ? "B"
        : this.lastOnAir && session.decks[this.lastOnAir].playing
          ? this.lastOnAir
          : null;
    let changed = false;
    for (const deck of ["A", "B"] as DeckId[]) {
      const isOn = session.decks[deck].onAir;
      if (isOn && !this.onAirSince[deck]) changed = true;
      this.onAirSince[deck] = isOn;
    }
    if (onAir !== this.lastOnAir) changed = true;
    this.lastOnAir = onAir;
    const state = onAir ? session.decks[onAir] : null;
    const track = state?.track ?? null;
    // The analysis usually lands a second after the load: the key and the tempo appear then, and
    // the card refreshes in place without sliding in again.
    const key = track ? `${onAir}|${track.id}|${state?.analysis ? "analysed" : "pending"}` : "";
    if (key === this.lastNowKey && !changed) return;
    this.lastNowKey = key;
    if (!track || !onAir || !state) {
      if (this.now) {
        this.now = null;
        this.postMeta();
      }
      return;
    }
    const analysis = state.analysis;
    const bpm = analysis ? analysis.grid.bpm * state.rate : 0;
    const now: NowPlaying = {
      deck: onAir,
      title: track.title,
      artist: track.artist,
      camelot: analysis?.key.camelot ?? "",
      keyName: analysis?.key.name ?? "",
      bpm: Math.round(bpm * 10) / 10,
    };
    this.now = now;
    const energy = analysis
      ? Math.max(
          1,
          Math.min(
            10,
            Math.round(
              (analysis.energyPerBar.reduce((total, value) => total + value, 0) /
                Math.max(1, analysis.energyPerBar.length)) *
                10,
            ),
          ),
        )
      : 5;
    const previous = this.night.at(-1);
    if (!previous || previous.id !== track.id) {
      this.night = [
        ...this.night,
        {
          id: track.id,
          title: track.title,
          artist: track.artist,
          camelot: now.camelot,
          bpm: now.bpm,
          startedAt: Date.now(),
          energy,
        },
      ].slice(-NIGHT_CAP);
      writeNight(this.sessionId, this.night);
    }
    this.postMeta();
    void artworkThumbnail(track.id).then((artwork) => {
      if (!artwork || this.now !== now) return;
      this.now = { ...now, artwork };
      this.postMeta();
    });
  }

  private onSession(): void {
    const session = sessionStore.getState();
    this.updateNowPlaying(session);
    const { sceneId, blackout } = session.visuals;
    if (sceneId !== this.lastVisualsScene && sceneById(sceneId)) {
      this.lastVisualsScene = sceneId;
      this.patch({ sceneId });
    }
    if (blackout !== this.lastVisualsBlackout) {
      this.lastVisualsBlackout = blackout;
      this.patch({ blackout });
    }
    this.bindEngine();
  }

  private bindEngine(): void {
    const engine = getEngine();
    if (engine === this.boundEngine) return;
    this.unsubscribeFeatures?.();
    this.boundEngine = engine;
    this.unsubscribeFeatures = engine ? engine.onFeatures(() => this.tick()) : null;
    this.syncTimer();
  }

  /** Publish only while a Stage window has been seen recently; tick on a timer when features cannot. */
  private syncTimer(): void {
    const active = performance.now() - this.lastPeerAt < PUBLISH_GRACE_MS && this.peers.size > 0;
    const settings = stageSettingsStore.getState();
    const wantMs = !active ? 0 : settings.testSignal ? TEST_TIMER_MS : this.boundEngine ? 0 : IDLE_TIMER_MS;
    if (wantMs === this.timerMs) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = wantMs ? setInterval(() => this.tick(), wantMs) : null;
    this.timerMs = wantMs;
    if (!settings.testSignal) this.testSignal = null;
  }

  private audioTime(): number {
    return this.boundEngine?.context.currentTime ?? performance.now() / 1000;
  }

  private tick(): void {
    if (!this.channel || !this.peers.size) return;
    const now = performance.now();
    if (now - this.lastPublishAt < MIN_FRAME_INTERVAL_MS) return;
    if (now - this.lastPeerAt > PUBLISH_GRACE_MS) return;
    this.lastPublishAt = now;
    const settings = stageSettingsStore.getState();
    const frame = settings.testSignal ? this.testFrame(now) : this.liveFrame();
    this.applyFollow(frame, settings);
    this.post({ type: "frame", frame });
  }

  private testFrame(now: number): StageFrame {
    if (!this.testSignal) {
      this.testSignal = new TestSignal(this.sessionId);
      this.testLast = now;
      this.detector.reset();
    }
    const frame = this.testSignal.next((now - this.testLast) / 1000);
    this.testLast = now;
    this.seq += 1;
    return { ...frame, seq: this.seq, sentAt: absoluteNow() };
  }

  /**
   * The night's energy arc. It has its own timer because it must keep filling whether or not a
   * Stage window is open: the arc under the ON-AIR strip and the end-of-set recap are console
   * features, and frames are only published while something is watching.
   */
  private sampleArc(): void {
    const session = sessionStore.getState();
    const onAir: DeckId | null = session.decks.A.onAir ? "A" : session.decks.B.onAir ? "B" : null;
    if (!onAir) {
      nightArc.sample(Date.now(), 0, "none", null);
      return;
    }
    const deck = session.decks[onAir];
    const analysis = deck.analysis;
    const position = this.boundEngine?.frame().decks[onAir].positionSec ?? deck.positionSec;
    let energy = 0.5;
    let section: StageFrame["section"] = "none";
    if (analysis) {
      const at = sectionAt(analysis.sections, analysis.grid, position);
      section = at?.kind ?? "none";
      const bar = Math.max(
        0,
        Math.floor((beatInfo(analysis.grid, position).index - analysis.grid.downbeatOffset) / 4),
      );
      energy = analysis.energyPerBar[Math.min(analysis.energyPerBar.length - 1, bar)] ?? 0.5;
    }
    nightArc.sample(Date.now(), energy, section, deck.track?.id ?? null);
  }

  private liveFrame(): StageFrame {
    const session = sessionStore.getState();
    const engine = this.boundEngine;
    const engineFrame = engine?.frame() ?? null;
    const f = new Float32Array(FEATURE_FRAME_LENGTH);
    if (engineFrame) f.set(engineFrame.features.subarray(0, FEATURE_FRAME_LENGTH));
    const tAudio = engineFrame?.time ?? performance.now() / 1000;
    const { A, B } = session.decks;
    const onAir = A.onAir && B.onAir ? "both" : A.onAir ? "A" : B.onAir ? "B" : "none";
    const reference = referenceDeck(session);
    const deck = reference ? session.decks[reference] : null;
    const analysis = deck?.analysis ?? null;
    const position = reference ? (engineFrame?.decks[reference].positionSec ?? deck?.positionSec ?? 0) : 0;
    const rate = reference ? (engineFrame?.decks[reference].rate ?? deck?.rate ?? 1) : 1;
    let section: StageFrame["section"] = "none";
    let next: StageFrame["section"] = "none";
    let keyHue: number | null = null;
    let beatIndex: number | null = null;
    let barIndex: number | null = null;
    let phraseIndex: number | null = null;
    if (analysis) {
      const beat = beatInfo(analysis.grid, position);
      f[F.beatPhase] = beat.phase;
      f[F.barPhase] = beat.barPhase;
      f[F.phrasePhase] = beat.phrasePhase;
      f[F.bpm] = analysis.grid.bpm * rate;
      beatIndex = beat.index;
      barIndex = Math.floor((beat.index - analysis.grid.downbeatOffset) / 4);
      phraseIndex = Math.floor(barIndex / beat.phraseBars);
      const at = sectionAt(analysis.sections, analysis.grid, position);
      section = at?.kind ?? "none";
      next = at?.next ?? "none";
      f[F.barsToNextSection] = at?.barsToNext ?? -1;
      const bar = Math.max(0, barIndex);
      f[F.energy] = analysis.energyPerBar[Math.min(analysis.energyPerBar.length - 1, bar)] ?? 0.5;
      keyHue = analysis.key.confidence > 0.25 ? camelotHue(analysis.key.camelot) : null;
    } else {
      f[F.bpm] = 0;
      f[F.barsToNextSection] = -1;
      f[F.energy] = 0.5;
    }
    const mixer = session.mixer;
    const gains = crossfaderGains(mixer.crossfader, mixer.curve);
    f[F.crossfader] = mixer.crossfader;
    f[F.gainA] = faderGain(mixer.a.fader) * gains.a;
    f[F.gainB] = faderGain(mixer.b.fader) * gains.b;
    f[F.lowA] = lowGain(mixer.a.eqLow);
    f[F.lowB] = lowGain(mixer.b.eqLow);
    f[F.filterA] = mixer.a.filter;
    f[F.filterB] = mixer.b.filter;
    const sample: DetectorSample = {
      t: tAudio,
      beatIndex,
      barIndex,
      phraseIndex,
      kick: f[F.kick] ?? 0,
      snare: f[F.snare] ?? 0,
      hat: f[F.hat] ?? 0,
      section,
      crossfader: mixer.crossfader,
      loop: { A: A.loop !== null && A.playing, B: B.loop !== null && B.playing },
      playing: { A: A.playing, B: B.playing },
    };
    const events = this.detector.next(sample);
    this.seq += 1;
    return {
      v: STAGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: this.seq,
      tAudio,
      sentAt: absoluteNow(),
      f,
      section,
      next,
      keyHue,
      onAir,
      events,
    };
  }

  /** Follow sections: on a section change choose the scene for it (a pinned scene lasts one section). */
  private applyFollow(frame: StageFrame, settings: StageSettings): void {
    if (frame.section === this.lastSection) return;
    this.lastSection = frame.section;
    if (!settings.follow || settings.blackout) return;
    this.followVariant += 1;
    const next = followScene(
      frame.section,
      frame.f[F.energy] ?? 0.5,
      this.followVariant,
      sceneCategory(settings.sceneId),
    );
    if (next && next !== settings.sceneId) this.patch({ sceneId: next });
  }
}

/** The night is per console tab and never leaves it: sessionStorage, capped, numbers and titles only. */
function readNight(sessionId: string): NightEntry[] {
  try {
    const raw = sessionStorage.getItem(nightStorageKey(sessionId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter(isNightEntry).slice(-NIGHT_CAP) : [];
  } catch {
    return [];
  }
}

function writeNight(sessionId: string, night: NightEntry[]): void {
  try {
    sessionStorage.setItem(nightStorageKey(sessionId), JSON.stringify(night));
  } catch {
    // Storage is a convenience; the night still works in memory.
  }
}

let bridge: ConsoleStageBridge | null = null;

/** The console's bridge (created on first use; one per console tab). */
export function getStageBridge(): ConsoleStageBridge {
  if (!bridge) bridge = new ConsoleStageBridge();
  return bridge;
}

export function startStageBridge(): ConsoleStageBridge {
  const instance = getStageBridge();
  instance.start();
  return instance;
}

// ---------- Windows ----------

interface ScreenDetailsLike {
  screens: {
    availLeft: number;
    availTop: number;
    availWidth: number;
    availHeight: number;
    isPrimary: boolean;
    label: string;
  }[];
  currentScreen: { availLeft: number; availTop: number };
}

export interface ScreenChoice {
  index: number;
  label: string;
  primary: boolean;
  width: number;
  height: number;
}

/** Screens through the Window Management API (Chromium only, permission prompt); one entry elsewhere. */
export async function listScreens(): Promise<ScreenChoice[] | null> {
  const getScreenDetails = (window as { getScreenDetails?: () => Promise<ScreenDetailsLike> })
    .getScreenDetails;
  if (typeof getScreenDetails !== "function") return null;
  try {
    const details = await getScreenDetails.call(window);
    return details.screens.map((screen, index) => ({
      index,
      label: screen.label || `Screen ${index + 1}`,
      primary: screen.isPrimary,
      width: screen.availWidth,
      height: screen.availHeight,
    }));
  } catch {
    return null;
  }
}

export function openStudio(sessionId: string): Window | null {
  return window.open(stageUrl(sessionId, "studio"), "mixerx-stage", "popup,width=1280,height=800");
}

/** Opens the audience display, on the chosen screen when the browser can place windows. */
export async function openDisplay(
  sessionId: string,
  screenIndex: number | null = null,
): Promise<Window | null> {
  let features = "popup,width=1280,height=720";
  const getScreenDetails = (window as { getScreenDetails?: () => Promise<ScreenDetailsLike> })
    .getScreenDetails;
  if (screenIndex !== null && typeof getScreenDetails === "function") {
    try {
      const details = await getScreenDetails.call(window);
      const screen = details.screens[screenIndex];
      if (screen)
        features = `popup,left=${screen.availLeft},top=${screen.availTop},width=${screen.availWidth},height=${screen.availHeight}`;
    } catch {
      // Fall back to a plain popup the user can drag.
    }
  }
  return window.open(stageUrl(sessionId, "display"), `mixerx-display-${screenIndex ?? "any"}`, features);
}

interface DocumentPictureInPictureLike {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

export function pictureInPictureAvailable(): boolean {
  return typeof (window as { documentPictureInPicture?: unknown }).documentPictureInPicture === "object";
}

/** Always-on-top preview of the audience output (Document Picture-in-Picture); null when unsupported. */
export async function openPictureInPicture(sessionId: string): Promise<Window | null> {
  const api = (window as { documentPictureInPicture?: DocumentPictureInPictureLike })
    .documentPictureInPicture;
  if (!api) return null;
  try {
    const pip = await api.requestWindow({ width: 480, height: 270 });
    const doc = pip.document;
    doc.documentElement.style.cssText = "height:100%;margin:0;background:#000";
    doc.body.style.cssText = "height:100%;margin:0;background:#000;overflow:hidden";
    const iframe = doc.createElement("iframe");
    iframe.src = stageUrl(sessionId, "preview");
    iframe.title = "Mixerx stage preview";
    iframe.style.cssText = "display:block;width:100%;height:100%;border:0;background:#000";
    doc.body.append(iframe);
    return pip;
  } catch {
    return null;
  }
}
