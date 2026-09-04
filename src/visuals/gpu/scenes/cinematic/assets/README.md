# Cinematic artwork provenance

Six WebP images provide the Cinematic Stage backgrounds and foreground layers.
They load from the application origin, never from remote artwork services.

| Files | Recorded origin |
| --- | --- |
| `phoenix-sky.webp`, `phoenix.webp` | Image data extracted from supplied `night-phoenix-live.html` |
| `spectral-garden.webp`, `spectral-gate.webp` | Image data extracted from supplied `spectral-gate-psytrance-live.html` |
| `astral-lotus.webp`, `crystal-voyage.webp` | Generated for Mixerx on 2026-09-03; prompts in [prompts.json](prompts.json) |

## Processing and runtime

Images retain their 1672×941 dimensions and any alpha channel. WebP quality is
84 for the extracted assets and 86 for the generated paintings.

Only image data was reused from the supplied documents, not scripts, audio
loading, controls, or independent timing. Mipmaps are generated locally.
Scene disposal releases the GPU textures, including when image decoding is
still pending. The Console does not decode the Cinematic artwork.

## Permission status

The source documents record where the four extracted images came from, but do
not establish ownership or redistribution permission. No separate grant for
those images is recorded in this repository. Keep this distinction from the
two project-generated images when reviewing a release.

See [Third-party notices](../../../../../../THIRD-PARTY-NOTICES.md). Generation
prompts and provenance records are source documentation, not disposable QA output.
