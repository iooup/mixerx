# Local music library

The library connects user-selected files to decoding, analysis, deck loading,
and browser-local persistence.

- `sources.ts`: directory permissions, file lists, drag-and-drop, and an optional
  development manifest.
- `tags.ts`, `decode.ts`: embedded metadata/artwork and local audio decoding.
- `library.ts`: library lifecycle, sequential analysis, priority deck loads,
  and user-data application.
- `db.ts`: IndexedDB sources, tracks, analyses, and cue/grid edits.
- `library-store.ts`, `queue.ts`: UI-facing library and queue state.
- `compatibility.ts`: musical-fit scoring against the on-air track.
- `demo-tracks.ts`: the two original tracks generated locally for an empty library.

Only metadata, analyses, user edits, and supported source handles persist.
Decoded audio is not saved to IndexedDB. File-picker imports may need reselecting
after a reload; directory handles may need permission again.

The development manifest is read only in development. Keep its audio and metadata
out of Git and production output; see [Local audio setup](../../local-audio/README.md).
