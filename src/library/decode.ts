import type { DecodedAudio } from "./types";

/**
 * Decodes a file with `decodeAudioData` through a throwaway OfflineAudioContext at the engine's
 * sample rate, so the deck plays at ratio 1. Channel data is copied out so the AudioBuffer can be
 * released immediately.
 */
export async function decodeAudio(blob: Blob, sampleRate: number): Promise<DecodedAudio> {
  const bytes = await blob.arrayBuffer();
  const context = new OfflineAudioContext(2, 1, sampleRate);
  const buffer = await context.decodeAudioData(bytes);
  const channelCount = Math.min(2, buffer.numberOfChannels);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = new Float32Array(buffer.length);
    buffer.copyFromChannel(data, channel);
    channels.push(data);
  }
  if (channels.length === 1 && channels[0]) channels.push(new Float32Array(channels[0]));
  return { sampleRate: buffer.sampleRate, durationSec: buffer.duration, channels };
}

/** Deep copy of decoded channels, for handing one copy to the worklet and one to the analysis worker. */
export function cloneChannels(channels: Float32Array[]): Float32Array[] {
  return channels.map((channel) => new Float32Array(channel));
}
