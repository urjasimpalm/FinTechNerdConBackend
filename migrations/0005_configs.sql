-- Generic config lookup table for: maintenance, sponsor, event-quest, event-day, stage-type
create table if not exists public.configs (
  id integer generated always as identity primary key,
  type text not null,
  name text not null,

  created_at timestamptz not null default now(),
  unique (type, name)
);

alter table public.configs enable row level security;

create policy "configs are readable by authenticated users"
  on public.configs for select
  to authenticated
  using (true);
