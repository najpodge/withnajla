-- Community authors: each browser gets a random two-word name ("Quiet Heron").
-- The client sends only two list indexes, never text, so nobody can choose
-- what appears as an author. Curated rows keep author = null.
--
-- submit_idea is wrapped rather than rewritten: the wrapper puts the name in a
-- transaction-local setting, and each table's `author` column defaults to it.

create or replace function public.author_name(a jsonb)
returns text
language sql
immutable
as $$
  -- Keep these lists identical to AUTHOR_ADJECTIVES / AUTHOR_NOUNS in src/authors.ts.
  select case
    when jsonb_typeof(a) = 'array'
     and jsonb_typeof(a->0) = 'number'
     and jsonb_typeof(a->1) = 'number'
    then (array['Amber','Bright','Calm','Clever','Coral','Curious','Gentle','Golden',
                'Hidden','Jade','Lively','Lucky','Misty','Nimble','Quiet','Rapid',
                'Silver','Steady','Sunny','Swift','Teal','Velvet','Wild','Wise'])
           [abs((a->>0)::numeric::bigint % 24) + 1]
         || ' ' ||
         (array['Badger','Beaver','Crane','Delta','Falcon','Fern','Finch','Fox',
                'Heron','Kestrel','Lark','Lynx','Marten','Meadow','Otter','Owl',
                'Pebble','Puffin','Raven','Reed','Rill','Salmon','Spring','Willow'])
           [abs((a->>1)::numeric::bigint % 24) + 1]
  end
$$;

create or replace function public.current_author()
returns text
language sql
stable
as $$ select nullif(current_setting('flow.author', true), '') $$;

alter table public.stuck_points add column if not exists author text default public.current_author();
alter table public.root_causes  add column if not exists author text default public.current_author();
alter table public.remediations add column if not exists author text default public.current_author();
alter table public.signals      add column if not exists author text default public.current_author();

-- Move the existing function aside and put the wrapper in its place.
alter function public.submit_idea(jsonb) rename to submit_idea_core;
revoke all on function public.submit_idea_core(jsonb) from public, anon, authenticated, service_role;

create or replace function public.submit_idea(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('flow.author', coalesce(public.author_name(payload->'author'), ''), true);
  return public.submit_idea_core(payload - 'author');
end
$$;

revoke all on function public.submit_idea(jsonb) from public, anon, authenticated;
grant execute on function public.submit_idea(jsonb) to service_role;
