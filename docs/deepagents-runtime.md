# Deep Agents runtime integration

MundusX owns identity, task persistence, repository authority, runner pairing, approvals, node selection, quotas, and audit evidence. Deep Agents is an optional execution runtime behind those boundaries.

## Runtime contract

1. Chat, OpenWebUI, MCP, or `mundusx agent run` creates a user-scoped task.
2. The task requests `auto`, `native`, or `deepagents`; `auto` is the compatibility default.
3. A paired runner advertises `capabilities.agent_runtimes` and can claim only a runtime it supports.
4. MundusX supplies an immutable authority envelope to the selected runtime.
5. Runtime tools are created from that envelope. Deep Agents never receives an unrestricted production filesystem or shell.
6. The MundusX session UUID becomes the LangGraph `thread_id`, enabling resume through the existing session contract.
7. Runtime events and results return through the existing connector endpoints.

Old runners remain valid: when no runtime capability is advertised, `auto` selects `native`. An explicit `deepagents` task waits for a runner that advertises it.

## Deployment phases

- Phase 1 (this change): runtime package, selection contract, database negotiation, native fallback, authority/session tests.
- Phase 2: embed `@mundusx/agent-runtime` in the local MundusX connector and adapt the selected local model to LangChain's chat-model interface.
- Phase 3: expose only policy-derived repository, patch, validation, and MCP tools; require approval for mutation tools.
- Phase 4: stream normalized plan/tool/subagent events, persist checkpoints, and implement `mundusx agent resume` and `sessions` over the same UUID.
- Phase 5: canary opt-in, evaluation against the native runtime, then make `auto` prefer Deep Agents on capable runners.

The `deepagents` dependency is pinned. Upgrades require contract tests because its profile APIs are still evolving.
