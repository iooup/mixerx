/**
 * Demo tracks, synthesised in the browser so a first-time visitor has something to mix.
 *
 * Nothing is bundled and nothing is fetched: the audio is generated from these functions at
 * runtime, wrapped in a `File`, and handed to the same `addFiles` path a dropped file takes, so it
 * goes through the real decode → beat grid → key → structure pipeline rather than carrying
 * pre-computed answers. The two tracks are written to be mixable: 124 and 128 BPM, A minor (8A)
 * and C major (8B) — the same note set, so a harmonic blend is audible.
 *
 * The output is original work owned by this project, which keeps the repository free of licensed
 * audio and lets a demo recording use the same music.
 */

const SAMPLE_RATE = 44_100;
const BEATS_PER_BAR = 4;

/** Deterministic noise, so a rendered track is byte-identical on every machine and in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export type SectionName = "intro" | "build" | "drop" | "break" | "outro";

export interface DemoSection {
  name: SectionName;
  /** First bar of the section, inclusive. */
  fromBar: number;
  /** One past the last bar. */
  toBar: number;
}

export interface DemoTrackSpec {
  fileName: string;
  bpm: number;
  /** Camelot notation, for the read-out the analysis should independently arrive at. */
  camelot: string;
  /** Root of each chord in the four-bar progression, as MIDI note numbers. */
  progression: readonly number[];
  sections: readonly DemoSection[];
  seed: number;
  /** Slight timbral difference so the two tracks are told apart by ear. */
  brightness: number;
}

/** 40 bars: long enough to cue, blend and leave, short enough to hold attention. */
const SECTIONS: readonly DemoSection[] = [
  { name: "intro", fromBar: 0, toBar: 8 },
  { name: "build", fromBar: 8, toBar: 16 },
  { name: "drop", fromBar: 16, toBar: 28 },
  { name: "break", fromBar: 28, toBar: 34 },
  { name: "outro", fromBar: 34, toBar: 40 },
];

export const DEMO_TRACKS: readonly DemoTrackSpec[] = [
  {
    // Am – Am – F – G: the tonic carries two bars and there is no C chord, so the key detector
    // has a reason to hear A as home rather than the relative major.
    fileName: "Mixerx - Neon Drift.wav",
    bpm: 124,
    camelot: "8A",
    progression: [45, 45, 41, 43],
    sections: SECTIONS,
    seed: 0x4d69_7845,
    brightness: 0.72,
  },
  {
    // C – Am – F – G: the same seven notes, a fifth of daylight apart.
    fileName: "Mixerx - Glass Tide.wav",
    bpm: 128,
    camelot: "8B",
    progression: [48, 45, 41, 43],
    sections: SECTIONS,
    seed: 0x476c_6173,
    brightness: 0.93,
  },
];

export function sectionAtBar(spec: DemoTrackSpec, bar: number): SectionName {
  for (const section of spec.sections) {
    if (bar >= section.fromBar && bar < section.toBar) return section.name;
  }
  return "outro";
}

export function trackBars(spec: DemoTrackSpec): number {
  return spec.sections[spec.sections.length - 1]?.toBar ?? 0;
}

export function trackDurationSec(spec: DemoTrackSpec): number {
  return (trackBars(spec) * BEATS_PER_BAR * 60) / spec.bpm;
}

/** Kick: a pitch sweep into the floor plus a click, so onset detection has an unambiguous edge. */
function kickAt(age: number): number {
  if (age < 0 || age > 0.42) return 0;
  const hz = 45 + 78 * Math.exp(-age * 42);
  const body = Math.sin(2 * Math.PI * hz * age) * Math.exp(-age * 7.4);
  const click = Math.exp(-age * 320) * 0.35;
  return body * 0.92 + click;
}

/** A saw folded down to a rounded pulse; cheap, and warm enough not to fatigue. */
function bassAt(age: number, hz: number, length: number): number {
  if (age < 0 || age > length) return 0;
  const phase = (hz * age) % 1;
  const saw = 2 * phase - 1;
  const round = saw - 0.32 * saw * saw * saw;
  const attack = Math.min(1, age * 220);
  const release = Math.min(1, (length - age) * 26);
  return round * attack * release * Math.exp(-age * 1.4);
}

function hatAt(age: number, noise: number, open: boolean): number {
  const length = open ? 0.16 : 0.045;
  if (age < 0 || age > length) return 0;
  return noise * Math.exp(-age / (length * 0.34));
}

function clapAt(age: number, noise: number): number {
  if (age < 0 || age > 0.24) return 0;
  // Three fast slaps then a tail, the way a clap actually reads.
  const slap = age < 0.012 ? 1 : age < 0.024 ? 0.7 : age < 0.036 ? 0.5 : 0;
  const tail = Math.exp(-age * 22) * 0.42;
  return noise * (slap + tail);
}

/** Chord bed: three detuned voices per note, which is what gives the key detector something real. */
function chordAt(age: number, roots: readonly number[], length: number, brightness: number): number {
  if (age < 0 || age > length) return 0;
  const attack = Math.min(1, age * 5.5);
  const release = Math.min(1, (length - age) * 4.5);
  let sum = 0;
  for (const midi of roots) {
    const hz = midiToHz(midi);
    sum += Math.sin(2 * Math.PI * hz * age);
    sum += Math.sin(2 * Math.PI * hz * 1.0018 * age) * 0.7;
    sum += Math.sin(2 * Math.PI * hz * 2 * age) * 0.22 * brightness;
  }
  return (sum / (roots.length * 2.2)) * attack * release;
}

/** A minor triad over the root, voiced close so the chords sit under the bass without clashing. */
function triad(root: number, major: boolean): number[] {
  const third = major ? 4 : 3;
  return [root + 24, root + 24 + third, root + 24 + 7];
}

interface Layers {
  kick: boolean;
  bass: boolean;
  hats: boolean;
  clap: boolean;
  chords: boolean;
  /** 0 at the start of a build, 1 at its end; drives the riser and the hat density. */
  rise: number;
}

function layersFor(spec: DemoTrackSpec, bar: number, barPhase: number): Layers {
  const section = sectionAtBar(spec, bar);
  switch (section) {
    case "intro":
      return { kick: true, bass: false, hats: bar >= 4, clap: false, chords: false, rise: 0 };
    case "build": {
      const rise = (bar - 8 + barPhase) / 8;
      return { kick: true, bass: true, hats: true, clap: bar >= 12, chords: bar >= 12, rise };
    }
    case "drop":
      return { kick: true, bass: true, hats: true, clap: true, chords: true, rise: 0 };
    case "break":
      return { kick: false, bass: false, hats: false, clap: false, chords: true, rise: 0 };
    case "outro":
      return { kick: true, bass: false, hats: true, clap: false, chords: true, rise: 0 };
  }
}

/**
 * Renders one track to stereo float channels. Pure: the same spec always yields the same samples.
 */
export function renderDemoTrack(spec: DemoTrackSpec, sampleRate = SAMPLE_RATE): Float32Array[] {
  const secondsPerBeat = 60 / spec.bpm;
  const secondsPerBar = secondsPerBeat * BEATS_PER_BAR;
  const totalBars = trackBars(spec);
  const frames = Math.round(totalBars * secondsPerBar * sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const random = mulberry32(spec.seed);

  // Noise is drawn once per sample so every layer hears the same air.
  const noise = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) noise[i] = random() * 2 - 1;

  const major = spec.camelot.endsWith("B");
  // One chord root per bar, resolved up front so the sample loop stays arithmetic.
  const rootByBar: number[] = [];
  for (let bar = 0; bar < totalBars; bar += 1) {
    rootByBar.push(spec.progression[bar % spec.progression.length] ?? spec.progression[0] ?? 45);
  }

  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const bar = Math.floor(t / secondsPerBar);
    const barStart = bar * secondsPerBar;
    const barPhase = (t - barStart) / secondsPerBar;
    const beatInBar = Math.floor(barPhase * BEATS_PER_BAR);
    const layers = layersFor(spec, bar, barPhase);

    const chordRoot = rootByBar[Math.min(bar, totalBars - 1)] ?? 45;
    let sample = 0;

    if (layers.kick) {
      const beatStart = barStart + beatInBar * secondsPerBeat;
      sample += kickAt(t - beatStart) * 0.92;
    }

    if (layers.bass) {
      // Offbeat eighths: the space between the kicks, which is where the groove lives.
      const eighth = Math.floor(barPhase * 8);
      if (eighth % 2 === 1) {
        const noteStart = barStart + (eighth * secondsPerBar) / 8;
        sample += bassAt(t - noteStart, midiToHz(chordRoot), secondsPerBar / 8) * 0.34;
      }
    }

    if (layers.hats) {
      const division = layers.rise > 0.55 ? 16 : 8;
      const step = Math.floor(barPhase * division);
      const stepStart = barStart + (step * secondsPerBar) / division;
      const open = division === 8 && step % 4 === 2;
      const level = 0.13 + 0.07 * layers.rise;
      sample += hatAt(t - stepStart, noise[i] ?? 0, open) * level * spec.brightness;
    }

    if (layers.clap && (beatInBar === 1 || beatInBar === 3)) {
      const beatStart = barStart + beatInBar * secondsPerBeat;
      sample += clapAt(t - beatStart, noise[i] ?? 0) * 0.3;
    }

    if (layers.chords) {
      sample += chordAt(t - barStart, triad(chordRoot, major), secondsPerBar, spec.brightness) * 0.26;
    }

    if (layers.rise > 0) {
      // A riser that lifts through the build and is cut off by the drop.
      const hz = 220 + 1400 * layers.rise ** 2;
      sample += Math.sin(2 * Math.PI * hz * t) * 0.05 * layers.rise ** 2;
    }

    // Soft clip: keeps peaks honest without a limiter's pumping.
    const shaped = Math.tanh(sample * 1.18) * 0.86;
    // A little width, so the stage's stereo read-outs have something to show.
    const spread = 0.012 * Math.sin(2 * Math.PI * 0.3 * t);
    left[i] = shaped * (1 - spread);
    right[i] = shaped * (1 + spread);
  }

  return [left, right];
}

/** 16-bit PCM RIFF/WAVE; decodable everywhere `decodeAudioData` is. */
export function encodeWav(channels: Float32Array[], sampleRate = SAMPLE_RATE): ArrayBuffer {
  const channelCount = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * channelCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true); // byte rate
  view.setUint16(32, channelCount * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = Math.max(-1, Math.min(1, channels[channel]?.[frame] ?? 0));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

/** The demo pack as `File`s, ready for `Library.addFiles`. */
export function demoTrackFiles(sampleRate = SAMPLE_RATE): File[] {
  return DEMO_TRACKS.map((spec) => {
    const wav = encodeWav(renderDemoTrack(spec, sampleRate), sampleRate);
    return new File([wav], spec.fileName, { type: "audio/wav", lastModified: 0 });
  });
}
