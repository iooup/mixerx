# Local audio for testing

This directory is optional and private. Everything here except this guide is
ignored by Git. Do not commit music, manifests, exports, or upload records.

You do not need a test corpus to use Mixerx: import files through the Console
or choose **Load demo tracks** in an empty library.

## Development manifest

For local corpus testing, place authorized audio files under `library/` and
create `library.json`. For example:

```json
{
  "library": { "title": "Local test library" },
  "tracks": [
    {
      "id": "test-track-01",
      "title": "Original test track",
      "artist": "Test artist",
      "src": "library/test-track-01.wav",
      "sizeBytes": 123456,
      "durationSec": 120,
      "bpm": 128,
      "key": "8A"
    }
  ]
}
```

Replace the illustrative values with your actual file metadata. Paths are
relative to `library.json`; use same-origin local paths, not remote music URLs.
BPM and key fields are optional comparison hints for the corpus report.

The application reads this manifest only in development. Vite serves these files
over its development origin, so bind the server to `127.0.0.1` when working
with private audio. Git ignore rules prevent tracking, not HTTP access.

## Test limitations

Several browser tests require a particular 16-track collection rather than an
arbitrary manifest. The repository does not distribute that collection.
See [Testing](../docs/testing.md) for corpus-free checks and the CI limitation.

Demo-track tests expect no local manifest. Use a separate checkout without the
private library for that setup. Production builds do not include this directory.
