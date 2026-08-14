-- agenda (event sessions)
create table if not exists public.agenda (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  day date,
  start_time timestamptz,
  end_time timestamptz,
  speaker_name text,
  speaker_title text,
  speaker_company text,
  guild_id integer references public.guilds (id) on delete set null,
  location text,
  event_quest_config_id integer references public.configs (id) on delete set null,
  stage_config_id integer references public.configs (id) on delete set null,
  is_sponsored boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.agenda enable row level security;

create policy "agenda is readable by authenticated users"
  on public.agenda for select
  to authenticated
  using (true);
