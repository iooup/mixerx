import { createStore, useStore } from "../state/store";
import type { ActivityEntry, UndoHandle } from "./types";

export interface ActivityState {
  entries: ActivityEntry[]; // newest last
}

export type ActivityEvent =
  | { type: "activity/add"; entry: ActivityEntry }
  | { type: "activity/undone"; id: string }
  | { type: "activity/clear" };

const MAX_ENTRIES = 60;

export function reduceActivity(state: ActivityState, event: ActivityEvent): ActivityState {
  switch (event.type) {
    case "activity/add":
      return { entries: [...state.entries, event.entry].slice(-MAX_ENTRIES) };
    case "activity/undone":
      return {
        entries: state.entries.map((entry) => (entry.id === event.id ? { ...entry, undone: true } : entry)),
      };
    case "activity/clear":
      return { entries: [] };
    default:
      return state;
  }
}

export const activityStore = createStore<ActivityState, ActivityEvent>({ entries: [] }, reduceActivity);

const identity = (state: ActivityState) => state;
export function useActivity(): ActivityState {
  return useStore(activityStore, identity);
}

const undoHandles = new Map<string, UndoHandle>();
let counter = 0;

export function logActivity(entry: Omit<ActivityEntry, "id" | "at">, undo?: UndoHandle): ActivityEntry {
  counter += 1;
  const full: ActivityEntry = { ...entry, id: `act-${counter}`, at: Date.now() };
  if (undo) {
    full.undoLabel = undo.label;
    undoHandles.set(full.id, undo);
  }
  activityStore.dispatch({ type: "activity/add", entry: full });
  return full;
}

export async function undoActivity(id: string): Promise<boolean> {
  const handle = undoHandles.get(id);
  if (!handle) return false;
  undoHandles.delete(id);
  await handle.run();
  activityStore.dispatch({ type: "activity/undone", id });
  return true;
}

export function canUndo(id: string): boolean {
  return undoHandles.has(id);
}
