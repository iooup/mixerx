/** Low-rate status of a Stage window for its chrome (updated ~4 Hz by the render loop). */
import { createStore, useStore } from "../state/store";
import type { OnAir, StageSection } from "./protocol";

export interface StageStatus {
  webgpu: "pending" | "yes" | "no";
  gpuName: string;
  software: boolean;
  fps: number;
  gpuTimeMs: number | null;
  scale: number;
  sceneId: string;
  pendingScene: string | null;
  connected: boolean;
  frameRate: number;
  flashes: number;
  section: StageSection;
  barsToNext: number;
  onAir: OnAir;
  bpm: number;
  crossfader: number;
  intensity: number;
  crowd: boolean;
  face: boolean;
  lost: boolean;
}

export type StageStatusEvent = { type: "status/patch"; patch: Partial<StageStatus> };

export const initialStageStatus: StageStatus = {
  webgpu: "pending",
  gpuName: "",
  software: false,
  fps: 0,
  gpuTimeMs: null,
  scale: 1,
  sceneId: "",
  pendingScene: null,
  connected: false,
  frameRate: 0,
  flashes: 0,
  section: "none",
  barsToNext: -1,
  onAir: "none",
  bpm: 0,
  crossfader: 0,
  intensity: 0.5,
  crowd: false,
  face: false,
  lost: false,
};

export function reduceStageStatus(state: StageStatus, event: StageStatusEvent): StageStatus {
  const keys = Object.keys(event.patch) as (keyof StageStatus)[];
  if (keys.every((key) => state[key] === event.patch[key])) return state;
  return { ...state, ...event.patch };
}

export const stageStatusStore = createStore<StageStatus, StageStatusEvent>(
  initialStageStatus,
  reduceStageStatus,
);

const identity = (state: StageStatus) => state;

export function useStageStatus(): StageStatus {
  return useStore(stageStatusStore, identity);
}
