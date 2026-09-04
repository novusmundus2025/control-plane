-- Negotiate an agent runtime without allowing a client to bypass MundusX task authority.

alter table public.local_agent_tasks
  add column if not exists runtime_requested text not null default 'auto',
  add column if not exists runtime_selected text;

alter table public.local_agent_tasks
  drop constraint if exists local_agent_tasks_runtime_requested_check;

alter table public.local_agent_tasks
  add constraint local_agent_tasks_runtime_requested_check
  check (runtime_requested in ('auto', 'native', 'deepagents'));

alter table public.local_agent_tasks
  drop constraint if exists local_agent_tasks_runtime_selected_check;

alter table public.local_agent_tasks
  add constraint local_agent_tasks_runtime_selected_check
  check (runtime_selected is null or runtime_selected in ('native', 'deepagents'));
