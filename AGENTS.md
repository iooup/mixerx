# Agent Guide

Mixerx is a local-first browser DJ instrument with a two-deck Console, an optional
AI DJ agent, and a music-reactive visual Stage.

- Use concise English for responses, documentation, and comments unless the user asks otherwise.
- Read `README.md`, `CONTRIBUTING.md`, and the relevant guides in `docs/`. Describe the current product; do not revive retired plans or treat historical screenshots as specifications.
- Inspect Git status before editing and preserve unrelated changes. Keep each task scoped; confirm significant design or behavior changes with the maintainer.
- Keep audio processing local. Do not add uploads, telemetry, CDN assets, or external services. The introduction page's opt-in YouTube embed is an existing, isolated exception.
- Keep engine state and timing authoritative. Preserve agent permissions, confirmation, redaction, supported undo, accessibility, and reduced-motion behavior.
- Never commit secrets, private music, machine-specific state, or generated reports. Follow `docs/repository.md`; preserve licenses and asset provenance.
- Run the relevant checks in `docs/testing.md`. Report changed files, results, remaining risks, and the next useful step.
