# Architecture

Mixerx is a TypeScript and React application built with Vite. Its audio engine,
analysis, library, and visual renderer run in the browser. There is no application
backend for music, accounts, or agent inference.

## Surfaces

| Surface | Route | Responsibility |
| --- | --- | --- |
| Console | `/` | Decks, mixer, library, lesson, agent proposals, and settings |
| Stage studio | `/stage?session=…` | Scene selection, preview, director controls, and output settings |
| Audience display | `/stage?session=…&mode=display` | Presentation output without studio controls |
| Introduction website | `/mixerx/` | Product information and an opt-in recorded demo; built separately |

Learn, Mix, and Perform share the Console. They change guidance and available
controls without creating separate audio engines.

## Audio and analysis

`src/engine/` owns the AudioContext, AudioWorklet decks, mixer graph, output
routing, and transport actions. Musical scheduling is translated into audio-frame
targets; UI animation is not the playback clock.

Each deck passes through trim, three-band EQ, filter, channel fader, and
crossfader gain. The master path includes a limiter and a feature tap. A separate
cue bus supports the routing choices exposed by Audio Setup.

`src/library/` obtains user-selected files and decodes them locally.
`src/analysis/` processes a mono downmix in a Worker and produces tempo,
beat-grid, key, section, loudness, and waveform estimates. Analysis runs
sequentially; loading a deck prioritizes that track.

The analysis is heuristic. Confidence values and agreement with unverified
manifest hints are not measured accuracy against annotated music.

## State and persistence

`src/state/session.ts` defines the session contracts.
`session-store.ts` applies named events; UI components subscribe to stores.
The engine remains authoritative for playback position and timing.

| Data | Storage |
| --- | --- |
| Decoded audio | Memory; not saved in the library database |
| Source handles, track metadata, analyses, cue/grid edits | IndexedDB |
| UI, routing, MIDI, and Stage preferences | Browser storage |
| Running order and energy history | Session storage |
| Explicit recap exports | Files downloaded at the user's request |

Changes to stored formats must account for existing values. The interface is
English; track titles and other user-authored text may use any script.

## Agent tools

`src/agent/tools.ts` defines the tools; `registry.ts` validates inputs, checks
policy, creates proposals, and records results. WebMCP, the local rule-based agent,
and the development harness reuse that registry.

There are three access classes: `read`, `prepare`, and `act`. Observe permits
read access, Prepare also permits preparation, and Co-DJ permits action tools.
Calls above the selected level become confirmation proposals. Tool preconditions
still apply; an autonomy setting does not bypass them.

The mode controls tool availability: Learn exposes the reading subset, while
Mix and Perform expose the broader tool set. The WebMCP adapter feature-detects
its host API. Core mixing and local suggestions do not require WebMCP or a model.

Undo exists only where a handler supplies a reversible operation. It cannot undo
sound the audience has already heard. See [agent module](../src/agent/README.md)
and [privacy](privacy.md).

## Visual Stage

`src/visuals/console-bridge.ts` publishes validated features, musical events,
settings, and limited now-playing metadata over a session-scoped BroadcastChannel.
It does not send audio samples or file handles to Stage windows.

The Stage client receives those messages. A Director turns musical structure and
DJ gestures into rendering intent; prediction smooths the gap between incoming
frames. WebGPU scenes, the SVG layers, and the pet sprites consume that intent.
The same scene renderers produce previews and audience output.

Blackout, reduced motion, bounded brightness, and feature-loss behavior belong
to the shared rendering contract. Keep test signals clearly distinguishable from
live audio. Details live in the [visuals module](../src/visuals/README.md).

## Module map

| Path | Purpose |
| --- | --- |
| `src/app/` | Bootstrap, routes, English string lookup, privacy probe |
| `src/ui/` | Console and Stage controls, canvases, styles, keyboard actions |
| `src/coach/` | Declarative lessons and completion/scoring logic |
| `src/midi/` | Opt-in controller input, mapping, and soft takeover |
| `src/locales/` | English string dictionaries, including lazy feature chunks |
| `scripts/` | Security policy, build checks, and packaging |
| `worker/` | Static application serving and response security headers |
| `tests/` | Unit, browser, corpus, and soak checks |

## Build and security boundaries

`npm run build` creates `dist/client/` and packages the worker and Sites
metadata under `dist/`. The root `.openai/hosting.json` is a required build
input, not disposable local state. Building does not publish anything.

`npm run build:site` checks the instrument's security and size budgets, builds the
introduction page separately, then includes it under `dist/client/mixerx/` in the
same package. The worker serves it at `/mixerx/`; `/stage` retains the app fallback.
Missing introduction assets never fall back to the Console document.

The Console and Stage use the shared policy in `scripts/csp.mjs`.
The introduction website has a narrow, opt-in video exception in
`mixerx/security.mjs` and a separate Vite build. Do not apply its relaxed
embedding headers to the instrument.
