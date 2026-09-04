/**
 * Scene catalogue shared by the Stage and agent tools. Keep ids stable for saved settings
 * and proposals. Each look combines a renderer and Director preset; crowd overlays are
 * independent layers, not scenes.
 */
import type { SectionKind } from "../state/session";

export type SceneRenderer =
  | "terrain"
  | "rig"
  | "field"
  | "ink"
  | "monolith"
  | "waves"
  | "cubes"
  | "backdrop"
  | "line-waves"
  | "line-orbits"
  | "line-ribbons"
  | "line-lattice"
  | "cinematic-phoenix"
  | "cinematic-gate"
  | "cinematic-lotus"
  | "cinematic-crystal"
  | "none";
export type SceneLayer = "face";
export type SceneCategory = "classic" | "simple" | "cinematic";

export interface SceneInfo {
  id: string;
  /** Proper name of the look (not translated). */
  title: string;
  renderer: SceneRenderer;
  category: SceneCategory;
  /** DOM layer drawn over the renderer (SVG), for looks that are not shader work. */
  layer?: SceneLayer;
  sections: SectionKind[];
  minEnergy: number; // 1..10
}

export const SCENES: SceneInfo[] = [
  {
    id: "intro-lines",
    title: "FFT Ocean",
    renderer: "terrain",
    category: "classic",
    sections: ["intro", "outro"],
    minEnergy: 1,
  },
  {
    id: "build-rise",
    title: "Light Rig",
    renderer: "rig",
    category: "classic",
    sections: ["build"],
    minEnergy: 3,
  },
  {
    id: "drop-burst",
    title: "Kick Field",
    renderer: "field",
    category: "classic",
    sections: ["drop"],
    minEnergy: 7,
  },
  {
    id: "break-haze",
    title: "Ink Feedback",
    renderer: "ink",
    category: "classic",
    sections: ["break"],
    minEnergy: 1,
  },
  {
    id: "body-pulse",
    title: "Monolith",
    renderer: "monolith",
    category: "classic",
    sections: ["body"],
    minEnergy: 4,
  },
  {
    id: "cubes",
    title: "Cube Dance",
    renderer: "cubes",
    category: "classic",
    sections: ["build", "body", "drop"],
    minEnergy: 3,
  },
  {
    id: "face",
    title: "Face",
    renderer: "backdrop",
    category: "classic",
    layer: "face",
    sections: ["body", "drop"],
    minEnergy: 4,
  },
  { id: "blackout", title: "Blackout", renderer: "none", category: "classic", sections: [], minEnergy: 1 },
  {
    id: "line-waves",
    title: "Waves",
    renderer: "line-waves",
    category: "simple",
    sections: ["intro", "body", "outro"],
    minEnergy: 1,
  },
  {
    id: "line-orbits",
    title: "Orbits",
    renderer: "line-orbits",
    category: "simple",
    sections: ["intro", "break", "outro"],
    minEnergy: 1,
  },
  {
    id: "line-ribbons",
    title: "Ribbons",
    renderer: "line-ribbons",
    category: "simple",
    sections: ["build", "body", "drop"],
    minEnergy: 1,
  },
  {
    id: "line-lattice",
    title: "Lattice",
    renderer: "line-lattice",
    category: "simple",
    sections: ["build", "body", "drop"],
    minEnergy: 1,
  },
  {
    id: "cinematic-phoenix",
    title: "Night Phoenix",
    renderer: "cinematic-phoenix",
    category: "cinematic",
    sections: ["intro", "build", "body"],
    minEnergy: 1,
  },
  {
    id: "cinematic-gate",
    title: "Spectral Gate",
    renderer: "cinematic-gate",
    category: "cinematic",
    sections: ["build", "body", "drop"],
    minEnergy: 1,
  },
  {
    id: "cinematic-lotus",
    title: "Astral Lotus",
    renderer: "cinematic-lotus",
    category: "cinematic",
    sections: ["intro", "break", "outro"],
    minEnergy: 1,
  },
  {
    id: "cinematic-crystal",
    title: "Crystal Voyage",
    renderer: "cinematic-crystal",
    category: "cinematic",
    sections: ["build", "body", "drop"],
    minEnergy: 1,
  },
];

export const sceneCategory = (id: string): SceneCategory => sceneById(id)?.category ?? "classic";
export const scenesInCategory = (category: SceneCategory): SceneInfo[] =>
  SCENES.filter((scene) => scene.category === category);

/** Blackout and unknown ids never participate in a blend. */
export function canBlendScenes(from: string, to: string): boolean {
  const a = sceneById(from);
  const b = sceneById(to);
  return !!a && !!b && a.renderer !== "none" && b.renderer !== "none" && a.category === b.category;
}

/** Every look that suits a section at this energy, in catalogue order (the follow rule rotates through them). */
export function scenesFor(
  section: SectionKind | null,
  energy: number,
  category: SceneCategory = "classic",
): SceneInfo[] {
  return scenesInCategory(category).filter(
    (scene) => section && scene.sections.includes(section) && energy >= scene.minEnergy,
  );
}

export const sceneById = (id: string): SceneInfo | undefined => SCENES.find((scene) => scene.id === id);

export function sceneFor(
  section: SectionKind | null,
  energy: number,
  category: SceneCategory = "classic",
): SceneInfo {
  const bySection = scenesFor(section, energy, category)[0];
  if (bySection) return bySection;
  if (category === "simple") return sceneById("line-waves") as SceneInfo;
  if (category === "cinematic") return sceneById("cinematic-phoenix") as SceneInfo;
  const fallback = energy >= 7 ? "drop-burst" : energy >= 4 ? "body-pulse" : "intro-lines";
  return SCENES.find((scene) => scene.id === fallback) ?? (SCENES[0] as SceneInfo);
}
