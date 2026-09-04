/** Gestures that leave no trace in the session store but matter to the Stage (cue hits). */
import type { DeckId } from "../state/session";

export type EngineGesture = { kind: "cue"; deck: DeckId };

const listeners = new Set<(gesture: EngineGesture) => void>();

export function emitGesture(gesture: EngineGesture): void {
  for (const listener of listeners) listener(gesture);
}

export function onGesture(listener: (gesture: EngineGesture) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
