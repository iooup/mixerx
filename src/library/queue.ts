import { sessionStore } from "../state/session-store";

function set(queue: string[]): void {
  sessionStore.dispatch({ type: "queue/set", queue });
}

export const queueActions = {
  toggle(trackId: string): void {
    const queue = sessionStore.getState().queue;
    set(queue.includes(trackId) ? queue.filter((id) => id !== trackId) : [...queue, trackId]);
  },
  add(trackId: string): void {
    const queue = sessionStore.getState().queue;
    if (!queue.includes(trackId)) set([...queue, trackId]);
  },
  remove(trackId: string): void {
    set(sessionStore.getState().queue.filter((id) => id !== trackId));
  },
  move(trackId: string, direction: -1 | 1): void {
    const queue = [...sessionStore.getState().queue];
    const index = queue.indexOf(trackId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= queue.length) return;
    const other = queue[target];
    if (other === undefined) return;
    queue[target] = trackId;
    queue[index] = other;
    set(queue);
  },
  clear(): void {
    set([]);
  },
};
