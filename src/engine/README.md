# Audio engine

The engine owns playback time and audible state. UI controls, lessons, MIDI, and
agent tools all use the same actions.

- `audio-engine.ts` creates the AudioContext, two decks, cue preview, mixer,
  sampler, and feature worker connection.
- `deck.ts` and `worklets/deck-processor.ts` implement deck playback and
  audio-frame scheduling.
- `mixer-graph.ts` builds channel strips, crossfader gains, master, and cue buses.
- `worklets/limiter-processor.ts` limits the master output.
- `worklets/tap-processor.ts` produces meters and passes audio blocks to feature extraction.
- `routing.ts` manages single-output, two-device, four-channel, and mono-split routing.
- `actions.ts` coordinates transport, mixer changes, and session updates.
- `beat-math.ts` contains shared timing and control calculations.
- `harness.ts` supports browser-level engine tests.

Keep audio-thread work bounded. Schedule musical actions against the engine's
clock; never use a UI animation or timer as a substitute for audio timing.
Device support and physical headphone isolation must be checked in Audio Setup.

Tempo changes currently alter pitch. Pitch-preserving keylock is not implemented.
