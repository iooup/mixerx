import type { ChannelStripState, CrossfaderCurve, DeckId } from "../state/session";
import { crossfaderGains, dbToGain, eqGainDb, faderGain, filterFrequencies } from "./beat-math";

const RAMP_SECONDS = 0.012;
/** Web Audio expresses lowpass/highpass Q in dB; 20·log10(1/√2) is the flat Butterworth response. */
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);

function ramp(context: BaseAudioContext, param: AudioParam, value: number, seconds = RAMP_SECONDS): void {
  const now = context.currentTime;
  if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(now);
  else param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, seconds / 3);
}

/** trim → 3-band EQ → bipolar filter → (PFL tap) → fader → crossfader gain. */
export class ChannelStrip {
  private crossfadeGain = 1;
  readonly input: GainNode;
  readonly pfl: GainNode;
  readonly output: GainNode;
  private readonly eqLow: BiquadFilterNode;
  private readonly eqMid: BiquadFilterNode;
  private readonly eqHigh: BiquadFilterNode;
  private readonly highpass: BiquadFilterNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly fader: GainNode;
  readonly state: ChannelStripState = {
    trim: 0,
    eqHigh: 0,
    eqMid: 0,
    eqLow: 0,
    filter: 0,
    fader: 1,
    pfl: false,
  };

  constructor(
    private readonly context: BaseAudioContext,
    cueBus: AudioNode,
  ) {
    this.input = context.createGain();
    this.eqLow = context.createBiquadFilter();
    this.eqLow.type = "lowshelf";
    this.eqLow.frequency.value = 120;
    this.eqMid = context.createBiquadFilter();
    this.eqMid.type = "peaking";
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.8;
    this.eqHigh = context.createBiquadFilter();
    this.eqHigh.type = "highshelf";
    this.eqHigh.frequency.value = 8000;
    this.highpass = context.createBiquadFilter();
    this.highpass.type = "highpass";
    this.highpass.frequency.value = 20;
    this.highpass.Q.value = BUTTERWORTH_Q_DB;
    this.lowpass = context.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpass.frequency.value = 20000;
    this.lowpass.Q.value = BUTTERWORTH_Q_DB;
    this.pfl = context.createGain();
    this.pfl.gain.value = 0;
    this.fader = context.createGain();
    this.output = context.createGain();

    this.input.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.highpass);
    this.highpass.connect(this.lowpass);
    this.lowpass.connect(this.pfl);
    this.pfl.connect(cueBus);
    this.lowpass.connect(this.fader);
    this.fader.connect(this.output);
  }

  setTrim(db: number): void {
    this.state.trim = db;
    ramp(this.context, this.input.gain, dbToGain(db));
  }

  setEq(band: "high" | "mid" | "low", db: number): void {
    const node = band === "high" ? this.eqHigh : band === "mid" ? this.eqMid : this.eqLow;
    if (band === "high") this.state.eqHigh = db;
    else if (band === "mid") this.state.eqMid = db;
    else this.state.eqLow = db;
    ramp(this.context, node.gain, eqGainDb(db));
  }

  setFilter(value: number): void {
    this.state.filter = value;
    const { highpassHz, lowpassHz } = filterFrequencies(value);
    ramp(this.context, this.highpass.frequency, highpassHz);
    ramp(this.context, this.lowpass.frequency, lowpassHz);
  }

  setFader(value: number): void {
    this.state.fader = value;
    ramp(this.context, this.fader.gain, faderGain(value));
  }

  setPfl(on: boolean): void {
    this.state.pfl = on;
    ramp(this.context, this.pfl.gain, on ? 1 : 0);
  }

  setCrossfadeGain(gain: number): void {
    this.crossfadeGain = gain;
    ramp(this.context, this.output.gain, gain);
  }

  /** Post-fader, post-crossfader gain from the ramp *targets* (AudioParams may still be ramping). */
  get audibleGain(): number {
    return faderGain(this.state.fader) * this.crossfadeGain;
  }
}

export interface MixerGraphOptions {
  limiter?: boolean;
}

/** Two channel strips, a crossfader, master bus with limiter and metering tap, and the CUE bus. */
export class MixerGraph {
  readonly strips: Record<DeckId, ChannelStrip>;
  readonly cueBus: GainNode;
  readonly cueLevel: GainNode;
  readonly masterToCue: GainNode;
  readonly master: GainNode;
  private cueBlend = 0;
  private cueBlendEnabled = true;
  readonly limiter: AudioWorkletNode | null;
  readonly tap: AudioWorkletNode;
  crossfader = 0;
  curve: CrossfaderCurve = "equal-power";
  masterLevel = 0.8;
  cueLevelValue = 0.8;

  constructor(
    private readonly context: BaseAudioContext,
    options: MixerGraphOptions = {},
  ) {
    this.cueBus = context.createGain();
    this.cueLevel = context.createGain();
    this.cueLevel.gain.value = faderGain(this.cueLevelValue);
    this.cueBus.connect(this.cueLevel);
    this.masterToCue = context.createGain();
    this.masterToCue.gain.value = 0;
    this.master = context.createGain();
    this.master.gain.value = faderGain(this.masterLevel);
    this.strips = { A: new ChannelStrip(context, this.cueBus), B: new ChannelStrip(context, this.cueBus) };
    this.tap = new AudioWorkletNode(context, "mixerx-tap", {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.limiter =
      options.limiter === false
        ? null
        : new AudioWorkletNode(context, "mixerx-limiter", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });

    this.strips.A.output.connect(this.master);
    this.strips.B.output.connect(this.master);
    if (this.limiter) {
      this.master.connect(this.limiter);
      this.limiter.connect(this.tap, 0, 0);
    } else {
      this.master.connect(this.tap, 0, 0);
    }
    this.strips.A.output.connect(this.tap, 0, 1);
    this.strips.B.output.connect(this.tap, 0, 2);
    this.cueLevel.connect(this.tap, 0, 3);
    this.master.connect(this.masterToCue);
    this.masterToCue.connect(this.cueLevel);
    this.setCrossfader(0);
  }

  /** Master signal after limiter and tap; connect this to the routing. */
  get masterOut(): AudioNode {
    return this.tap;
  }

  /** CUE signal after the CUE level; connect this to the routing. */
  get cueOut(): AudioNode {
    return this.cueLevel;
  }

  setCrossfader(position: number): void {
    this.crossfader = Math.min(1, Math.max(0, position));
    this.applyCrossfader();
  }

  setCurve(curve: CrossfaderCurve): void {
    this.curve = curve;
    this.applyCrossfader();
  }

  private applyCrossfader(): void {
    const gains = crossfaderGains(this.crossfader, this.curve);
    this.strips.A.setCrossfadeGain(gains.a);
    this.strips.B.setCrossfadeGain(gains.b);
  }

  crossfaderGain(deck: DeckId): number {
    const gains = crossfaderGains(this.crossfader, this.curve);
    return deck === "A" ? gains.a : gains.b;
  }

  setMasterLevel(value: number): void {
    this.masterLevel = value;
    ramp(this.context, this.master.gain, faderGain(value), 0.02);
  }

  setCueLevel(value: number): void {
    this.cueLevelValue = value;
    ramp(this.context, this.cueLevel.gain, faderGain(value), 0.02);
  }

  /** Headphone blend: how much of the master is mixed into the CUE output (0 = PFL only). */
  setCueBlend(value: number): void {
    this.cueBlend = Math.min(1, Math.max(0, value));
    this.applyCueBlend();
  }

  /** With a single output the CUE bus already feeds the master, so blending would double it. */
  setCueBlendEnabled(enabled: boolean): void {
    this.cueBlendEnabled = enabled;
    this.applyCueBlend();
  }

  private applyCueBlend(): void {
    ramp(this.context, this.masterToCue.gain, this.cueBlendEnabled ? faderGain(this.cueBlend) : 0, 0.02);
  }
}
