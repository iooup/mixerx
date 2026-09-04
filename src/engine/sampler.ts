import { createStore, useStore } from "../state/store";

export const SAMPLER_SLOTS = 8;

export interface SamplerSlotState {
  name: string | null;
  playing: boolean;
  durationSec: number;
}

export interface SamplerState {
  slots: SamplerSlotState[];
}

export type SamplerEvent = { type: "sampler/slot"; index: number; slot: SamplerSlotState };

const emptySlot = (): SamplerSlotState => ({ name: null, playing: false, durationSec: 0 });

export const samplerStore = createStore<SamplerState, SamplerEvent>(
  { slots: Array.from({ length: SAMPLER_SLOTS }, emptySlot) },
  (state, event) => ({
    slots: state.slots.map((slot, index) => (index === event.index ? event.slot : slot)),
  }),
);

const identity = (state: SamplerState) => state;
export function useSampler(): SamplerState {
  return useStore(samplerStore, identity);
}

/** Eight one-shot pads into the master bus (before the limiter). */
export class Sampler {
  readonly output: GainNode;
  private readonly buffers: (AudioBuffer | null)[] = Array.from({ length: SAMPLER_SLOTS }, () => null);
  private readonly sources: (AudioBufferSourceNode | null)[] = Array.from(
    { length: SAMPLER_SLOTS },
    () => null,
  );

  constructor(
    private readonly context: AudioContext,
    destination: AudioNode,
  ) {
    this.output = context.createGain();
    this.output.gain.value = 0.8;
    this.output.connect(destination);
  }

  async load(index: number, blob: Blob, name: string): Promise<void> {
    const buffer = await this.context.decodeAudioData(await blob.arrayBuffer());
    this.stop(index);
    this.buffers[index] = buffer;
    samplerStore.dispatch({
      type: "sampler/slot",
      index,
      slot: { name, playing: false, durationSec: buffer.duration },
    });
  }

  trigger(index: number): boolean {
    const buffer = this.buffers[index];
    if (!buffer) return false;
    this.stop(index);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => {
      if (this.sources[index] === source) {
        this.sources[index] = null;
        this.update(index, { playing: false });
      }
    };
    source.start();
    this.sources[index] = source;
    this.update(index, { playing: true });
    return true;
  }

  stop(index: number): void {
    const source = this.sources[index];
    if (!source) return;
    this.sources[index] = null;
    try {
      source.stop();
    } catch {
      // already stopped
    }
    this.update(index, { playing: false });
  }

  private update(index: number, patch: Partial<SamplerSlotState>): void {
    const slot = samplerStore.getState().slots[index];
    if (!slot) return;
    samplerStore.dispatch({ type: "sampler/slot", index, slot: { ...slot, ...patch } });
  }
}
