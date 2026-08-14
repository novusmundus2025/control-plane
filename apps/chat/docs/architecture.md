# MundusX Chat Architecture

MundusX Chat originally followed a modular monolith style with ports-and-adapters boundaries. Its OpenAI gateway and live-weather adapter have moved into the control plane; this document now describes the legacy service retained during UAT cutover.

The app remains one deployable Railway service, but code should be grouped by responsibility:

- HTTP and composition: request parsing, response writing, server startup, and environment config.
- Control-plane adapter: all calls to MundusX control-plane APIs.
- Tool adapters: weather, facts, web search, math, and other deterministic helpers.
- Planning and routing: deciding whether a request is direct, compound, chunked, or tool-backed.
- Output quality: sanitizing, formatting, and rejecting malformed model output.
- UI rendering: HTML, CSS, client-side event wiring, and conversation rendering.
- Persistence: browser cache, backend job lookup, and future conversation storage.

Rules for future changes:

- Do not add new protocol or tool behavior here; add it to the control-plane gateway or its internal tool modules.
- Extract pure, standalone logic into small modules before adding more branches to `main.js`.
- Do not let tool adapters know about UI rendering.
- Do not let UI code know worker internals beyond normalized job status.
- Do not commit generated build output such as Rust `target/`, Node `node_modules/`, coverage, or local caches.
- Prefer deterministic cleanup before calling another model to repair an answer.
- Tests should cover the public behavior at the boundary: API routes, rendered job state, and output quality decisions.

Current cleanup direction:

- `src/main.js` remains the composition shell while the repo is small.
- `src/chat-quality.js` owns answer-quality flags such as repetition, instruction leaks, broken Markdown, and unrelated-question drift.
- New feature slices should follow the same extraction pattern instead of growing one file indefinitely.
