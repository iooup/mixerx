/**
 * UI-facing engine actions. Every action updates the engine and the session store together so
 * there is exactly one truth.
 */
import { guideStore } from "../coach/guide-store";
import { getLibrary } from "../library/library";
import { libraryStore } from "../library/library-store";
import { HOT_CUE_SLOTS, normaliseHotCues } from "../library/user-data";
import type {
  ChannelStripState,
  CrossfaderCurve,
  DeckId,
  ScheduledEvent,
  TrackAnalysis,
} from "../state/session";
import { sessionStore } from "../state/session-store";
import {
  beatPeriodSec,
  beatPosition,
  clamp,
  contextFrameAt,
  EQ_MIN_DB,
  nextDownbeatSec,
  phaseErrorMs,
  rateToTempoOffset,
  secAtBeat,
  secondsUntilDeckTime,
  syncRate,
  TEMPO_RANGE_PCT,
  tempoOffsetToRate,
} from "./beat-math";
import { emitGesture } from "./events";
import { ensureEngine, getEngine, recomputeOnAir, removeScheduled } from "./index";

export const NUDGE_PCT = 2;

const otherDeck = (deck: DeckId): DeckId => (deck === "A" ? "B" : "A");
const bend: Record<DeckId, -1 | 0 | 1> = { A: 0, B: 0 };
let scheduledCounter = 0;

/** LEARN locks PLAY on B until the lesson lets the engine start it. */
function playLocked(deck: DeckId): boolean {
  return deck === "B" && guideStore.getState().locks.includes("play-B");
}

function deckAnalysis(deck: DeckId): TrackAnalysis | null {
  return sessionStore.getState().decks[deck].analysis;
}

function baseRate(deck: DeckId): number {
  return sessionStore.getState().decks[deck].rate;
}

function applyRate(deck: DeckId, rate: number, slew = 0.05): void {
  const engine = getEngine();
  if (!engine) return;
  engine.decks[deck].setRate(rate * (1 + (bend[deck] * NUDGE_PCT) / 100), slew);
}

/** The first downbeat at or after `sec` (the natural start point for an entry). */
function entrySec(analysis: TrackAnalysis | null, sec: number): number {
  if (!analysis) return sec;
  return Math.max(0, nextDownbeatSec(analysis.grid, sec - 0.001, 0));
}

export const deckActions = {
  /** Decodes the library track and loads it into the deck (stops the deck first). */
  async load(deck: DeckId, trackId: string): Promise<void> {
    const engine = await ensureEngine();
    const library = getLibrary();
    library.setSampleRate(engine.context.sampleRate);
    const loaded = await library.prepareForDeck(trackId);
    const userData = await library.getUserData(trackId);
    const target = engine.decks[deck];
    target.stop();
    removeScheduled(deck);
    target.setLoop(null);
    target.cueSec = userData?.cueSec ?? 0;
    target.load(loaded.channels, loaded.sampleRate, loaded.track.id);
    sessionStore.dispatch({
      type: "deck/track",
      deck,
      track: {
        id: loaded.track.id,
        title: loaded.track.title,
        artist: loaded.track.artist,
        durationSec: loaded.track.durationSec,
        sizeBytes: loaded.track.sizeBytes,
        source: loaded.track.source,
        hasArtwork: loaded.track.hasArtwork,
      },
    });
    if (target.cueSec) sessionStore.dispatch({ type: "deck/cue", deck, cueSec: target.cueSec });
    sessionStore.dispatch({ type: "deck/hotCues", deck, hotCues: normaliseHotCues(userData?.hotCues) });
    target.seekSec(target.cueSec);
    const analysis = library.getAnalysis(trackId);
    if (analysis) sessionStore.dispatch({ type: "deck/analysis", deck, analysis });
    recomputeOnAir(engine);
  },

  async play(deck: DeckId): Promise<void> {
    if (playLocked(deck)) return;
    const engine = await ensureEngine();
    engine.decks[deck].play();
  },

  async stop(deck: DeckId): Promise<void> {
    const engine = await ensureEngine();
    engine.decks[deck].stop();
    removeScheduled(deck);
  },

  async togglePlay(deck: DeckId): Promise<void> {
    const engine = await ensureEngine();
    const target = engine.decks[deck];
    if (!target.trackId) return;
    if (target.playing) {
      target.stop();
      removeScheduled(deck);
    } else if (!playLocked(deck)) target.play();
  },

  /** DJ CUE: playing → return to the cue point and stop; stopped → set the cue point here. */
  async cue(deck: DeckId): Promise<void> {
    const engine = await ensureEngine();
    const target = engine.decks[deck];
    if (!target.trackId) return;
    if (target.playing) {
      target.stop();
      removeScheduled(deck);
      target.seekSec(target.cueSec);
      emitGesture({ kind: "cue", deck });
      return;
    }
    const position = target.positionSec();
    if (Math.abs(position - target.cueSec) > 0.01) {
      target.cueSec = position;
      sessionStore.dispatch({ type: "deck/cue", deck, cueSec: position });
      void getLibrary().updateUserData(target.trackId, { cueSec: position });
    } else {
      target.seekSec(target.cueSec);
    }
  },

  async seek(deck: DeckId, sec: number): Promise<void> {
    const engine = await ensureEngine();
    engine.decks[deck].seekSec(sec);
  },

  /** Moves the playhead by whole bars (one second without a grid). */
  async stepBars(deck: DeckId, direction: -1 | 1, bars = 1): Promise<void> {
    await deckActions.jumpBeats(deck, direction * bars * 4);
  },

  async jumpBeats(deck: DeckId, beats: number): Promise<void> {
    const engine = await ensureEngine();
    const target = engine.decks[deck];
    if (!target.trackId) return;
    const analysis = deckAnalysis(deck);
    const position = target.positionSec();
    const step = analysis ? beats * beatPeriodSec(analysis.grid, position) : beats * 0.25;
    target.seekSec(clamp(position + step, 0, Math.max(0, target.durationSec - 0.01)));
  },

  async setTempo(deck: DeckId, tempoOffsetPct: number): Promise<void> {
    await ensureEngine();
    const pct = clamp(tempoOffsetPct, -TEMPO_RANGE_PCT, TEMPO_RANGE_PCT);
    const rate = tempoOffsetToRate(pct);
    sessionStore.dispatch({ type: "deck/rate", deck, rate, tempoOffsetPct: pct });
    applyRate(deck, rate);
  },

  /** Temporary ±2 % rate bend while held; `0` releases. */
  async nudge(deck: DeckId, direction: -1 | 0 | 1): Promise<void> {
    await ensureEngine();
    if (bend[deck] === direction) return;
    bend[deck] = direction;
    applyRate(deck, baseRate(deck), 0.05);
  },

  /** Matches this deck's tempo to the other deck and aligns the beat phase. */
  async sync(deck: DeckId): Promise<{ rate: number; clamped: boolean; phaseErrorMs: number } | null> {
    const engine = await ensureEngine();
    const source = deckAnalysis(deck);
    const reference = deckAnalysis(otherDeck(deck));
    const referenceDeck = engine.decks[otherDeck(deck)];
    const target = engine.decks[deck];
    if (!source || !reference || !target.trackId || !referenceDeck.trackId) return null;
    const referenceBpm = reference.grid.bpm * baseRate(otherDeck(deck));
    const { rate, clamped } = syncRate(referenceBpm, source.grid.bpm);
    const now = engine.context.currentTime;
    const error = phaseErrorMs(
      reference.grid,
      referenceDeck.positionSec(now),
      source.grid,
      target.positionSec(now),
    );
    bend[deck] = 0;
    if (target.playing && referenceDeck.playing) {
      // Slew the rate for two bars so the phase error is removed without an audible jump.
      const seconds = (8 * beatPeriodSec(reference.grid, referenceDeck.positionSec(now))) / rate;
      const delta = clamp((-2 * (error / 1000)) / seconds, -0.02, 0.02);
      target.rate.cancelScheduledValues(now);
      target.rate.setValueAtTime(rate * (1 + delta), now);
      target.rate.linearRampToValueAtTime(rate, now + seconds);
    } else {
      target.setRate(rate, 0.01);
      if (!target.playing) target.seekSec(Math.max(0, target.positionSec(now) - error / 1000));
    }
    sessionStore.dispatch({ type: "deck/rate", deck, rate, tempoOffsetPct: rateToTempoOffset(rate) });
    return { rate, clamped, phaseErrorMs: error };
  },

  /**
   * Starts this deck on the other deck's next bar 1, sample-accurately, from its own first
   * downbeat at or after the cue point. With `sync`, the tempo is matched first.
   */
  async enterOnNextBar(
    deck: DeckId,
    options: { minLeadBeats?: number; sync?: boolean } = {},
  ): Promise<ScheduledEvent | null> {
    const engine = await ensureEngine();
    const referenceId = otherDeck(deck);
    const reference = deckAnalysis(referenceId);
    const referenceDeck = engine.decks[referenceId];
    const target = engine.decks[deck];
    const source = deckAnalysis(deck);
    if (!reference || !referenceDeck.playing || !target.trackId) return null;
    if (options.sync && source) {
      const { rate } = syncRate(reference.grid.bpm * baseRate(referenceId), source.grid.bpm);
      bend[deck] = 0;
      target.setRate(rate, 0.01);
      sessionStore.dispatch({ type: "deck/rate", deck, rate, tempoOffsetPct: rateToTempoOffset(rate) });
    }
    const now = engine.context.currentTime;
    const referencePosition = referenceDeck.positionSec(now);
    const targetSec = nextDownbeatSec(reference.grid, referencePosition, options.minLeadBeats ?? 4);
    const wait = secondsUntilDeckTime(referencePosition, targetSec, referenceDeck.currentRate);
    const frame = contextFrameAt(now, engine.context.sampleRate, wait);
    target.stop();
    target.seekSec(entrySec(source, target.cueSec));
    target.play(frame);
    scheduledCounter += 1;
    const event: ScheduledEvent = {
      id: `enter-${scheduledCounter}`,
      kind: "enter",
      targetDeck: deck,
      referenceDeck: referenceId,
      atBeatIndex: Math.round(beatPosition(reference.grid, targetSec)),
      atContextFrame: frame,
      label: `${deck} enters on bar 1`,
      cancellable: true,
    };
    sessionStore.dispatch({
      type: "scheduled/set",
      scheduled: [...sessionStore.getState().scheduled.filter((entry) => entry.targetDeck !== deck), event],
    });
    return event;
  },

  /** Starts this deck on a specific bar (0-based) of the other deck, from its own first downbeat. */
  async enterAtBar(
    deck: DeckId,
    bar: number,
    options: { sync?: boolean; label?: string } = {},
  ): Promise<ScheduledEvent | null> {
    const engine = await ensureEngine();
    const referenceId = otherDeck(deck);
    const reference = deckAnalysis(referenceId);
    const referenceDeck = engine.decks[referenceId];
    const target = engine.decks[deck];
    const source = deckAnalysis(deck);
    if (!reference || !referenceDeck.playing || !target.trackId) return null;
    const targetBeat = reference.grid.downbeatOffset + bar * 4;
    const targetSec = secAtBeat(reference.grid, targetBeat);
    const now = engine.context.currentTime;
    const referencePosition = referenceDeck.positionSec(now);
    if (targetSec <= referencePosition + 0.05) return null;
    if (options.sync && source) {
      const { rate } = syncRate(reference.grid.bpm * baseRate(referenceId), source.grid.bpm);
      bend[deck] = 0;
      target.setRate(rate, 0.01);
      sessionStore.dispatch({ type: "deck/rate", deck, rate, tempoOffsetPct: rateToTempoOffset(rate) });
    }
    const wait = secondsUntilDeckTime(referencePosition, targetSec, referenceDeck.currentRate);
    const frame = contextFrameAt(now, engine.context.sampleRate, wait);
    target.stop();
    target.seekSec(entrySec(source, target.cueSec));
    target.play(frame);
    scheduledCounter += 1;
    const event: ScheduledEvent = {
      id: `enter-${scheduledCounter}`,
      kind: "transition",
      targetDeck: deck,
      referenceDeck: referenceId,
      atBeatIndex: Math.round(targetBeat),
      atContextFrame: frame,
      label: options.label ?? `${deck} enters at bar ${bar + 1}`,
      cancellable: true,
    };
    sessionStore.dispatch({
      type: "scheduled/set",
      scheduled: [...sessionStore.getState().scheduled.filter((entry) => entry.targetDeck !== deck), event],
    });
    return event;
  },

  async cancelScheduled(id: string): Promise<void> {
    const engine = await ensureEngine();
    const event = sessionStore.getState().scheduled.find((entry) => entry.id === id);
    if (!event) return;
    engine.decks[event.targetDeck].stop();
    removeScheduled(event.targetDeck);
  },

  /** Beat loop from the playhead; the same length again (or `null`) exits the loop. */
  async setLoopBeats(deck: DeckId, beats: number | null): Promise<void> {
    const engine = await ensureEngine();
    const target = engine.decks[deck];
    const analysis = deckAnalysis(deck);
    const current = sessionStore.getState().decks[deck].loop;
    if (!beats || !analysis || !target.trackId || current?.beats === beats) {
      target.setLoop(null);
      sessionStore.dispatch({ type: "deck/loop", deck, loop: null });
      return;
    }
    const position = target.positionSec();
    // Snap the loop start to the current beat so loops stay on the grid.
    const start = Math.max(
      0,
      position -
        (((beatPosition(analysis.grid, position) % 1) + 1) % 1) * beatPeriodSec(analysis.grid, position),
    );
    const end = start + beats * beatPeriodSec(analysis.grid, start);
    target.setLoop({ startSec: start, endSec: end });
    sessionStore.dispatch({ type: "deck/loop", deck, loop: { startSec: start, endSec: end, beats } });
  },

  /** Hot cue pad: empty → set here; set → jump there (and play if stopped). */
  async triggerHotCue(deck: DeckId, slot: number): Promise<void> {
    const engine = await ensureEngine();
    const target = engine.decks[deck];
    if (!target.trackId || slot < 0 || slot >= HOT_CUE_SLOTS) return;
    const hotCues = [...sessionStore.getState().decks[deck].hotCues];
    const stored = hotCues[slot];
    if (stored === null || stored === undefined) {
      hotCues[slot] = target.positionSec();
      sessionStore.dispatch({ type: "deck/hotCues", deck, hotCues });
      void getLibrary().updateUserData(target.trackId, { hotCues });
      return;
    }
    target.seekSec(stored);
    if (!target.playing) target.play();
    emitGesture({ kind: "cue", deck });
  },

  async clearHotCue(deck: DeckId, slot: number): Promise<void> {
    await ensureEngine();
    const trackId = sessionStore.getState().decks[deck].track?.id;
    if (!trackId) return;
    const hotCues = [...sessionStore.getState().decks[deck].hotCues];
    hotCues[slot] = null;
    sessionStore.dispatch({ type: "deck/hotCues", deck, hotCues });
    void getLibrary().updateUserData(trackId, { hotCues });
  },
};

export const mixerActions = {
  async setStrip(deck: DeckId, key: keyof ChannelStripState, value: number | boolean): Promise<void> {
    const engine = await ensureEngine();
    const strip = engine.mixer.strips[deck];
    switch (key) {
      case "trim":
        strip.setTrim(Number(value));
        break;
      case "eqHigh":
        strip.setEq("high", Number(value));
        break;
      case "eqMid":
        strip.setEq("mid", Number(value));
        break;
      case "eqLow":
        strip.setEq("low", Number(value));
        break;
      case "filter":
        strip.setFilter(Number(value));
        break;
      case "fader":
        strip.setFader(Number(value));
        break;
      case "pfl":
        strip.setPfl(Boolean(value));
        break;
      default:
        return;
    }
    sessionStore.dispatch({ type: "mixer/strip", deck, patch: { [key]: value } });
    recomputeOnAir(engine);
  },

  /** Double-tap on an EQ band: kill it, or restore it to flat. */
  async toggleKill(deck: DeckId, key: "eqHigh" | "eqMid" | "eqLow"): Promise<void> {
    const current = sessionStore.getState().mixer[deck === "A" ? "a" : "b"][key];
    await mixerActions.setStrip(deck, key, current <= EQ_MIN_DB + 0.01 ? 0 : EQ_MIN_DB);
  },

  async setCrossfader(position: number): Promise<void> {
    const engine = await ensureEngine();
    engine.mixer.setCrossfader(position);
    sessionStore.dispatch({ type: "mixer/patch", patch: { crossfader: engine.mixer.crossfader } });
    recomputeOnAir(engine);
  },

  async setCurve(curve: CrossfaderCurve): Promise<void> {
    const engine = await ensureEngine();
    engine.mixer.setCurve(curve);
    sessionStore.dispatch({ type: "mixer/patch", patch: { curve } });
    recomputeOnAir(engine);
  },

  async setMaster(level: number): Promise<void> {
    const engine = await ensureEngine();
    engine.mixer.setMasterLevel(level);
    sessionStore.dispatch({ type: "mixer/patch", patch: { master: level } });
    recomputeOnAir(engine);
  },

  async setCueLevel(level: number): Promise<void> {
    const engine = await ensureEngine();
    engine.mixer.setCueLevel(level);
    sessionStore.dispatch({ type: "mixer/patch", patch: { cueLevel: level } });
  },

  async setCueBlend(value: number): Promise<void> {
    const engine = await ensureEngine();
    engine.mixer.setCueBlend(value);
    sessionStore.dispatch({ type: "mixer/patch", patch: { cueBlend: value } });
  },
};

/** CUE preview: plays a library track into the CUE bus without touching the decks. */
export const previewActions = {
  async toggle(trackId: string): Promise<void> {
    const engine = await ensureEngine();
    if (libraryStore.getState().previewId === trackId) {
      engine.preview.stop();
      libraryStore.dispatch({ type: "library/preview", id: null });
      return;
    }
    const library = getLibrary();
    library.setSampleRate(engine.context.sampleRate);
    libraryStore.dispatch({ type: "library/preview", id: trackId });
    const loaded = await library.prepareForDeck(trackId);
    if (libraryStore.getState().previewId !== trackId) return;
    engine.preview.stop();
    engine.preview.load(loaded.channels, loaded.sampleRate, trackId);
    const seconds = (loaded.channels[0]?.length ?? 0) / loaded.sampleRate;
    engine.preview.seekSec(Math.min(seconds * 0.25, 45));
    engine.preview.play();
  },

  async stop(): Promise<void> {
    const engine = getEngine();
    engine?.preview.stop();
    libraryStore.dispatch({ type: "library/preview", id: null });
  },
};

export const samplerActions = {
  async load(slot: number, blob: Blob, name: string): Promise<void> {
    const engine = await ensureEngine();
    await engine.sampler.load(slot, blob, name);
  },

  async trigger(slot: number): Promise<boolean> {
    const engine = await ensureEngine();
    return engine.sampler.trigger(slot);
  },

  async stop(slot: number): Promise<void> {
    const engine = await ensureEngine();
    engine.sampler.stop(slot);
  },
};

/** Short test tone on the master or the CUE bus (Audio Setup). */
export async function playTestTone(target: "master" | "cue", hz = 440, seconds = 0.4): Promise<void> {
  const engine = await ensureEngine();
  const context = engine.context;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = hz;
  gain.gain.value = 0;
  const now = context.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  oscillator.connect(gain);
  gain.connect(target === "cue" ? engine.mixer.cueBus : engine.mixer.master);
  oscillator.start(now);
  oscillator.stop(now + seconds + 0.05);
}

export function engineReady(): boolean {
  return getEngine()?.state === "running";
}
