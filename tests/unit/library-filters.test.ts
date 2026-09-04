import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, filterTracks } from "../../src/library/library-store";
import type { LibraryTrack } from "../../src/library/types";

function track(id: string, patch: Partial<LibraryTrack>): LibraryTrack {
  return {
    id,
    title: id,
    artist: "",
    durationSec: 300,
    sizeBytes: 1,
    source: "manifest",
    hasArtwork: false,
    sourceId: "dev",
    fileName: `${id}.mp3`,
    relativePath: `${id}.mp3`,
    lastModified: 0,
    analysisState: "ready",
    ...patch,
  };
}

const tracks = [
  track("same", { camelot: "8A", bpm: 128, energy: 7 }),
  track("neighbour", { camelot: "9A", bpm: 131, energy: 8 }),
  track("clash", { camelot: "2B", bpm: 128, energy: 7 }),
  track("fast", { camelot: "8A", bpm: 150, energy: 9, sourceId: "folder" }),
  track("unknown", {}),
];
const reference = { camelot: "8A", bpm: 128, energy: 7 };

describe("library filters", () => {
  it("filters by key compatibility, tempo window, energy band and source", () => {
    const ids = (list: LibraryTrack[]) => list.map((entry) => entry.id);
    expect(ids(filterTracks(tracks, "", { ...DEFAULT_FILTERS, keyCompatible: true }, reference))).toEqual([
      "same",
      "neighbour",
      "fast",
    ]);
    expect(ids(filterTracks(tracks, "", { ...DEFAULT_FILTERS, tempoWindow: true }, reference))).toEqual([
      "same",
      "neighbour",
      "clash",
    ]);
    expect(ids(filterTracks(tracks, "", { ...DEFAULT_FILTERS, energyBand: "high" }, reference))).toEqual([
      "neighbour",
      "fast",
    ]);
    expect(ids(filterTracks(tracks, "", { ...DEFAULT_FILTERS, sourceId: "folder" }, reference))).toEqual([
      "fast",
    ]);
    expect(ids(filterTracks(tracks, "", { ...DEFAULT_FILTERS, keyCompatible: true }, null))).toEqual([]);
  });

  it("sorts by fit, bpm, energy and title without mutating the input", () => {
    const byFit = filterTracks(tracks, "", DEFAULT_FILTERS, reference, "compat").map((entry) => entry.id);
    expect(byFit[0]).toBe("same");
    // A key clash scores below an unanalysed track (0.5), so it sorts last.
    expect(byFit[byFit.length - 1]).toBe("clash");
    expect(filterTracks(tracks, "", DEFAULT_FILTERS, null, "bpm").map((entry) => entry.bpm ?? 0)).toEqual([
      0, 128, 128, 131, 150,
    ]);
    expect(filterTracks(tracks, "", DEFAULT_FILTERS, null, "energy")[0]?.id).toBe("fast");
    expect(filterTracks(tracks, "", DEFAULT_FILTERS, null, "title")[0]?.id).toBe("clash");
    expect(tracks[0]?.id).toBe("same");
  });
});
