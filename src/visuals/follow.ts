/**
 * "Follow sections": the scene chosen from the on-air section and energy. The first look is the
 * one `propose-scene` names; each section change rotates to the next look that suits the section,
 * so a set does not show the same five pictures forever. The console applies it so all windows
 * and `get-session` agree; a standalone demo Stage applies it locally.
 */
import { type SceneCategory, sceneFor, scenesFor } from "../agent/scenes";
import type { StageSection } from "./protocol";

export function followScene(
  section: StageSection,
  energy01: number,
  variant = 0,
  category: SceneCategory = "classic",
): string | null {
  if (section === "none") return null;
  const energy = Math.round(Math.min(1, Math.max(0, energy01)) * 10);
  const candidates = scenesFor(section, energy, category);
  if (!candidates.length) return sceneFor(section, energy, category).id;
  return (
    (candidates[((variant % candidates.length) + candidates.length) % candidates.length] ?? candidates[0])
      ?.id ?? null
  );
}
