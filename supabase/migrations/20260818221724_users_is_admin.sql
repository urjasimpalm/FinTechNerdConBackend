-- Admin flag on the attendee profile. Nobody is an admin by default; the flag is
-- set server-side (service role, SQL, or Studio), never by the app.
alter table public.users
  add column if not exists is_admin boolean not null default false;

-- Locking the flag down is the important half of this migration.
--
-- public.users lets a user update their own row ("users can update their own
-- profile"), and `authenticated` holds a table-wide UPDATE grant from Supabase's
-- default privileges. RLS can decide *which rows* an update may touch but not
-- *which columns*, so as it stands any signed-in user could
--   PATCH /rest/v1/users?id=eq.<self>  {"is_admin": true}
-- and promote themselves. Pinning the writable columns with column-level grants
-- is what prevents that (same approach as notifications.read_at).
--
-- Adding a user-editable column later means adding it to this list, otherwise
-- profile updates start failing with 42501.
revoke update on public.users from authenticated;
grant update (
  first_name,
  last_name,
  user_type_config_id,
  guild_id,
  company_name,
  job_title,
  profile_image,
  device_type,
  device_token
) on public.users to authenticated;

-- anon has no update policy on public.users, so it cannot reach any row today,
-- but it carries the same blanket grant. Drop it so the flag stays unreachable
-- even if a policy is added for anon later.
revoke update on public.users from anon;

-- is_admin is readable: the directory select policy already exposes every
-- profile to signed-in users, and the app needs the flag to decide what to show.
comment on column public.users.is_admin is
  'Grants admin rights in the app. Writable only by the service role — see the column grants in this migration.';
