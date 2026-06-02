# NovusX Operator Repo

This private repository contains the company-owned operator surface for NovusX:

- `apps/control-plane/` - scheduler, routing, auth, and job management
- `apps/dashboard/` - operator web UI
- `supabase/` - company-side schema and migrations
- `tools/` - shared macOS identity helpers used by the operator surface

The public contributor-facing code lives in the separate open-source repo.

See the component READMEs for local development details:

- `apps/control-plane/README.md`
- `apps/dashboard/README.md`

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | **Yes** | Port the server binds on (`0.0.0.0:PORT`). Must be set in production (Railway injects it but you must confirm it's present). Without it the server falls back to `127.0.0.1:8787` (loopback only). |
| `DATABASE_URL` | **Yes** | Supabase Postgres connection string. Used for migrations and state persistence. Find it in Supabase → Settings → Database → Connection string (use the pooler URI). |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase service role key. Find it in Supabase → Settings → API → `service_role`. |
| `SUPABASE_URL` | No | Supabase project URL (e.g. `https://xxx.supabase.co`). Derived automatically from `DATABASE_URL` if omitted. |
| `MUNDUSX_OPERATOR_TOKEN` | **Strongly recommended** | Bearer token protecting the dashboard (`/`), status, nodes, jobs, credits, and job-submit endpoints. If unset, those endpoints are publicly accessible with no authentication. |
| `MUNDUSX_CONTROL_PLANE_HOST` | No | Override the bind host. Defaults to `0.0.0.0` when `PORT` is set. |

### Local `.env`

Create a `.env` file at the repo root (never commit it):

```
PORT=8787
DATABASE_URL=postgresql://postgres.your-ref:password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_URL=https://your-ref.supabase.co
MUNDUSX_OPERATOR_TOKEN=a-strong-random-secret
```

---

## Railway deployment

1. Set all variables above in Railway → **Variables**.
2. Confirm **Networking → Public Networking** is enabled and the target port matches `PORT`.
3. Run database migrations once before (or on) first deploy:
   ```
   ./control-plane migrate
   ```
   You can do this as a Railway one-off job or from a local machine with `DATABASE_URL` set.
4. The normal start command is just the binary with no arguments: `./control-plane`.

---

## API endpoints

### Node / agent endpoints (require valid device signature)

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/register` | Register a new node |
| `POST` | `/v1/heartbeat` | Send a heartbeat |
| `GET` | `/v1/jobs/next?node_id=...` | Claim next available job |
| `POST` | `/v1/jobs/complete` | Mark a job completed or failed |

### Operator endpoints (require `Authorization: Bearer <MUNDUSX_OPERATOR_TOKEN>` if token is set)

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Dashboard UI |
| `GET` | `/health` | Health check + sync status (JSON) |
| `GET` | `/v1/status` | Full state snapshot (JSON) |
| `GET` | `/v1/nodes` | Node list (JSON) |
| `GET` | `/v1/jobs` | Job list (JSON) |
| `GET` | `/v1/job-events` | Job event log (JSON) |
| `GET` | `/v1/credits` | Credits ledger (JSON) |
| `POST` | `/v1/jobs` | Submit a job |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completion (queued, non-streaming) |

---

## Known gaps

- **No `GET /v1/jobs/:id`** — after submitting a job or chat completion you get a `job_id` back, but there is no endpoint yet to poll individual job status or retrieve the result.
- **Streaming not supported** — `POST /v1/chat/completions` with `"stream": true` returns `400`.
- **`operatorAuth: disabled`** in logs means `MUNDUSX_OPERATOR_TOKEN` is not set and the operator endpoints are open.
