-- Link several existing root causes at once when adding a signal or a root cause.
--
--   metric: { section, arrow, name, looks_like?, root_cause_ids?, root_cause?, remediations? }
--   cause:  { metric_id, root_cause_ids?, root_cause?, remediations? }
--
-- root_cause_ids are existing root causes to link (up to 20). root_cause is an
-- optional new one (linked instead if the same text already exists).
-- Remediations go to the new root cause, or to the single picked one.

create or replace function public.submit_metric(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  kind      text := payload->>'type';
  rems      jsonb := coalesce(payload->'remediations', '[]'::jsonb);
  ids       jsonb := coalesce(payload->'root_cause_ids', '[]'::jsonb);
  m         public.metrics;
  rc        public.root_causes;
  target    public.root_causes;
  link      public.metric_causes;
  rem       public.remediations;
  rc_rows   jsonb := '[]'::jsonb;
  link_rows jsonb := '[]'::jsonb;
  rem_rows  jsonb := '[]'::jsonb;
  picked    uuid[] := '{}';
  rc_id     uuid;
  r         jsonb;
  x         jsonb;
  lens      text;
  sec       text;
  rc_text   text;
  looks     text;
  recent    int;
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

  if jsonb_typeof(rems) <> 'array' or jsonb_typeof(ids) <> 'array' then
    raise exception using errcode = '22023', message = 'Malformed submission';
  end if;
  if jsonb_array_length(rems) > 10 then
    raise exception using errcode = '22023', message = 'At most 10 remediations at a time';
  end if;
  if jsonb_array_length(ids) > 20 then
    raise exception using errcode = '22023', message = 'Pick at most 20 root causes at a time';
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

  -- Existing root causes picked from the list.
  for x in select * from jsonb_array_elements(ids) loop
    begin
      rc_id := (x #>> '{}')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'Malformed submission';
    end;
    select * into rc from public.root_causes where id = rc_id and hidden = false;
    if rc.id is null then
      raise exception using errcode = '22023', message = 'One of those root causes no longer exists';
    end if;
    if not rc.id = any(picked) then
      picked := picked || rc.id;
      rc_rows := rc_rows || to_jsonb(rc);
    end if;
  end loop;

  -- An optional new one, linked instead if the same text already exists.
  if nullif(btrim(coalesce(payload->>'root_cause', '')), '') is not null then
    rc_text := public.clean_field(payload->'root_cause', 'Root cause', 200);
    select * into target from public.root_causes where lower(text) = lower(rc_text) and hidden = false;
    if target.id is null then
      begin
        insert into public.root_causes (stuck_point_id, text, source, created_at)
        values (null, rc_text, 'community', clock_timestamp())
        returning * into target;
      exception when unique_violation then
        raise exception using errcode = '23505', message = 'That root cause can''t be added';
      end;
    end if;
    if not target.id = any(picked) then
      picked := picked || target.id;
      rc_rows := rc_rows || to_jsonb(target);
    end if;
  elsif cardinality(picked) = 1 then
    select * into target from public.root_causes where id = picked[1];
  end if;

  if kind = 'cause' and cardinality(picked) = 0 then
    raise exception using errcode = '22023', message = 'Pick or write at least one root cause';
  end if;
  if jsonb_array_length(rems) > 0 and target.id is null then
    raise exception using errcode = '22023', message = 'Remediations need a single root cause: write a new one, or pick just one';
  end if;
  if (select count(*) from public.metric_causes where metric_id = m.id) + cardinality(picked) > 100 then
    raise exception using errcode = '22023', message = 'This signal already has plenty of root causes';
  end if;

  foreach rc_id in array picked loop
    insert into public.metric_causes (metric_id, root_cause_id, source, created_at)
    values (m.id, rc_id, 'community', clock_timestamp())
    on conflict (metric_id, root_cause_id) do nothing
    returning * into link;
    if found then
      link_rows := link_rows || to_jsonb(link);
    end if;
  end loop;
  if kind = 'cause' and jsonb_array_length(link_rows) = 0 and jsonb_array_length(rems) = 0 then
    raise exception using errcode = '23505', message = 'Those root causes are already listed under this signal';
  end if;

  for r in select * from jsonb_array_elements(rems) loop
    lens := lower(coalesce(r->>'lens', ''));
    if lens not in ('people', 'process', 'tech') then
      raise exception using errcode = '22023', message = 'Each remediation needs a lens: People, Process or Tech';
    end if;
    insert into public.remediations (root_cause_id, lens, text, source, created_at)
    values (target.id, lens, public.clean_field(r->'text', 'Remediation', 200), 'community', clock_timestamp())
    on conflict do nothing
    returning * into rem;
    if found then
      rem_rows := rem_rows || to_jsonb(rem);
    end if;
  end loop;

  return jsonb_build_object(
    'metric', case when kind = 'metric' then to_jsonb(m) end,
    'root_causes', rc_rows,
    'links', link_rows,
    'remediations', rem_rows
  );
end;
$$;

revoke all on function public.submit_metric(jsonb) from public, anon, authenticated, service_role;
