-- config/guilds
create table if not exists public.guilds (
  id integer generated always as identity primary key,
  name text not null unique,
  description text,
  created_at timestamptz not null default now()
);

alter table public.guilds enable row level security;

create policy "guilds are readable by authenticated users"
  on public.guilds for select
  to authenticated
  using (true);
