/**
 * IndexedDB persistence. Only metadata, analysis numbers, and
 * directory handles are stored — never audio.
 */
import type { TrackAnalysis } from "../state/session";
import type { LibrarySource, LibraryTrack } from "./types";

export const DB_NAME = "mixerx-v2";
export const DB_VERSION = 1;
export const STORES = {
  sources: "sources",
  tracks: "tracks",
  analyses: "analyses",
  userData: "userData",
} as const;

export interface TrackUserData {
  trackId: string;
  cueSec?: number;
  hotCues?: (number | null)[];
  downbeatOffset?: 0 | 1 | 2 | 3;
  downbeatConfirmed?: boolean;
  gridOffsetMs?: number; // user nudge of the whole grid
  bpmOverride?: number;
}

type StoreName = (typeof STORES)[keyof typeof STORES];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export class LibraryDatabase {
  private constructor(private readonly db: IDBDatabase) {}

  static open(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<LibraryDatabase | null> {
    if (!factory) return Promise.resolve(null);
    return new Promise((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.sources))
          db.createObjectStore(STORES.sources, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORES.tracks))
          db.createObjectStore(STORES.tracks, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORES.analyses))
          db.createObjectStore(STORES.analyses, { keyPath: "trackId" });
        if (!db.objectStoreNames.contains(STORES.userData))
          db.createObjectStore(STORES.userData, { keyPath: "trackId" });
      };
      req.onsuccess = () => resolve(new LibraryDatabase(req.result));
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  private store(name: StoreName, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async get<T>(name: StoreName, key: string): Promise<T | null> {
    const value = await request(this.store(name, "readonly").get(key));
    return (value as T | undefined) ?? null;
  }

  async getAll<T>(name: StoreName): Promise<T[]> {
    return (await request(this.store(name, "readonly").getAll())) as T[];
  }

  async put(name: StoreName, value: unknown): Promise<void> {
    await request(this.store(name, "readwrite").put(value));
  }

  async delete(name: StoreName, key: string): Promise<void> {
    await request(this.store(name, "readwrite").delete(key));
  }

  async clear(name: StoreName): Promise<void> {
    await request(this.store(name, "readwrite").clear());
  }

  // Typed helpers.
  listSources(): Promise<LibrarySource[]> {
    return this.getAll<LibrarySource>(STORES.sources);
  }

  saveSource(source: LibrarySource): Promise<void> {
    return this.put(STORES.sources, source);
  }

  listTracks(): Promise<LibraryTrack[]> {
    return this.getAll<LibraryTrack>(STORES.tracks);
  }

  saveTrack(track: LibraryTrack): Promise<void> {
    return this.put(STORES.tracks, track);
  }

  getAnalysis(trackId: string): Promise<TrackAnalysis | null> {
    return this.get<TrackAnalysis>(STORES.analyses, trackId);
  }

  saveAnalysis(analysis: TrackAnalysis): Promise<void> {
    return this.put(STORES.analyses, analysis);
  }

  getUserData(trackId: string): Promise<TrackUserData | null> {
    return this.get<TrackUserData>(STORES.userData, trackId);
  }

  saveUserData(data: TrackUserData): Promise<void> {
    return this.put(STORES.userData, data);
  }

  close(): void {
    this.db.close();
  }
}
