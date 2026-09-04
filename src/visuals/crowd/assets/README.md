# Pet artwork provenance

These atlases are Stage playback assets, not installable pet packages.

| Character | Recorded source |
| --- | --- |
| Codex | Built-in Codex application artwork |
| Fireball | Built-in Codex application artwork |
| Hoots | Built-in Codex application artwork |
| Dario | Community artwork from codex-pets.net |

[provenance.json](provenance.json) records source identifiers, the community
source URL, and source/output SHA-256 checksums. Keep that record with the images.

## Transformations

The idle, right-step, left-step, waving, and jumping rows remain in their original
order. Source cells were reduced from 192×208 to 96×104 with nearest-neighbor
sampling. Each Stage atlas is 768×520: eight columns and five rows.

Codex, Fireball, and Hoots use lossless WebP. Dario uses WebP quality 90 with
transparency. No frames were generated or redrawn; the Stage applies its own
music-driven choreography to the existing poses.

The runtime imports bundled files. It does not fetch any provenance URL.

## Permission status

The images retain their original ownership. This repository records no
redistribution license or permission grant for them. A source URL, an installed
copy, or permission to download an asset is not itself a recorded redistribution
grant. See [Third-party notices](../../../../THIRD-PARTY-NOTICES.md) before
publishing a distribution containing these images.
