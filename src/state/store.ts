import { useSyncExternalStore } from "react";

export interface Store<S, E> {
  getState(): S;
  dispatch(event: E): S;
  subscribe(listener: () => void): () => void;
}

/** Minimal typed, event-sourced store. Reducers must return the same reference when nothing changed. */
export function createStore<S, E>(initial: S, reduce: (state: S, event: E) => S): Store<S, E> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(event) {
      const next = reduce(state, event);
      if (next !== state) {
        state = next;
        for (const listener of listeners) listener();
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** React binding. Selectors must return stable references (or primitives) for unchanged state. */
export function useStore<S, E, T>(store: Store<S, E>, selector: (state: S) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/** Storage guard: localStorage may be missing (node) or throw (privacy modes). */
export function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(storage: Storage | null, key: string): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(storage: Storage | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience; the instrument keeps working without it.
  }
}
