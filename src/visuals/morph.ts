/**
 * When the galaxy writes a word. The message assembles on a phrase boundary over one bar, holds,
 * and is released — by the next drop, by eight bars passing in "hold", or the moment the DJ turns
 * it off. Pure and unit-tested; the shape itself is sampled in `gpu/targets.ts`.
 *
 * "auto" writes the title of whatever went on air, so a track announces itself in particles.
 */

import type { MorphSettings } from "./protocol";

export type { MorphMode } from "./protocol";

import { packTargets, targetsFor } from "./gpu/targets";
import type { MorphMode } from "./protocol";

export type MorphPhase = "idle" | "armed" | "assembling" | "holding" | "releasing";

export interface MorphState {
  phase: MorphPhase;
  /** 0 (the galaxy is itself) … 1 (fully assembled into the shape). */
  amount: number;
  /** Bars spent holding the shape. */
  heldBars: number;
  /** Phrase index the state machine last acted on. */
  phrase: number;
}

export interface MorphInput {
  mode: MorphMode;
  /** True when there is a shape to assemble at all. */
  hasText: boolean;
  /** True on the frame a new message arrived (a new title, or the DJ pressed Show). */
  requested: boolean;
  phraseIndex: number;
  barIndex: number;
  /** True on the frame a drop landed: the message explodes with the field. */
  drop: boolean;
  reduced: boolean;
}

/** Bars the shape takes to assemble, and how long "hold" keeps it before letting go. */
export const MORPH_ASSEMBLE_BARS = 1;
export const MORPH_HOLD_BARS = 8;

export const initialMorph = (): MorphState => ({ phase: "idle", amount: 0, heldBars: 0, phrase: -1 });

/** Advances the machine by `barsElapsed` bars of music (0 when the grid is unknown). */
export function stepMorph(state: MorphState, input: MorphInput, barsElapsed: number): MorphState {
  const bars = Math.max(0, barsElapsed);
  const release = (phase: MorphPhase = "releasing"): MorphState => ({
    phase: state.amount <= 0 ? "idle" : phase,
    // Reduced motion dissolves; otherwise the spring lets go and the field takes over.
    amount: Math.max(0, state.amount - bars / (input.reduced ? 1 : 0.5)),
    heldBars: 0,
    phrase: state.phrase,
  });

  if (input.mode === "off" || !input.hasText) return release();
  if (input.drop) return release();

  if (input.requested) return { phase: "armed", amount: state.amount, heldBars: 0, phrase: -1 };

  switch (state.phase) {
    case "idle":
      return state.amount > 0 ? release() : state;
    case "armed":
      // Wait for the next phrase: a message that lands mid-phrase reads as a glitch.
      if (state.phrase === -1) return { ...state, phrase: input.phraseIndex };
      if (input.phraseIndex === state.phrase) return state;
      return { phase: "assembling", amount: state.amount, heldBars: 0, phrase: input.phraseIndex };
    case "assembling": {
      const amount = Math.min(1, state.amount + bars / MORPH_ASSEMBLE_BARS);
      return amount >= 1
        ? { phase: "holding", amount: 1, heldBars: 0, phrase: state.phrase }
        : { ...state, amount };
    }
    case "holding": {
      const heldBars = state.heldBars + bars;
      // "hold" lets go after eight bars at the next phrase; "auto" waits for the next track.
      if (input.mode === "hold" && heldBars >= MORPH_HOLD_BARS && input.phraseIndex !== state.phrase)
        return { phase: "releasing", amount: 1, heldBars: 0, phrase: state.phrase };
      return { ...state, heldBars };
    }
    case "releasing":
      return release();
    default:
      return state;
  }
}

/**
 * Drives the state machine from the Stage's own settings and the track on air, and rasterises the
 * shape when the message changes. The GPU side reads `takeTargets()` once per new message.
 */
export class MorphController {
  private state = initialMorph();
  private text = "";
  private points: Float32Array | null = null;
  private count = 0;
  private pending = false;

  /** Advances one rendered frame and returns how assembled the message is (0 … 1). */
  step(
    settings: MorphSettings,
    nowPlayingTitle: string,
    intent: {
      beat: { bpm: number; phraseIndex: number; barIndex: number };
      reducedMotion: boolean;
    },
    dt: number,
    drop: boolean,
  ): number {
    // "auto" writes whatever is on air; the other modes write what the DJ typed.
    const wanted = settings.mode === "auto" ? nowPlayingTitle.trim().slice(0, 24) : settings.text.trim();
    let requested = false;
    if (wanted !== this.text) {
      this.text = wanted;
      const points = wanted ? targetsFor(wanted) : [];
      this.count = points.length;
      this.points = this.count ? packTargets(points) : null;
      this.pending = true;
      requested = this.count > 0 && settings.mode !== "off";
    }
    const bars = intent.beat.bpm > 0 ? (dt * intent.beat.bpm) / 60 / 4 : 0;
    this.state = stepMorph(
      this.state,
      {
        mode: settings.mode,
        hasText: this.count > 0,
        requested,
        phraseIndex: intent.beat.phraseIndex,
        barIndex: intent.beat.barIndex,
        drop,
        reduced: intent.reducedMotion,
      },
      bars,
    );
    return this.state.amount;
  }

  /** The packed target buffer when a new message needs uploading, else null. */
  takeTargets(): { points: Float32Array | null; count: number } | null {
    if (!this.pending) return null;
    this.pending = false;
    return { points: this.points, count: this.count };
  }

  /** Show or release the current message by hand (the studio's M key). */
  toggle(settings: MorphSettings): MorphMode {
    return settings.mode === "off" ? "hold" : "off";
  }

  get phase(): MorphPhase {
    return this.state.phase;
  }
}
