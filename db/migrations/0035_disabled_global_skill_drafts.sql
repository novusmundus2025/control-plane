-- Empty Markdown is a valid disabled draft, never an enabled instruction set.
alter table public.global_skill_overrides
  drop constraint if exists global_skill_overrides_content_check,
  add constraint global_skill_overrides_content_check
    check (length(content) <= 12000 and (not enabled or length(btrim(content)) > 0));
