import type { RoutingMode } from "../state/session";

export interface RoutingConfig {
  mode: RoutingMode;
  masterDeviceId?: string;
  cueDeviceId?: string;
}

export interface OutputDevice {
  deviceId: string;
  label: string;
}

export interface RoutingCapabilities {
  setSinkId: boolean;
  selectAudioOutput: boolean;
  maxChannels: number;
}

export interface RoutingStatus {
  mode: RoutingMode;
  configured: boolean;
  cueConnected: boolean;
  masterDeviceId?: string;
  cueDeviceId?: string;
  latencyMs: { master: number; cue: number };
  error?: string;
}

interface SinkCapableContext extends AudioContext {
  setSinkId?: (sinkId: string | { type: "none" }) => Promise<void>;
  sinkId?: string | { type: "none" };
}

type SinkAudioContextConstructor = new (options?: AudioContextOptions & { sinkId?: string }) => AudioContext;

const contextLatencyMs = (context: AudioContext): number =>
  Math.round((context.baseLatency + (context.outputLatency || 0)) * 1000 * 10) / 10;

/**
 * Connects the mixer's master and CUE outputs to the browser according to the chosen mode.
 *  - single: master and CUE both go to the default output (CUE audible through the CUE level).
 *  - two-devices: CUE is bridged through a MediaStream into a second AudioContext bound to a device.
 *  - split-4ch: one interface with ≥ 4 outputs; master → 1/2, CUE → 3/4.
 *  - mono-split: left = master (mono), right = CUE (mono), for a Y-cable.
 */
export class Routing {
  readonly capabilities: RoutingCapabilities;
  private config: RoutingConfig = { mode: "single" };
  private configured = false;
  private cueConnected = false;
  private error: string | undefined;
  private nodes: AudioNode[] = [];
  private cueContext: AudioContext | null = null;
  private cueStreamDestination: MediaStreamAudioDestinationNode | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly masterOut: AudioNode,
    private readonly cueOut: AudioNode,
  ) {
    const sinkContext = context as SinkCapableContext;
    this.capabilities = {
      setSinkId: typeof sinkContext.setSinkId === "function",
      selectAudioOutput:
        typeof navigator !== "undefined" &&
        typeof (navigator.mediaDevices as { selectAudioOutput?: unknown } | undefined)?.selectAudioOutput ===
          "function",
      maxChannels: context.destination.maxChannelCount,
    };
    this.wireSingle();
  }

  get current(): RoutingConfig {
    return this.config;
  }

  status(): RoutingStatus {
    const status: RoutingStatus = {
      mode: this.config.mode,
      configured: this.configured,
      cueConnected: this.cueConnected,
      latencyMs: {
        master: contextLatencyMs(this.context),
        cue: this.cueContext ? contextLatencyMs(this.cueContext) : contextLatencyMs(this.context),
      },
    };
    if (this.config.masterDeviceId) status.masterDeviceId = this.config.masterDeviceId;
    if (this.config.cueDeviceId) status.cueDeviceId = this.config.cueDeviceId;
    if (this.error) status.error = this.error;
    return status;
  }

  /** Lists audio outputs. Labels and stable ids require a one-time microphone permission in Chromium. */
  async listOutputs(requestPermission = false): Promise<OutputDevice[]> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
    if (requestPermission) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
      } catch {
        // Permission denied: labels stay empty, ids may be unstable.
      }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audiooutput")
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Output ${index + 1}` }));
  }

  async apply(config: RoutingConfig): Promise<RoutingStatus> {
    this.teardown();
    this.config = { ...config };
    this.error = undefined;
    try {
      switch (config.mode) {
        case "two-devices":
          await this.wireTwoDevices(config);
          break;
        case "split-4ch":
          this.wireSplit();
          break;
        case "mono-split":
          this.wireMonoSplit();
          break;
        default:
          this.wireSingle();
          if (config.masterDeviceId) await this.setMasterSink(config.masterDeviceId);
          break;
      }
      this.configured = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.teardown();
      this.config = { mode: "single" };
      this.wireSingle();
      this.configured = false;
    }
    return this.status();
  }

  private async setMasterSink(deviceId: string): Promise<void> {
    const sinkContext = this.context as SinkCapableContext;
    if (typeof sinkContext.setSinkId !== "function")
      throw new Error("This browser cannot choose the output device");
    await sinkContext.setSinkId(deviceId);
  }

  private track<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  private resetDestinationChannels(): void {
    const destination = this.context.destination;
    try {
      destination.channelCountMode = "explicit";
      destination.channelInterpretation = "speakers";
      destination.channelCount = Math.min(2, destination.maxChannelCount || 2);
    } catch {
      // Some contexts refuse channel changes; the default configuration still works.
    }
  }

  private wireSingle(): void {
    this.resetDestinationChannels();
    this.masterOut.connect(this.context.destination);
    this.cueOut.connect(this.context.destination);
    this.cueConnected = true;
  }

  private async wireTwoDevices(config: RoutingConfig): Promise<void> {
    if (!config.cueDeviceId) throw new Error("Choose a CUE device");
    this.resetDestinationChannels();
    this.masterOut.connect(this.context.destination);
    if (config.masterDeviceId) await this.setMasterSink(config.masterDeviceId);

    const AudioContextCtor = globalThis.AudioContext as unknown as SinkAudioContextConstructor;
    const cueContext = new AudioContextCtor({ latencyHint: "interactive", sinkId: config.cueDeviceId });
    const cueSink = cueContext as SinkCapableContext;
    if (typeof cueSink.setSinkId === "function") await cueSink.setSinkId(config.cueDeviceId);
    else throw new Error("This browser cannot route CUE to a second device");
    this.cueContext = cueContext;
    this.cueStreamDestination = this.track(this.context.createMediaStreamDestination());
    this.cueOut.connect(this.cueStreamDestination);
    const source = cueContext.createMediaStreamSource(this.cueStreamDestination.stream);
    source.connect(cueContext.destination);
    await cueContext.resume();
    this.cueConnected = cueContext.state === "running";
  }

  private wireSplit(): void {
    const destination = this.context.destination;
    if (destination.maxChannelCount < 4) throw new Error("The current output has fewer than 4 channels");
    destination.channelCountMode = "explicit";
    destination.channelInterpretation = "discrete";
    destination.channelCount = 4;
    const merger = this.track(this.context.createChannelMerger(4));
    const masterSplit = this.track(this.context.createChannelSplitter(2));
    const cueSplit = this.track(this.context.createChannelSplitter(2));
    this.masterOut.connect(masterSplit);
    this.cueOut.connect(cueSplit);
    masterSplit.connect(merger, 0, 0);
    masterSplit.connect(merger, 1, 1);
    cueSplit.connect(merger, 0, 2);
    cueSplit.connect(merger, 1, 3);
    merger.connect(destination);
    this.cueConnected = true;
  }

  private wireMonoSplit(): void {
    this.resetDestinationChannels();
    const masterMono = this.track(this.context.createGain());
    masterMono.channelCount = 1;
    masterMono.channelCountMode = "explicit";
    const cueMono = this.track(this.context.createGain());
    cueMono.channelCount = 1;
    cueMono.channelCountMode = "explicit";
    const merger = this.track(this.context.createChannelMerger(2));
    this.masterOut.connect(masterMono);
    this.cueOut.connect(cueMono);
    masterMono.connect(merger, 0, 0);
    cueMono.connect(merger, 0, 1);
    merger.connect(this.context.destination);
    this.cueConnected = true;
  }

  private teardown(): void {
    try {
      this.masterOut.disconnect();
      this.cueOut.disconnect();
    } catch {
      // Nothing was connected yet.
    }
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.nodes = [];
    this.cueStreamDestination = null;
    if (this.cueContext) {
      void this.cueContext.close().catch(() => {});
      this.cueContext = null;
    }
    this.cueConnected = false;
  }

  dispose(): void {
    this.teardown();
  }
}
