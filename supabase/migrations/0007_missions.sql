-- user/mission (mission catalog)
create table if not exists public.missions (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  points integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.missions enable row level security;

create policy "missions are readable by authenticated users"
  on public.missions for select
  to authenticated
  using (true);
