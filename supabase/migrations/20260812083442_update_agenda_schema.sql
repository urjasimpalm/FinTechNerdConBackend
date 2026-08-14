-- Remove the old guild relationship
alter table public.agenda
drop constraint if exists agenda_guild_id_fkey;

alter table public.agenda
drop column if exists guild_id;


-- Add event day config
alter table public.agenda
    add column if not exists event_day_config_id integer
    references public.configs(id)
    on delete set null;


-- Rename/keep quest config as appropriate
-- If event_quest_config_id already exists, no change needed.


-- Add ordering
alter table public.agenda
    add column if not exists sort_order integer not null default 0;


-- Add status
alter table public.agenda
    add column if not exists status text not null default 'scheduled';


-- Guild many-to-many
create table if not exists public.agenda_guilds (
                                                    agenda_id uuid not null
                                                    references public.agenda(id)
    on delete cascade,

    guild_id integer not null
    references public.guilds(id)
    on delete cascade,

    primary key (agenda_id, guild_id)
    );

create index if not exists idx_agenda_guilds_guild_id
    on public.agenda_guilds(guild_id);


alter table public.agenda_guilds enable row level security;

create policy "agenda guilds are readable by authenticated users"
  on public.agenda_guilds
  for select
                 to authenticated
                 using (true);