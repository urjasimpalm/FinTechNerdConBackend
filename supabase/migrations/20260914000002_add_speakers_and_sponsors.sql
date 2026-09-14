/*
 * Add speakers and sponsor support to Agenda.
 *
 * Creates a speakers table and updates agenda table to support:
 * - Multiple speakers (1-4 per agenda) stored as JSON array
 * - Sponsor tracking (is_sponsored and sponsor_name)
 * - Sponsor validation (sponsor_name required if is_sponsored=true)
 */

-- Create speakers table
create table if not exists public.speakers (
  id text not null,
  name text not null,
  title text null,
  company text null,
  bio text null,
  linkedin text null,
  status text null default 'confirmed',
  unavailable_slots jsonb null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  role text null default 'speaker',
  updated_at timestamptz not null default now(),
  primary key (id)
);

alter table public.speakers enable row level security;

create policy "speakers are readable by all users"
  on public.speakers for select
  to public, authenticated
  using (true);

grant select on table public.speakers to anon;
grant select on table public.speakers to authenticated;
grant select, insert, update, delete on table public.speakers to service_role;

create index if not exists idx_speakers_name on public.speakers(name);
create index if not exists idx_speakers_status on public.speakers(status);

comment on table public.speakers is
  'Speaker profiles for agenda events. Used to manage speaker information.';
comment on column public.speakers.id is
  'Unique speaker identifier.';
comment on column public.speakers.name is
  'Speaker name (required).';
comment on column public.speakers.title is
  'Speaker job title or role.';
comment on column public.speakers.company is
  'Speaker company or organization.';
comment on column public.speakers.bio is
  'Speaker biography or description.';
comment on column public.speakers.linkedin is
  'LinkedIn profile URL or handle.';
comment on column public.speakers.status is
  'Speaker status: confirmed, pending, declined (default: confirmed).';
comment on column public.speakers.role is
  'Speaker role type (default: speaker).';

-- Add speakers array to agenda table
alter table public.agenda
  add column if not exists speakers jsonb not null default '[]'::jsonb;

-- Add sponsor fields to agenda table
alter table public.agenda
  add column if not exists is_sponsored boolean not null default false;

alter table public.agenda
  add column if not exists sponsor_name text null;

-- Fix existing data: set is_sponsored = false for rows with missing sponsor_name
update public.agenda
set is_sponsored = false
where is_sponsored = true and (sponsor_name is null or sponsor_name = '');

-- Add constraint: sponsor_name required if is_sponsored = true
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.agenda'::regclass
      and conname = 'agenda_sponsor_name_required'
  ) then
    alter table public.agenda
      add constraint agenda_sponsor_name_required
      check (
        not is_sponsored or (is_sponsored and sponsor_name is not null and sponsor_name != '')
      );
  end if;
end;
$$;

-- Function to validate speaker count (1-4 speakers)
create or replace function public.validate_agenda_speakers()
returns trigger
language plpgsql
as $$
declare
  speaker_count integer;
begin
  -- speakers is a JSONB array, count the elements
  speaker_count := jsonb_array_length(coalesce(new.speakers, '[]'::jsonb));

  if speaker_count < 1 then
    raise exception 'Agenda must have at least 1 speaker.'
      using errcode = 'P0001';
  end if;

  if speaker_count > 4 then
    raise exception 'Agenda can have at most 4 speakers.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Trigger for speaker validation
drop trigger if exists validate_agenda_speakers_trigger on public.agenda;
create trigger validate_agenda_speakers_trigger
  before insert or update on public.agenda
  for each row
  execute function public.validate_agenda_speakers();

comment on table public.agenda is
  'Event sessions/agenda items. Supports multiple speakers (1-4) and sponsor information.';
comment on column public.agenda.speakers is
  'Array of speaker objects: [{id, name, title, company}, ...]. Min 1, max 4 speakers.';
comment on column public.agenda.is_sponsored is
  'Whether the agenda item is sponsored (default: false).';
comment on column public.agenda.sponsor_name is
  'Name of the sponsor. Required if is_sponsored = true.';
