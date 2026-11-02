-- Newer Supabase projects don't grant table access to service_role by
-- default. The seed script writes to the tables directly and needs it.
-- Safe to run more than once.

grant select, insert, update, delete on public.sections, public.stuck_points,
  public.root_causes, public.remediations to service_role;
