import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  initialTakeover,
  MIDI_TARGETS,
  sanitiseMaps,
  scaleForTarget,
  softTakeover,
  targetById,
  targetFor,
  unitForTarget,
  value01,
} from "../../src/midi/mapping";
import { ARC_CAP, ARC_INTERVAL_MS, NightArc } from "../../src/state/night-arc";
import { normalise, rank, score } from "../../src/ui/palette/matcher";
import { awardLesson, buildRecap, emptyBadges, recapJson } from "../../src/ui/recap/recap-model";
import type { NightEntry } from "../../src/visuals/protocol";

describe("command palette matcher", () => {
  it("matches subsequences and rewards the starts of words", () => {
    expect(score("as", "Apply scene")).not.toBeNull();
    expect(score("zz", "Apply scene")).toBeNull();
    expect(score("", "anything")).toBe(0);
    // A hit at the start of a word beats the same letters buried mid-word.
    const atStart = score("sc", "Apply scene") as number;
    const buried = score("sc", "Miscellaneous") as number;
    expect(atStart).toBeGreaterThan(buried);
    // A short label wins over a long one containing the same query.
    expect(score("end", "End set") as number).toBeGreaterThan(
      score("end", "End set and write a very long recap of the night") as number,
    );
  });

  it("folds case and Latin diacritics so a title is findable as typed", () => {
    expect(normalise("Café")).toBe(normalise("cafe"));
    expect(normalise("Björk")).toBe(normalise("bjork"));
    expect(score("HANDS", "hands up")).not.toBeNull();
    // A DJ types "cafe", the file says "Café".
    expect(score("cafe", "Café del Mar")).not.toBeNull();
  });

  it("ranks by score, then by the order it was given, and honours the weight", () => {
    const items = [
      { id: "a", haystack: "Apply scene" },
      { id: "b", haystack: "Apply preset" },
      { id: "c", haystack: "Something else entirely" },
    ];
    const ranked = rank("apply", items);
    expect(ranked.map((item) => item.id)).toEqual(["a", "b"]);
    // A recently used command comes first when the scores are close.
    const weighted = rank("apply", [items[0] as (typeof items)[0], { ...items[1], weight: 40 } as never]);
    expect(weighted[0]?.id).toBe("b");
    expect(rank("", items)).toHaveLength(3);
    expect(rank("apply", items, 1)).toHaveLength(1);
  });
});

describe("night arc", () => {
  it("samples at most once an interval and never grows past an hour", () => {
    const arc = new NightArc();
    expect(arc.sample(0, 0.5, "body", "t1")).toBe(true);
    expect(arc.sample(500, 0.5, "body", "t1")).toBe(false);
    expect(arc.sample(ARC_INTERVAL_MS, 0.6, "body", "t1")).toBe(true);
    expect(arc.length).toBe(2);
    // The first sample of a track is its boundary tick; later ones are not.
    expect(arc.samples[0]?.boundary).toBe(true);
    expect(arc.samples[1]?.boundary).toBe(false);
    expect(arc.sample(ARC_INTERVAL_MS * 2, 0.9, "drop", "t2")).toBe(true);
    expect(arc.samples[2]?.boundary).toBe(true);
    expect(arc.energyOf("t1")).toBeCloseTo(0.55, 5);
    expect(arc.energyOf("nope")).toBeNull();
    // Energy is clamped, and the ring drops the oldest hour.
    for (let i = 3; i < ARC_CAP + 60; i += 1) arc.sample(ARC_INTERVAL_MS * i, 5, "body", "t2");
    expect(arc.length).toBe(ARC_CAP);
    expect(arc.samples[arc.length - 1]?.energy).toBe(1);
    arc.clear();
    expect(arc.length).toBe(0);
  });
});

describe("session recap", () => {
  const entry = (id: string, startedAt: number, energy = 5): NightEntry => ({
    id,
    title: `Track ${id}`,
    artist: "Someone",
    camelot: "8A",
    bpm: 128,
    startedAt,
    energy,
  });

  it("builds the night from the running order and what was actually heard", () => {
    const arc = new NightArc();
    arc.sample(1000, 0.4, "intro", "a");
    arc.sample(3000, 0.6, "body", "a");
    arc.sample(5000, 0.9, "drop", "b");
    const recap = buildRecap([entry("a", 1000), entry("b", 5000, 3)], arc.samples, emptyBadges(), 5000);
    expect(recap.tracks).toHaveLength(2);
    expect(recap.transitions).toBe(1);
    // Track a was heard at 0.4 and 0.6 → 5/10; track b's own energy is overridden by 0.9 → 9/10.
    expect(recap.tracks[0]?.energy).toBe(5);
    expect(recap.tracks[1]?.energy).toBe(9);
    expect(recap.tracks[0]?.minutes).toBeCloseTo(4 / 60, 5);
    expect(recap.peak?.energy).toBeCloseTo(0.9, 5);
    expect(recap.minutes).toBeCloseTo(4 / 60, 5);
    // An empty night is a recap too, not a crash.
    const empty = buildRecap([], [], emptyBadges(), 1000);
    expect(empty.tracks).toEqual([]);
    expect(empty.transitions).toBe(0);
    expect(empty.meanEnergy).toBe(0);
    // The export carries titles and numbers, and no ids or paths.
    const json = JSON.parse(recapJson(recap)) as { tracks: { title: string }[] };
    expect(json.tracks[0]?.title).toBe("Track a");
    expect(recapJson(recap)).not.toContain('"id"');
  });

  it("awards badges and counts a practice streak by calendar day", () => {
    const day = (iso: string) => new Date(`${iso}T20:00:00`).getTime();
    let state = awardLesson(
      emptyBadges(),
      { alignmentMs: 22, blendBars: 9, bassSwapOnBeatOne: true },
      day("2026-09-01"),
    );
    expect(state.earned).toContain("first-blend");
    expect(state.earned).toContain("clean-swap");
    expect(state.earned).toContain("patient");
    expect(state.earned).not.toContain("tight");
    expect(state.streak).toBe(1);
    expect(state.bestAlignmentMs).toBe(22);
    // The same day again does not extend the streak; the next day does.
    state = awardLesson(
      state,
      { alignmentMs: 30, blendBars: 4, bassSwapOnBeatOne: false },
      day("2026-09-01"),
    );
    expect(state.streak).toBe(1);
    expect(state.bestAlignmentMs).toBe(22);
    state = awardLesson(state, { alignmentMs: 8, blendBars: 4, bassSwapOnBeatOne: false }, day("2026-09-02"));
    expect(state.streak).toBe(2);
    expect(state.earned).toContain("tight");
    expect(state.bestAlignmentMs).toBe(8);
    state = awardLesson(
      state,
      { alignmentMs: 12, blendBars: 4, bassSwapOnBeatOne: false },
      day("2026-09-03"),
    );
    expect(state.streak).toBe(3);
    expect(state.earned).toContain("streak-3");
    // A gap starts again from one, and nothing already earned is taken away.
    state = awardLesson(
      state,
      { alignmentMs: 12, blendBars: 4, bassSwapOnBeatOne: false },
      day("2026-09-08"),
    );
    expect(state.streak).toBe(1);
    expect(state.earned).toContain("streak-3");
  });
});

describe("MIDI mapping", () => {
  it("decodes the messages it maps and ignores the rest", () => {
    expect(decodeMessage([0xb0, 31, 64])).toEqual({ kind: "cc", channel: 0, number: 31, value: 64 });
    expect(decodeMessage([0x95, 40, 100])).toEqual({ kind: "note-on", channel: 5, number: 40, value: 100 });
    // A note-on with velocity 0 is a note-off, as every controller intends.
    expect(decodeMessage([0x90, 40, 0])?.kind).toBe("note-off");
    expect(decodeMessage([0x80, 40, 64])?.kind).toBe("note-off");
    expect(decodeMessage([0xe0, 0, 64])).toBeNull(); // pitch bend
    expect(decodeMessage([0xf8])).toBeNull(); // clock
  });

  it("finds the target a message is bound to", () => {
    const map = {
      "mixer.crossfader": { kind: "cc" as const, channel: 6, number: 31 },
      "deck.A.play": { kind: "note" as const, channel: 0, number: 11 },
    };
    expect(targetFor(map, { kind: "cc", channel: 6, number: 31, value: 5 })).toBe("mixer.crossfader");
    expect(targetFor(map, { kind: "note-on", channel: 0, number: 11, value: 100 })).toBe("deck.A.play");
    // A note-off is the same binding: the router decides what to do with it, not the map.
    expect(targetFor(map, { kind: "note-off", channel: 0, number: 11, value: 0 })).toBe("deck.A.play");
    expect(targetFor(map, { kind: "cc", channel: 0, number: 31, value: 5 })).toBeNull();
  });

  it("holds a knob back until it reaches the software value, then follows it", () => {
    let state = initialTakeover();
    // The software crossfader is at 0.5 and the hardware is at 0: nothing moves.
    let step = softTakeover(state, 0, 0.5);
    state = step.state;
    expect(step.value).toBeNull();
    step = softTakeover(state, 0.3, 0.5);
    state = step.state;
    expect(step.value).toBeNull();
    // Reaching it (within the tolerance) takes control.
    step = softTakeover(state, 0.49, 0.5);
    state = step.state;
    expect(step.value).toBeCloseTo(0.49, 5);
    // From then on it follows, wherever it goes.
    step = softTakeover(state, 0.05, 0.49);
    expect(step.value).toBeCloseTo(0.05, 5);

    // Crossing counts too: a fast move that steps over the value takes control on that step.
    let jump = initialTakeover();
    jump = softTakeover(jump, 0.1, 0.5).state;
    const crossed = softTakeover(jump, 0.9, 0.5);
    expect(crossed.value).toBeCloseTo(0.9, 5);
    expect(crossed.state.armed).toBe(true);
  });

  it("scales a 7-bit value into each control's own range, and back", () => {
    expect(value01(0)).toBe(0);
    expect(value01(127)).toBe(1);
    expect(scaleForTarget("mixer.crossfader", 0.25)).toBeCloseTo(0.25, 5);
    expect(scaleForTarget("strip.A.eqLow", 0)).toBeCloseTo(-26, 5);
    expect(scaleForTarget("strip.A.eqLow", 1)).toBeCloseTo(12, 5);
    expect(scaleForTarget("strip.B.filter", 0.5)).toBeCloseTo(0, 5);
    expect(scaleForTarget("strip.B.trim", 0.5)).toBeCloseTo(0, 5);
    // Round trip: the unit a control is at now is what soft takeover compares against.
    for (const id of ["strip.A.eqLow", "strip.A.trim", "strip.A.filter", "mixer.master"])
      expect(unitForTarget(id, scaleForTarget(id, 0.3))).toBeCloseTo(0.3, 5);
  });

  it("keeps only mappings it can honour when reading them back", () => {
    const clean = sanitiseMaps({
      "Some controller": {
        "mixer.crossfader": { kind: "cc", channel: 6, number: 31 },
        "made.up.control": { kind: "cc", channel: 0, number: 1 },
        "deck.A.play": { kind: "sysex", channel: 0, number: 1 },
        "deck.B.play": { kind: "note", channel: 99, number: 1 },
        "deck.B.cue": { kind: "note", channel: 0, number: 900 },
      },
      "Empty controller": {},
      bogus: 5,
    });
    expect(Object.keys(clean)).toEqual(["Some controller"]);
    expect(Object.keys(clean["Some controller"] ?? {})).toEqual(["mixer.crossfader"]);
    expect(sanitiseMaps(null)).toEqual({});
    expect(sanitiseMaps("nope")).toEqual({});
  });

  it("offers every console control the plan names, with stable ids", () => {
    const ids = MIDI_TARGETS.map((target) => target.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "mixer.crossfader",
      "strip.A.fader",
      "strip.B.eqLow",
      "strip.A.filter",
      "deck.A.play",
      "deck.B.cue",
      "deck.A.sync",
      "deck.B.hotcue.7",
      "stage.intensity",
      "stage.blackout",
      "stage.crowd",
      "stage.scene.8",
      "stage.preset.8",
    ])
      expect(ids).toContain(id);
    expect(targetById("mixer.crossfader")?.kind).toBe("continuous");
    expect(targetById("deck.A.play")?.kind).toBe("trigger");
    expect(targetById("stage.blackout")?.kind).toBe("toggle");
    expect(targetById("nope")).toBeUndefined();
  });
});
