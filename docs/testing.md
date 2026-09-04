# Testing

Install the locked dependencies with `npm ci`. Node.js 22.12 or newer is required;
CI uses Node.js 24.

## Fast checks

```bash
npm run verify
```

This runs TypeScript, Biome, unit tests, the production build, the Content Security
Policy check, and bundle-size budgets. It does not require a private audio library.
Build output goes to `dist/`; building does not deploy the application.

Dependency vulnerability auditing is not part of `verify`. The shared `.npmrc`
disables npm's automatic install-time audit; assess dependencies separately
before a release rather than treating successful installation as a security check.

For a focused change:

```bash
npm run typecheck
npm run lint
npm run test -- tests/unit/privacy.test.ts
```

## Browser tests

Install the browser used by the suite:

```bash
npx playwright install chromium
```

On a Linux test machine, `npx playwright install --with-deps chromium` also
installs browser system dependencies.

A small Console/audio-engine check that does not use the private corpus is:

```bash
npx playwright test tests/e2e/console.spec.ts tests/e2e/engine.spec.ts --project=console
```

Playwright starts the local server when needed. Console tests use Chromium's
headless shell; Stage tests use full Chromium with WebGPU. GPU availability and
driver behavior affect the visual and timing checks.

### Private-corpus dependency

`npm run e2e` currently includes tests that load `local-audio/library.json`.
Several assert exactly 16 library rows or use particular analyzed tracks.
Those files are intentionally not distributed. An arbitrary replacement library
does not guarantee those assertions will pass.

The CI workflow invokes this full suite without provisioning that corpus.
Consequently, full E2E success from a clean public clone is not established.
Replacing corpus-dependent fixtures with original, deterministic test material is
a separate test-infrastructure task; do not publish private music to make CI pass.

Demo-track tests instead expect an empty initial library. Run those against a
checkout without a local manifest so the two generated tracks are the only rows.
Neither an all-green private-corpus run nor a demo-only run proves both setups.

## Introduction website

The introduction page is independent of the main application build:

```bash
npx vite build --config mixerx/vite.config.mjs
node --test mixerx/landing.test.mjs
```

Build it before running its tests, which inspect the generated HTML and assets.
See [its guide](../mixerx/README.md) for security-header requirements.

For a combined Sites package, run `npm run build:site`, then the introduction tests
above. The command checks the instrument's existing size budgets before adding
the separately built introduction assets, then validates both document policies.
The worker's route and header isolation are covered by `tests/unit/csp.test.ts`.

## Corpus and soak checks

These are optional, private-library checks:

```bash
npm run corpus
npm run test:soak
```

The corpus run reports analysis completion and agreement with manifest BPM/key
hints. Unless those hints have been independently verified, the report is not a
musical-accuracy benchmark.

The soak runs approximately 30 minutes of real-time playback with scene, tempo,
and formation changes. Its JavaScript-heap readings are not total browser or GPU
memory. A completed run measures that configuration, not every output device.

Generated reports and captures belong under Playwright's ignored
`test-results/` directory. They may contain private track titles; review them
before sharing. Do not write generated evidence into public documentation.

## What to report

State the exact checks run, their results, and anything skipped or unavailable.
Avoid permanent test-count and performance claims in product documentation.
Audio-device routing, listening quality, physical displays, and live-performance
reliability need hardware checks beyond automated tests.
