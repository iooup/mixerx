/**
 * The end-of-set recap, as data. Everything here is derived from what the console already knows —
 * the running order, the energy arc, the activity log, the Guide's best score and the practice
 * badges. Nothing is fetched, nothing is sent; the recap exists only in this tab until the DJ
 * exports it themselves.
 */
import type { ArcSample } from "../../state/night-arc";
import type { NightEntry } from "../../visuals/protocol";

export const BADGES_KEY = "mixerx.v2.badges";

export interface BadgeState {
  /** Ids of the badges earned, in the order they were earned. */
  earned: string[];
  /** Days in a row with at least one finished lesson (a day is a local calendar day). */
  streak: number;
  /** ISO date (YYYY-MM-DD) of the last practice day. */
  lastDay: string | null;
  /** Best Lesson 1 result so far: mean alignment in milliseconds, lower is better. */
  bestAlignmentMs: number | null;
}

export const emptyBadges = (): BadgeState => ({
  earned: [],
  streak: 0,
  lastDay: null,
  bestAlignmentMs: null,
});

const localDay = (at: number): string => {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const dayBefore = (iso: string): string => {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() - 1);
  return localDay(date.getTime());
};

/** Badges awarded for one finished lesson. Pure, so the streak is testable without a clock. */
export function awardLesson(
  state: BadgeState,
  result: { alignmentMs: number; blendBars: number; bassSwapOnBeatOne: boolean },
  at: number,
): BadgeState {
  const today = localDay(at);
  const streak =
    state.lastDay === today
      ? Math.max(1, state.streak)
      : state.lastDay === dayBefore(today)
        ? state.streak + 1
        : 1;
  const earned = new Set(state.earned);
  earned.add("first-blend");
  if (result.alignmentMs <= 10) earned.add("tight");
  if (result.bassSwapOnBeatOne) earned.add("clean-swap");
  if (result.blendBars >= 8) earned.add("patient");
  if (streak >= 3) earned.add("streak-3");
  return {
    earned: [...earned],
    streak,
    lastDay: today,
    bestAlignmentMs:
      state.bestAlignmentMs === null
        ? result.alignmentMs
        : Math.min(state.bestAlignmentMs, result.alignmentMs),
  };
}

export interface RecapTrack {
  id: string;
  title: string;
  artist: string;
  camelot: string;
  bpm: number;
  startedAt: number;
  /** Minutes on air, from the arc; null when it was never sampled. */
  minutes: number | null;
  /** 1..10 — the energy the audience actually heard, else the track's own. */
  energy: number;
}

export interface Recap {
  tracks: RecapTrack[];
  /** Start and end of the night in absolute milliseconds. */
  from: number;
  to: number;
  minutes: number;
  /** Transitions the DJ made: one per track after the first. */
  transitions: number;
  /** Mean energy across the whole arc, 0..1. */
  meanEnergy: number;
  peak: { energy: number; at: number } | null;
  badges: BadgeState;
}

/** Builds the recap from the night's running order and the arc. Pure. */
export function buildRecap(
  night: readonly NightEntry[],
  arc: readonly ArcSample[],
  badges: BadgeState,
  now = Date.now(),
): Recap {
  const minutesOf = (id: string): number | null => {
    const count = arc.filter((sample) => sample.trackId === id).length;
    return count ? (count * 2) / 60 : null;
  };
  const heardEnergy = (id: string): number | null => {
    const samples = arc.filter((sample) => sample.trackId === id);
    if (!samples.length) return null;
    return samples.reduce((total, sample) => total + sample.energy, 0) / samples.length;
  };
  const tracks: RecapTrack[] = night.map((entry) => {
    const heard = heardEnergy(entry.id);
    return {
      id: entry.id,
      title: entry.title,
      artist: entry.artist,
      camelot: entry.camelot,
      bpm: entry.bpm,
      startedAt: entry.startedAt,
      minutes: minutesOf(entry.id),
      energy: heard === null ? entry.energy : Math.max(1, Math.min(10, Math.round(heard * 10))),
    };
  });
  const from = night[0]?.startedAt ?? arc[0]?.t ?? now;
  const to = arc.at(-1)?.t ?? now;
  const played = arc.filter((sample) => sample.trackId !== null);
  const meanEnergy = played.length
    ? played.reduce((total, sample) => total + sample.energy, 0) / played.length
    : 0;
  let peak: Recap["peak"] = null;
  for (const sample of played)
    if (!peak || sample.energy > peak.energy) peak = { energy: sample.energy, at: sample.t };
  return {
    tracks,
    from,
    to: Math.max(to, from),
    minutes: Math.max(0, (Math.max(to, from) - from) / 60000),
    transitions: Math.max(0, tracks.length - 1),
    meanEnergy,
    peak,
    badges,
  };
}

/** The recap as JSON the DJ can keep: numbers and titles, no paths and no audio. */
export function recapJson(recap: Recap): string {
  return JSON.stringify(
    {
      from: new Date(recap.from).toISOString(),
      to: new Date(recap.to).toISOString(),
      minutes: Math.round(recap.minutes * 10) / 10,
      transitions: recap.transitions,
      meanEnergy: Math.round(recap.meanEnergy * 100) / 100,
      badges: recap.badges,
      tracks: recap.tracks.map((track) => ({
        title: track.title,
        artist: track.artist,
        camelot: track.camelot,
        bpm: track.bpm,
        startedAt: new Date(track.startedAt).toISOString(),
        minutes: track.minutes === null ? null : Math.round(track.minutes * 10) / 10,
        energy: track.energy,
      })),
    },
    null,
    2,
  );
}
