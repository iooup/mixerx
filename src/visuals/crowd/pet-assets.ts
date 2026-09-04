import codex from "./assets/codex.webp";
import dario from "./assets/dario.webp";
import fireball from "./assets/fireball.webp";
import hoots from "./assets/hoots.webp";
import type { PetId } from "./characters";

/** Local Stage atlases: five original animation rows, eight cells per row. */
export const PET_ASSETS: Record<PetId, string> = { codex, fireball, hoots, dario };
export const PET_CELL = { width: 96, height: 104 } as const;
