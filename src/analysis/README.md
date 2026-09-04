# Track analysis

The analysis pipeline turns locally decoded audio into a `TrackAnalysis`
defined in [session.ts](../state/session.ts).

- `client.ts` and `worker.ts` coordinate work away from the UI thread.
- `analyse.ts` combines tempo, beat-grid, downbeat, key, sections, and loudness.
- `dsp/` provides resampling, filters, FFT, and feature extraction.
- `waveform.ts` creates summaries used by the actual track waveforms.
- `feature-worker.ts` extracts live playback features for the Stage.

The library owns decoding, queuing, and persistence. Analysis estimates can need
manual correction; confidence is not an independently measured accuracy score.
Keep user-confirmed grid edits separate from recomputed estimates.

See [Testing](../../docs/testing.md) before interpreting private-corpus results.
