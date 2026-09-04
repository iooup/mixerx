import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { LibraryDatabase } from "../../src/library/db";
import { createInitialLibrary, filterTracks, reduceLibrary } from "../../src/library/library-store";
import { id3HeaderLength, parseId3 } from "../../src/library/tags";
import { isAudioFileName, type LibraryTrack, titleFromFileName, trackIdFor } from "../../src/library/types";

function id3Frame(id: string, text: string, encoding = 3): Uint8Array {
  const body = new TextEncoder().encode(text);
  const frame = new Uint8Array(10 + 1 + body.length);
  frame.set(new TextEncoder().encode(id), 0);
  const size = body.length + 1;
  frame[4] = (size >> 24) & 0xff;
  frame[5] = (size >> 16) & 0xff;
  frame[6] = (size >> 8) & 0xff;
  frame[7] = size & 0xff;
  frame[10] = encoding;
  frame.set(body, 11);
  return frame;
}

function id3Tag(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const tag = new Uint8Array(10 + total);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0], 0);
  tag[6] = (total >> 21) & 0x7f;
  tag[7] = (total >> 14) & 0x7f;
  tag[8] = (total >> 7) & 0x7f;
  tag[9] = total & 0x7f;
  let offset = 10;
  for (const frame of frames) {
    tag.set(frame, offset);
    offset += frame.length;
  }
  return tag;
}

describe("library identity and names", () => {
  it("hashes file identity stably and recognises audio extensions", () => {
    expect(trackIdFor("a.mp3", 100, 5)).toBe(trackIdFor("a.mp3", 100, 5));
    expect(trackIdFor("a.mp3", 100, 5)).not.toBe(trackIdFor("a.mp3", 101, 5));
    expect(isAudioFileName("Track.FLAC")).toBe(true);
    expect(isAudioFileName("cover.jpg")).toBe(false);
    expect(titleFromFileName("03 Charlotte de Witte - Roar.mp3")).toEqual({
      artist: "Charlotte de Witte",
      title: "Roar",
    });
    expect(titleFromFileName("mandala.wav")).toEqual({ title: "mandala", artist: "" });
  });
});

describe("ID3 tags", () => {
  it("parses v2.3 text frames and artwork presence", () => {
    const tag = id3Tag([
      id3Frame("TIT2", "Roar"),
      id3Frame("TPE1", "Charlotte de Witte"),
      id3Frame("TBPM", "136"),
      id3Frame("TKEY", "Am"),
    ]);
    expect(id3HeaderLength(tag)).toBe(tag.length);
    const tags = parseId3(tag);
    expect(tags).toEqual({
      title: "Roar",
      artist: "Charlotte de Witte",
      bpm: 136,
      key: "Am",
      hasArtwork: false,
    });
    expect(parseId3(new Uint8Array([0, 1, 2]))).toEqual({ hasArtwork: false });
  });
});

describe("library store", () => {
  it("replaces tracks by id and filters by text", () => {
    const track = (id: string, title: string, camelot?: string): LibraryTrack => ({
      id,
      title,
      artist: "Someone",
      durationSec: 0,
      sizeBytes: 1,
      source: "folder",
      hasArtwork: false,
      sourceId: "s",
      fileName: `${title}.mp3`,
      relativePath: `${title}.mp3`,
      lastModified: 0,
      analysisState: "queued",
      ...(camelot ? { camelot } : {}),
    });
    let state = reduceLibrary(createInitialLibrary(), {
      type: "library/tracks",
      tracks: [track("1", "Roar", "7A"), track("2", "Pria")],
    });
    state = reduceLibrary(state, {
      type: "library/track",
      track: { ...track("1", "Roar", "7A"), analysisState: "ready" },
    });
    expect(state.tracks).toHaveLength(2);
    expect(state.tracks[0]?.analysisState).toBe("ready");
    expect(filterTracks(state.tracks, "7a").map((t) => t.id)).toEqual(["1"]);
    expect(filterTracks(state.tracks, "someone")).toHaveLength(2);
  });
});

describe("IndexedDB persistence", () => {
  it("stores sources, tracks, analyses, and user data by key", async () => {
    const db = await LibraryDatabase.open();
    expect(db).not.toBeNull();
    if (!db) return;
    await db.saveSource({ id: "s1", kind: "files", name: "Files", addedAt: 1, trackCount: 1 });
    await db.saveTrack({
      id: "t1",
      title: "Roar",
      artist: "",
      durationSec: 1,
      sizeBytes: 1,
      source: "folder",
      hasArtwork: false,
      sourceId: "s1",
      fileName: "roar.mp3",
      relativePath: "roar.mp3",
      lastModified: 0,
      analysisState: "queued",
    });
    await db.saveUserData({ trackId: "t1", cueSec: 12.5 });
    expect((await db.listSources()).map((source) => source.id)).toEqual(["s1"]);
    expect((await db.listTracks())[0]?.title).toBe("Roar");
    expect((await db.getUserData("t1"))?.cueSec).toBe(12.5);
    expect(await db.getAnalysis("missing")).toBeNull();
    db.close();
  });
});
