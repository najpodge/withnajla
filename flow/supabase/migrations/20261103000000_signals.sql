-- Let people add signals to an existing stuck point.
-- Signals that came with a stuck point stay in stuck_points.signals; signals
-- added later live here, one row each, so they can be badged and hidden.

create table public.signals (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  stuck_point_id uuid not null references public.stuck_points(id) on delete cascade,
  text           text not null check (public.is_clean_text(text, 80)),
  source         text not null check (source in ('najla', 'community')),
  hidden         boolean not null default false,
  unique (stuck_point_id, text)
);

create index on public.signals (stuck_point_id);

alter table public.signals enable row level security;
revoke insert, update, delete, truncate on public.signals from anon, authenticated;
grant select on public.signals to anon, authenticated;
grant select, insert, update, delete on public.signals to service_role;
create policy "public read visible signals" on public.signals
  for select to anon, authenticated using (hidden = false);

alter publication supabase_realtime add table public.signals;
create trigger signals_visibility after update of hidden on public.signals
  for each row execute function public.broadcast_visibility();

-- submit_idea gains a 'signal' type; the other types are unchanged.
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
  srow        public.signals;
  rem_rows    jsonb := '[]'::jsonb;
  sig_rows    jsonb := '[]'::jsonb;
  r           jsonb;
  lens        text;
  sec         text;
  sigs        text[] := '{}';
  sig         jsonb;
  s           text;
  next_num    int;
  recent      int;
begin
  if kind not in ('remediation', 'root_cause', 'stuck_point', 'signal') then
    raise exception using errcode = '22023', message = 'Unknown submission type';
  end if;

  -- Global safety valve against floods that get past Turnstile.
  select (select count(*) from public.remediations
            where source = 'community' and created_at > now() - interval '10 minutes')
       + (select count(*) from public.signals
            where source = 'community' and created_at > now() - interval '10 minutes')
    into recent;
  if recent > 500 then
    raise exception using errcode = '54000', message = 'Too many submissions right now. Try again in a few minutes.';
  end if;

  if kind = 'signal' then
    select * into sp from public.stuck_points
      where id = (payload->>'stuck_point_id')::uuid and hidden = false;
    if sp.id is null then
      raise exception using errcode = '22023', message = 'That stuck point no longer exists';
    end if;
    if payload ? 'signals' and jsonb_typeof(payload->'signals') = 'array' then
      for sig in select * from jsonb_array_elements(payload->'signals') loop
        if jsonb_typeof(sig) = 'string' and btrim(sig #>> '{}') <> '' then
          sigs := sigs || public.clean_field(sig, 'Each signal', 80);
        end if;
      end loop;
    end if;
    if cardinality(sigs) = 0 then
      raise exception using errcode = '22023', message = 'Add at least one signal';
    end if;
    if cardinality(sigs) > 6 then
      raise exception using errcode = '22023', message = 'At most 6 signals at a time';
    end if;
    if (select count(*) from public.signals where stuck_point_id = sp.id) + cardinality(sigs) > 30 then
      raise exception using errcode = '22023', message = 'This stuck point already has plenty of signals';
    end if;
    foreach s in array sigs loop
      if exists (select 1 from unnest(sp.signals) x where lower(x) = lower(s)) then
        raise exception using errcode = '23505', message = 'That signal is already listed';
      end if;
      insert into public.signals (stuck_point_id, text, source, created_at)
      values (sp.id, s, 'community', clock_timestamp())
      returning * into srow;
      sig_rows := sig_rows || to_jsonb(srow);
    end loop;
    return jsonb_build_object('stuck_point', null, 'root_cause', null, 'remediations', '[]'::jsonb, 'signals', sig_rows);
  end if;

  -- Every other submission carries at least one remediation.
  if rems is null or jsonb_typeof(rems) <> 'array' or jsonb_array_length(rems) = 0 then
    raise exception using errcode = '22023', message = 'Add at least one remediation';
  end if;
  if jsonb_array_length(rems) > 10 then
    raise exception using errcode = '22023', message = 'At most 10 remediations at a time';
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
    'remediations', rem_rows,
    'signals', '[]'::jsonb
  );
end;
$$;
