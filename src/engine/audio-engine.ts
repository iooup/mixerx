import type { DeckId } from "../state/session";
import { Deck } from "./deck";
import {
  FEATURE_FRAME_LENGTH,
  type FeatureCommand,
  type LimiterReport,
  type MeterLevels,
  type MeterReport,
} from "./messages";
import { MixerGraph } from "./mixer-graph";
import { Routing } from "./routing";
import { Sampler } from "./sampler";
import deckProcessorUrl from "./worklets/deck-processor.ts?worker&url";
import limiterProcessorUrl from "./worklets/limiter-processor.ts?worker&url";
import tapProcessorUrl from "./worklets/tap-processor.ts?worker&url";

export const FEATURE_BLOCK_SIZE = 512;

export interface EngineDeckFrame {
  trackId: string | null;
  positionSec: number;
  durationSec: number;
  playing: boolean;
  rate: number;
}

export interface EngineMeters {
  master: MeterLevels;
  a: MeterLevels;
  b: MeterLevels;
  cue: MeterLevels;
  limiterReduction: number;
}

export interface EngineFrame {
  time: number;
  decks: Record<DeckId, EngineDeckFrame>;
  preview: EngineDeckFrame;
  meters: EngineMeters;
  features: Float32Array;
}

const SILENT: MeterLevels = { peak: 0, rms: 0 };

/** Loads the worklet modules into any (online or offline) context. */
export async function loadWorklets(context: BaseAudioContext): Promise<void> {
  await Promise.all([
    context.audioWorklet.addModule(deckProcessorUrl),
    context.audioWorklet.addModule(limiterProcessorUrl),
    context.audioWorklet.addModule(tapProcessorUrl),
  ]);
}

export class AudioEngine {
  readonly decks: Record<DeckId, Deck>;
  readonly preview: Deck;
  readonly mixer: MixerGraph;
  readonly routing: Routing;
  readonly sampler: Sampler;
  private meters: EngineMeters = { master: SILENT, a: SILENT, b: SILENT, cue: SILENT, limiterReduction: 0 };
  private features: Float32Array = new Float32Array(FEATURE_FRAME_LENGTH);
  private featureWorker: Worker | null = null;
  private readonly featureListeners = new Set<(features: Float32Array) => void>();
  private disposed = false;

  private constructor(
    readonly context: AudioContext,
    mixer: MixerGraph,
    decks: Record<DeckId, Deck>,
    preview: Deck,
    routing: Routing,
  ) {
    this.mixer = mixer;
    this.decks = decks;
    this.preview = preview;
    this.routing = routing;
    this.sampler = new Sampler(context, mixer.master);
    mixer.tap.port.onmessage = (event: MessageEvent<MeterReport>) => {
      if (event.data?.type === "meters") {
        this.meters = {
          ...this.meters,
          master: event.data.master,
          a: event.data.a,
          b: event.data.b,
          cue: event.data.cue,
        };
      }
    };
    if (mixer.limiter) {
      mixer.limiter.port.onmessage = (event: MessageEvent<LimiterReport>) => {
        if (event.data?.type === "limiter")
          this.meters = { ...this.meters, limiterReduction: event.data.reduction };
      };
    }
  }

  static async create(): Promise<AudioEngine> {
    const context = new AudioContext({ latencyHint: "interactive" });
    await loadWorklets(context);
    const mixer = new MixerGraph(context);
    const decks: Record<DeckId, Deck> = { A: new Deck(context, "A"), B: new Deck(context, "B") };
    decks.A.node.connect(mixer.strips.A.input);
    decks.B.node.connect(mixer.strips.B.input);
    const preview = new Deck(context, "preview");
    preview.node.connect(mixer.cueBus);
    const routing = new Routing(context, mixer.masterOut, mixer.cueOut);
    const engine = new AudioEngine(context, mixer, decks, preview, routing);
    engine.startFeatureWorker();
    return engine;
  }

  private startFeatureWorker(): void {
    if (typeof Worker === "undefined" || typeof MessageChannel === "undefined") return;
    try {
      const worker = new Worker(new URL("../analysis/feature-worker.ts", import.meta.url), {
        type: "module",
      });
      const channel = new MessageChannel();
      this.mixer.tap.port.postMessage({ type: "feature-port", port: channel.port1 }, [channel.port1]);
      const config: FeatureCommand = {
        type: "config",
        sampleRate: this.context.sampleRate,
        blockSize: FEATURE_BLOCK_SIZE,
        port: channel.port2,
      };
      worker.postMessage(config, [channel.port2]);
      worker.onmessage = (event: MessageEvent<Float32Array>) => {
        if (event.data instanceof Float32Array && event.data.length === FEATURE_FRAME_LENGTH) {
          this.features = event.data;
          for (const listener of this.featureListeners) listener(event.data);
        }
      };
      this.featureWorker = worker;
    } catch {
      this.featureWorker = null;
    }
  }

  /**
   * Called on the main thread for every feature block (~86 Hz). Worker messages keep arriving
   * while the tab is hidden, unlike requestAnimationFrame, so the Stage publisher ticks on them.
   */
  onFeatures(listener: (features: Float32Array) => void): () => void {
    this.featureListeners.add(listener);
    return () => {
      this.featureListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
  }

  async suspend(): Promise<void> {
    if (this.context.state === "running") await this.context.suspend();
  }

  get state(): AudioContextState {
    return this.context.state;
  }

  latencyMs(): number {
    return Math.round((this.context.baseLatency + (this.context.outputLatency || 0)) * 10000) / 10;
  }

  deckFrame(deck: Deck, now: number): EngineDeckFrame {
    return {
      trackId: deck.trackId,
      positionSec: deck.positionSec(now),
      durationSec: deck.durationSec,
      playing: deck.playing,
      rate: deck.currentRate,
    };
  }

  frame(): EngineFrame {
    const now = this.context.currentTime;
    return {
      time: now,
      decks: { A: this.deckFrame(this.decks.A, now), B: this.deckFrame(this.decks.B, now) },
      preview: this.deckFrame(this.preview, now),
      meters: this.meters,
      features: this.features,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.featureWorker?.terminate();
    this.featureWorker = null;
    this.routing.dispose();
    void this.context.close().catch(() => {});
  }
}
