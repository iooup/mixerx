/**
 * Library service: sources → tracks → decode → analysis, plus loading tracks into decks.
 * One analysis runs at a time; deck loads jump the queue.
 */
import { AnalysisClient } from "../analysis/client";
import type { WaveformSummary } from "../analysis/waveform";
import type { DeckId, TrackAnalysis } from "../state/session";
import { sessionStore } from "../state/session-store";
import { LibraryDatabase, type TrackUserData } from "./db";
import { cloneChannels, decodeAudio } from "./decode";
import { libraryStore } from "./library-store";
import {
  directoryPermission,
  filesFromList,
  type LibraryFile,
  listDirectory,
  loadManifest,
  pickDirectory,
} from "./sources";
import { readTags } from "./tags";
import { type LibrarySource, type LibraryTrack, titleFromFileName, trackIdFor } from "./types";
import { applyUserData } from "./user-data";

export interface LoadedTrack {
  track: LibraryTrack;
  sampleRate: number;
  channels: Float32Array[];
}

export type WaveformListener = (trackId: string, waveform: WaveformSummary) => void;

const DEFAULT_SAMPLE_RATE = 44100;

export class Library {
  private db: LibraryDatabase | null = null;
  private readonly files = new Map<string, LibraryFile>();
  private readonly analyses = new Map<string, TrackAnalysis>();
  private readonly waveforms = new Map<string, WaveformSummary>();
  private readonly userData = new Map<string, TrackUserData>();
  private readonly artwork = new Map<string, Promise<string | null>>();
  private readonly analysisClient: AnalysisClient;
  private readonly queue: string[] = [];
  private analysingId: string | null = null;
  private readonly waveformListeners = new Set<WaveformListener>();
  private sampleRate = DEFAULT_SAMPLE_RATE;

  constructor(options: { createWorker?: () => Worker } = {}) {
    this.analysisClient = new AnalysisClient(options.createWorker);
  }

  setSampleRate(sampleRate: number): void {
    this.sampleRate = sampleRate;
  }

  onWaveform(listener: WaveformListener): () => void {
    this.waveformListeners.add(listener);
    return () => {
      this.waveformListeners.delete(listener);
    };
  }

  getAnalysis(trackId: string): TrackAnalysis | null {
    const analysis = this.analyses.get(trackId);
    return analysis ? applyUserData(analysis, this.userData.get(trackId)) : null;
  }

  /** Object URL of the embedded artwork (APIC), cached per track; null when there is none. */
  artworkUrl(trackId: string): Promise<string | null> {
    const cached = this.artwork.get(trackId);
    if (cached) return cached;
    const promise = (async () => {
      try {
        const tags = await readTags(await this.getFile(trackId), { artwork: true });
        if (!tags.artwork) return null;
        return URL.createObjectURL(new Blob([tags.artwork.bytes as BlobPart], { type: tags.artwork.mime }));
      } catch {
        return null;
      }
    })();
    this.artwork.set(trackId, promise);
    return promise;
  }

  async getUserData(trackId: string): Promise<TrackUserData | null> {
    const cached = this.userData.get(trackId);
    if (cached) return cached;
    const stored = (await this.db?.getUserData(trackId)) ?? null;
    if (stored) this.userData.set(trackId, stored);
    return stored;
  }

  /** Merges and persists user decisions for a track and refreshes any deck holding it. */
  async updateUserData(trackId: string, patch: Partial<TrackUserData>): Promise<TrackUserData> {
    const current = (await this.getUserData(trackId)) ?? { trackId };
    const next: TrackUserData = { ...current, ...patch, trackId };
    this.userData.set(trackId, next);
    await this.db?.saveUserData(next);
    const analysis = this.analyses.get(trackId);
    if (analysis) {
      for (const deck of ["A", "B"] as DeckId[]) {
        if (sessionStore.getState().decks[deck].track?.id === trackId) {
          sessionStore.dispatch({ type: "deck/analysis", deck, analysis: applyUserData(analysis, next) });
        }
      }
    }
    return next;
  }

  getWaveform(trackId: string): WaveformSummary | null {
    return this.waveforms.get(trackId) ?? this.analyses.get(trackId)?.waveform ?? null;
  }

  /** Restores persisted sources/tracks; directory handles wait for a click to re-request permission. */
  async open(): Promise<void> {
    this.db = await LibraryDatabase.open();
    const sources = this.db ? await this.db.listSources() : [];
    const tracks = this.db ? await this.db.listTracks() : [];
    for (const source of sources) {
      if (source.kind === "directory" && source.handle) {
        source.permission = await directoryPermission(source.handle, false);
      }
    }
    for (const track of tracks) {
      if (track.analysisState !== "ready") track.analysisState = "queued";
    }
    libraryStore.dispatch({ type: "library/ready", sources, tracks });
    for (const source of sources) {
      if (source.kind === "directory" && source.handle && source.permission === "granted") {
        await this.scanDirectory(source, source.handle);
      }
    }
    if (import.meta.env.DEV) await this.addManifest();
  }

  private async persistTrack(track: LibraryTrack): Promise<void> {
    libraryStore.dispatch({ type: "library/track", track });
    await this.db?.saveTrack(track);
  }

  private updateTrack(id: string, patch: Partial<LibraryTrack>): LibraryTrack | null {
    const current = libraryStore.getState().tracks.find((track) => track.id === id);
    if (!current) return null;
    const next = { ...current, ...patch };
    void this.persistTrack(next);
    return next;
  }

  private async registerFiles(source: LibrarySource, files: LibraryFile[]): Promise<void> {
    const known = new Map(libraryStore.getState().tracks.map((track) => [track.id, track]));
    const tracks: LibraryTrack[] = [];
    for (const file of files) {
      const id = trackIdFor(file.name, file.size, file.lastModified);
      this.files.set(id, file);
      const existing = known.get(id);
      if (existing) {
        tracks.push({ ...existing, sourceId: source.id });
        continue;
      }
      const fallback = titleFromFileName(file.name);
      let title = fallback.title;
      let artist = fallback.artist;
      let hasArtwork = false;
      try {
        const tags = await readTags(await file.getFile());
        if (tags.title) title = tags.title;
        if (tags.artist) artist = tags.artist;
        hasArtwork = tags.hasArtwork;
      } catch {
        // Tags are optional.
      }
      tracks.push({
        id,
        title,
        artist,
        durationSec: 0,
        sizeBytes: file.size,
        source: source.kind === "directory" ? "folder" : source.kind === "files" ? "drop" : "manifest",
        hasArtwork,
        sourceId: source.id,
        fileName: file.name,
        relativePath: file.relativePath,
        lastModified: file.lastModified,
        analysisState: "queued",
      });
    }
    const others = libraryStore
      .getState()
      .tracks.filter((track) => track.sourceId !== source.id && !tracks.some((t) => t.id === track.id));
    const all = [...others, ...tracks];
    libraryStore.dispatch({ type: "library/tracks", tracks: all });
    source.trackCount = tracks.length;
    await this.db?.saveSource(source);
    const sources = libraryStore.getState().sources.filter((entry) => entry.id !== source.id);
    libraryStore.dispatch({ type: "library/sources", sources: [...sources, source] });
    for (const track of tracks) await this.db?.saveTrack(track);
    for (const track of tracks) {
      if (track.analysisState !== "ready") this.enqueue(track.id);
      else if (!this.analyses.has(track.id)) {
        const stored = await this.db?.getAnalysis(track.id);
        if (stored) this.analyses.set(track.id, stored);
        else this.enqueue(track.id);
      }
    }
  }

  private async scanDirectory(source: LibrarySource, handle: FileSystemDirectoryHandle): Promise<void> {
    libraryStore.dispatch({ type: "library/scanning", scanning: true });
    try {
      const files = await listDirectory(handle);
      await this.registerFiles(source, files);
      libraryStore.dispatch({ type: "library/error" });
    } catch (error) {
      libraryStore.dispatch({
        type: "library/error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      libraryStore.dispatch({ type: "library/scanning", scanning: false });
    }
  }

  async addDirectory(): Promise<boolean> {
    const handle = await pickDirectory();
    if (!handle) return false;
    const source: LibrarySource = {
      id: `dir-${handle.name}-${Date.now().toString(36)}`,
      kind: "directory",
      name: handle.name,
      addedAt: Date.now(),
      handle,
      permission: "granted",
      trackCount: 0,
    };
    await this.scanDirectory(source, handle);
    return true;
  }

  async regrantDirectory(sourceId: string): Promise<void> {
    const source = libraryStore.getState().sources.find((entry) => entry.id === sourceId);
    if (!source?.handle) return;
    const permission = await directoryPermission(source.handle, true);
    source.permission = permission;
    libraryStore.dispatch({
      type: "library/sources",
      sources: libraryStore.getState().sources.map((s) => (s.id === sourceId ? { ...source } : s)),
    });
    if (permission === "granted") await this.scanDirectory(source, source.handle);
  }

  async addFiles(list: Iterable<File>, name = "Files"): Promise<number> {
    const files = filesFromList(list);
    if (!files.length) return 0;
    const source: LibrarySource = {
      id: `files-${Date.now().toString(36)}`,
      kind: "files",
      name,
      addedAt: Date.now(),
      trackCount: 0,
    };
    await this.registerFiles(source, files);
    return files.length;
  }

  async addManifest(): Promise<void> {
    const loaded = await loadManifest();
    if (!loaded) return;
    const source: LibrarySource = {
      id: "manifest",
      kind: "manifest",
      name: loaded.manifest.library?.title ?? "Development library",
      addedAt: Date.now(),
      trackCount: 0,
    };
    const files: LibraryFile[] = [];
    const urls = new Map<string, string>();
    for (const entry of loaded.manifest.tracks ?? []) {
      const url = new URL(entry.src, loaded.baseUrl).href;
      const name = entry.src.split("/").pop() ?? entry.src;
      const size = entry.sizeBytes ?? 0;
      const lastModified = 0;
      urls.set(trackIdFor(name, size, lastModified), url);
      files.push({
        relativePath: entry.src,
        name,
        size,
        lastModified,
        getFile: async () => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Cannot fetch ${entry.src}`);
          return new File([await response.blob()], name, { lastModified });
        },
      });
    }
    await this.registerFiles(source, files);
    // Manifest titles/artists override file names.
    for (const entry of loaded.manifest.tracks ?? []) {
      const name = entry.src.split("/").pop() ?? entry.src;
      const id = trackIdFor(name, entry.sizeBytes ?? 0, 0);
      const current = libraryStore.getState().tracks.find((track) => track.id === id);
      if (
        current &&
        (current.title !== entry.title || current.artist !== entry.artist || current.url !== urls.get(id))
      ) {
        await this.persistTrack({ ...current, title: entry.title, artist: entry.artist, url: urls.get(id) });
      }
    }
  }

  private enqueue(trackId: string, priority = false): void {
    if (this.analysingId === trackId || this.queue.includes(trackId)) {
      if (priority) {
        const index = this.queue.indexOf(trackId);
        if (index > 0) {
          this.queue.splice(index, 1);
          this.queue.unshift(trackId);
        }
      }
      return;
    }
    if (priority) this.queue.unshift(trackId);
    else this.queue.push(trackId);
    this.reportAnalysing();
    void this.pump();
  }

  private reportAnalysing(): void {
    libraryStore.dispatch({
      type: "library/analysing",
      count: this.queue.length + (this.analysingId ? 1 : 0),
    });
  }

  private async pump(): Promise<void> {
    if (this.analysingId) return;
    const next = this.queue.shift();
    if (!next) {
      this.reportAnalysing();
      return;
    }
    this.analysingId = next;
    this.reportAnalysing();
    try {
      await this.analyseTrack(next);
    } finally {
      this.analysingId = null;
      void this.pump();
    }
  }

  async getFile(trackId: string): Promise<File> {
    const file = this.files.get(trackId);
    if (file) return file.getFile();
    const track = libraryStore.getState().tracks.find((entry) => entry.id === trackId);
    if (track?.url) {
      const response = await fetch(track.url);
      if (!response.ok) throw new Error(`Cannot fetch ${track.fileName}`);
      return new File([await response.blob()], track.fileName, { lastModified: track.lastModified });
    }
    throw new Error("File is not available in this session; add its folder again");
  }

  private async analyseTrack(
    trackId: string,
    decoded?: { sampleRate: number; channels: Float32Array[] },
  ): Promise<TrackAnalysis | null> {
    const cached = this.analyses.get(trackId) ?? (await this.db?.getAnalysis(trackId)) ?? null;
    if (cached) {
      this.analyses.set(trackId, cached);
      this.applyAnalysisSummary(trackId, cached, "ready");
      return cached;
    }
    try {
      let audio = decoded;
      if (!audio) {
        this.updateTrack(trackId, { analysisState: "decoding" });
        const file = await this.getFile(trackId);
        const result = await decodeAudio(file, this.sampleRate);
        audio = { sampleRate: result.sampleRate, channels: result.channels };
        this.updateTrack(trackId, { durationSec: result.durationSec });
      }
      this.updateTrack(trackId, { analysisState: "analysing", analysisStage: "waveform" });
      const analysis = await this.analysisClient.analyse(trackId, audio.channels, audio.sampleRate, {
        onWaveform: (waveform) => {
          this.waveforms.set(trackId, waveform);
          for (const listener of this.waveformListeners) listener(trackId, waveform);
        },
        onStage: (stage) => this.updateTrack(trackId, { analysisStage: stage }),
      });
      this.analyses.set(trackId, analysis);
      await this.db?.saveAnalysis(analysis);
      this.applyAnalysisSummary(trackId, analysis, "ready");
      return analysis;
    } catch (error) {
      this.updateTrack(trackId, {
        analysisState: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private applyAnalysisSummary(
    trackId: string,
    analysis: TrackAnalysis,
    state: LibraryTrack["analysisState"],
  ): void {
    const energy = analysis.energyPerBar.length
      ? Math.max(
          1,
          Math.min(
            10,
            Math.round(
              (Array.from(analysis.energyPerBar).reduce((a, b) => a + b, 0) / analysis.energyPerBar.length) *
                10,
            ),
          ),
        )
      : undefined;
    const patch: Partial<LibraryTrack> = {
      analysisState: state,
      bpm: analysis.grid.bpm,
      camelot: analysis.key.camelot,
      keyName: analysis.key.name,
      integratedLufs: analysis.loudness.integratedLufs,
      sections: analysis.sections,
      gridConfidence: analysis.grid.confidence,
      keyConfidence: analysis.key.confidence,
    };
    if (energy !== undefined) patch.energy = energy;
    const track = this.updateTrack(trackId, patch);
    for (const deck of ["A", "B"] as DeckId[]) {
      if (sessionStore.getState().decks[deck].track?.id === trackId) {
        sessionStore.dispatch({
          type: "deck/analysis",
          deck,
          analysis: applyUserData(analysis, this.userData.get(trackId)),
        });
      }
    }
    if (!track) return;
  }

  /** Decodes a track for a deck; the caller hands the channels to the engine. Analysis is prioritised. */
  async prepareForDeck(trackId: string): Promise<LoadedTrack> {
    const track = libraryStore.getState().tracks.find((entry) => entry.id === trackId);
    if (!track) throw new Error("Unknown track");
    const file = await this.getFile(trackId);
    const decoded = await decodeAudio(file, this.sampleRate);
    if (track.durationSec !== decoded.durationSec)
      this.updateTrack(trackId, { durationSec: decoded.durationSec });
    const analysis = this.analyses.get(trackId) ?? (await this.db?.getAnalysis(trackId)) ?? null;
    if (analysis) {
      this.analyses.set(trackId, analysis);
    } else {
      // Analyse from a copy without waiting for the queue.
      const copy = cloneChannels(decoded.channels);
      void this.runPriorityAnalysis(trackId, { sampleRate: decoded.sampleRate, channels: copy });
    }
    return {
      track: { ...track, durationSec: decoded.durationSec },
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
    };
  }

  private async runPriorityAnalysis(
    trackId: string,
    decoded: { sampleRate: number; channels: Float32Array[] },
  ): Promise<void> {
    const index = this.queue.indexOf(trackId);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.analysingId) {
      // The client queue is sequential; the deck's analysis goes next.
      this.queue.unshift(trackId);
      this.reportAnalysing();
      return;
    }
    this.analysingId = trackId;
    this.reportAnalysing();
    try {
      await this.analyseTrack(trackId, decoded);
    } finally {
      this.analysingId = null;
      void this.pump();
    }
  }

  dispose(): void {
    this.analysisClient.dispose();
    this.db?.close();
  }
}

let instance: Library | null = null;

export function getLibrary(): Library {
  if (!instance) instance = new Library();
  return instance;
}
