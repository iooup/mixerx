# Contributing to Mixerx

Contributions can improve the instrument, its accessibility, testing, or
documentation. Keep each change focused and explain the user problem it solves.

## Get started

Use Node.js 22.12 or newer, then run:

```bash
npm ci
npm run dev -- --host 127.0.0.1
```

Read the [architecture guide](docs/architecture.md) and the module documentation
for the area you want to change. Discuss significant changes in behavior,
dependencies, or product scope with the maintainer before implementing them.

## Product principles

- Keep audio processing local; do not add uploads, telemetry, analytics, or CDN assets.
- Preserve the shared audio engine, its timing, and the accuracy of visible state.
- Preserve agent access policy, confirmation, redaction, and supported undo behavior.
- Make controls accessible by keyboard and keep reduced-motion behavior intact.
- Write interface copy, documentation, and comments in English. User-owned track
  titles and metadata may contain any language.
- Keep the introduction page's opt-in video policy separate from the instrument's
  stricter policy. See [Privacy and data](docs/privacy.md).

## Before opening a pull request

Run `npm run verify` and the relevant browser checks listed in
[Testing](docs/testing.md). The full E2E suite currently depends partly on private
audio; report unavailable checks instead of claiming a clean-clone pass.

Describe the change, the checks run, and any remaining limitations. Include
screenshots when changing visible behavior, using demo or authorized material.
Update the relevant guide when behavior changes.

Follow [Repository contents](docs/repository.md): keep generated evidence and
local configuration out of Git, but retain tests, lockfiles, license notices,
and provenance.

## Licensing of contributions

Mixerx is dual-licensed: AGPL-3.0-or-later for everyone, and a separate
commercial license offered by the copyright holder (see `NOTICE`). That second
option only works if a single party holds the rights to the whole codebase.

So, by submitting a contribution, you agree that:

1. You are the author of the contribution, or you have the right to submit it.
2. You grant the project maintainer (Ayob, ayob8986@gmail.com) a perpetual,
   worldwide, irrevocable, royalty-free right to use, modify and relicense your
   contribution, **including under licenses other than the AGPL** — for example
   as part of a commercially licensed version of Mixerx.
3. Your contribution remains available to everyone under the AGPL-3.0-or-later
   as part of this repository.

You keep the copyright to your own work; you are granting a license, not
transferring ownership.

Sign off each commit to confirm this:

```bash
git commit -s -m "your message"
```

If a contribution includes code, artwork, audio, fonts or any other material you
did not create yourself, say so in the pull request and name its license. Do not
submit material whose license you cannot identify.
