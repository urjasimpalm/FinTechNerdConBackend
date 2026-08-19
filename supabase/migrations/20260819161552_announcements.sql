-- The event-wide announcement banner: admins set the text, every signed-in user
-- reads it.
--
-- One announcement exists at a time, so this is a single row pinned to id = 1
-- rather than a list. Empty text is a valid state and means "nothing to show" —
-- that is how an admin clears the banner, so the client should hide it when
-- `text` is empty rather than treating empty as an error.
create table if not exists public.announcements (
  -- Singleton: the check constraint is what stops a second announcement appearing.
  id smallint primary key default 1 check (id = 1),
  text text not null default '',
  -- Who last saved it, for accountability. Kept even if that admin's profile is
  -- deleted, hence set null rather than cascade.
  updated_by uuid references public.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Seed the row so a GET has something to return before the first save.
insert into public.announcements (id, text)
values (1, '')
on conflict (id) do nothing;

-- Dropped first so the whole migration can be re-run without erroring on the
-- trigger and skipping the grants below it.
drop trigger if exists announcements_set_updated_at on public.announcements;
create trigger announcements_set_updated_at
  before update on public.announcements
  for each row
  execute function public.set_updated_at();

alter table public.announcements enable row level security;

-- Readable by any signed-in user. Deliberately not granted to anon: the banner is
-- event content for attendees, not public web copy. If it ever needs to show on
-- the login screen, add an equivalent policy `to anon`.
drop policy if exists "announcement is readable by authenticated users"
  on public.announcements;
create policy "announcement is readable by authenticated users"
  on public.announcements for select
  to authenticated
  using (true);

-- No insert/update/delete policies: writes go through the admin edge function,
-- which runs on the service role after checking public.users.is_admin. An admin
-- has no direct write path to this table, which keeps the is_admin check in one
-- place.

-- Table privileges have to be spelled out, and the two environments disagree if
-- they are not. Hosted projects carry `alter default privileges ... grant all on
-- tables to anon, authenticated, service_role`, so a new table arrives fully
-- granted there; the local stack has no such default, so the same table arrives
-- with no grants at all and even the service role gets
-- "42501: permission denied for table announcements".
--
-- Setting them explicitly makes local and deployed behave the same. RLS is still
-- what stops clients writing — these grants only decide who may attempt it.
revoke all on table public.announcements from anon;
revoke all on table public.announcements from authenticated;

grant select on table public.announcements to authenticated;
grant select, insert, update on table public.announcements to service_role;
