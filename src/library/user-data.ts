import type { TrackAnalysis } from "../state/session";
import type { TrackUserData } from "./db";

export const HOT_CUE_SLOTS = 8;

export function normaliseHotCues(value: unknown): (number | null)[] {
  const out = new Array<number | null>(HOT_CUE_SLOTS).fill(null);
  if (Array.isArray(value)) {
    value.slice(0, HOT_CUE_SLOTS).forEach((entry, index) => {
      out[index] = typeof entry === "number" && Number.isFinite(entry) ? entry : null;
    });
  }
  return out;
}

/** Applies the user's grid decisions (downbeat, nudge, tempo override) on top of the analysis. */
export function applyUserData(
  analysis: TrackAnalysis,
  data: TrackUserData | null | undefined,
): TrackAnalysis {
  if (!data) return analysis;
  const grid = { ...analysis.grid };
  let changed = false;
  if (data.downbeatOffset !== undefined && data.downbeatOffset !== grid.downbeatOffset) {
    grid.downbeatOffset = data.downbeatOffset;
    changed = true;
  }
  if (data.downbeatConfirmed !== undefined && data.downbeatConfirmed !== grid.downbeatConfirmed) {
    grid.downbeatConfirmed = data.downbeatConfirmed;
    changed = true;
  }
  if (data.gridOffsetMs) {
    const shift = data.gridOffsetMs / 1000;
    grid.firstBeatSec += shift;
    if (grid.beatsSec) grid.beatsSec = grid.beatsSec.map((sec) => sec + shift);
    changed = true;
  }
  if (data.bpmOverride && data.bpmOverride > 0 && grid.kind === "constant" && data.bpmOverride !== grid.bpm) {
    grid.bpm = data.bpmOverride;
    changed = true;
  }
  return changed ? { ...analysis, grid } : analysis;
}
