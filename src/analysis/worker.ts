/** Analysis worker: one job at a time, waveform summaries first, then the full TrackAnalysis. */
import type { TrackAnalysis } from "../state/session";
import { analyseTrack } from "./analyse";
import type { WaveformSummary } from "./waveform";

export type AnalysisRequest = {
  type: "analyse";
  jobId: string;
  trackId: string;
  sampleRate: number;
  channels: Float32Array[];
};

export type AnalysisResponse =
  | { type: "waveform"; jobId: string; trackId: string; waveform: WaveformSummary }
  | { type: "stage"; jobId: string; trackId: string; stage: string }
  | { type: "result"; jobId: string; trackId: string; analysis: TrackAnalysis; elapsedMs: number }
  | { type: "error"; jobId: string; trackId: string; message: string };

const scope = self as unknown as { postMessage(message: AnalysisResponse, transfer?: Transferable[]): void };

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  if (request?.type !== "analyse") return;
  const started = performance.now();
  try {
    const analysis = analyseTrack({
      trackId: request.trackId,
      sampleRate: request.sampleRate,
      channels: request.channels,
      onWaveform: (waveform) => {
        scope.postMessage({
          type: "waveform",
          jobId: request.jobId,
          trackId: request.trackId,
          waveform: { ...waveform, bins: waveform.bins.slice(), overview: waveform.overview.slice() },
        });
      },
      onStage: (stage) =>
        scope.postMessage({ type: "stage", jobId: request.jobId, trackId: request.trackId, stage }),
    });
    const transfer: Transferable[] = [
      analysis.waveform.bins.buffer,
      analysis.waveform.overview.buffer,
      analysis.energyPerBar.buffer,
    ];
    if (analysis.grid.beatsSec) transfer.push(analysis.grid.beatsSec.buffer);
    scope.postMessage(
      {
        type: "result",
        jobId: request.jobId,
        trackId: request.trackId,
        analysis,
        elapsedMs: performance.now() - started,
      },
      transfer,
    );
  } catch (error) {
    scope.postMessage({
      type: "error",
      jobId: request.jobId,
      trackId: request.trackId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
