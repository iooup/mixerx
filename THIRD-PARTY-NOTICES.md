# Third-party notices

Mixerx itself is licensed under the AGPL-3.0-or-later (see `LICENSE` and `NOTICE`).
Software and assets retain their own ownership and applicable terms. Preserve
their notices when redistributing. The artwork sections below identify where
provenance is recorded but redistribution permission is not documented.

## Runtime libraries (shipped in the client bundle)

| Component | Version | License | Copyright |
|---|---|---|---|
| [React](https://react.dev) (`react`, `react-dom`) | 19.2.8 | MIT | Meta Platforms, Inc. and affiliates |
| [lucide-react](https://lucide.dev) | 1.39.0 | ISC | Lucide Contributors |

Both licenses are permissive and compatible with the AGPL: their code may be
incorporated into an AGPL-licensed work provided the notices above are kept.

## Typefaces (bundled as WOFF2, served from the app's own origin)

| Family | Package | License |
|---|---|---|
| IBM Plex Sans | `@fontsource/ibm-plex-sans` 5.3.0 | SIL Open Font License 1.1 |
| IBM Plex Mono | `@fontsource/ibm-plex-mono` 5.3.0 | SIL Open Font License 1.1 |
| Syne (introduction page `mixerx/` only) | `@fontsource/syne` 5.3.0 | SIL Open Font License 1.1 |
| Space Mono (introduction page `mixerx/` only) | `@fontsource/space-mono` 5.3.0 | SIL Open Font License 1.1 |

Copyright 2017–2019 IBM Corp. "IBM Plex" is a Reserved Font Name under the OFL.
Copyright 2019 The Syne Project Authors (https://gitlab.com/bonjour-monde/fonderie/syne-typeface). Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono). Syne and Space Mono are bundled only by the standalone introduction page under `mixerx/`; the Console bundle does not include them.
The fonts are redistributed unmodified. Under the OFL they may be bundled with
and redistributed alongside this software; they may not be sold on their own,
and any modified version must be released under a different name. The full OFL
text ships with each package (`node_modules/@fontsource/*/LICENSE`).

## Derived code

**FFT ocean surface** — `src/visuals/gpu/scenes/ocean-spectrum.ts` and
`src/visuals/gpu/scenes/ocean-shaders.ts` adapt the Phillips spectrum evolution,
the Stockham inverse-FFT schedule and the particle shading from Vercel's `vgpu`
example.

- Source: <https://vgpu.sh/examples/fft-ocean> / <https://github.com/vercel-labs/vgpu>
- License: MIT — Copyright (c) 2025 Vercel, Inc.
- Full text: [`docs/licenses/vgpu-MIT.txt`](docs/licenses/vgpu-MIT.txt)

The MIT license permits this adaptation inside an AGPL work as long as the
copyright notice above is retained.

## Crowd artwork

The Stage bundles Codex, Fireball, and Hoots sprites sourced from the Codex
application, and Dario sprites from a community source. Their origins,
transformations, and checksums are recorded in the
[asset guide](src/visuals/crowd/assets/README.md) and its `provenance.json`.

No redistribution license or permission grant for these four character assets
is recorded in this repository. This is a documentation gap, not a determination
of infringement. Their inclusion does not make them AGPL-licensed or establish
that the project's commercial license covers them. Resolve permission or replace
the assets before distributing them publicly.

## Cinematic artwork

The four Cinematic looks bundle six WebP images. Four were extracted from supplied
HTML documents; two were generated for Mixerx. The
[asset guide](src/visuals/gpu/scenes/cinematic/assets/README.md) records which is
which, and `prompts.json` preserves the generation prompts.

The supplied files establish provenance, not ownership or redistribution rights.
No separate permission grant for those four extracted images is recorded here.
Confirm their applicable terms before redistribution; do not describe supplied
artwork as automatically covered by the project license.

## Audio

No audio is bundled with this repository. Mixerx reads music from folders the
user picks on their own machine; those files are never uploaded, copied into the
repository, or transmitted anywhere. The development corpus under `local-audio/`
is git-ignored and is not part of any distribution.
