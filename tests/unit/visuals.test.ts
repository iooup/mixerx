import { describe, expect, it } from "vitest";
import { SCENES, sceneFor } from "../../src/agent/scenes";
import {
  armTarget,
  type DancerSeed,
  dancerPose,
  handPoint,
  hasPhone,
  makeCrowd,
  phoneTarget,
  sparkPoints,
  waveDelaySec,
  waveHop,
} from "../../src/visuals/crowd/crowd-math";
import { Director, FlashBudget, sectionTargets } from "../../src/visuals/director";
import { EventDetector } from "../../src/visuals/events";
import { facePose, initialFaceState, mouthPath } from "../../src/visuals/face/face-math";
import { followScene } from "../../src/visuals/follow";
import { CAMERA_SHOTS, shotForSection, shotView } from "../../src/visuals/gpu/camera";
import {
  MASK_HEIGHT,
  MASK_WIDTH,
  packTargets,
  samplePoints,
  TARGET_CAP,
} from "../../src/visuals/gpu/targets";
import { initialLowerThird, stepLowerThird } from "../../src/visuals/lower-third/lower-third-math";
import { initialMorph, stepMorph } from "../../src/visuals/morph";
import { placeStars, SKY_BOTTOM, SKY_TOP, type Star, skyVisible } from "../../src/visuals/night/night-math";
import {
  buildPalette,
  camelotHue,
  enforceContrast,
  hueDistance,
  parseHex,
  rgbToHsl,
} from "../../src/visuals/palette";
import { FramePredictor, MAX_BACKSTEP_BEATS } from "../../src/visuals/predict";
import {
  DEFAULT_STAGE_SETTINGS,
  emptyFrame,
  F,
  isStageFrame,
  isStageMessage,
  type NightEntry,
  PRESET_CAP,
  presetPatch,
  type StageEvent,
  type StageFrame,
  type StageSettings,
  sanitisePatch,
  sanitisePreset,
  sanitiseSettings,
} from "../../src/visuals/protocol";
import { reduceStageSettings } from "../../src/visuals/settings-store";
import {
  TEST_BPM,
  TestSignal,
  testEventsBetween,
  testFeaturesAt,
  testSectionAt,
} from "../../src/visuals/test-signal";

const BEAT = 60 / TEST_BPM;
const BAR = BEAT * 4;

/** Runs the Director over the test signal from `from` to `to` seconds in `dt` steps. */
function drive(
  director: Director,
  settings: StageSettings,
  from: number,
  to: number,
  dt = 1 / 60,
  onFrame?: (intent: ReturnType<Director["update"]>, t: number) => void,
) {
  const signal = new TestSignal("test", from);
  let t = from;
  let last = director.update(signal.next(0), [], settings, 0);
  while (t < to) {
    const frame = signal.next(dt);
    t += dt;
    last = director.update(frame, frame.events, settings, dt);
    onFrame?.(last, t);
  }
  return last;
}

const frameWith = (events: StageEvent[], patch: Partial<StageFrame> = {}): StageFrame => {
  const frame = emptyFrame("x");
  frame.f[F.bpm] = TEST_BPM;
  return { ...frame, events, ...patch };
};

describe("stage protocol", () => {
  it("validates frames and messages strictly", () => {
    const frame = emptyFrame("abc");
    expect(isStageFrame(frame)).toBe(true);
    expect(isStageFrame({ ...frame, f: new Float32Array(3) })).toBe(false);
    expect(isStageFrame({ ...frame, section: "chorus" })).toBe(false);
    expect(isStageFrame({ ...frame, events: [{ t: 0, kind: "explode" }] })).toBe(false);
    expect(isStageMessage({ type: "frame", frame })).toBe(true);
    expect(isStageMessage({ type: "hello", from: "a", role: "display" })).toBe(true);
    expect(isStageMessage({ type: "hello", from: "a", role: "hacker" })).toBe(false);
    expect(isStageMessage({ type: "patch", patch: { blackout: true }, from: "a" })).toBe(true);
    expect(isStageMessage({ type: "nope" })).toBe(false);
  });

  it("sanitises settings and patches, keeping only valid fields", () => {
    const settings = sanitiseSettings({
      intensity: 7,
      palette: "rainbow",
      transition: "wipe",
      custom: ["#123456", "nope"],
      crowdScenes: ["drop-burst", "nope", 3],
    });
    expect(settings.intensity).toBe(1);
    expect(settings.palette).toBe(DEFAULT_STAGE_SETTINGS.palette);
    expect(settings.transition).toBe("wipe");
    expect(settings.custom).toEqual(DEFAULT_STAGE_SETTINGS.custom);
    expect(settings.crowdScenes).toEqual(["drop-burst"]);
    expect(sanitiseSettings({}).crowdScenes).toEqual([]);
    expect(sanitisePatch({ blackout: true, bogus: 1 })).toEqual({ blackout: true });
    expect(sanitisePatch("x")).toEqual({});
  });

  it("reduces settings without allocating on no-ops", () => {
    const state = { ...DEFAULT_STAGE_SETTINGS };
    expect(reduceStageSettings(state, { type: "stage/patch", patch: { intensity: state.intensity } })).toBe(
      state,
    );
    const next = reduceStageSettings(state, {
      type: "stage/patch",
      patch: { intensity: 0.2, sceneId: "break-haze" },
    });
    expect(next.intensity).toBe(0.2);
    expect(next.sceneId).toBe("break-haze");
    expect(reduceStageSettings(next, { type: "stage/replace", settings: next })).toBe(next);
  });
});

describe("palette", () => {
  it("maps Camelot keys to hues 30° apart with minor keys slightly cooler", () => {
    expect(camelotHue("8A")).not.toBeNull();
    expect(hueDistance(camelotHue("8B") as number, camelotHue("9B") as number)).toBe(30);
    expect(hueDistance(camelotHue("8A") as number, camelotHue("8B") as number)).toBe(12);
    expect(camelotHue("13A")).toBeNull();
    expect(camelotHue("")).toBeNull();
  });

  it("never collapses into grey and keeps the two colours apart", () => {
    const [a, b] = enforceContrast({ h: 10, s: 0.05, l: 0.5 }, { h: 12, s: 0.05, l: 0.5 });
    expect(a.s).toBeGreaterThanOrEqual(0.55);
    expect(b.s).toBeGreaterThanOrEqual(0.55);
    expect(hueDistance(a.h, b.h)).toBeGreaterThanOrEqual(60);
    const custom = buildPalette({ source: "custom", keyHue: null, custom: ["#808080", "#7f7f7f"] });
    expect(rgbToHsl(custom.a).s).toBeGreaterThan(0.3);
    const decks = buildPalette({ source: "decks", keyHue: null });
    expect(decks.cssA).toBe("#ffa03c");
    expect(parseHex(decks.cssB)).not.toBeNull();
    const key = buildPalette({ source: "key", keyHue: 200 });
    expect(hueDistance(key.hueA, key.hueB)).toBeGreaterThanOrEqual(60);
  });

  it("locks the explicit palettes against warmth and warms only the key-derived one", () => {
    const pair: [string, string] = ["#ff3355", "#22ddaa"];
    const cool = buildPalette({ source: "custom", keyHue: null, custom: pair, warmth: -1 });
    const warm = buildPalette({ source: "custom", keyHue: null, custom: pair, warmth: 1 });
    expect(warm.cssA).toBe(cool.cssA);
    expect(warm.cssB).toBe(cool.cssB);
    expect(buildPalette({ source: "decks", keyHue: null, warmth: 1 }).cssA).toBe("#ffa03c");
    expect(buildPalette({ source: "decks", keyHue: null, warmth: -1 }).cssA).toBe("#ffa03c");
    const keyCool = buildPalette({ source: "key", keyHue: 200, warmth: -1 });
    const keyWarm = buildPalette({ source: "key", keyHue: 200, warmth: 1 });
    expect(hueDistance(keyCool.hueA, keyWarm.hueA)).toBeGreaterThan(10);
  });
});

describe("test signal", () => {
  it("is deterministic and follows the documented 32-bar structure", () => {
    expect(testSectionAt(0).kind).toBe("intro");
    expect(testSectionAt(8).kind).toBe("build");
    expect(testSectionAt(16).kind).toBe("drop");
    expect(testSectionAt(24).kind).toBe("break");
    expect(testSectionAt(28).kind).toBe("body");
    expect(testSectionAt(32).kind).toBe("intro");
    const a = testFeaturesAt(17.3);
    const b = testFeaturesAt(17.3);
    expect(Array.from(a.f)).toEqual(Array.from(b.f));
    expect(a.section).toBe("build");
    expect(testFeaturesAt(16 * BAR + 0.01).f[F.rms]).toBeGreaterThan(
      testFeaturesAt(25 * BAR + 0.01).f[F.rms] as number,
    );
  });

  it("emits beat, bar, phrase, section and drop events at the right moments", () => {
    const events = testEventsBetween(16 * BAR - 0.01, 16 * BAR + 0.01);
    const kinds = events.map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(["beat", "bar", "phrase", "section", "drop", "kick"]));
    const midBar = testEventsBetween(16 * BAR + BEAT - 0.01, 16 * BAR + BEAT + 0.01).map(
      (event) => event.kind,
    );
    expect(midBar).toContain("beat");
    expect(midBar).not.toContain("bar");
    expect(midBar).toContain("snare");
    const signal = new TestSignal("s");
    let beats = 0;
    for (let i = 0; i < 600; i += 1)
      beats += signal.next(1 / 60).events.filter((event) => event.kind === "beat").length;
    expect(beats).toBe(Math.floor(10 / BEAT));
  });
});

describe("frame prediction", () => {
  const wrap01 = (value: number) => value - Math.floor(value);

  /** A frame describing the music `beats` into the track, stamped at `sentAt` (absolute ms). */
  const at = (beats: number, sentAt: number, bpm = TEST_BPM): StageFrame => {
    const frame = emptyFrame("p");
    frame.f[F.bpm] = bpm;
    frame.f[F.beatPhase] = wrap01(beats);
    frame.f[F.barPhase] = wrap01(beats / 4);
    frame.f[F.phrasePhase] = wrap01(beats / 32);
    frame.f[F.rms] = 0.5;
    return { ...frame, sentAt };
  };

  /** Unwrapped difference between two 0..1 phases, in (−0.5, 0.5]. */
  const delta = (from: number, to: number) => {
    let d = to - from;
    if (d > 0.5) d -= 1;
    if (d <= -0.5) d += 1;
    return d;
  };

  it("advances the beat phase smoothly between 30 Hz frames with a step error below 0.01", () => {
    const predictor = new FramePredictor(emptyFrame("p"));
    const beatsPerMs = TEST_BPM / 60 / 1000;
    const sampleMs = 1000 / 120;
    let now = 1000;
    let nextFrameAt = 1000;
    predictor.push(at(0, now), now);
    let previous = predictor.sample(now, sampleMs / 1000).f[F.beatPhase] as number;
    const steps: number[] = [];
    for (let i = 0; i < 240; i += 1) {
      now += sampleMs;
      if (now >= nextFrameAt) {
        predictor.push(at((nextFrameAt - 1000) * beatsPerMs, nextFrameAt), now);
        nextFrameAt += 33;
      }
      const phase = predictor.sample(now, sampleMs / 1000).f[F.beatPhase] as number;
      steps.push(delta(previous, phase));
      previous = phase;
    }
    const expected = sampleMs * beatsPerMs;
    // Monotonic modulo 1 (never a backward step) and every step within 0.01 beat of the true one.
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(-MAX_BACKSTEP_BEATS);
    expect(Math.max(...steps.map((step) => Math.abs(step - expected)))).toBeLessThan(0.01);
  });

  it("holds through a 200 ms gap and re-syncs without stepping backwards", () => {
    const predictor = new FramePredictor(emptyFrame("p"));
    const beatsPerMs = TEST_BPM / 60 / 1000;
    const sampleMs = 1000 / 120;
    let now = 1000;
    predictor.push(at(0, now), now);
    let previous = predictor.sample(now, sampleMs / 1000).f[F.beatPhase] as number;
    let held = 0;
    const steps: number[] = [];
    // 200 ms with no frames at all, then the stream resumes.
    for (let i = 0; i < 24; i += 1) {
      now += sampleMs;
      const phase = predictor.sample(now, sampleMs / 1000).f[F.beatPhase] as number;
      const step = delta(previous, phase);
      if (step < 1e-6) held += 1;
      steps.push(step);
      previous = phase;
    }
    // The 120 ms cap stops the extrapolation well before the gap ends.
    expect(held).toBeGreaterThan(3);
    for (let i = 0; i < 24; i += 1) {
      now += sampleMs;
      predictor.push(at((now - 1000) * beatsPerMs, now), now);
      const phase = predictor.sample(now, sampleMs / 1000).f[F.beatPhase] as number;
      steps.push(delta(previous, phase));
      previous = phase;
    }
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(-MAX_BACKSTEP_BEATS);
  });

  it("snaps to a frame that disagrees by a third of a beat", () => {
    const predictor = new FramePredictor(emptyFrame("p"));
    const sampleMs = 1000 / 120;
    let now = 1000;
    predictor.push(at(0, now), now);
    predictor.sample(now, sampleMs / 1000);
    now += sampleMs;
    predictor.push(at(0.3, now), now);
    const phase = predictor.sample(now, sampleMs / 1000).f[F.beatPhase] as number;
    expect(Math.abs(delta(0.3, phase))).toBeLessThan(0.02);
  });

  it("smooths continuous features and keeps the onset attack instant", () => {
    const predictor = new FramePredictor(emptyFrame("p"));
    const now = 1000;
    const quiet = at(0, now);
    quiet.f[F.rms] = 0;
    quiet.f[F.kick] = 0;
    predictor.push(quiet, now);
    predictor.sample(now, 1 / 120);
    const loud = at(0, now + 8);
    loud.f[F.rms] = 1;
    loud.f[F.kick] = 1;
    predictor.push(loud, now + 8);
    const first = predictor.sample(now + 8, 1 / 120);
    // The kick jumps at once; the level takes a few frames to arrive.
    expect(first.f[F.kick]).toBe(1);
    expect(first.f[F.rms] as number).toBeLessThan(0.8);
    expect(first.f[F.rms] as number).toBeGreaterThan(0.2);
    let rms = first.f[F.rms] as number;
    for (let i = 0; i < 6; i += 1) rms = predictor.sample(now + 8 + i, 1 / 120).f[F.rms] as number;
    expect(rms).toBeGreaterThan(0.95);
    // The release is smoothed, never instant.
    const silent = at(0, now + 40);
    silent.f[F.kick] = 0;
    predictor.push(silent, now + 40);
    const released = predictor.sample(now + 40, 1 / 120).f[F.kick] as number;
    expect(released).toBeGreaterThan(0.5);
    expect(released).toBeLessThan(1);
  });
});

describe("event detector", () => {
  const sample = (t: number, patch: Partial<Parameters<EventDetector["next"]>[0]> = {}) => ({
    t,
    beatIndex: Math.floor(t / BEAT),
    barIndex: Math.floor(t / BAR),
    phraseIndex: Math.floor(t / (BAR * 8)),
    kick: 0,
    snare: 0,
    hat: 0,
    section: "body" as const,
    crossfader: 0,
    loop: { A: false, B: false },
    playing: { A: true, B: false },
    ...patch,
  });

  it("detects onsets once per hit with a refractory time", () => {
    const detector = new EventDetector();
    detector.next(sample(0));
    const first = detector.next(sample(0.01, { kick: 0.9 }));
    const second = detector.next(sample(0.02, { kick: 0.95 }));
    const third = detector.next(sample(0.05, { kick: 0.1 }));
    const fourth = detector.next(sample(0.2, { kick: 0.9 }));
    expect(first.map((e) => e.kind)).toContain("kick");
    expect(second.map((e) => e.kind)).not.toContain("kick");
    expect(third.map((e) => e.kind)).not.toContain("kick");
    expect(fourth.map((e) => e.kind)).toContain("kick");
  });

  it("derives beats, bars, phrases, sections, drops, loops, deck starts and the fader centre", () => {
    const detector = new EventDetector();
    detector.next(sample(BAR * 7.9));
    const bar = detector.next(sample(BAR * 8.0 + 0.001, { section: "drop" }));
    expect(bar.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["beat", "bar", "phrase", "section", "drop"]),
    );
    const loop = detector.next(sample(BAR * 8.1, { section: "drop", loop: { A: true, B: false } }));
    expect(loop).toContainEqual({ t: BAR * 8.1, kind: "loopOn", deck: "A" });
    const fader = detector.next(
      sample(BAR * 8.2, {
        section: "drop",
        loop: { A: true, B: false },
        crossfader: 0.6,
        playing: { A: true, B: true },
      }),
    );
    expect(fader.map((e) => e.kind)).toEqual(expect.arrayContaining(["faderCentre", "deckStart"]));
    detector.push({ t: 1, kind: "cue", deck: "B" });
    expect(
      detector.next(
        sample(BAR * 8.3, {
          section: "drop",
          loop: { A: true, B: false },
          crossfader: 0.6,
          playing: { A: true, B: true },
        }),
      ),
    ).toContainEqual({ t: 1, kind: "cue", deck: "B" });
  });
});

describe("director", () => {
  it("keeps breaks darker and slower than drops", () => {
    const settings = { ...DEFAULT_STAGE_SETTINGS, follow: false };
    const director = new Director("body-pulse");
    const drop = drive(director, settings, 16 * BAR, 20 * BAR);
    const brk = drive(director, settings, 24 * BAR, 27 * BAR);
    expect(brk.intensity).toBeLessThan(drop.intensity * 0.6);
    expect(brk.motion).toBeLessThan(drop.motion);
    expect(sectionTargets("build", 1, true).intensity).toBeGreaterThan(
      sectionTargets("build", 0, true).intensity,
    );
    expect(sectionTargets("drop", 0, false)).toEqual(sectionTargets("break", 0, false));
  });

  it("flashes once on the drop, bursts, and honours the photosensitive switch", () => {
    const settings = { ...DEFAULT_STAGE_SETTINGS, follow: false };
    let flashes = 0;
    let maxBurst = 0;
    drive(new Director(), settings, 15.9 * BAR, 16.5 * BAR, 1 / 60, (intent) => {
      if (intent.flash >= 0.5) flashes += 1;
      maxBurst = Math.max(maxBurst, intent.burst);
    });
    expect(flashes).toBe(1);
    expect(maxBurst).toBeGreaterThan(0.95);

    let safeFlash = 0;
    let safeMaxBurst = 0;
    let maxStep = 0;
    let previous = 0;
    drive(
      new Director(),
      { ...settings, photosensitiveSafe: true },
      15.9 * BAR,
      16.5 * BAR,
      1 / 60,
      (intent) => {
        safeFlash = Math.max(safeFlash, intent.flash);
        safeMaxBurst = Math.max(safeMaxBurst, intent.burst);
        maxStep = Math.max(maxStep, Math.abs(intent.burst - previous));
        previous = intent.burst;
      },
    );
    expect(safeFlash).toBe(0);
    expect(safeMaxBurst).toBeLessThanOrEqual(0.6);
    expect(maxStep).toBeLessThan(0.1);
  });

  it("never emits more than three flashes per second, however fast drops arrive", () => {
    const director = new Director();
    const settings = { ...DEFAULT_STAGE_SETTINGS, follow: false };
    const perSecond: number[] = [];
    let count = 0;
    let time = 0;
    for (let i = 0; i < 300; i += 1) {
      const events: StageEvent[] = i % 6 === 0 ? [{ t: time, kind: "drop" }] : [];
      const intent = director.update(frameWith(events, { section: "drop" }), events, settings, 1 / 60);
      if (intent.flash >= 0.5) count += 1;
      time += 1 / 60;
      if ((i + 1) % 60 === 0) {
        perSecond.push(count);
        count = 0;
      }
    }
    expect(Math.max(...perSecond)).toBeLessThanOrEqual(3);
    expect(Math.max(...perSecond)).toBeGreaterThanOrEqual(2);
    const budget = new FlashBudget(3);
    expect([
      budget.request(0, 1),
      budget.request(0.1, 1),
      budget.request(0.2, 1),
      budget.request(0.3, 1),
    ]).toEqual([1, 1, 1, 0]);
    expect(budget.request(1.05, 1)).toBe(1);
  });

  it("switches scenes only at a bar (cut) and dissolves over two bars", () => {
    const director = new Director("body-pulse");
    const cut: StageSettings = {
      ...DEFAULT_STAGE_SETTINGS,
      follow: false,
      transition: "cut",
      sceneId: "body-pulse",
    };
    drive(director, cut, 0, 0.6 * BAR);
    const wanted = { ...cut, sceneId: "break-haze" };
    const midBar = drive(director, wanted, 0.6 * BAR, 0.9 * BAR);
    expect(midBar.sceneId).toBe("body-pulse");
    expect(director.pendingScene).toBe("break-haze");
    const afterBar = drive(director, wanted, 0.9 * BAR, 1.1 * BAR);
    expect(afterBar.sceneId).toBe("break-haze");
    expect(afterBar.transition).toBeNull();

    // Settle on break-haze past the 0.3 s grace window after bar 1.
    drive(director, wanted, 1.1 * BAR, 1.6 * BAR);
    const dissolve: StageSettings = { ...wanted, transition: "dissolve", sceneId: "intro-lines" };
    // Requested mid-bar: waits for bar 2, then dissolves over two bars.
    const waiting = drive(director, dissolve, 1.6 * BAR, 1.9 * BAR);
    expect(waiting.transition).toBeNull();
    expect(director.pendingScene).toBe("intro-lines");
    const started = drive(director, dissolve, 1.9 * BAR, 2.05 * BAR);
    expect(started.transition?.kind).toBe("dissolve");
    expect(started.transition?.progress ?? 1).toBeLessThan(0.2);
    const half = drive(director, dissolve, 2.05 * BAR, 3.0 * BAR);
    expect(half.transition?.progress ?? 1).toBeGreaterThan(0.4);
    const done = drive(director, dissolve, 3.0 * BAR, 4.2 * BAR);
    expect(done.transition).toBeNull();
    expect(done.sceneId).toBe("intro-lines");
  });

  it("switches after half a second when there is no beat grid", () => {
    const director = new Director("body-pulse");
    const settings = {
      ...DEFAULT_STAGE_SETTINGS,
      follow: false,
      sceneId: "drop-burst",
      transition: "cut" as const,
    };
    const frame = emptyFrame("x");
    let intent = director.update(frame, [], settings, 1 / 60);
    for (let i = 0; i < 20; i += 1) intent = director.update(frame, [], settings, 1 / 60);
    expect(intent.sceneId).toBe("body-pulse");
    for (let i = 0; i < 20; i += 1) intent = director.update(frame, [], settings, 1 / 60);
    expect(intent.sceneId).toBe("drop-burst");
  });

  it("reduced motion slows everything and removes flashes; blackout is instant", () => {
    const settings = { ...DEFAULT_STAGE_SETTINGS, follow: false };
    const normal = drive(new Director(), settings, 16 * BAR, 18 * BAR);
    let flash = 0;
    const reduced = drive(
      new Director(),
      { ...settings, reducedMotion: true },
      15.9 * BAR,
      18 * BAR,
      1 / 60,
      (intent) => {
        flash = Math.max(flash, intent.flash);
      },
    );
    expect(reduced.motion).toBeLessThan(normal.motion * 0.5);
    expect(flash).toBe(0);
    const dark = drive(new Director(), { ...settings, blackout: true }, 0, 1);
    expect(dark.sceneId).toBe("blackout");
    expect(dark.blackout).toBe(true);
  });

  it("maps gestures: LOW kill drops the floor, loops freeze, cues cut, phrases re-seed", () => {
    const settings = { ...DEFAULT_STAGE_SETTINGS, follow: false };
    const director = new Director();
    const lowKill = frameWith([], { onAir: "A" });
    lowKill.f[F.lowA] = 0;
    let intent = director.update(lowKill, [], settings, 1 / 60);
    for (let i = 0; i < 60; i += 1) intent = director.update(lowKill, [], settings, 1 / 60);
    expect(intent.floor).toBeLessThan(0.05);
    const seed = intent.seed;
    intent = director.update(
      frameWith([{ t: 0, kind: "loopOn", deck: "A" }]),
      [{ t: 0, kind: "loopOn", deck: "A" }],
      settings,
      1 / 60,
    );
    for (let i = 0; i < 30; i += 1) intent = director.update(frameWith([]), [], settings, 1 / 60);
    expect(intent.freeze).toBeGreaterThan(0.9);
    intent = director.update(
      frameWith([{ t: 0, kind: "cue", deck: "A" }]),
      [{ t: 0, kind: "cue", deck: "A" }],
      settings,
      1 / 60,
    );
    expect(intent.cut).toBe(1);
    expect(intent.seed).toBe(seed + 1);
    intent = director.update(
      frameWith([{ t: 0, kind: "phrase" }]),
      [{ t: 0, kind: "phrase" }],
      settings,
      1 / 60,
    );
    expect(intent.seed).toBe(seed + 2);
  });

  it("carries the crowd only on the scenes the DJ added it to", () => {
    const settings = {
      ...DEFAULT_STAGE_SETTINGS,
      follow: false,
      sceneId: "body-pulse",
      crowdScenes: ["drop-burst"],
    };
    const director = new Director("body-pulse");
    expect(director.update(emptyFrame("x"), [], settings, 1 / 60).crowd).toBe(false);
    const withCrowd = { ...settings, crowdScenes: ["body-pulse"] };
    expect(director.update(emptyFrame("x"), [], withCrowd, 1 / 60).crowd).toBe(true);
    expect(director.update(emptyFrame("x"), [], { ...withCrowd, blackout: true }, 1 / 60).crowd).toBe(false);
  });

  it("follows sections with the same rule as propose-scene", () => {
    expect(followScene("drop", 0.9)).toBe("drop-burst");
    expect(followScene("break", 0.2)).toBe("break-haze");
    expect(followScene("none", 0.5)).toBeNull();
    expect(followScene("intro", 0.1)).toBe(sceneFor("intro", 1).id);
  });
});

describe("anticipation, idle and the lower third", () => {
  const settings = { ...DEFAULT_STAGE_SETTINGS, follow: false };

  it("ramps the anticipation over the four bars before a drop and drops it after", () => {
    const director = new Director("body-pulse");
    // The test signal's drop starts at bar 16, so bars 12–15 are the run-up.
    const early = drive(director, settings, 8 * BAR, 11 * BAR);
    expect(early.anticipation).toBeLessThan(0.05);
    const late = drive(director, settings, 11 * BAR, 15.9 * BAR);
    expect(late.anticipation).toBeGreaterThan(0.9);
    // The picture is held back, never brightened.
    expect(late.motion).toBeLessThan(early.motion + 0.5);
    const after = drive(director, settings, 15.9 * BAR, 17 * BAR);
    expect(after.anticipation).toBe(0);
    // With section reactions off there is no anticipation at all.
    const quiet = drive(
      new Director("body-pulse"),
      { ...settings, sectionReactions: false },
      11 * BAR,
      15.9 * BAR,
    );
    expect(quiet.anticipation).toBe(0);
  });

  it("goes idle after twenty seconds of silence and comes back within 300 ms", () => {
    const director = new Director("body-pulse");
    const silent = emptyFrame("x");
    let intent = director.update(silent, [], settings, 1 / 60);
    for (let i = 0; i < 60 * 19; i += 1) intent = director.update(silent, [], settings, 1 / 60);
    expect(intent.idle).toBe(0);
    for (let i = 0; i < 60 * 4; i += 1) intent = director.update(silent, [], settings, 1 / 60);
    expect(intent.idle).toBeGreaterThan(0.9);
    expect(intent.intensity).toBeLessThan(0.35);
    // Any audio wakes it inside 300 ms.
    const loud = emptyFrame("x");
    loud.f[F.rms] = 0.4;
    for (let i = 0; i < 20; i += 1) intent = director.update(loud, [], settings, 1 / 60);
    expect(intent.idle).toBe(0);
    // No frames at all is the same as silence.
    const stale = new Director("body-pulse");
    let staleIntent = stale.update(loud, [], settings, 1 / 60);
    for (let i = 0; i < 60 * 4; i += 1)
      staleIntent = stale.update(loud, [], settings, 1 / 60, { frameAgeSec: 30 });
    expect(staleIntent.idle).toBeGreaterThan(0.9);
  });

  it("runs the lower third in, holds it six seconds and takes it out", () => {
    let state = initialLowerThird();
    expect(state.progress).toBe(0);
    state = stepLowerThird(state, 0, true, true);
    expect(state.phase).toBe("in");
    for (let i = 0; i < 40; i += 1) state = stepLowerThird(state, 1 / 60, false, true);
    expect(state.phase).toBe("hold");
    expect(state.progress).toBe(1);
    for (let i = 0; i < 60 * 5; i += 1) state = stepLowerThird(state, 1 / 60, false, true);
    expect(state.phase).toBe("hold");
    const phases: string[] = [];
    for (let i = 0; i < 60 * 3; i += 1) {
      state = stepLowerThird(state, 1 / 60, false, true);
      phases.push(state.phase);
    }
    // Six seconds of hold, then it leaves and is gone.
    expect(phases).toContain("out");
    expect(state).toEqual(initialLowerThird());
    // Turning it off (or a blackout) takes it away the way it came, not with a jump.
    let live = stepLowerThird(initialLowerThird(), 0, true, true);
    for (let i = 0; i < 40; i += 1) live = stepLowerThird(live, 1 / 60, false, true);
    const leaving = stepLowerThird(live, 0.1, false, false);
    expect(leaving.progress).toBeLessThan(1);
    expect(leaving.progress).toBeGreaterThan(0);
  });
});

describe("presets", () => {
  it("sanitises, caps at nine, and applies only its own fields", () => {
    const good = sanitisePreset({ name: "Deep", sceneId: "drop-burst", palette: "key", intensity: 0.5 });
    expect(good?.transition).toBe("dissolve");
    expect(good?.crowd).toBe(false);
    expect(sanitisePreset({ name: "X", sceneId: "nope" })).toBeNull();
    expect(sanitisePreset({ sceneId: "cubes" })).toBeNull();
    expect(sanitisePreset("x")).toBeNull();
    const many = Array.from({ length: 14 }, (_value, i) => ({ name: `p${i}`, sceneId: "cubes" }));
    expect(sanitiseSettings({ presets: many }).presets).toHaveLength(PRESET_CAP);
    expect(DEFAULT_STAGE_SETTINGS.presets).toHaveLength(4);

    const current: StageSettings = {
      ...DEFAULT_STAGE_SETTINGS,
      sceneId: "face",
      blackout: true,
      testSignal: true,
      follow: false,
      crowdScenes: ["face", "cubes"],
    };
    const preset = sanitisePreset({
      name: "Lattice",
      sceneId: "cubes",
      palette: "decks",
      transition: "wipe",
      intensity: 0.42,
      crowd: true,
      lowerThird: false,
    });
    const patch = presetPatch(preset as NonNullable<typeof preset>, current);
    expect(patch.sceneId).toBe("cubes");
    expect(patch.intensity).toBe(0.42);
    expect(patch.lowerThird).toBe(false);
    // The preset owns the crowd on *its* scene; every other scene keeps the DJ's own choice.
    expect(patch.crowdScenes).toEqual(["face", "cubes"]);
    // The DJ's own state is never in a preset.
    expect(patch).not.toHaveProperty("blackout");
    expect(patch).not.toHaveProperty("testSignal");
    expect(patch).not.toHaveProperty("follow");
    const off = presetPatch(
      sanitisePreset({ name: "No crowd", sceneId: "cubes" }) as NonNullable<typeof preset>,
      current,
    );
    expect(off.crowdScenes).toEqual(["face"]);
  });
});

describe("night sky", () => {
  const entry = (id: string, energy = 5, camelot = "8A"): NightEntry => ({
    id,
    title: id,
    artist: "x",
    camelot,
    bpm: 128,
    startedAt: 0,
    energy,
  });

  it("places every track deterministically inside the sky band", () => {
    const night = [entry("a"), entry("b", 9), entry("c", 1, "")];
    const stars = placeStars(night);
    expect(stars).toHaveLength(3);
    expect(placeStars(night)).toEqual(stars);
    for (const star of stars) {
      expect(star.y).toBeGreaterThanOrEqual(SKY_TOP);
      expect(star.y).toBeLessThanOrEqual(SKY_BOTTOM);
      expect(star.x).toBeGreaterThan(0);
      expect(star.x).toBeLessThan(1);
    }
    // Size follows energy; a track with no key has no hue of its own.
    expect((stars[1] as Star).r).toBeGreaterThan((stars[2] as Star).r);
    expect((stars[2] as Star).hue).toBeNull();
    expect((stars[0] as Star).hue).not.toBeNull();
    // Two tracks never land on the same point.
    expect(new Set(stars.map((star) => star.x.toFixed(4))).size).toBe(3);
    expect(placeStars([])).toEqual([]);
  });

  it("shows itself in the quiet parts, or whenever the DJ pins it", () => {
    expect(skyVisible("auto", "break", 0)).toBe(true);
    expect(skyVisible("auto", "outro", 0)).toBe(true);
    expect(skyVisible("auto", "drop", 0)).toBe(false);
    expect(skyVisible("auto", "drop", 1)).toBe(true);
    expect(skyVisible("always", "drop", 0)).toBe(true);
    expect(skyVisible("off", "break", 1)).toBe(false);
  });
});

describe("particle messages", () => {
  /** A mask with a solid block in the middle third, like a letter would be. */
  const blockMask = (width: number, height: number) => {
    const mask = new Uint8Array(width * height);
    for (let y = Math.floor(height * 0.25); y < Math.floor(height * 0.75); y += 1)
      for (let x = Math.floor(width * 0.4); x < Math.floor(width * 0.6); x += 1) mask[y * width + x] = 255;
    return mask;
  };

  it("samples a mask into spread points inside the shape, deterministically and under the cap", () => {
    const mask = blockMask(MASK_WIDTH, MASK_HEIGHT);
    const points = samplePoints(mask, MASK_WIDTH, MASK_HEIGHT);
    expect(points.length).toBeGreaterThan(200);
    expect(points.length).toBeLessThanOrEqual(TARGET_CAP);
    expect(samplePoints(mask, MASK_WIDTH, MASK_HEIGHT)).toEqual(points);
    const aspect = MASK_WIDTH / MASK_HEIGHT;
    for (const point of points) {
      // Inside the block's own bounding box: x in the middle fifth, y in the middle half.
      expect(point.x).toBeGreaterThan(-0.21 * aspect);
      expect(point.x).toBeLessThan(0.21 * aspect);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(0.5);
      expect(point.weight).toBeCloseTo(1, 5);
    }
    // The stride spreads the sample: a cap far below the pixel count still covers the whole block.
    const few = samplePoints(mask, MASK_WIDTH, MASK_HEIGHT, 64);
    expect(few).toHaveLength(64);
    expect(Math.max(...few.map((p) => p.y)) - Math.min(...few.map((p) => p.y))).toBeGreaterThan(0.6);
    expect(samplePoints(new Uint8Array(0), 0, 0)).toEqual([]);
    const packed = packTargets(points);
    expect(packed).toHaveLength(TARGET_CAP * 4);
    expect(packed[3]).toBeCloseTo(points[0]?.weight ?? 0, 5);
  });

  it("assembles on a phrase, holds, and lets go on the drop or when it is turned off", () => {
    const base = {
      mode: "hold" as const,
      hasText: true,
      requested: false,
      phraseIndex: 4,
      barIndex: 0,
      drop: false,
      reduced: false,
    };
    let state = stepMorph(initialMorph(), { ...base, requested: true }, 0);
    expect(state.phase).toBe("armed");
    // It waits for the next phrase rather than appearing mid-bar.
    state = stepMorph(state, base, 0.25);
    state = stepMorph(state, base, 0.25);
    expect(state.phase).toBe("armed");
    expect(state.amount).toBe(0);
    state = stepMorph(state, { ...base, phraseIndex: 5 }, 0.25);
    expect(state.phase).toBe("assembling");
    for (let i = 0; i < 5; i += 1) state = stepMorph(state, { ...base, phraseIndex: 5 }, 0.25);
    expect(state.phase).toBe("holding");
    expect(state.amount).toBe(1);
    // A drop throws it apart with the field.
    const dropped = stepMorph(state, { ...base, phraseIndex: 5, drop: true }, 0.25);
    expect(dropped.amount).toBeLessThan(1);
    // "off" lets go at once.
    expect(stepMorph(state, { ...base, mode: "off" }, 0.25).amount).toBeLessThan(1);
    // "hold" lets go after eight bars, at the next phrase.
    let held = state;
    for (let i = 0; i < 40; i += 1) held = stepMorph(held, { ...base, phraseIndex: 5 }, 0.25);
    expect(held.phase).toBe("holding");
    held = stepMorph(held, { ...base, phraseIndex: 6 }, 0.25);
    expect(held.phase).toBe("releasing");
    // Reduced motion dissolves instead of springing back.
    const calm = stepMorph(state, { ...base, mode: "off", reduced: true }, 0.25);
    expect(calm.amount).toBeGreaterThan(dropped.amount);
  });
});

describe("camera operator", () => {
  it("frames each scene from outside its own floor and minimum distance", () => {
    const frame = {
      distance: 6,
      height: 3,
      centre: [0, 0, 0] as [number, number, number],
      floorY: 0.5,
      minDistance: 4.5,
      fovDeg: 46,
    };
    const shape = { framing: 1, anticipation: 1 };
    for (const shot of CAMERA_SHOTS) {
      const view = shotView(shot, 0.4, frame, shape);
      expect(view.eye[1]).toBeGreaterThanOrEqual(frame.floorY);
      expect(Math.hypot(view.eye[0], view.eye[2])).toBeGreaterThanOrEqual(frame.minDistance - 1e-6);
      expect(Number.isFinite(view.fovDeg)).toBe(true);
    }
    // Framing and anticipation pull the camera in, never past the minimum.
    const wide = shotView("wide", 0, frame, { framing: 0, anticipation: 0 });
    const tight = shotView("wide", 0, frame, { framing: 1, anticipation: 1 });
    expect(tight.eye[2]).toBeLessThan(wide.eye[2]);
  });

  it("chooses a shot for each section and drops the handheld under reduced motion", () => {
    expect(shotForSection("build", 0, 0, false)).toBe("push");
    expect(shotForSection("break", 0, 0, false)).toBe("low");
    expect(shotForSection("body", 0, 0, false)).toBe("orbit");
    expect(shotForSection("intro", 0, 0, false)).toBe("wide");
    // Anticipation overrides everything: the camera pushes in before the drop.
    expect(shotForSection("break", 0.8, 0, false)).toBe("push");
    // A new angle every two phrases through a drop, and never a handheld when motion is reduced.
    const shots = [0, 1, 2, 3, 4, 5, 6, 7].map((phrase) => shotForSection("drop", 0, phrase, false));
    expect(new Set(shots).size).toBeGreaterThan(2);
    expect(shots[0]).toBe(shots[1]);
    expect(shots[1]).not.toBe(shots[2]);
    for (const phrase of [0, 1, 2, 3, 4, 5, 6, 7])
      expect(shotForSection("drop", 0, phrase, true)).not.toBe("handheld");
  });

  it("cuts only on a bar", () => {
    const settings = { ...DEFAULT_STAGE_SETTINGS, follow: false };
    const director = new Director("body-pulse");
    const build = frameWith([], { section: "build" });
    build.f[F.barsToNextSection] = 12;
    let intent = director.update(build, [], settings, 1 / 60);
    const before = intent.cameraShot;
    for (let i = 0; i < 120; i += 1) intent = director.update(build, [], settings, 1 / 60);
    expect(intent.cameraShot).toBe(before);
    intent = director.update(build, [{ t: 0, kind: "bar" }], settings, 1 / 60);
    expect(intent.cameraShot).not.toBe(before);
  });
});

describe("scene catalogue", () => {
  it("keeps the stable ids and gives every look a renderer", () => {
    expect(SCENES.map((scene) => scene.id)).toEqual([
      "intro-lines",
      "build-rise",
      "drop-burst",
      "break-haze",
      "body-pulse",
      "cubes",
      "face",
      "blackout",
      "line-waves",
      "line-orbits",
      "line-ribbons",
      "line-lattice",
      "cinematic-phoenix",
      "cinematic-gate",
      "cinematic-lotus",
      "cinematic-crystal",
    ]);
    expect(SCENES.filter((scene) => scene.renderer !== "none")).toHaveLength(15);
    expect(new Set(SCENES.map((scene) => scene.renderer)).size).toBe(16);
    expect(SCENES.find((scene) => scene.id === "face")?.layer).toBe("face");
    // The agent's first choice per section is unchanged; the follow rule rotates through the rest.
    expect(sceneFor("drop", 8).id).toBe("drop-burst");
    expect(followScene("drop", 0.8, 0)).toBe("drop-burst");
    expect(followScene("drop", 0.8, 1)).toBe("cubes");
    expect(followScene("drop", 0.8, 2)).toBe("face");
    expect(followScene("drop", 0.8, 3)).toBe("drop-burst");
    expect(followScene("intro", 0.1, 1)).toBe("intro-lines");
  });
});

describe("crowd", () => {
  const input = {
    t: 1,
    beatPhase: 0.1,
    barPhase: 0.3,
    kick: 0.8,
    snare: 0.2,
    hat: 0.4,
    snareCount: 3,
    intensity: 0.8,
    motion: 0.7,
    section: "body",
    barsToNext: 4,
    burst: 0,
    floor: 1,
    freeze: 0,
    balance: 0.5,
    reduced: false,
    anticipation: 0,
    phone: 0,
    phraseAge: 99,
    barSec: 60 / TEST_BPM / 0.25,
    waveFromLeft: true,
  };

  it("builds a deterministic crowd with one lead dancer", () => {
    const crowd = makeCrowd(12);
    expect(crowd).toHaveLength(12);
    expect(crowd.filter((dancer) => dancer.personality === "lead")).toHaveLength(1);
    expect(makeCrowd(12)).toEqual(crowd);
    expect(makeCrowd(100)).toHaveLength(40);
  });

  it("poses are finite, arms rise through a build, jumps follow the burst, the floor lifts the crowd", () => {
    const [seed] = makeCrowd(4);
    if (!seed) throw new Error("no dancer");
    const pose = dancerPose(seed, input);
    for (const value of Object.values(pose)) expect(Number.isFinite(value)).toBe(true);
    expect(armTarget("build", 2, 0, 0)).toBeGreaterThan(armTarget("build", 14, 0, 0));
    expect(armTarget("drop", 0, 0, 1)).toBeGreaterThan(armTarget("break", 0, 0, 1));
    const jumping = dancerPose(seed, { ...input, burst: 1 });
    expect(jumping.y).toBeLessThan(pose.y - 30);
    const floating = dancerPose(seed, { ...input, floor: 0 });
    expect(floating.y).toBeLessThan(pose.y - 20);
    const calm = dancerPose(seed, { ...input, reduced: true, burst: 1 });
    expect(calm.jump).toBe(0);
    const hand = handPoint(pose, 1);
    expect(Number.isFinite(hand.x) && Number.isFinite(hand.y)).toBe(true);
  });

  it("lives the sections: phones in a break, a wave across the floor, stillness before a drop", () => {
    const crowd = makeCrowd(22);
    const carrier = crowd.find((dancer) => hasPhone(dancer)) as DancerSeed;
    const leader = crowd.find((dancer) => dancer.personality === "lead") as DancerSeed;
    // Phones go up in a break and nowhere else; the lead never carries one.
    expect(phoneTarget("break")).toBe(1);
    expect(phoneTarget("drop")).toBe(0);
    expect(phoneTarget("body")).toBe(0);
    expect(hasPhone(leader)).toBe(false);
    expect(dancerPose(carrier, { ...input, section: "break", phone: 1 }).phone).toBe(1);
    expect(dancerPose(carrier, { ...input, section: "body", phone: 0 }).phone).toBe(0);

    // The wave runs from the crossfader's side: a dancer further along waits longer.
    const sorted = [...crowd].filter((d) => d.personality !== "lead").sort((a, b) => a.slot - b.slot);
    const near = sorted[0] as DancerSeed;
    const far = sorted[sorted.length - 1] as DancerSeed;
    const wave = { ...input, phraseAge: 0.02 };
    expect(waveDelaySec(far, wave)).toBeGreaterThan(waveDelaySec(near, wave));
    expect(waveDelaySec(far, { ...wave, waveFromLeft: false })).toBeLessThan(waveDelaySec(far, wave));
    expect(waveHop(near, wave)).toBeGreaterThan(0);
    expect(waveHop(far, wave)).toBe(0);
    expect(waveHop(near, { ...wave, reduced: true })).toBe(0);
    expect(dancerPose(near, wave).y).toBeLessThan(dancerPose(near, { ...input, phraseAge: 99 }).y);

    // Anticipation: the bodies go still while the arms come up.
    const calm = dancerPose(carrier, { ...input, anticipation: 1 });
    const normal = dancerPose(carrier, { ...input, anticipation: 0 });
    expect(calm.armL).toBeGreaterThan(normal.armL);
    expect(Math.abs(calm.hipShift)).toBeLessThan(Math.abs(normal.hipShift));

    // Snares only lift the jumpers off the floor.
    const jumper = crowd.find((dancer) => dancer.personality === "jump") as DancerSeed;
    const bouncer = crowd.find((dancer) => dancer.personality === "bounce") as DancerSeed;
    expect(dancerPose(jumper, { ...input, snare: 1 }).y).toBeLessThan(
      dancerPose(jumper, { ...input, snare: 0 }).y,
    );
    expect(dancerPose(bouncer, { ...input, snare: 1 }).y).toBe(dancerPose(bouncer, { ...input, snare: 0 }).y);
  });

  it("sparks spread as the burst decays and vanish with it", () => {
    expect(sparkPoints(0, 1)).toHaveLength(0);
    const early = sparkPoints(0.95, 3);
    const late = sparkPoints(0.3, 3);
    const radius = (points: { x: number; y: number }[]) =>
      Math.max(...points.map((p) => Math.hypot(p.x, p.y + 40)));
    expect(radius(late)).toBeGreaterThan(radius(early));
    expect(Math.max(...late.map((p) => p.alpha))).toBeLessThan(Math.max(...early.map((p) => p.alpha)));
  });
});

describe("face", () => {
  const input = {
    t: 1,
    beatPhase: 0.2,
    barPhase: 0.4,
    kick: 0.6,
    snare: 0,
    hat: 0.3,
    bass: 0.5,
    snareCount: 0,
    intensity: 0.7,
    motion: 0.6,
    section: "body",
    barsToNext: 6,
    burst: 0,
    floor: 1,
    freeze: 0,
    balance: 0.5,
    reduced: false,
  };

  it("blinks on snares, opens its mouth with the bass, raises its brows through the build, and stays finite", () => {
    const state = initialFaceState();
    const rest = facePose(input, state);
    for (const value of Object.values(rest)) expect(Number.isFinite(value)).toBe(true);
    expect(rest.eyeOpen).toBeGreaterThan(0.9);
    facePose({ ...input, t: 1.02, snareCount: 1 }, state); // the snare starts a 140 ms blink
    const blink = facePose({ ...input, t: 1.09, snareCount: 1 }, state); // mid-blink
    expect(blink.eyeOpen).toBeLessThan(0.3);
    const after = facePose({ ...input, t: 1.3, snareCount: 1 }, state);
    expect(after.eyeOpen).toBeGreaterThan(0.9);
    const loud = facePose({ ...input, t: 1.5, bass: 0.95, kick: 1 }, state);
    expect(loud.mouthOpen).toBeGreaterThan(rest.mouthOpen);
    const build = facePose({ ...input, t: 2, section: "build", barsToNext: 2 }, state);
    expect(build.browRaise).toBeGreaterThan(rest.browRaise);
    const left = facePose({ ...input, t: 2.5, balance: 0 }, state);
    const right = facePose({ ...input, t: 2.6, balance: 1 }, state);
    expect(left.pupilX).toBeLessThan(right.pupilX);
    expect(mouthPath(loud)).toMatch(/^M-?[\d.]+ 0 Q/);
    const floating = facePose({ ...input, t: 3, floor: 0 }, state);
    expect(floating.y).toBeLessThan(rest.y - 20);
  });
});
