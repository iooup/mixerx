import { describe, expect, it } from "vitest";
import { scenesInCategory } from "../../src/agent/scenes";
import { Director } from "../../src/visuals/director";
import {
  type CinematicMotion,
  cinematicExposure,
  stepCinematicMotion,
} from "../../src/visuals/gpu/scenes/cinematic/motion";
import { DEFAULT_STAGE_SETTINGS, emptyFrame, F } from "../../src/visuals/protocol";

describe("cinematic music response", () => {
  it("never flashes on rapid kicks or drops even with the optional safety setting disabled", () => {
    for (const scene of scenesInCategory("cinematic")) {
      const director = new Director(scene.id);
      const frame = emptyFrame("cinematic");
      frame.onAir = "A";
      frame.section = "drop";
      frame.f[F.bpm] = 145;
      const settings = {
        ...DEFAULT_STAGE_SETTINGS,
        sceneId: scene.id,
        follow: false,
        photosensitiveSafe: false,
      };
      for (let i = 0; i < 180; i++) {
        const intent = director.update(
          frame,
          [
            { kind: "drop", t: i / 60 },
            { kind: "kick", t: i / 60 },
          ],
          settings,
          1 / 60,
        );
        expect(intent.flash).toBe(0);
        expect(intent.strobe).toBe(0);
        expect(intent.flashesLastSecond).toBe(0);
      }
    }
  });

  it("smooths bass, holds travel during silence and reduced motion, and bounds stalls", () => {
    const frame = emptyFrame("cinematic");
    const intent = new Director("cinematic-phoenix").update(frame, [], DEFAULT_STAGE_SETTINGS, 0);
    const state: CinematicMotion = { time: 0, energy: 0, bass: 0, treble: 0 };
    intent.intensity = 1;
    intent.audio.rms = 1;
    intent.audio.bass = 1;
    stepCinematicMotion(state, intent, 1 / 60);
    expect(state.bass).toBeGreaterThan(0);
    expect(state.bass).toBeLessThan(0.025);
    const before = state.time;
    intent.reducedMotion = true;
    for (let i = 0; i < 120; i++) stepCinematicMotion(state, intent, 1 / 60);
    expect(state.time).toBe(before);
    expect(state.bass).toBeLessThan(0.002);
    intent.reducedMotion = false;
    intent.audio.rms = 0;
    for (let i = 0; i < 600; i++) stepCinematicMotion(state, intent, 1 / 60);
    expect(state.time).toBe(before);
    expect(state.energy).toBeLessThan(0.0001);
    intent.audio.rms = 1;
    stepCinematicMotion(state, intent, 120);
    expect(state.time - before).toBeLessThan(0.031);
    expect(cinematicExposure(0)).toBe(0.72);
    expect(cinematicExposure(100)).toBe(0.94);
  });

  it("the shared intensity control changes motion in every category", () => {
    for (const sceneId of ["intro-lines", "line-waves", "cinematic-phoenix"]) {
      const outputs = [0, 1].map((intensity) => {
        const director = new Director(sceneId);
        const frame = emptyFrame("motion");
        frame.onAir = "A";
        frame.section = "body";
        let intent = director.update(
          frame,
          [],
          { ...DEFAULT_STAGE_SETTINGS, sceneId, intensity, follow: false },
          0,
        );
        for (let i = 0; i < 240; i++)
          intent = director.update(
            frame,
            [],
            { ...DEFAULT_STAGE_SETTINGS, sceneId, intensity, follow: false },
            1 / 60,
          );
        return intent.motion;
      });
      expect(outputs[1] as number).toBeGreaterThan((outputs[0] as number) * 3);
    }
  });
});
