/** Main-thread client for the analysis worker: a sequential queue with waveform-first callbacks. */
import type { TrackAnalysis } from "../state/session";
import type { WaveformSummary } from "./waveform";
import type { AnalysisRequest, AnalysisResponse } from "./worker";

export interface AnalyseJobOptions {
  onWaveform?: (waveform: WaveformSummary) => void;
  onStage?: (stage: string) => void;
}

interface Job {
  request: AnalysisRequest;
  transfer: Transferable[];
  options: AnalyseJobOptions;
  resolve: (analysis: TrackAnalysis) => void;
  reject: (error: Error) => void;
}

export class AnalysisClient {
  private worker: Worker | null = null;
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private counter = 0;

  constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  get pending(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /** `channels` are transferred to the worker; pass copies if the caller still needs them. */
  analyse(
    trackId: string,
    channels: Float32Array[],
    sampleRate: number,
    options: AnalyseJobOptions = {},
  ): Promise<TrackAnalysis> {
    return new Promise((resolve, reject) => {
      this.counter += 1;
      const request: AnalysisRequest = {
        type: "analyse",
        jobId: `job-${this.counter}`,
        trackId,
        sampleRate,
        channels,
      };
      this.queue.push({
        request,
        transfer: channels.map((channel) => channel.buffer),
        options,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<AnalysisResponse>) => this.handle(event.data);
    worker.onerror = (event) => {
      const active = this.active;
      this.active = null;
      active?.reject(new Error(event.message || "analysis worker failed"));
      this.pump();
    };
    this.worker = worker;
    return worker;
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    this.ensureWorker().postMessage(job.request, job.transfer);
  }

  private handle(response: AnalysisResponse): void {
    const job = this.active;
    if (!job || response.jobId !== job.request.jobId) return;
    switch (response.type) {
      case "waveform":
        job.options.onWaveform?.(response.waveform);
        break;
      case "stage":
        job.options.onStage?.(response.stage);
        break;
      case "result":
        this.active = null;
        job.resolve(response.analysis);
        this.pump();
        break;
      case "error":
        this.active = null;
        job.reject(new Error(response.message));
        this.pump();
        break;
      default:
        break;
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue.length = 0;
    for (const job of jobs) job.reject(new Error("analysis client disposed"));
  }
}
