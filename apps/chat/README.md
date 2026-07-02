# MundusX Chat

Standalone chat surface for the future `chat.mundusx.ai` deployment.

The app is intentionally separate from the operator control-plane UI. It serves a user-facing chat page and proxies prompt requests to the MundusX control plane.

## Run locally

```powershell
$env:MUNDUSX_CONTROL_PLANE_URL = "https://uat.mundusx.ai"
$env:PORT = "3002"
pnpm --filter @mundusx/chat dev
```

Open `http://127.0.0.1:3002`.

## Railway

Deploy this as a separate Railway service from the control-plane monorepo.

Recommended Railway settings:

| Setting | Value |
| --- | --- |
| Root Directory | `apps/chat` |
| Build Command | empty / Railway default |
| Start Command | `pnpm start` |
| Healthcheck Path | `/health` |

Required environment:

```text
MUNDUSX_CONTROL_PLANE_URL=https://uat.mundusx.ai
```

Optional environment:

```text
MUNDUSX_OPERATOR_TOKEN=<only if the target control plane requires auth>
MUNDUSX_CHAT_DEFAULT_MODEL=Qwen/Qwen2.5-1.5B-Instruct
MUNDUSX_CHAT_TIMEOUT_SECONDS=90
```

Railway provides `PORT`; the app reads it automatically.

## Environment

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port for the chat app |
| `MUNDUSX_CONTROL_PLANE_URL` | `https://uat.mundusx.ai` | Control-plane API origin |
| `MUNDUSX_OPERATOR_TOKEN` | unset | Optional bearer token for protected UAT/API deployments |
| `OPENGPU_OPERATOR_TOKEN` | unset | Deprecated fallback token name |
| `MUNDUSX_CHAT_DEFAULT_MODEL` | `Qwen/Qwen2.5-1.5B-Instruct` | Default model sent to chat completions |
| `MUNDUSX_CHAT_TIMEOUT_SECONDS` | `90` | Default server-side poll timeout for one chat turn |

## Current Flow

1. Browser posts a user message to `POST /api/chat`.
2. Chat app submits an OpenAI-compatible request to `POST /v1/chat/completions`.
3. Control plane returns a queued MundusX job id.
4. Chat app polls `GET /v1/jobs/:id`.
5. Completed output is returned to the browser.

Streaming is not enabled yet; the first version uses polling because the control plane already exposes job status and output.
