/**
 * What agents may see: no file paths, no URLs, no audio, no waveform bytes. Titles and artists
 * come from file tags, so tools that return them set `untrustedContentHint`.
 */
import type { DeckState, Section, Session, TrackAnalysis } from "../state/session";

export interface AnalysisSummary {
  bpm: number;
  gridKind: "constant" | "list";
  gridConfidence: number;
  downbeatConfirmed: boolean;
  key: { camelot: string; name: string; confidence: number };
  integratedLufs: number;
  gainSuggestionDb: number;
  energyPerBar: number[];
  sections: Section[];
  bars: number;
}

export function summariseAnalysis(analysis: TrackAnalysis): AnalysisSummary {
  const energy = Array.from(analysis.energyPerBar).map((value) => Math.round(value * 100) / 100);
  return {
    bpm: analysis.grid.bpm,
    gridKind: analysis.grid.kind,
    gridConfidence: Math.round(analysis.grid.confidence * 100) / 100,
    downbeatConfirmed: analysis.grid.downbeatConfirmed,
    key: analysis.key,
    integratedLufs: Math.round(analysis.loudness.integratedLufs * 10) / 10,
    gainSuggestionDb: Math.round(analysis.loudness.gainSuggestionDb * 10) / 10,
    energyPerBar: energy,
    sections: analysis.sections,
    bars: energy.length,
  };
}

export interface RedactedDeck {
  id: DeckState["id"];
  track: { id: string; title: string; artist: string; durationSec: number } | null;
  analysis: AnalysisSummary | null;
  playing: boolean;
  onAir: boolean;
  rate: number;
  tempoOffsetPct: number;
  cueSec: number;
  loop: DeckState["loop"];
  hotCues: (number | null)[];
}

export interface RedactedSession {
  mode: Session["mode"];
  autonomy: Session["autonomy"];
  engine: Session["engine"];
  decks: Record<"A" | "B", RedactedDeck>;
  mixer: Session["mixer"];
  routing: {
    mode: Session["routing"]["mode"];
    configured: boolean;
    cueConnected: boolean;
    latencyMs: Session["routing"]["latencyMs"];
  };
  queue: string[];
  scheduled: Session["scheduled"];
  proposals: Session["proposals"];
  agent: Session["agent"];
  visuals: Session["visuals"];
  privacy: Session["privacy"];
}

function redactDeck(deck: DeckState): RedactedDeck {
  return {
    id: deck.id,
    track: deck.track
      ? {
          id: deck.track.id,
          title: deck.track.title,
          artist: deck.track.artist,
          durationSec: deck.track.durationSec,
        }
      : null,
    analysis: deck.analysis ? summariseAnalysis(deck.analysis) : null,
    playing: deck.playing,
    onAir: deck.onAir,
    rate: deck.rate,
    tempoOffsetPct: deck.tempoOffsetPct,
    cueSec: deck.cueSec,
    loop: deck.loop,
    hotCues: deck.hotCues,
  };
}

export function redactSession(session: Session): RedactedSession {
  return {
    mode: session.mode,
    autonomy: session.autonomy,
    engine: session.engine,
    decks: { A: redactDeck(session.decks.A), B: redactDeck(session.decks.B) },
    mixer: session.mixer,
    routing: {
      mode: session.routing.mode,
      configured: session.routing.configured,
      cueConnected: session.routing.cueConnected,
      latencyMs: session.routing.latencyMs,
    },
    queue: session.queue,
    scheduled: session.scheduled,
    proposals: session.proposals,
    agent: session.agent,
    visuals: session.visuals,
    privacy: session.privacy,
  };
}
