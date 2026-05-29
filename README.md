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
