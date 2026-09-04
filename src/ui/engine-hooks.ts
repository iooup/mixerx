import { useEffect, useRef, useState } from "react";
import { getEngine } from "../engine";
import type { EngineFrame } from "../engine/audio-engine";

export type FrameListener = (frame: EngineFrame | null, timeMs: number) => void;

const listeners = new Set<FrameListener>();
let rafId = 0;

function tick(timeMs: number): void {
  const engine = getEngine();
  const frame = engine ? engine.frame() : null;
  for (const listener of listeners) listener(frame, timeMs);
  rafId = listeners.size ? requestAnimationFrame(tick) : 0;
}

/** One shared requestAnimationFrame loop for canvases and meters. */
export function subscribeFrames(listener: FrameListener): () => void {
  listeners.add(listener);
  if (!rafId) rafId = requestAnimationFrame(tick);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

/** Runs `listener` every animation frame without re-rendering React. */
export function useEngineFrame(listener: FrameListener): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribeFrames((frame, timeMs) => ref.current(frame, timeMs)), []);
}

/** A derived value re-rendered at most every `intervalMs` (for text such as elapsed time). */
export function useFrameValue<T>(
  select: (frame: EngineFrame | null) => T,
  intervalMs = 100,
  equals: (a: T, b: T) => boolean = Object.is,
): T {
  const [value, setValue] = useState<T>(() => select(getEngine()?.frame() ?? null));
  const last = useRef(0);
  const selectRef = useRef(select);
  selectRef.current = select;
  const equalsRef = useRef(equals);
  equalsRef.current = equals;
  useEngineFrame((frame, timeMs) => {
    if (timeMs - last.current < intervalMs) return;
    last.current = timeMs;
    const next = selectRef.current(frame);
    setValue((previous) => (equalsRef.current(previous, next) ? previous : next));
  });
  return value;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
