/*
 * Attendees who have been invited but may not have registered yet.
 *
 * GET user/people lists these after the registered users, so people can find
 * attendees before they sign up. They are not accounts: there is no auth.users row
 * behind them, so they have no connections, guilds or user type, and they never
 * touch public.users.
 *
 * Email is the identity. It is stored lower-cased and trimmed, and is unique, so
 * the registered-user check in directory_attendees below is a plain comparison.
 */

create table if not exists public.attendees (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null default '',
  email text not null,
  nerd_number text null,
  company_name text null,
  job_title text null,
  profile_image text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendees_email_normalised check (email = lower(btrim(email))),
  constraint attendees_email_key unique (email)
);

-- Same shape as users.search_text: one lower-cased string the people search can
-- ilike against. nerd_number is left out, as attendees do not have one yet.
alter table public.attendees
  add column if not exists search_text text
  generated always as (
    lower(
      first_name || ' ' || last_name || ' ' ||
      coalesce(company_name, '') || ' ' || coalesce(job_title, '')
    )
  ) stored;

drop trigger if exists attendees_set_updated_at on public.attendees;
create trigger attendees_set_updated_at
  before update on public.attendees
  for each row
  execute function public.set_updated_at();

comment on table public.attendees is
  'Invited attendees, listed in GET user/people until they register. Written by migrations and the service role only.';
comment on column public.attendees.email is
  'Identity of the attendee. Stored lower-cased and trimmed; unique.';
comment on column public.attendees.search_text is
  'Lower-cased name, company and title in one string. Generated — search only, never write or return it.';

-- Attendee emails are contact details, so nothing a client can reach reads this
-- table: RLS is on with no policies, and only the service role has privileges.
alter table public.attendees enable row level security;

revoke all on table public.attendees from anon;
revoke all on table public.attendees from authenticated;
grant select, insert, update, delete on table public.attendees to service_role;

/*
 * The attendees who are not yet registered users: the list GET user/people appends.
 *
 * An attendee is dropped from here as soon as an account exists for the same email
 * (compared lower-cased and trimmed), so each person appears once — as a registered
 * user, through public.users, and not also as an attendee.
 *
 * security_invoker = true, so the table's RLS still applies to whoever queries it.
 */
create or replace view public.directory_attendees
  with (security_invoker = true)
  as
  select a.*
  from public.attendees a
  where not exists (
    select 1
    from public.users u
    where lower(btrim(u.email)) = a.email
  );

revoke all on public.directory_attendees from anon;
revoke all on public.directory_attendees from authenticated;
grant select on public.directory_attendees to service_role;
