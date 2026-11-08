-- Signal-first library: section -> signal -> root causes -> remediations.
--
-- Signals live in `metrics` (the name `signals` is taken by the old
-- per-stuck-point table). A root cause exists once and is linked to any number
-- of signals through `metric_causes`. Remediations stay on root causes, so
-- everything already in `root_causes` and `remediations` carries over as is.
-- `stuck_points` and the old `signals` table are left untouched and unused.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.metrics (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  section    text not null references public.sections(id),
  arrow      text not null check (arrow in ('up', 'down')),
  name       text not null check (public.is_clean_text(name, 80)),
  looks_like text check (looks_like is null or public.is_clean_text(looks_like, 200)),
  on_deck    boolean not null default false,
  sort       int not null default 1000,
  source     text not null check (source in ('najla', 'community')),
  author     text default public.current_author(),
  hidden     boolean not null default false
);
create unique index metrics_section_name_key on public.metrics (section, lower(name));
create index on public.metrics (created_at) where source = 'community';

create table public.metric_causes (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  metric_id     uuid not null references public.metrics(id) on delete cascade,
  root_cause_id uuid not null references public.root_causes(id) on delete cascade,
  source        text not null check (source in ('najla', 'community')),
  author        text default public.current_author(),
  hidden        boolean not null default false,
  unique (metric_id, root_cause_id)
);
create index on public.metric_causes (root_cause_id);
create index on public.metric_causes (created_at) where source = 'community';

-- Root causes no longer belong to a stuck point, and each text exists once.
alter table public.root_causes alter column stuck_point_id drop not null;
create unique index root_causes_text_key on public.root_causes (lower(text));

-- ---------------------------------------------------------------------------
-- Access: the public reads visible rows; writes go through submit_idea only
-- ---------------------------------------------------------------------------

alter table public.metrics       enable row level security;
alter table public.metric_causes enable row level security;

revoke insert, update, delete, truncate on public.metrics, public.metric_causes from anon, authenticated;
grant select on public.metrics, public.metric_causes to anon, authenticated;
grant select, insert, update, delete on public.metrics, public.metric_causes to service_role;

create policy "public read visible metrics" on public.metrics
  for select to anon, authenticated using (hidden = false);
create policy "public read visible metric causes" on public.metric_causes
  for select to anon, authenticated using (hidden = false);

alter publication supabase_realtime add table public.metrics, public.metric_causes;

create trigger metrics_visibility after update of hidden on public.metrics
  for each row execute function public.broadcast_visibility();
create trigger metric_causes_visibility after update of hidden on public.metric_causes
  for each row execute function public.broadcast_visibility();

-- ---------------------------------------------------------------------------
-- Submissions
--   metric:      { section, arrow, name, looks_like?, root_cause?, remediations? }
--   cause:       { metric_id, root_cause_id | root_cause, remediations? }
--   remediation: { root_cause_id, remediations }   (unchanged, via submit_idea_core)
-- A root cause typed with the same text as an existing one is linked, not copied.
-- ---------------------------------------------------------------------------

create or replace function public.submit_metric(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  kind     text := payload->>'type';
  rems     jsonb := payload->'remediations';
  m        public.metrics;
  rc       public.root_causes;
  link     public.metric_causes;
  rem      public.remediations;
  rem_rows jsonb := '[]'::jsonb;
  r        jsonb;
  lens     text;
  sec      text;
  rc_text  text;
  looks    text;
  recent   int;
begin
  -- Global safety valve against floods that get past Turnstile.
  select (select count(*) from public.metrics
            where source = 'community' and created_at > now() - interval '10 minutes')
       + (select count(*) from public.metric_causes
            where source = 'community' and created_at > now() - interval '10 minutes')
       + (select count(*) from public.remediations
            where source = 'community' and created_at > now() - interval '10 minutes')
    into recent;
  if recent > 500 then
    raise exception using errcode = '54000', message = 'Too many submissions right now. Try again in a few minutes.';
  end if;

  if rems is not null and jsonb_typeof(rems) <> 'array' then
    raise exception using errcode = '22023', message = 'Remediations must be a list';
  end if;
  if coalesce(jsonb_array_length(rems), 0) > 10 then
    raise exception using errcode = '22023', message = 'At most 10 remediations at a time';
  end if;

  if kind = 'metric' then
    sec := upper(btrim(coalesce(payload->>'section', '')));
    if not exists (select 1 from public.sections where id = sec) then
      raise exception using errcode = '22023', message = 'Pick a section A–G';
    end if;
    if coalesce(payload->>'arrow', '') not in ('up', 'down') then
      raise exception using errcode = '22023', message = 'Pick whether it should go up or down';
    end if;
    if (select count(*) from public.metrics where section = sec) >= 100 then
      raise exception using errcode = '22023', message = 'This section already has plenty of signals';
    end if;
    if nullif(btrim(coalesce(payload->>'looks_like', '')), '') is not null then
      looks := public.clean_field(payload->'looks_like', 'When it goes wrong', 200);
    end if;
    begin
      insert into public.metrics (section, arrow, name, looks_like, source, created_at)
      values (sec, payload->>'arrow', public.clean_field(payload->'name', 'Signal', 80), looks, 'community', clock_timestamp())
      returning * into m;
    exception when unique_violation then
      raise exception using errcode = '23505', message = 'That signal is already listed in this section';
    end;
  elsif kind = 'cause' then
    select * into m from public.metrics
      where id = (payload->>'metric_id')::uuid and hidden = false;
    if m.id is null then
      raise exception using errcode = '22023', message = 'That signal no longer exists';
    end if;
  else
    raise exception using errcode = '22023', message = 'Unknown submission type';
  end if;

  -- The root cause: an existing one by id, or text (matched to an existing one if the same).
  if nullif(payload->>'root_cause_id', '') is not null then
    select * into rc from public.root_causes
      where id = (payload->>'root_cause_id')::uuid and hidden = false;
    if rc.id is null then
      raise exception using errcode = '22023', message = 'That root cause no longer exists';
    end if;
  elsif nullif(btrim(coalesce(payload->>'root_cause', '')), '') is not null then
    rc_text := public.clean_field(payload->'root_cause', 'Root cause', 200);
    select * into rc from public.root_causes where lower(text) = lower(rc_text) and hidden = false;
    if rc.id is null then
      begin
        insert into public.root_causes (stuck_point_id, text, source, created_at)
        values (null, rc_text, 'community', clock_timestamp())
        returning * into rc;
      exception when unique_violation then
        raise exception using errcode = '23505', message = 'That root cause can''t be added';
      end;
    end if;
  elsif kind = 'cause' then
    raise exception using errcode = '22023', message = 'Root cause is required';
  end if;

  if rc.id is not null then
    if (select count(*) from public.metric_causes where metric_id = m.id) >= 100 then
      raise exception using errcode = '22023', message = 'This signal already has plenty of root causes';
    end if;
    insert into public.metric_causes (metric_id, root_cause_id, source, created_at)
    values (m.id, rc.id, 'community', clock_timestamp())
    on conflict (metric_id, root_cause_id) do nothing
    returning * into link;
    if link.id is null and kind = 'cause' and coalesce(jsonb_array_length(rems), 0) = 0 then
      raise exception using errcode = '23505', message = 'That root cause is already listed under this signal';
    end if;
  elsif coalesce(jsonb_array_length(rems), 0) > 0 then
    raise exception using errcode = '22023', message = 'Add a root cause for these remediations';
  end if;

  for r in select * from jsonb_array_elements(coalesce(rems, '[]'::jsonb)) loop
    lens := lower(coalesce(r->>'lens', ''));
    if lens not in ('people', 'process', 'tech') then
      raise exception using errcode = '22023', message = 'Each remediation needs a lens: People, Process or Tech';
    end if;
    insert into public.remediations (root_cause_id, lens, text, source, created_at)
    values (rc.id, lens, public.clean_field(r->'text', 'Remediation', 200), 'community', clock_timestamp())
    on conflict do nothing
    returning * into rem;
    if found then
      rem_rows := rem_rows || to_jsonb(rem);
    end if;
  end loop;

  return jsonb_build_object(
    'metric', case when kind = 'metric' then to_jsonb(m) end,
    'root_cause', case when rc.id is not null then to_jsonb(rc) end,
    'link', case when link.id is not null then to_jsonb(link) end,
    'remediations', rem_rows
  );
end;
$$;

revoke all on function public.submit_metric(jsonb) from public, anon, authenticated, service_role;

-- The entry point: sets the author name, then routes by type. Old stuck point
-- submissions are refused so nothing lands in tables the page no longer shows.
create or replace function public.submit_idea(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  kind text := payload->>'type';
begin
  perform set_config('flow.author', coalesce(public.author_name(payload->'author'), ''), true);
  if kind in ('metric', 'cause') then
    return public.submit_metric(payload - 'author');
  end if;
  if kind = 'remediation' then
    return public.submit_idea_core(payload - 'author');
  end if;
  raise exception using errcode = '22023', message = 'This page is out of date. Reload it and try again.';
end
$$;

revoke all on function public.submit_idea(jsonb) from public, anon, authenticated;
grant execute on function public.submit_idea(jsonb) to service_role;
