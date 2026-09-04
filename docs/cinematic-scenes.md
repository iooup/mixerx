# Cinematic scenes

The Cinematic category offers four image-backed WebGPU worlds driven by the
same music features and Director as the other Stage scenes.

| Scene | Visual movement |
| --- | --- |
| Night Phoenix | Wing and feather deformation with controlled eye glow |
| Spectral Gate | A slowly rotating mandala over a layered background |
| Astral Lotus | Petal and water movement around a floating flower |
| Crystal Voyage | Layered travel through a crystalline corridor |

## Controls and playback

Choose Cinematic in the Stage studio. Intensity and automatic scene selection
remain available; appearance, overlays, and diagnostics live in expandable
controls. Presets retain scene settings and can be recalled in connected outputs.

Automatic following stays within the selected category. Scene changes use the
shared transition logic. Thumbnails use the same artwork and motion clock as
the output.

Music envelopes are smoothed; silence and reduced motion hold travel.
Cinematic flash and strobe effects are disabled in both Director and compositor.
Blackout remains available. These limits do not constitute a medical safety
guarantee for photosensitive viewers.

## Implementation

`src/visuals/gpu/scenes/cinematic/` contains image loading, motion, and shaders.
The six local WebP assets load from the application origin and use locally
generated mipmaps. GPU textures are released when the scene is disposed.

The scenes do not import another audio engine, remote artwork, or executable
scripts from source reference material.

See [artwork provenance](../src/visuals/gpu/scenes/cinematic/assets/README.md)
and [Third-party notices](../THIRD-PARTY-NOTICES.md) for the recorded origins and
permission gaps. Relevant checks live in `tests/unit/cinematic.test.ts` and
`tests/e2e/cinematic-stage.spec.ts`; see [Testing](testing.md).
