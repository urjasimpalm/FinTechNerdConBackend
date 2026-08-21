/*
 * Agenda, brought up to what the FRD's Agenda sheet describes.
 *
 * public.agenda already carries most of it — name, description, day, times,
 * speaker, location, event_quest_config_id (Main / Side / Bonus Quests),
 * event_day_config_id, stage_config_id, is_sponsored, sort_order, status. What
 * the sheet asks for and the table has no room for:
 *
 *   - an XP Value per event,
 *   - "up to 2 tags per event, one primary and one secondary",
 *   - filtering by Builder / Operator / Explorer,
 *   - invite-only events, where the user expresses interest instead of adding.
 *
 * Tags reuse public.agenda_guilds rather than a new vocabulary: the sheet's tag
 * list (AI, Payments, Banking, Stablecoins, …) is essentially the 15 rows in
 * public.guilds, and the My Profile sheet calls guilds "the interest area tags".
 */

-- The XP a session is worth. Earned by checking in with the session's QR code
-- (see 20260822000003_qr_codes.sql), not by adding it to a schedule.
alter table public.agenda
  add column if not exists xp_value integer not null default 0;

-- Invite-only events: the Agenda screen shows an "express interest" button in
-- place of the add-to-schedule one, and an admin approves. capacity is the "see
-- number of attendees" figure the Admin UI sheet wants a denominator for.
alter table public.agenda
  add column if not exists is_invite_only boolean not null default false;

alter table public.agenda
  add column if not exists capacity integer;

-- The sheet's 650-character limit on description. Added NOT VALID on purpose:
-- existing rows are left alone (this is authoring guidance, and failing the
-- migration over seed copy would be worse), while every insert and update from
-- here on is checked. Run `alter table public.agenda validate constraint
-- agenda_description_length;` once the existing copy has been trimmed.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.agenda'::regclass
      and conname = 'agenda_description_length'
  ) then
    alter table public.agenda
      add constraint agenda_description_length
      check (description is null or char_length(description) <= 650)
      not valid;
  end if;
end;
$$;

comment on column public.agenda.xp_value is
  'XP awarded for attending, granted when the session''s QR code is scanned.';
comment on column public.agenda.is_invite_only is
  'When true the app offers "express interest" instead of add-to-schedule, and an admin approves. See public.user_agenda.status.';


/*
 * Tags: primary and secondary.
 *
 * agenda_guilds is already (agenda_id, guild_id) many-to-many. is_primary marks
 * which of the two is the primary tag; the partial unique index allows exactly
 * one primary per event, and the trigger caps the pair at two tags total. The
 * trigger is the same shape as public.enforce_user_guild_limit() in
 * 20260820013705_user_guilds.sql — an upper bound cannot be a check constraint,
 * because it has to count sibling rows.
 */
alter table public.agenda_guilds
  add column if not exists is_primary boolean not null default false;

create unique index if not exists agenda_guilds_one_primary
  on public.agenda_guilds (agenda_id)
  where is_primary;

create or replace function public.enforce_agenda_tag_limit()
returns trigger
language plpgsql
as $$
declare
  total integer;
begin
  select count(*) into total
    from public.agenda_guilds
    where agenda_id = new.agenda_id;

  if total > 2 then
    raise exception 'An event can have at most 2 tags (one primary, one secondary).'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

drop trigger if exists agenda_guilds_tag_limit on public.agenda_guilds;
create trigger agenda_guilds_tag_limit
  after insert on public.agenda_guilds
  for each row
  execute function public.enforce_agenda_tag_limit();

comment on column public.agenda_guilds.is_primary is
  'The event''s primary tag. At most one per event (agenda_guilds_one_primary), at most 2 tags in total.';


/*
 * Builder / Operator / Explorer tagging, so the Agenda filter the sheet asks for
 * ("filter events by day or by builder/operator/explorer tag") has something to
 * filter on. A join table rather than a column, because the sheet does not say an
 * event has only one, and this mirrors agenda_guilds.
 *
 * The target has to be a user_type row in public.configs. A foreign key cannot
 * constrain to a subset of a table, so a trigger does it — public.configs holds
 * five unrelated types on one id sequence, and pointing an event at 'Day 1' would
 * otherwise be accepted silently.
 */
create table if not exists public.agenda_user_types (
  agenda_id uuid not null references public.agenda (id) on delete cascade,
  user_type_config_id integer not null references public.configs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (agenda_id, user_type_config_id)
);

-- "which events suit an Explorer" — the filter direction.
create index if not exists agenda_user_types_config_idx
  on public.agenda_user_types (user_type_config_id);

create or replace function public.enforce_agenda_user_type()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.configs c
    where c.id = new.user_type_config_id and c.type = 'user_type'
  ) then
    raise exception 'config % is not a user_type.', new.user_type_config_id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists agenda_user_types_check on public.agenda_user_types;
create trigger agenda_user_types_check
  before insert or update on public.agenda_user_types
  for each row
  execute function public.enforce_agenda_user_type();

alter table public.agenda_user_types enable row level security;

-- Readable by any signed-in user, the same as agenda and agenda_guilds: it is
-- event content the Agenda screen renders.
drop policy if exists "agenda user types are readable by authenticated users"
  on public.agenda_user_types;
create policy "agenda user types are readable by authenticated users"
  on public.agenda_user_types for select
  to authenticated
  using (true);

-- Spelled out because the two environments disagree otherwise: hosted projects
-- grant new tables to every role by default, the local stack grants nothing.
revoke all on table public.agenda_user_types from anon;
revoke all on table public.agenda_user_types from authenticated;
grant select on table public.agenda_user_types to authenticated;
grant select, insert, update, delete on table public.agenda_user_types to service_role;

comment on table public.agenda_user_types is
  'Which Builder/Operator/Explorer audiences an event is tagged for. Rows point at public.configs rows of type user_type.';


/*
 * public.user_agenda gains a status, so one table covers both halves of the
 * sheet: a normal event is 'saved', an invite-only event goes
 * 'interested' → 'approved' | 'rejected' when an admin answers.
 *
 * My Schedule is therefore status in ('saved', 'approved'), and that is also the
 * set that earns the "Add a session" / "Book Your First Quest" missions — see
 * public.award_agenda_mission() in the next migration.
 */
alter table public.user_agenda
  add column if not exists status text not null default 'saved';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_agenda'::regclass
      and conname = 'user_agenda_status_check'
  ) then
    alter table public.user_agenda
      add constraint user_agenda_status_check
      check (status in ('saved', 'interested', 'approved', 'rejected'));
  end if;
end;
$$;

-- "my schedule" and "what am I waiting on", the two lists the app asks for.
create index if not exists user_agenda_user_status_idx
  on public.user_agenda (user_id, status);

comment on column public.user_agenda.status is
  'saved = on my schedule. interested/approved/rejected are the invite-only flow. My Schedule is saved + approved.';

/*
 * Writes move server-side.
 *
 * Two reasons, and the second is the important one:
 *
 *   - A client that can insert its own row can insert status = 'approved' and
 *     let itself into an invite-only event.
 *   - Adding a session awards mission XP (next migration). The award is a trigger
 *     so it fires whatever the path, but the *status* it keys off has to be
 *     trustworthy for that to mean anything.
 *
 * select stays open — the app still reads its own schedule directly. This is a
 * breaking change for the direct upsert documented in postman/API.md §7: use
 * POST user/agenda/schedule instead.
 */
drop policy if exists "users can add to their own agenda" on public.user_agenda;
drop policy if exists "users can remove from their own agenda" on public.user_agenda;

revoke insert, update, delete on table public.user_agenda from anon;
revoke insert, update, delete on table public.user_agenda from authenticated;
grant select on table public.user_agenda to authenticated;
grant select, insert, update, delete on table public.user_agenda to service_role;

comment on table public.user_agenda is
  'A user''s relationship to an event. Written only by the user edge function on the service role (POST user/agenda/schedule); clients may read their own rows.';
