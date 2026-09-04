/**
 * Deterministic planners used by the local agent and the tools: a phrase-aligned transition
 * plan between two analysed decks, and a set order that follows an energy arc.
 */
import { beatPosition } from "../engine/beat-math";
import { compatibility, keyRelation, parseCamelot, tempoDeltaPct } from "../library/compatibility";
import type { DeckId, Section, TrackAnalysis, TransitionPlan } from "../state/session";

const PHRASE_BARS = 8;

export interface TransitionInput {
  from: DeckId;
  to: DeckId;
  fromAnalysis: TrackAnalysis;
  toAnalysis: TrackAnalysis;
  fromPositionSec: number;
  toCueSec: number;
  minLeadBars?: number;
  maxLeadBars?: number;
}

function sectionAtBar(sections: Section[], bar: number): { section: Section; index: number } | null {
  const index = sections.findIndex((section) => bar >= section.startBar && bar < section.endBar);
  const section = sections[index];
  return section ? { section, index } : null;
}

function introBars(analysis: TrackAnalysis): number {
  const first = analysis.sections[0];
  if (!first) return 16;
  return Math.max(4, first.endBar - first.startBar);
}

export function planTransition(input: TransitionInput): TransitionPlan {
  const { fromAnalysis, toAnalysis } = input;
  const grid = fromAnalysis.grid;
  const minLead = input.minLeadBars ?? 4;
  const maxLead = input.maxLeadBars ?? 32;
  const currentBar = (beatPosition(grid, input.fromPositionSec) - grid.downbeatOffset) / 4;
  const reasons: string[] = [];

  // Entry: the next section boundary on A within reach, else the next phrase boundary.
  const nextPhrase = Math.ceil((currentBar + minLead) / PHRASE_BARS) * PHRASE_BARS;
  let entryBar = nextPhrase;
  const here = sectionAtBar(fromAnalysis.sections, Math.floor(currentBar));
  if (here) {
    const boundary = here.section.endBar;
    if (boundary - currentBar >= minLead && boundary - currentBar <= maxLead) {
      entryBar = boundary;
      const next = fromAnalysis.sections[here.index + 1];
      reasons.push(
        `A: ${here.section.kind} ends in ${Math.ceil(boundary - currentBar)} bars${next ? ` → ${next.kind}` : ""}`,
      );
    } else {
      reasons.push(`entry at bar ${entryBar + 1} (next phrase boundary)`);
    }
  } else {
    reasons.push(`entry at bar ${entryBar + 1} (next phrase boundary)`);
  }

  const intro = introBars(toAnalysis);
  const lengthBars: TransitionPlan["lengthBars"] = intro >= 32 ? 32 : intro >= 16 ? 16 : 8;
  reasons.push(`B ${toAnalysis.sections[0]?.kind ?? "intro"} = ${intro} bars → blend ${lengthBars}`);

  const left = parseCamelot(toAnalysis.key.camelot);
  const right = parseCamelot(fromAnalysis.key.camelot);
  if (left && right)
    reasons.push(`key ${fromAnalysis.key.camelot}→${toAnalysis.key.camelot} (${keyRelation(left, right)})`);
  const tempo = tempoDeltaPct(fromAnalysis.grid.bpm, toAnalysis.grid.bpm);
  if (Number.isFinite(tempo)) reasons.push(`tempo ${tempo > 0 ? "+" : ""}${tempo.toFixed(1)} %`);
  const energyA = averageEnergy(fromAnalysis);
  const energyB = averageEnergy(toAnalysis);
  reasons.push(`energy ${energyA}→${energyB}`);

  const half = entryBar + lengthBars / 2;
  return {
    fromDeck: input.from,
    toDeck: input.to,
    entryBarOnFrom: entryBar,
    startCueSecOnTo: input.toCueSec,
    lengthBars,
    faderCurve: "equal-power",
    eqMoves: [
      { atBar: entryBar, deck: input.to, band: "low", toDb: -26 },
      { atBar: half, deck: input.from, band: "low", toDb: -26 },
      { atBar: half, deck: input.to, band: "low", toDb: 0 },
    ],
    reasons,
  };
}

export function averageEnergy(analysis: TrackAnalysis): number {
  const values = Array.from(analysis.energyPerBar);
  if (!values.length) return 5;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.max(1, Math.min(10, Math.round(mean * 10)));
}

export interface SetCandidate {
  id: string;
  title?: string;
  energy?: number;
  bpm?: number;
  camelot?: string;
}

export type SetTarget = "rise" | "peak" | "release";

/** Target energy (1..10) at a normalised position for each arc shape. */
export function arcTarget(position: number, target: SetTarget, low: number, high: number): number {
  const span = high - low;
  if (target === "rise") return low + span * position;
  if (target === "release") return high - span * position;
  const shape = position <= 0.7 ? position / 0.7 : 1 - ((position - 0.7) / 0.3) * 0.4;
  return low + span * shape;
}

export function planSet(
  candidates: SetCandidate[],
  target: SetTarget = "peak",
): { order: string[]; reasons: string[] } {
  if (candidates.length <= 1) return { order: candidates.map((candidate) => candidate.id), reasons: [] };
  const energies = candidates.map((candidate) => candidate.energy ?? 5);
  const low = Math.min(...energies);
  const high = Math.max(...energies);
  const remaining = [...candidates];
  const order: SetCandidate[] = [];
  const reasons: string[] = [];
  for (let position = 0; position < candidates.length; position += 1) {
    const wanted = arcTarget(position / (candidates.length - 1), target, low, high);
    const previous = order[order.length - 1];
    let best: { candidate: SetCandidate; cost: number; fit: number } | null = null;
    for (const candidate of remaining) {
      const energyCost = Math.abs((candidate.energy ?? 5) - wanted);
      const fit = previous ? compatibility(candidate, previous).score : 0.5;
      const cost = energyCost + (1 - fit) * 2;
      if (!best || cost < best.cost) best = { candidate, cost, fit };
    }
    if (!best) break;
    order.push(best.candidate);
    remaining.splice(remaining.indexOf(best.candidate), 1);
    reasons.push(
      `${position + 1}. ${best.candidate.title ?? best.candidate.id}: energy ${best.candidate.energy ?? "?"} for target ${wanted.toFixed(1)}${previous ? `, fit ${Math.round(best.fit * 100)} %` : ""}`,
    );
  }
  return { order: order.map((candidate) => candidate.id), reasons };
}
