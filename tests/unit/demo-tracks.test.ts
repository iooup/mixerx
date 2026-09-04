import { describe, expect, it } from "vitest";
import {
  DEMO_TRACKS,
  type DemoTrackSpec,
  encodeWav,
  midiToHz,
  renderDemoTrack,
  sectionAtBar,
  trackBars,
  trackDurationSec,
} from "../../src/library/demo-tracks";

/** A short rate keeps the suite fast; the shape of the signal is what is under test. */
const RATE = 8000;

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

function barRange(spec: DemoTrackSpec, bar: number, rate: number): [number, number] {
  const secondsPerBar = (60 / spec.bpm) * 4;
  return [Math.round(bar * secondsPerBar * rate), Math.round((bar + 1) * secondsPerBar * rate)];
}

/** The renders under test always have two channels; this keeps the assertions readable. */
function channel(spec: DemoTrackSpec, index: number, rate: number): Float32Array {
  const rendered = renderDemoTrack(spec, rate)[index];
  if (!rendered) throw new Error(`missing channel ${index}`);
  return rendered;
}

describe("demo tracks", () => {
  it("ships two tracks that are mixable by tempo and key", () => {
    expect(DEMO_TRACKS).toHaveLength(2);
    const [a, b] = DEMO_TRACKS;
    if (!a || !b) throw new Error("expected two demo tracks");
    expect(Math.abs(a.bpm - b.bpm)).toBeLessThanOrEqual(6);
    // 8A and 8B are the same seven notes: the pair demonstrates a harmonic blend.
    expect(a.camelot).toBe("8A");
    expect(b.camelot).toBe("8B");
    for (const spec of DEMO_TRACKS) {
      expect(spec.fileName).toMatch(/^Mixerx - .+\.wav$/);
      expect(trackBars(spec)).toBe(40);
      // Long enough to cue, blend and leave.
      expect(trackDurationSec(spec)).toBeGreaterThan(70);
      expect(trackDurationSec(spec)).toBeLessThan(90);
    }
  });

  it("lays the sections out in order with no gap or overlap", () => {
    for (const spec of DEMO_TRACKS) {
      expect(spec.sections.map((s) => s.name)).toEqual(["intro", "build", "drop", "break", "outro"]);
      let cursor = 0;
      for (const section of spec.sections) {
        expect(section.fromBar).toBe(cursor);
        expect(section.toBar).toBeGreaterThan(section.fromBar);
        cursor = section.toBar;
      }
      expect(sectionAtBar(spec, 0)).toBe("intro");
      expect(sectionAtBar(spec, 20)).toBe("drop");
      expect(sectionAtBar(spec, 30)).toBe("break");
    }
  });

  it("renders deterministically, in range, and at the right length", () => {
    const spec = DEMO_TRACKS[0];
    if (!spec) throw new Error("expected a demo track");
    const first = renderDemoTrack(spec, RATE);
    const second = renderDemoTrack(spec, RATE);
    expect(first).toHaveLength(2);
    expect(first[0]?.length).toBe(Math.round(trackDurationSec(spec) * RATE));
    expect(first[0]).toEqual(second[0]);
    expect(first[1]).toEqual(second[1]);
    let peak = 0;
    for (const value of channel(spec, 0, RATE)) peak = Math.max(peak, Math.abs(value));
    expect(peak).toBeLessThanOrEqual(1);
    // Loud enough to be a track, not so loud it clips into the limiter all night.
    expect(peak).toBeGreaterThan(0.4);
  });

  it("the drop is louder than the break, and the break is not silent", () => {
    for (const spec of DEMO_TRACKS) {
      const left = channel(spec, 0, RATE);
      const [dropFrom, dropTo] = barRange(spec, 20, RATE);
      const [breakFrom, breakTo] = barRange(spec, 30, RATE);
      const [introFrom, introTo] = barRange(spec, 1, RATE);
      const drop = rms(left, dropFrom, dropTo);
      const quiet = rms(left, breakFrom, breakTo);
      const intro = rms(left, introFrom, introTo);
      expect(drop).toBeGreaterThan(quiet * 1.3);
      expect(quiet).toBeGreaterThan(0.01);
      expect(drop).toBeGreaterThan(intro);
    }
  });

  it("puts a kick transient on every beat of the drop", () => {
    const spec = DEMO_TRACKS[0];
    if (!spec) throw new Error("expected a demo track");
    const left = channel(spec, 0, RATE);
    const secondsPerBeat = 60 / spec.bpm;
    // Compare the 12 ms around each beat against the sample just before it.
    for (let beat = 80; beat < 92; beat += 1) {
      const at = Math.round(beat * secondsPerBeat * RATE);
      const onset = rms(left, at, at + Math.round(0.012 * RATE));
      const before = rms(left, at - Math.round(0.02 * RATE), at - Math.round(0.006 * RATE));
      expect(onset).toBeGreaterThan(before);
    }
  });

  it("converts MIDI to pitch at concert A", () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(57)).toBeCloseTo(220, 6);
    expect(midiToHz(45)).toBeCloseTo(110, 6);
  });

  it("encodes a WAV header a decoder will accept", () => {
    const channels = [new Float32Array([0, 0.5, -0.5, 1]), new Float32Array([0, -0.5, 0.5, -1])];
    const buffer = encodeWav(channels, 44_100);
    const view = new DataView(buffer);
    const text = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(buffer, offset, length));

    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(12, 4)).toBe("fmt ");
    expect(text(36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16); // bit depth
    expect(view.getUint32(40, true)).toBe(4 * 2 * 2); // frames × channels × 2 bytes
    expect(buffer.byteLength).toBe(44 + 16);
    // Interleaved L,R per frame; full scale survives the round trip at the last frame.
    expect(view.getInt16(44, true)).toBe(0); // frame 0 left
    expect(view.getInt16(50, true)).toBe(-16384); // frame 1 right, −0.5
    expect(view.getInt16(56, true)).toBe(0x7fff); // frame 3 left, +1
    expect(view.getInt16(58, true)).toBe(-0x8000); // frame 3 right, −1
  });
});
