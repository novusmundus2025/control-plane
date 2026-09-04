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

- Phase 1 — complete: runtime package, selection contract, database negotiation, native fallback, and authority/session tests.
- Phase 2 — complete: the pinned Deep Agents runtime has a LangChain adapter for the loopback MundusX model; the connector advertises it only when the optional runtime executable is installed.
- Phase 3 — complete: the immutable authority envelope filters caller-supplied tools, the virtual filesystem is rooted at the selected workspace, and write operations remain blocked unless the task carries explicit mutation approval.
- Phase 4 — complete: normalized allowlisted events cross the connector, completed turns provide a durable bounded checkpoint for resume, and browser and CLI session APIs use the same session UUID.
- Phase 5 — complete but conservative: stable percentage canaries and native-versus-Deep-Agents evidence are available. `auto` selects Deep Agents only on a connector that proves the runtime is installed, so old installations remain native without a migration.

The optional executable implements a narrow stdin/stdout contract:

```text
mundusx-deepagents-runtime run-json --workspace <absolute-path>
```

The connector locates it through `MUNDUSX_DEEPAGENTS_BIN`. It never advertises
Deep Agents merely because the control plane supports it. This prevents a task
from being leased to an incapable machine.

The `deepagents` dependency is pinned. Upgrades require contract tests because its profile APIs are still evolving.
