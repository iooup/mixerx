# Repository contents

Keep the repository useful to someone cloning Mixerx for the first time:
source, reproducible tooling, current documentation, and material needed to
build and redistribute the project.

## Keep tracked

- Application source, tests, scripts, and build configuration.
- `package.json` and `package-lock.json` for reproducible dependency installation.
- `.github/` for shared checks and dependency maintenance.
- `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, and current technical guides.
- `LICENSE`, `NOTICE`, third-party notices, and asset provenance.
- Runtime images under `src/`, the introduction page's `mixerx/shots/`,
  its `mark.svg`, and `public/og.png`.
- `.openai/hosting.json`: required by the current packaging script. Do not
  ignore the whole directory or insert credentials into the manifest.

`AGENTS.md` is shared contributor guidance, not a private conversation log.
Write durable rules there, not task prompts, approval transcripts, or phase reports.

## Keep local and ignored

- Installed dependencies, build output, coverage, and tool caches.
- Browser screenshots, recordings, traces, and generated test reports.
- Local environment files, credentials, editor state, and agent-session folders.
- All files beneath `local-audio/` except its public setup guide.
- Scratch plans, review notes, and one-off task output under `.local/`.

Use `test-results/` for generated test evidence. Keep a curated image in a public
documentation or product-asset directory only when a current page actually uses
it and its distribution rights are documented.

Do not globally ignore image, JSON, Markdown, or audio extensions: those patterns
can hide legitimate source assets and future distributable test fixtures.

## Retire finished-work material

Old redesign proposals, superseded implementation logs, phase prompts, private
upload notes, submission drafts, and unreferenced QA captures are not product
documentation. Extract any lasting behavior or limitations into a current guide
before removing the old material.

Do not remove tests, development harnesses, or provenance just because they were
created during development. They still support reproducibility and maintenance.

## Git boundaries

Ignore rules apply to untracked files. Adding a tracked file to `.gitignore`
does not remove it from Git or erase earlier commits. Inspect staged changes
before every commit, especially generated reports containing track metadata.

Deleting a tracked file removes it from the next tree, not from repository
history or existing clones. A public-source release must separately review the
history for private information and material that should not be redistributed.
Do not rewrite shared history as routine cleanup.

## Before a public release

- Verify the intended source tree and release archive, not only the working folder.
- Resolve the artwork permission gaps listed in
  [Third-party notices](../THIRD-PARTY-NOTICES.md).
- Check that public CI can run without a private music collection. Some current
  browser tests require a specific 16-track corpus; see [Testing](testing.md).
- Confirm that documentation describes implemented features and measured checks,
  without stale phase names, test totals, or unsupported performance claims.
- Keep hosting and publication as explicit release actions. A build or a commit
  alone is not approval to publish.
