/**
 * Compatibility of a library track with the on-air deck:
 * key-wheel distance, tempo delta, and energy delta, folded into one 0..1 score.
 */

export interface CamelotKey {
  number: number; // 1..12
  mode: "A" | "B";
}

export function parseCamelot(value: string | undefined): CamelotKey | null {
  const match = /^(\d{1,2})([AB])$/i.exec((value ?? "").trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (number < 1 || number > 12) return null;
  return { number, mode: match[2]?.toUpperCase() === "A" ? "A" : "B" };
}

/** Steps around the Camelot wheel: 0 same key, 1 neighbour or relative, 2+ further. */
export function camelotDistance(left: CamelotKey, right: CamelotKey): number {
  const around = Math.abs(left.number - right.number);
  const wheel = Math.min(around, 12 - around);
  return wheel + (left.mode === right.mode ? 0 : 1);
}

export type KeyRelation = "same" | "relative" | "neighbour" | "energy-boost" | "clash";

export function keyRelation(left: CamelotKey, right: CamelotKey): KeyRelation {
  const around = Math.abs(left.number - right.number);
  const wheel = Math.min(around, 12 - around);
  if (wheel === 0 && left.mode === right.mode) return "same";
  if (wheel === 0) return "relative";
  if (wheel === 1 && left.mode === right.mode) return "neighbour";
  if (wheel === 2 && left.mode === right.mode) return "energy-boost";
  return "clash";
}

export function tempoDeltaPct(fromBpm: number, toBpm: number): number {
  if (!(fromBpm > 0) || !(toBpm > 0)) return Number.NaN;
  // Compare in the nearest octave so 70 vs 140 counts as a doubled tempo, not a 100 % jump.
  let candidate = toBpm;
  while (candidate / fromBpm > 1.5) candidate /= 2;
  while (candidate / fromBpm < 0.667) candidate *= 2;
  return ((candidate - fromBpm) / fromBpm) * 100;
}

export interface Compatibility {
  score: number; // 0..1
  key: KeyRelation | null;
  tempoDeltaPct: number | null;
  energyDelta: number | null;
}

export interface CompatibilityInput {
  camelot?: string;
  bpm?: number;
  energy?: number;
}

export function compatibility(candidate: CompatibilityInput, reference: CompatibilityInput): Compatibility {
  const left = parseCamelot(candidate.camelot);
  const right = parseCamelot(reference.camelot);
  const key = left && right ? keyRelation(left, right) : null;
  const tempo =
    candidate.bpm && reference.bpm ? Math.round(tempoDeltaPct(reference.bpm, candidate.bpm) * 10) / 10 : null;
  const energy =
    candidate.energy !== undefined && reference.energy !== undefined
      ? candidate.energy - reference.energy
      : null;

  let score = 0.5;
  if (key)
    score +=
      key === "same"
        ? 0.3
        : key === "relative" || key === "neighbour"
          ? 0.25
          : key === "energy-boost"
            ? 0.1
            : -0.3;
  if (tempo !== null) score += Math.abs(tempo) <= 2 ? 0.2 : Math.abs(tempo) <= 6 ? 0.1 : -0.3;
  if (energy !== null) score += Math.abs(energy) <= 1 ? 0.05 : Math.abs(energy) >= 4 ? -0.1 : 0;
  return { score: Math.max(0, Math.min(1, score)), key, tempoDeltaPct: tempo, energyDelta: energy };
}

/** Hue for a Camelot key on the wheel (12 hues, relative keys share one). */
export function camelotHue(value: string | undefined): number | null {
  const key = parseCamelot(value);
  return key ? ((key.number - 1) * 30) % 360 : null;
}
