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
MUNDUSX_CHAT_MODEL=<optional explicit model override>
MUNDUSX_CHAT_TIMEOUT_SECONDS=90
MUNDUSX_WEATHER_CACHE_URL=<optional redis://, rediss://, valkey://, or valkeys:// URL>
MUNDUSX_FACTUAL_SUMMARY_URL=<optional factual summary API origin>
```

Railway provides `PORT`; the app reads it automatically.

## Environment

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port for the chat app |
| `MUNDUSX_CONTROL_PLANE_URL` | `https://uat.mundusx.ai` | Control-plane API origin |
| `MUNDUSX_OPERATOR_TOKEN` | unset | Optional bearer token for protected UAT/API deployments |
| `OPENGPU_OPERATOR_TOKEN` | unset | Deprecated fallback token name |
| `MUNDUSX_CHAT_MODEL` | unset | Optional explicit model override; unset means control-plane routed contributor models |
| `MUNDUSX_CHAT_DEFAULT_MODEL` | unset | Deprecated alias for `MUNDUSX_CHAT_MODEL` |
| `MUNDUSX_CHAT_TIMEOUT_SECONDS` | `90` | Default server-side poll timeout for one chat turn |
| `MUNDUSX_WEATHER_URL` | `https://wttr.in` | Weather API origin for direct weather answers |
| `MUNDUSX_WEATHER_CACHE_URL` | unset | Optional Redis/Valkey URL for weather response caching |
| `VALKEY_URL` | unset | Fallback cache URL when `MUNDUSX_WEATHER_CACHE_URL` is unset |
| `REDIS_URL` | unset | Fallback cache URL when `MUNDUSX_WEATHER_CACHE_URL` and `VALKEY_URL` are unset |
| `MUNDUSX_WEATHER_TTL_SECONDS` | `7200` | Weather cache TTL; default is 2 hours |
| `MUNDUSX_FACTUAL_SUMMARY_URL` | `https://en.wikipedia.org/api/rest_v1/page/summary` | Factual summary API used before LLM jobs for obvious history/who/what questions |

## Current Flow

1. Browser posts a user message to `POST /api/chat/jobs`.
2. Obvious weather questions are answered directly through `wttr.in`; if Redis/Valkey is configured the response is cached for 2 hours.
3. Obvious factual history/who/what questions are answered from the factual summary source before using local LLM jobs.
4. Other requests are submitted as routed MundusX jobs to `POST /v1/jobs` with `execution_mode=auto`.
5. Control plane decides whether the request is single-job or decomposed across graph chunks.
6. Browser polls `GET /api/chat/jobs/:id`, which reads `GET /v1/jobs/:id`.
7. Completed output and graph progress are returned to the browser.

Streaming is not enabled yet; the first version uses polling because the control plane already exposes job status and output.
