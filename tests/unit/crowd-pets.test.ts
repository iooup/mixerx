import { describe, expect, it } from "vitest";
import { DEFAULT_CROWD_LAYOUT, PET_IDS, sanitiseCrowdLayout } from "../../src/visuals/crowd/characters";
import { type DancerSeed, makeCrowd } from "../../src/visuals/crowd/crowd-math";
import { petFormation } from "../../src/visuals/crowd/pet-formation";
import { PetMotion, petPose, REST_POSE } from "../../src/visuals/crowd/pet-motion";
import { Director, type Intent } from "../../src/visuals/director";
import {
  DEFAULT_STAGE_SETTINGS,
  presetPatch,
  sanitisePreset,
  sanitiseSettings,
  settingsEqual,
} from "../../src/visuals/protocol";
import {
  readStoredStageSettings,
  reduceStageSettings,
  STAGE_STORAGE_KEY,
} from "../../src/visuals/settings-store";
import { TestSignal } from "../../src/visuals/test-signal";

const leader = makeCrowd(10)[0] as DancerSeed;
const frame = new TestSignal("pets", 32).next(1 / 60);
const live = new Director().update(frame, frame.events, DEFAULT_STAGE_SETTINGS, 1 / 60);

describe("pet choreography", () => {
  it("keeps every animation in a populated sprite cell through a complete set", () => {
    const director = new Director();
    const signal = new TestSignal("pets");
    const rowLengths = [6, 8, 8, 4, 5];
    const visited = new Set<number>();
    for (let i = 0; i < 240; i++) {
      const next = signal.next(0.25);
      const intent = director.update(next, next.events, DEFAULT_STAGE_SETTINGS, 0.25);
      for (const pet of PET_IDS) {
        for (const seed of makeCrowd(10)) {
          const pose = petPose(pet, seed, intent);
          visited.add(pose.row);
          expect(pose.column).toBeGreaterThanOrEqual(0);
          expect(pose.column).toBeLessThan(rowLengths[pose.row] as number);
          expect(
            Object.values(pose)
              .filter((value) => typeof value === "number")
              .every(Number.isFinite),
          ).toBe(true);
        }
      }
    }
    expect([...visited].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("uses a still neutral frame for silence, reduced motion and blackout", () => {
    for (const patch of [{ onAir: "none" }, { reducedMotion: true }, { blackout: true }]) {
      for (const pet of PET_IDS) {
        expect(petPose(pet, leader, { ...live, ...patch } as Intent)).toEqual(REST_POSE);
      }
    }
  });

  it("changes frames with the musical phase and has a distinct groove for each pet", () => {
    const intent: Intent = {
      ...live,
      onAir: "A",
      section: "body",
      burst: 0,
      anticipation: 0,
      reducedMotion: false,
      beat: { ...live.beat, beatIndex: 4, phase: 0.2, bpm: 128, barIndex: 1 },
    };
    const a = petPose("codex", leader, intent);
    const b = petPose("codex", leader, { ...intent, beat: { ...intent.beat, phase: 0.8 } });
    expect(a.column).not.toBe(b.column);
    expect(petPose("codex", leader, intent)).toEqual(a);
    expect(new Set(PET_IDS.map((id) => JSON.stringify(petPose(id, leader, intent)))).size).toBe(4);
  });
});

describe("crowd choices", () => {
  it("migrates old settings, validates identifiers, and preserves each scene's choice", () => {
    expect(sanitiseSettings({ crowdScenes: ["face"] }).crowdStyles).toEqual({});
    const state = sanitiseSettings({
      crowdStyles: {
        face: "codex",
        cubes: "hoots",
        unknown: "dario",
        "drop-burst": "https://external.test/pet.webp",
      },
    });
    expect(state.crowdStyles).toEqual({ face: "codex", cubes: "hoots" });
    const changed = reduceStageSettings(state, {
      type: "stage/patch",
      patch: { crowdStyles: { ...state.crowdStyles, face: "fireball" } },
    });
    expect(changed.crowdStyles).toEqual({ face: "fireball", cubes: "hoots" });
    expect(settingsEqual(state, changed)).toBe(false);
    expect(settingsEqual(changed, sanitiseSettings(changed))).toBe(true);
    const storage = {
      getItem: (key: string) => (key === STAGE_STORAGE_KEY ? JSON.stringify(changed) : null),
    } as Storage;
    expect(readStoredStageSettings(storage).crowdStyles).toEqual(changed.crowdStyles);
  });

  it("presets restore the chosen character without replacing another scene's crowd", () => {
    const state = sanitiseSettings({
      crowdStyles: { face: "codex", cubes: "hoots" },
      crowdScenes: ["face"],
    });
    const preset = sanitisePreset({
      name: "Fire dance",
      sceneId: "cubes",
      crowd: true,
      crowdStyle: "fireball",
    });
    expect(preset).not.toBeNull();
    const next = sanitiseSettings({ ...state, ...presetPatch(preset as NonNullable<typeof preset>, state) });
    expect(next.crowdStyles).toEqual({ face: "codex", cubes: "fireball" });
    expect(next.crowdScenes).toEqual(["cubes", "face"]);
    expect(sanitisePreset({ name: "Old", sceneId: "cubes" })?.crowdStyle).toBe("classic");
  });
});

describe("pet rhythm and formation refinements", () => {
  const playing = (patch: Partial<Intent> = {}): Intent => ({
    ...live,
    onAir: "A",
    section: "body",
    burst: 0,
    anticipation: 0,
    freeze: 0,
    reducedMotion: false,
    beat: { ...live.beat, beatIndex: 2, phase: 0.3, bpm: 120 },
    audio: { ...live.audio, kick: 0, snare: 0, rms: 0.6, bass: 0.5 },
    ...patch,
  });

  it("answers actual kicks with a landing and snares with a raised-hand pose", () => {
    const base = playing();
    for (const pet of PET_IDS) {
      const neutral = petPose(pet, leader, base);
      const kick = petPose(pet, leader, { ...base, audio: { ...base.audio, kick: 1 } });
      const snare = petPose(pet, leader, { ...base, audio: { ...base.audio, snare: 1 } });
      expect(kick.y).toBeGreaterThan(neutral.y);
      expect(kick.stretch).toBeGreaterThan(neutral.stretch);
      expect(snare.move).toBe("wave");
      expect(snare.row).toBe(3);
      expect(snare.column).toBe(3);
      expect(petPose(pet, leader, playing({ section: "drop", burst: 0.8 })).move).toBe("jump");
    }
  });

  it("smooths changes, holds the complete pose in a loop, and releases to stillness", () => {
    const motion = new PetMotion();
    motion.configure("codex", 12);
    const first = motion.update("codex", leader, playing(), 1 / 60);
    const changed = playing({ burst: 0.8, section: "drop" });
    const target = petPose("codex", leader, changed);
    const smooth = motion.update("codex", leader, changed, 1 / 120);
    expect(Math.abs(smooth.y - first.y)).toBeLessThan(Math.abs(target.y - first.y));
    expect(motion.update("codex", leader, playing({ freeze: 1 }), 1)).toEqual(smooth);
    expect(motion.update("codex", leader, playing({ freeze: 1, reducedMotion: true }), 1)).toEqual(REST_POSE);
    motion.configure("fireball", 4);
    expect(motion.update("fireball", leader, changed, 1 / 60)).toEqual(petPose("fireball", leader, changed));
  });

  it("keeps choreography on musical phase at different tempos", () => {
    const base = playing();
    for (const bpm of [90, 128, 160]) {
      expect(petPose("dario", leader, { ...base, beat: { ...base.beat, bpm } })).toEqual(
        petPose("dario", leader, base),
      );
    }
  });

  it("fits every dancer, preserves requested counts and includes all four in mixed mode", () => {
    for (const aspect of [0.35, 564 / 680, 892 / 812, 16 / 9, 2.5]) {
      for (const count of [4, 8, 10]) {
        for (const size of [0.65, 1, 1.4]) {
          for (const spacing of [0.6, 1, 1.5]) {
            const formation = petFormation("mixed", { count, size, spacing }, aspect);
            expect(formation).toHaveLength(count);
            expect(new Set(formation.map((d) => d.character))).toEqual(new Set(PET_IDS));
            for (const dancer of formation) {
              expect(dancer.x - dancer.size * 130).toBeGreaterThanOrEqual(0);
              expect(dancer.x + dancer.size * 130).toBeLessThanOrEqual(900 * aspect);
              expect(dancer.ground - dancer.size * 290).toBeGreaterThan(0);
              expect(dancer.ground + dancer.size * 30).toBeLessThan(900);
            }
          }
        }
      }
    }
  });

  it("bounds layout input and restores mixed formations through settings and presets", () => {
    expect(sanitiseCrowdLayout({ count: Infinity, size: NaN })).toEqual(DEFAULT_CROWD_LAYOUT);
    expect(sanitiseCrowdLayout({ count: 99, size: -1, spacing: 9 })).toEqual({
      count: 10,
      size: 0.65,
      spacing: 1.5,
    });
    const state = sanitiseSettings({
      crowdStyles: { face: "mixed" },
      crowdLayouts: { face: { count: 20, size: 1.2, spacing: 0.8 }, unknown: { count: 4 } },
    });
    expect(Object.keys(state.crowdLayouts)).toEqual(["face"]);
    expect(state.crowdLayouts.face?.count).toBe(10);
    const legacy = { crowdLayouts: { face: { count: 32, size: 1, spacing: 1 } } };
    const storage = { getItem: () => JSON.stringify(legacy) } as unknown as Storage;
    expect(readStoredStageSettings(storage).crowdLayouts.face?.count).toBe(10);
    const preset = sanitisePreset({
      name: "Mixed",
      sceneId: "face",
      crowd: true,
      crowdStyle: "mixed",
      crowdLayout: { ...state.crowdLayouts.face, count: 32 },
    });
    const restored = sanitiseSettings({
      ...state,
      ...presetPatch(preset as NonNullable<typeof preset>, state),
    });
    expect(restored.crowdStyles.face).toBe("mixed");
    expect(restored.crowdLayouts.face).toEqual(state.crowdLayouts.face);
    expect(
      settingsEqual(
        state,
        reduceStageSettings(state, {
          type: "stage/patch",
          patch: { crowdLayouts: { face: { count: 4, size: 1, spacing: 1 } } },
        }),
      ),
    ).toBe(false);
    expect(sanitiseSettings({ crowdStyles: { face: "codex" } }).crowdLayouts).toEqual({});
  });
});

describe("paused audio scene selection", () => {
  it("finishes a scene change while a loaded deck has BPM but no bar events", () => {
    const director = new Director("body-pulse");
    const paused = { ...frame, onAir: "none" as const, events: [] };
    const settings = sanitiseSettings({
      sceneId: "build-rise",
      crowdScenes: ["build-rise"],
      crowdStyles: { "build-rise": "mixed" },
    });
    let intent = director.update(paused, [], settings, 0.05);
    for (let i = 0; i < 140; i++) intent = director.update(paused, [], settings, 0.05);
    expect(intent.sceneId).toBe("build-rise");
    expect(intent.transition).toBeNull();
    expect(intent.crowd).toBe(true);
  });
});
