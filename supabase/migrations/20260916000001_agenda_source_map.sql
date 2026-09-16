/*
 * Track migrated agenda items from source Supabase project.
 *
 * Used for idempotent migration: if the same source session is migrated again,
 * it will be updated in the target rather than creating a duplicate.
 */

create table if not exists public.agenda_source_map (
  source_session_id text not null,
  target_agenda_id uuid not null references public.agenda(id) on delete cascade,
  migrated_at timestamptz not null default now(),
  primary key (source_session_id),
  unique (target_agenda_id)
);

alter table public.agenda_source_map enable row level security;

create index if not exists idx_agenda_source_map_target_id
  on public.agenda_source_map(target_agenda_id);

comment on table public.agenda_source_map is
  'Maps source session IDs from the Fintech NerdCon Agenda (Main) project to target agenda items in this project. Used for idempotent migrations.';
comment on column public.agenda_source_map.source_session_id is
  'Session ID from source public.public_agenda view.';
comment on column public.agenda_source_map.target_agenda_id is
  'UUID of the corresponding agenda item in target public.agenda table.';
comment on column public.agenda_source_map.migrated_at is
  'Timestamp when this mapping was created or last updated.';

grant select, insert, update, delete on table public.agenda_source_map to service_role;
