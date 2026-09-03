# MundusX Chat local-agent bridge

MundusX Chat can use the same local-first agent exposed by the `mundusx` CLI.
The browser never connects to `127.0.0.1`, and the Control Plane never receives
filesystem or shell authority. A local connector makes an outbound HTTPS
connection, claims only tasks owned by the connection token's user, and invokes
the loopback agent API on that machine.

## Connect

1. Sign in to `chat.mundusx.ai` and create a connection token in Account > MCP
   connections. The token is displayed once.
2. Start the connector from the repository or directory the agent may inspect:

   ```powershell
   $env:MUNDUSX_CHAT_TOKEN = "<connection-token>"
   mundusx connect --workspace .
   ```

When the connector is online, ordinary Chat requests prefer the local agent.
If it is offline, Chat uses the existing Control Plane path. Repository-changing
requests remain non-mutating unless a separate, explicit approval flow grants
that authority.

## Protocol and privacy

The v1 bridge uses `/api/agent/connector/*` with the existing user-scoped MCP
bearer token. Leases prevent two devices from executing the same task, and
heartbeats propagate browser cancellation to the local session. The connector
uploads only the prompt, an allowlisted progress summary, and the final answer;
tool arguments, tool results, file contents, and model transcripts remain local.

Remote connector URLs must use HTTPS. Plain HTTP is accepted only for loopback
development. Revoking the connection token immediately prevents new connector
requests.
