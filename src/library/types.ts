import type { Section, TrackRef } from "../state/session";

export type AnalysisState = "queued" | "decoding" | "analysing" | "ready" | "failed";

/** A track known to the library. The file itself is reached through `LibrarySource`. */
export interface LibraryTrack extends TrackRef {
  sourceId: string;
  fileName: string;
  relativePath: string;
  lastModified: number;
  /** Development manifest tracks are fetched from this same-origin URL. */
  url?: string;
  analysisState: AnalysisState;
  analysisStage?: string;
  error?: string;
  bpm?: number;
  camelot?: string;
  keyName?: string;
  energy?: number; // 1..10
  integratedLufs?: number;
  sections?: Section[];
  gridConfidence?: number;
  keyConfidence?: number;
}

export type LibrarySourceKind = "directory" | "files" | "manifest";

export interface LibrarySource {
  id: string;
  kind: LibrarySourceKind;
  name: string;
  addedAt: number;
  /** Persisted only for directories (structured-cloneable in Chromium). */
  handle?: FileSystemDirectoryHandle;
  permission?: "granted" | "prompt" | "denied";
  trackCount: number;
}

export interface DecodedAudio {
  sampleRate: number;
  durationSec: number;
  channels: Float32Array[];
}

export const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "aif", "aiff"]);

export function isAudioFileName(name: string): boolean {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return AUDIO_EXTENSIONS.has(extension);
}

/** FNV-1a over the file identity; stable across sessions for the same file. */
export function trackIdFor(name: string, sizeBytes: number, lastModified: number): string {
  const source = `${name}|${sizeBytes}|${lastModified}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `t-${(hash >>> 0).toString(16).padStart(8, "0")}-${sizeBytes.toString(36)}`;
}

/** "Artist - Title.ext" → { artist, title }; otherwise the file name without extension is the title. */
export function titleFromFileName(fileName: string): { title: string; artist: string } {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/^\d{1,3}[\s._-]+/, "");
  const separator = base.indexOf(" - ");
  if (separator > 0) {
    return { artist: base.slice(0, separator).trim(), title: base.slice(separator + 3).trim() };
  }
  return { title: base.trim(), artist: "" };
}
