/**
 * Library sources: a directory picked with the File System Access API (Chromium; the handle
 * persists in IndexedDB), a set of files (fallback picker or drag-and-drop), or the development
 * manifest served from /local-audio (never in production builds).
 */
import { isAudioFileName } from "./types";

export interface LibraryFile {
  relativePath: string;
  name: string;
  size: number;
  lastModified: number;
  getFile(): Promise<File>;
}

type PermissionMode = "read" | "readwrite";
interface DirectoryHandleLike {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FileSystemHandle>;
  queryPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionState>;
}
interface FileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
type DirectoryPicker = (options?: {
  id?: string;
  mode?: PermissionMode;
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;

export function directoryPickerAvailable(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ id: "mixerx-library", mode: "read", startIn: "music" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

export async function directoryPermission(
  handle: FileSystemDirectoryHandle,
  request: boolean,
): Promise<PermissionState> {
  const like = handle as unknown as DirectoryHandleLike;
  const current = like.queryPermission ? await like.queryPermission({ mode: "read" }) : "granted";
  if (current === "granted" || !request || !like.requestPermission) return current;
  return like.requestPermission({ mode: "read" });
}

/** Lists audio files under a directory handle (depth-first, up to `maxDepth`). */
export async function listDirectory(handle: FileSystemDirectoryHandle, maxDepth = 6): Promise<LibraryFile[]> {
  const files: LibraryFile[] = [];
  const walk = async (directory: DirectoryHandleLike, prefix: string, depth: number) => {
    if (depth > maxDepth) return;
    for await (const entry of directory.values()) {
      if (entry.kind === "directory") {
        await walk(entry as unknown as DirectoryHandleLike, `${prefix}${entry.name}/`, depth + 1);
      } else if (entry.kind === "file" && isAudioFileName(entry.name)) {
        const fileHandle = entry as unknown as FileHandleLike;
        const file = await fileHandle.getFile();
        files.push({
          relativePath: `${prefix}${entry.name}`,
          name: entry.name,
          size: file.size,
          lastModified: file.lastModified,
          getFile: () => fileHandle.getFile(),
        });
      }
    }
  };
  await walk(handle as unknown as DirectoryHandleLike, "", 0);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

/** Wraps File objects from an <input webkitdirectory> or a drop. */
export function filesFromList(list: Iterable<File>): LibraryFile[] {
  const files: LibraryFile[] = [];
  for (const file of list) {
    if (!isAudioFileName(file.name)) continue;
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    files.push({
      relativePath,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      getFile: async () => file,
    });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

export interface ManifestTrack {
  id: string;
  title: string;
  artist: string;
  src: string;
  sizeBytes?: number;
  durationSec?: number;
  group?: string;
}

export interface Manifest {
  library?: { title?: string; trackCount?: number };
  tracks?: ManifestTrack[];
}

/** Development corpus only: returns null outside `import.meta.env.DEV` or when the manifest is missing. */
export async function loadManifest(
  url = "/local-audio/library.json",
): Promise<{ baseUrl: string; manifest: Manifest } | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const manifest = (await response.json()) as Manifest;
    if (!Array.isArray(manifest.tracks) || !manifest.tracks.length) return null;
    return { baseUrl: new URL(url, globalThis.location?.href ?? "http://localhost/").href, manifest };
  } catch {
    return null;
  }
}
