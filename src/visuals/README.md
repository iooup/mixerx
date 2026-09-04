# Visual Stage

The Stage interprets the Console's musical state without opening music files
or running a second audio engine.

| Area | Responsibility |
| --- | --- |
| `protocol.ts` | Validated frames, settings, and session-channel messages |
| `console-bridge.ts` | Features, events, output windows, and settings synchronization |
| `stage-client.ts` | Channel subscription and explicitly selected test signals |
| `events.ts`, `predict.ts` | Musical events and bounded frame prediction |
| `director.ts`, `follow.ts`, `palette.ts` | Musical intent, scene following, transitions, and color |
| `gpu/` | WebGPU device, renderer, scene lifecycle, shaders, camera, and targets |
| `crowd/` | Classic SVG dancers and locally bundled pet sprites |
| `lower-third/`, `idle/`, `night/` | Now-playing text, idle clock, and set constellation |
| `morph.ts` | Particle-message assembly and release |
| `test-signal.ts` | Deterministic synthetic musical features |

The [scene catalogue](../agent/scenes.ts) groups looks into Classic, Simple,
and Cinematic. Studio UI lives in `src/ui/stage/`, the route in
`src/app/routes/StagePage.tsx`, and strings in `src/locales/stage.en.json`.

Preserve the shared blackout and reduced-motion behavior, bounded brightness,
resource disposal, and honest handling of silence or missing frames. Thumbnails
use scene renderers, not substitute artwork. Stage messages carry no audio samples.

See [Cinematic scenes](../../docs/cinematic-scenes.md),
[Crowd overlays](../../docs/crowd-pets.md), and
[Architecture](../../docs/architecture.md).
