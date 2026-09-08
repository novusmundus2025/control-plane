-- Device identity is separate from a replaceable credential or connection.
-- Legacy rows remain unbound until the installed agent proves its identity.
alter table public.local_agent_bootstrap_sessions add column if not exists device_id uuid;
alter table public.mcp_personal_access_tokens add column if not exists device_id uuid;
alter table public.local_agent_connections add column if not exists device_id uuid;

create unique index if not exists mcp_one_current_device_token
  on public.mcp_personal_access_tokens(user_id, device_id)
  where device_id is not null and revoked_at is null;
create unique index if not exists local_agent_one_device_connection
  on public.local_agent_connections(user_id, device_id)
  where device_id is not null;
