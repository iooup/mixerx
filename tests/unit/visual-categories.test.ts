import { describe, expect, it } from "vitest";
import { canBlendScenes, sceneById, sceneCategory, sceneFor, scenesInCategory } from "../../src/agent/scenes";
import { Director } from "../../src/visuals/director";
import { followScene } from "../../src/visuals/follow";
import { type LineMotion, stepLineMotion } from "../../src/visuals/gpu/scenes/line-motion";
import {
  DEFAULT_STAGE_SETTINGS,
  emptyFrame,
  F,
  presetPatch,
  sanitisePreset,
  sanitiseSettings,
} from "../../src/visuals/protocol";

const settings = { ...DEFAULT_STAGE_SETTINGS, follow: false };
const bar = [{ kind: "bar" as const, t: 0 }];

describe("visual categories", () => {
  it("partitions every look and keeps automatic suggestions inside the chosen category", () => {
    expect(scenesInCategory("classic")).toHaveLength(8);
    expect(scenesInCategory("simple")).toHaveLength(4);
    expect(scenesInCategory("cinematic")).toHaveLength(4);
    for (const category of ["classic", "simple", "cinematic"] as const) {
      for (const section of ["intro", "build", "drop", "break", "body", "outro"] as const) {
        for (const energy of [0, 0.5, 1]) {
          expect(sceneFor(section, energy * 10, category).category).toBe(category);
          for (const variant of [-1, 0, 1, 7]) {
            const id = followScene(section, energy, variant, category);
            expect(id && sceneById(id)?.category).toBe(category);
          }
        }
      }
    }
    expect(canBlendScenes("line-waves", "line-orbits")).toBe(true);
    expect(canBlendScenes("line-waves", "intro-lines")).toBe(false);
    expect(canBlendScenes("line-waves", "blackout")).toBe(false);
    expect(canBlendScenes("missing", "missing")).toBe(false);
  });

  for (const transition of ["dissolve", "wipe"] as const) {
    it(`${transition} cuts between categories in both directions at the boundary`, () => {
      for (const [from, to] of [
        ["intro-lines", "line-waves"],
        ["line-orbits", "build-rise"],
        ["line-waves", "cinematic-phoenix"],
        ["cinematic-gate", "intro-lines"],
      ]) {
        const director = new Director(from);
        const frame = emptyFrame("category");
        frame.f[F.bpm] = 128;
        frame.onAir = "A";
        const next = { ...settings, sceneId: to as string, transition };
        const pending = director.update(frame, [], next, 1 / 60);
        expect(pending.sceneId).toBe(from);
        expect(pending.pendingSceneId).toBe(to);
        expect(pending.transition).toBeNull();
        const applied = director.update(frame, bar, next, 1 / 60);
        expect(applied.sceneId).toBe(to);
        expect(applied.transition).toBeNull();
      }
    });

    it(`${transition} still blends within each category and safely interrupts an active blend`, () => {
      for (const [from, to, other] of [
        ["intro-lines", "build-rise", "line-waves"],
        ["line-waves", "line-orbits", "intro-lines"],
        ["cinematic-phoenix", "cinematic-gate", "line-waves"],
      ]) {
        const director = new Director(from);
        const frame = emptyFrame("category");
        const blending = director.update(
          frame,
          bar,
          { ...settings, sceneId: to as string, transition },
          1 / 60,
        );
        expect(blending.transition).toMatchObject({ from, to, kind: transition });
        const changed = director.update(
          frame,
          bar,
          { ...settings, sceneId: other as string, transition },
          1 / 60,
        );
        expect(changed.sceneId).toBe(other);
        expect(changed.transition).toBeNull();
      }
    });
  }

  it("cuts while paused, and carries the category through stored settings and preset recall", () => {
    const preset = sanitisePreset({
      name: "Quiet rings",
      sceneId: "line-orbits",
      transition: "wipe",
      intensity: 0.6,
    });
    if (!preset) throw new Error("Simple preset must be accepted");
    const restored = sanitiseSettings(JSON.parse(JSON.stringify({ ...settings, presets: [preset] })));
    const next = sanitiseSettings({ ...restored, ...presetPatch(preset, restored) });
    expect(sceneCategory(next.sceneId)).toBe("simple");
    const director = new Director("intro-lines");
    const frame = emptyFrame("paused");
    frame.f[F.bpm] = 128;
    for (let i = 0; i < 60; i++) {
      const intent = director.update(frame, [], next, 1 / 60);
      expect(intent.transition).toBeNull();
    }
    expect(director.scene).toBe("line-orbits");
    const dark = director.update(frame, [], { ...next, blackout: true }, 1 / 60);
    expect(dark.sceneId).toBe("blackout");
    expect(dark.transition).toBeNull();
    expect(director.update(frame, [], next, 1 / 60).sceneId).toBe("line-orbits");
  });
});

describe("simple line motion", () => {
  it("eases musical changes, holds travel in silence or reduced motion, and bounds a stalled frame", () => {
    const frame = emptyFrame("lines");
    const intent = new Director("line-waves").update(frame, [], { ...settings, sceneId: "line-waves" }, 0);
    const state: LineMotion = { time: 0, energy: 0.15, bass: 0 };
    intent.audio.rms = 0.8;
    intent.audio.bass = 1;
    intent.intensity = 1;
    stepLineMotion(state, intent, 1 / 60);
    expect(state.time).toBeGreaterThan(0);
    expect(state.bass).toBeGreaterThan(0);
    expect(state.bass).toBeLessThan(0.03);
    const before = state.time;
    intent.reducedMotion = true;
    stepLineMotion(state, intent, 1 / 60);
    expect(state.time).toBe(before);
    intent.reducedMotion = false;
    intent.audio.rms = 0;
    for (let i = 0; i < 600; i++) stepLineMotion(state, intent, 1 / 60);
    expect(state.time).toBe(before);
    expect(state.energy).toBeCloseTo(0.15, 4);
    expect(state.bass).toBeCloseTo(0, 4);
    intent.audio.rms = 1;
    stepLineMotion(state, intent, 100);
    expect(state.time - before).toBeLessThan(0.03);
  });
});
