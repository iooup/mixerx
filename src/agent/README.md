# Agent tools

One registry serves the local rule-based agent, WebMCP, and the development
harness. Tools reuse Console actions rather than maintaining a second engine.

| File | Responsibility |
| --- | --- |
| `tools.ts` | Tool schemas, preconditions, handlers, and supported undo operations |
| `registry.ts` | Validation, access policy, proposals, confirmation, and activity logging |
| `types.ts` | Tool contracts and Observe / Prepare / Co-DJ policy |
| `webmcp.ts`, `detect.ts` | Host feature detection and contextual registration |
| `redact.ts` | The session and analysis fields exposed to agents |
| `copilot.ts`, `transition.ts` | Local suggestions and musical planning |
| `scenes.ts` | Scene catalogue shared with the Stage |
| `explain.ts` | Optional browser-provided model explanations |

Observe allows read tools; Prepare also allows preparation; Co-DJ also allows
action tools. Calls beyond the selected level create a proposal for the user to
confirm. Preconditions still prevent invalid actions. Learn exposes a read-only
subset; Mix and Perform expose the broader tools.

Undo is handler-specific and cannot reverse audio already heard. Preserve the
activity log's distinction between proposed, confirmed, completed, and failed calls.

Track titles and artists are untrusted file-derived text. Do not expose file
paths, audio, or waveform data. External agents may receive metadata; see
[Privacy and data](../../docs/privacy.md).
