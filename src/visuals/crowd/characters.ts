/** Shared identifiers only: importing Stage settings must not load sprite artwork. */
export const PET_IDS = ["codex", "fireball", "hoots", "dario"] as const;
export type PetId = (typeof PET_IDS)[number];
export type CrowdStyle = "classic" | "mixed" | PetId;
export type CrowdStyles = Partial<Record<string, CrowdStyle>>;

export interface CrowdLayout {
  count: number;
  size: number;
  spacing: number;
}
export type CrowdLayouts = Partial<Record<string, CrowdLayout>>;
export const MAX_CROWD_COUNT = 10;
export const DEFAULT_CROWD_LAYOUT: Readonly<CrowdLayout> = Object.freeze({ count: 8, size: 1, spacing: 1 });

/** Storage and channel input share these bounds with the formation controls. */
export function sanitiseCrowdLayout(value: unknown): CrowdLayout {
  const input = value && typeof value === "object" ? (value as Partial<CrowdLayout>) : {};
  const bounded = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    count: Math.round(bounded(input.count, 4, MAX_CROWD_COUNT, DEFAULT_CROWD_LAYOUT.count)),
    size: bounded(input.size, 0.65, 1.4, DEFAULT_CROWD_LAYOUT.size),
    spacing: bounded(input.spacing, 0.6, 1.5, DEFAULT_CROWD_LAYOUT.spacing),
  };
}

export function isCrowdStyle(value: unknown): value is CrowdStyle {
  return value === "classic" || value === "mixed" || PET_IDS.some((id) => id === value);
}
