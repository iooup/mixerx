import { type CrowdLayout, type CrowdStyle, PET_IDS, type PetId } from "./characters";
import { type DancerSeed, makeCrowd } from "./crowd-math";

export interface PetPlacement {
  seed: DancerSeed;
  character: PetId;
  x: number;
  ground: number;
  size: number;
}

export const PET_STAGE_HEIGHT = 900;
const ROW_STEP = 120;

/** Fit complete rows into the actual output, reserving room for hops and side steps. */
export function petFormation(
  character: Exclude<CrowdStyle, "classic">,
  layout: CrowdLayout,
  aspect: number,
): PetPlacement[] {
  const width = PET_STAGE_HEIGHT * Math.max(0.2, aspect);
  const columns = Math.min(
    layout.count,
    Math.max(3, Math.min(11, Math.ceil(Math.sqrt(layout.count * aspect * 2)))),
  );
  const rows = Math.ceil(layout.count / columns);
  const step = 160 * layout.size * layout.spacing;
  const fit = Math.min(
    1,
    (width - 30) / ((columns - 1) * step + 320 * layout.size),
    430 / ((240 + (rows - 1) * ROW_STEP) * layout.size),
  );
  const dancers = makeCrowd(layout.count);
  const result: PetPlacement[] = [];
  let id = 0;
  for (let row = 0; row < rows; row++) {
    const inRow = Math.min(columns, layout.count - id);
    // Assign the leader first, near the centre; changing count never changes a dancer's identity.
    const slots = Array.from({ length: inRow }, (_, col) => col - (inRow - 1) / 2).sort(
      (a, b) => Math.abs(a) - Math.abs(b),
    );
    for (const slot of slots) {
      const seed = dancers[id] as DancerSeed;
      const half = (inRow - 1) / 2;
      const stagger = row % 2 && half > 0 ? 0.5 : 0;
      const rowSlot = stagger ? ((slot + stagger) * half) / (half + stagger) : slot;
      result.push({
        seed: { ...seed, depth: row / Math.max(1, rows), slot: 0.5 + (rowSlot * step * fit) / width },
        character: character === "mixed" ? (PET_IDS[id % PET_IDS.length] as PetId) : character,
        x: width / 2 + rowSlot * step * fit,
        ground: 835 - row * ROW_STEP * layout.size * fit,
        size: layout.size * fit * (id === 0 ? 1.22 : 0.85 + seed.swing * 0.12),
      });
      id++;
    }
  }
  return result.sort((a, b) => b.seed.depth - a.seed.depth);
}
