# Crowd overlays

The Stage can add a crowd over the selected scene: classic abstract dancers,
one pet character, or a mixed group. The choices are Codex, Dario, Fireball,
Hoots, and Mixed crowd.

## Set up a crowd

Open the Stage studio, choose the crowd character, and adjust **Crowd formation**.
Pet formations support 4–10 characters, defaulting to 8; size and spacing adjust
their layout. The classic crowd uses 10 dancers.

Character and formation settings are saved per scene, synchronized to connected
audience windows, and included in presets. Older larger counts are clamped to 10.

## Motion

Pet animation combines existing sprite poses with musical phase and kick/snare
responses. The four characters have distinct dance phrases. The existing Stage
render loop drives the overlay, with a bounded pose cache and locally decoded
images.

Silence and reduced motion return pets to a resting pose; loop freeze holds the
pose. Blackout hides the crowd along with the scene. Formation layout accounts
for the output aspect ratio.

## Implementation and assets

`src/visuals/crowd/` contains the classic SVG layer, sprite renderer, motion,
formation, and asset definitions. These are playback atlases, not installable
pet packages.

[Asset provenance](../src/visuals/crowd/assets/README.md) records sources and
transformations. The repository does not establish redistribution permission for
these third-party characters; see [Third-party notices](../THIRD-PARTY-NOTICES.md).

Focused checks live in `tests/unit/crowd-pets.test.ts` and
`tests/e2e/crowd-stage.spec.ts`. The optional soak has separate private-library
requirements described in [Testing](testing.md).
