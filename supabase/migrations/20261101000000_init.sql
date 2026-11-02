-- "Where flow gets stuck" library
-- stuck point -> root causes -> remediations, plus seeded sections A–G.

-- ---------------------------------------------------------------------------
-- Validation helpers (immutable, so they can back CHECK constraints)
-- ---------------------------------------------------------------------------

create or replace function public.is_clean_text(t text, max_len int)
returns boolean
language sql immutable
as $$
  select t is not null
     and t = btrim(t)
     and char_length(t) between 1 and max_len
$$;

create or replace function public.is_clean_signals(s text[])
returns boolean
language sql immutable
as $$
  select s is not null
     and coalesce(cardinality(s), 0) <= 6
     and not exists (
       select 1 from unnest(s) as x where not public.is_clean_text(x, 80)
     )
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.sections (
  id          text primary key check (id ~ '^[A-G]$'),
  name        text not null,
  description text not null,
  signals     text[] not null default '{}',
  sort        int not null,
  created_at  timestamptz not null default now()
);

create table public.stuck_points (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  section    text not null references public.sections(id),
  code       text not null unique check (code ~ '^[A-G][0-9]{1,3}$'),
  name       text not null check (public.is_clean_text(name, 80)),
  symptom    text not null check (public.is_clean_text(symptom, 200)),
  signals    text[] not null default '{}' check (public.is_clean_signals(signals)),
  source     text not null check (source in ('najla', 'community')),
  hidden     boolean not null default false,
  check (left(code, 1) = section)
);

create table public.root_causes (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  stuck_point_id uuid not null references public.stuck_points(id) on delete cascade,
  text           text not null check (public.is_clean_text(text, 200)),
  source         text not null check (source in ('najla', 'community')),
  hidden         boolean not null default false,
  unique (stuck_point_id, text)
);

create table public.remediations (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  root_cause_id uuid not null references public.root_causes(id) on delete cascade,
  lens          text not null check (lens in ('people', 'process', 'tech')),
  text          text not null check (public.is_clean_text(text, 200)),
  source        text not null check (source in ('najla', 'community')),
  hidden        boolean not null default false,
  unique (root_cause_id, lens, text)
);

create index on public.stuck_points (section);
create index on public.root_causes (stuck_point_id);
create index on public.remediations (root_cause_id);
create index on public.stuck_points (created_at) where source = 'community';
create index on public.root_causes (created_at) where source = 'community';
create index on public.remediations (created_at) where source = 'community';

-- ---------------------------------------------------------------------------
-- Row Level Security: the public can read visible rows and nothing else
-- ---------------------------------------------------------------------------

alter table public.sections     enable row level security;
alter table public.stuck_points enable row level security;
alter table public.root_causes  enable row level security;
alter table public.remediations enable row level security;

revoke insert, update, delete, truncate on public.sections, public.stuck_points,
  public.root_causes, public.remediations from anon, authenticated;
grant select on public.sections, public.stuck_points,
  public.root_causes, public.remediations to anon, authenticated;

create policy "public read sections" on public.sections
  for select to anon, authenticated using (true);
create policy "public read visible stuck points" on public.stuck_points
  for select to anon, authenticated using (hidden = false);
create policy "public read visible root causes" on public.root_causes
  for select to anon, authenticated using (hidden = false);
create policy "public read visible remediations" on public.remediations
  for select to anon, authenticated using (hidden = false);

-- ---------------------------------------------------------------------------
-- submit_idea: the only write path for contributions
-- ---------------------------------------------------------------------------

create or replace function public.clean_field(v jsonb, field text, max_len int)
returns text
language plpgsql immutable
as $$
declare
  t text;
begin
  if v is null or jsonb_typeof(v) <> 'string' then
    raise exception using errcode = '22023', message = field || ' is required';
  end if;
  t := btrim(v #>> '{}');
  if t = '' then
    raise exception using errcode = '22023', message = field || ' is required';
  end if;
  if char_length(t) > max_len then
    raise exception using errcode = '22023',
      message = field || ' must be ' || max_len || ' characters or fewer';
  end if;
  return t;
end;
$$;

create or replace function public.submit_idea(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  kind        text := payload->>'type';
  rems        jsonb := payload->'remediations';
  sp          public.stuck_points;
  rc          public.root_causes;
  rem         public.remediations;
  rem_rows    jsonb := '[]'::jsonb;
  r           jsonb;
  lens        text;
  sec         text;
  sigs        text[] := '{}';
  sig         jsonb;
  next_num    int;
  recent      int;
begin
  if kind not in ('remediation', 'root_cause', 'stuck_point') then
    raise exception using errcode = '22023', message = 'Unknown submission type';
  end if;

  -- Every submission carries at least one remediation.
  if rems is null or jsonb_typeof(rems) <> 'array' or jsonb_array_length(rems) = 0 then
    raise exception using errcode = '22023', message = 'Add at least one remediation';
  end if;
  if jsonb_array_length(rems) > 10 then
    raise exception using errcode = '22023', message = 'At most 10 remediations at a time';
  end if;

  -- Global safety valve against floods that get past Turnstile.
  select count(*) into recent from public.remediations
    where source = 'community' and created_at > now() - interval '10 minutes';
  if recent > 500 then
    raise exception using errcode = '54000', message = 'Too many submissions right now. Try again in a few minutes.';
  end if;

  if kind = 'stuck_point' then
    sec := upper(btrim(coalesce(payload->>'section', '')));
    if not exists (select 1 from public.sections where id = sec) then
      raise exception using errcode = '22023', message = 'Pick a section A–G';
    end if;

    if payload ? 'signals' and jsonb_typeof(payload->'signals') = 'array' then
      for sig in select * from jsonb_array_elements(payload->'signals') loop
        if jsonb_typeof(sig) = 'string' and btrim(sig #>> '{}') <> '' then
          sigs := sigs || public.clean_field(sig, 'Each signal', 80);
        end if;
      end loop;
      if cardinality(sigs) > 6 then
        raise exception using errcode = '22023', message = 'At most 6 signals';
      end if;
    end if;

    -- Serialize code assignment per section.
    perform pg_advisory_xact_lock(hashtext('stuck_point_code_' || sec));
    select coalesce(max(substring(code from 2)::int), 0) + 1 into next_num
      from public.stuck_points where section = sec;

    insert into public.stuck_points (section, code, name, symptom, signals, source, created_at)
    values (
      sec,
      sec || next_num,
      public.clean_field(payload->'name', 'Name', 80),
      public.clean_field(payload->'symptom', 'Symptom', 200),
      sigs,
      'community',
      clock_timestamp()
    )
    returning * into sp;
  end if;

  if kind in ('stuck_point', 'root_cause') then
    if kind = 'root_cause' then
      select * into sp from public.stuck_points
        where id = (payload->>'stuck_point_id')::uuid and hidden = false;
      if sp.id is null then
        raise exception using errcode = '22023', message = 'That stuck point no longer exists';
      end if;
    end if;

    insert into public.root_causes (stuck_point_id, text, source, created_at)
    values (sp.id, public.clean_field(payload->'root_cause', 'Root cause', 200), 'community', clock_timestamp())
    returning * into rc;
  end if;

  if kind = 'remediation' then
    select * into rc from public.root_causes
      where id = (payload->>'root_cause_id')::uuid and hidden = false;
    if rc.id is null then
      raise exception using errcode = '22023', message = 'That root cause no longer exists';
    end if;
  end if;

  for r in select * from jsonb_array_elements(rems) loop
    lens := lower(coalesce(r->>'lens', ''));
    if lens not in ('people', 'process', 'tech') then
      raise exception using errcode = '22023', message = 'Each remediation needs a lens: People, Process or Tech';
    end if;
    insert into public.remediations (root_cause_id, lens, text, source, created_at)
    values (rc.id, lens, public.clean_field(r->'text', 'Remediation', 200), 'community', clock_timestamp())
    returning * into rem;
    rem_rows := rem_rows || to_jsonb(rem);
  end loop;

  return jsonb_build_object(
    'stuck_point', case when kind = 'stuck_point' then to_jsonb(sp) end,
    'root_cause',  case when kind in ('stuck_point', 'root_cause') then to_jsonb(rc) end,
    'remediations', rem_rows
  );
end;
$$;

revoke all on function public.submit_idea(jsonb) from public, anon, authenticated;
grant execute on function public.submit_idea(jsonb) to service_role;
revoke all on function public.clean_field(jsonb, text, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.stuck_points, public.root_causes, public.remediations;

-- Postgres Changes are filtered by RLS, so a viewer never receives the UPDATE
-- that hides a row (the new row is no longer visible to them). Announce hide
-- and unhide on a public broadcast topic so open pages can drop the row live.
create or replace function public.broadcast_visibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.hidden is distinct from old.hidden then
    begin
      perform realtime.send(
        jsonb_build_object('table', tg_table_name, 'id', new.id, 'hidden', new.hidden),
        'visibility',
        'library',
        false
      );
    exception when others then
      -- Never block moderation because realtime is unavailable.
      raise warning 'broadcast_visibility failed: %', sqlerrm;
    end;
  end if;
  return new;
end;
$$;

create trigger stuck_points_visibility after update of hidden on public.stuck_points
  for each row execute function public.broadcast_visibility();
create trigger root_causes_visibility after update of hidden on public.root_causes
  for each row execute function public.broadcast_visibility();
create trigger remediations_visibility after update of hidden on public.remediations
  for each row execute function public.broadcast_visibility();
