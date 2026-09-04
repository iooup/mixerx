/**
 * Deterministic test signal: 32 bars at 128 BPM with an intro, a build, a drop, a break and a body,
 * looping. It feeds the Stage without audio (TEST SIGNAL, the standalone demo) and drives the
 * legibility tests, so its shape is fixed and documented here:
 *   bars 0–7 intro · 8–15 build (filter sweep, LOW kill on bars 14–15) · 16–23 drop ·
 *   24–27 break · 28–31 body (crossfader A→B), then it starts over.
 */
import {
  absoluteNow,
  F,
  FEATURE_FRAME_LENGTH,
  type StageEvent,
  type StageFrame,
  type StageSection,
} from "./protocol";

export const TEST_BPM = 128;
export const TEST_BARS = 32;
export const TEST_SECTIONS: { kind: StageSection; startBar: number; endBar: number; energy: number }[] = [
  { kind: "intro", startBar: 0, endBar: 8, energy: 0.25 },
  { kind: "build", startBar: 8, endBar: 16, energy: 0.55 },
  { kind: "drop", startBar: 16, endBar: 24, energy: 0.95 },
  { kind: "break", startBar: 24, endBar: 28, energy: 0.3 },
  { kind: "body", startBar: 28, endBar: 32, energy: 0.7 },
];

const BEAT_SEC = 60 / TEST_BPM;
const BAR_SEC = BEAT_SEC * 4;
const LOOP_SEC = BAR_SEC * TEST_BARS;

const decay = (age: number, tau: number): number => (age < 0 ? 0 : Math.exp(-age / tau));
const wrap01 = (value: number): number => ((value % 1) + 1) % 1;

export function testSectionAt(bar: number): (typeof TEST_SECTIONS)[number] {
  const wrapped = ((bar % TEST_BARS) + TEST_BARS) % TEST_BARS;
  return (
    TEST_SECTIONS.find((section) => wrapped >= section.startBar && wrapped < section.endBar) ??
    (TEST_SECTIONS[0] as (typeof TEST_SECTIONS)[number])
  );
}

function hasKick(section: StageSection, beatInBar: number): boolean {
  if (section === "intro") return beatInBar === 0 || beatInBar === 2;
  if (section === "break") return beatInBar === 0;
  return true;
}

function hasSnare(section: StageSection, beatInBar: number): boolean {
  return (section === "drop" || section === "body") && (beatInBar === 1 || beatInBar === 3);
}

function hasHat(section: StageSection): boolean {
  return section !== "intro";
}

/** The section that follows `bar` in the loop (the drop is telegraphed from the build). */
export function testNextSectionAt(bar: number): StageSection {
  const wrapped = ((bar % TEST_BARS) + TEST_BARS) % TEST_BARS;
  const index = TEST_SECTIONS.findIndex((section) => wrapped >= section.startBar && wrapped < section.endBar);
  const next = TEST_SECTIONS[(index + 1) % TEST_SECTIONS.length];
  return next?.kind ?? "none";
}

/** Feature frame at `t` seconds into the loop (pure). */
export function testFeaturesAt(t: number): {
  f: Float32Array;
  section: StageSection;
  next: StageSection;
  barsToNext: number;
} {
  const time = ((t % LOOP_SEC) + LOOP_SEC) % LOOP_SEC;
  const beatPosition = time / BEAT_SEC;
  const bar = Math.floor(beatPosition / 4);
  const beatInBar = Math.floor(beatPosition) % 4;
  const beatPhase = wrap01(beatPosition);
  const section = testSectionAt(bar);
  const barsToNext = section.endBar - bar;
  const f = new Float32Array(FEATURE_FRAME_LENGTH);

  // Envelopes from the most recent hit of each kind.
  const lastBeatStart = Math.floor(beatPosition) * BEAT_SEC;
  const sinceBeat = time - lastBeatStart;
  const kickEnv = hasKick(section.kind, beatInBar) ? decay(sinceBeat, 0.09) : 0;
  const snareEnv = hasSnare(section.kind, beatInBar) ? decay(sinceBeat, 0.12) : 0;
  const eighth = wrap01(beatPosition * 2) * (BEAT_SEC / 2);
  const hatEnv = hasHat(section.kind) ? decay(eighth, 0.04) * (section.kind === "build" ? 0.9 : 0.7) : 0;

  const buildProgress = section.kind === "build" ? (bar - 8 + wrap01(beatPosition / 4)) / 8 : 0;
  const level =
    section.kind === "build"
      ? 0.3 + 0.35 * buildProgress
      : section.kind === "drop"
        ? 0.85
        : section.kind === "break"
          ? 0.3
          : section.kind === "body"
            ? 0.65
            : 0.25;
  const rms = level * (0.75 + 0.25 * kickEnv);
  f[F.rms] = rms;
  f[F.peak] = Math.min(1, rms * 1.6);
  f[F.lufsShort] = -30 + 22 * level;
  f[F.kick] = kickEnv;
  f[F.snare] = snareEnv;
  f[F.hat] = hatEnv;
  f[F.centroid] = 0.25 + 0.35 * hatEnv + 0.15 * buildProgress;
  f[F.flux] = Math.max(kickEnv, snareEnv * 0.8, hatEnv * 0.5);
  const crossfader = section.kind === "body" ? (bar - 28 + wrap01(beatPosition / 4)) / 4 : 0;
  f[F.crossfader] = crossfader;
  f[F.gainA] = 1 - crossfader;
  f[F.gainB] = crossfader;
  f[F.beatPhase] = beatPhase;
  f[F.barPhase] = wrap01(beatPosition / 4);
  f[F.phrasePhase] = wrap01(beatPosition / 32);
  f[F.bpm] = TEST_BPM;
  f[F.barsToNextSection] = barsToNext;
  f[F.energy] = section.energy;
  const lowKill = section.kind === "build" && bar >= 14 ? 0 : 1;
  f[F.lowA] = lowKill;
  f[F.lowB] = 1;
  f[F.filterA] = section.kind === "build" ? 0.85 * buildProgress : 0;
  f[F.filterB] = 0;
  for (let band = 0; band < F.spectrumBins; band += 1) {
    const x = band / (F.spectrumBins - 1);
    const bass = Math.exp(-((x - 0.08) ** 2) / 0.006) * (0.45 + 0.55 * kickEnv);
    const mid = Math.exp(-((x - 0.45) ** 2) / 0.04) * (0.25 + 0.2 * snareEnv + 0.2 * buildProgress);
    const top = Math.exp(-((x - 0.85) ** 2) / 0.02) * (0.15 + 0.6 * hatEnv);
    const floor = 0.08 + 0.05 * Math.sin(band * 1.7 + time * 3);
    f[F.spectrumStart + band] = Math.min(1, level * (bass + mid + top) + floor * level);
  }
  return { f, section: section.kind, next: testNextSectionAt(bar), barsToNext };
}

/** Events between `from` (exclusive) and `to` (inclusive), in loop time. */
export function testEventsBetween(from: number, to: number): StageEvent[] {
  const events: StageEvent[] = [];
  if (to <= from) return events;
  const firstBeat = Math.floor(from / BEAT_SEC) + 1;
  const lastBeat = Math.floor(to / BEAT_SEC);
  for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
    const t = beat * BEAT_SEC;
    const loopBeat = ((beat % (TEST_BARS * 4)) + TEST_BARS * 4) % (TEST_BARS * 4);
    const bar = Math.floor(loopBeat / 4);
    const beatInBar = loopBeat % 4;
    const section = testSectionAt(bar);
    events.push({ t, kind: "beat" });
    if (beatInBar === 0) {
      events.push({ t, kind: "bar" });
      if (bar % 8 === 0) events.push({ t, kind: "phrase" });
      if (section.startBar === bar) {
        events.push({ t, kind: "section" });
        if (section.kind === "drop") events.push({ t, kind: "drop" });
      }
      if (bar === 0) events.push({ t, kind: "deckStart", deck: "A" });
    }
    if (hasKick(section.kind, beatInBar)) events.push({ t, kind: "kick" });
    if (hasSnare(section.kind, beatInBar)) events.push({ t, kind: "snare" });
    if (hasHat(section.kind)) {
      events.push({ t, kind: "hat" });
      events.push({ t: t + BEAT_SEC / 2, kind: "hat" });
    }
  }
  // Crossfader crosses the centre in the middle of the body section.
  const centre = (28 + 2) * BAR_SEC;
  const loopFrom = from % LOOP_SEC;
  const loopTo = to % LOOP_SEC;
  if (loopFrom < centre && loopTo >= centre) events.push({ t: to, kind: "faderCentre" });
  return events.filter((event) => event.t > from && event.t <= to);
}

/** Stateful generator: `next(dt)` returns the frame at the advanced time with the events since the last call. */
export class TestSignal {
  private time: number;
  private seq = 0;

  constructor(
    private readonly sessionId: string,
    startSec = 0,
  ) {
    this.time = startSec;
  }

  get seconds(): number {
    return this.time;
  }

  next(dtSec: number): StageFrame {
    const previous = this.time;
    this.time = previous + Math.max(0, dtSec);
    const { f, section, next } = testFeaturesAt(this.time);
    this.seq += 1;
    return {
      v: 2,
      sessionId: this.sessionId,
      seq: this.seq,
      tAudio: this.time,
      sentAt: absoluteNow(),
      f,
      section,
      next,
      keyHue: 200, // 8A-ish
      onAir: "A",
      events: testEventsBetween(previous, this.time),
    };
  }
}
