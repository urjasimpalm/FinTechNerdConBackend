-- Backs the verify-email edge function: before collecting a password the app
-- asks whether an email is on the pre-approved attendee list (public.email_stack).
-- Matching is case-insensitive, so "Wasim@Simpalm.com" finds a stack row stored
-- as "wasim@simpalm.com".
create index if not exists email_stack_email_lower_idx
  on public.email_stack (lower(email));

-- Earlier name of this helper, in case a database already ran that version.
drop function if exists public.is_email_in_stack(text);

create or replace function public.verify_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.email_stack
    where lower(email) = lower(trim(p_email))
  );
$$;

-- email_stack has RLS enabled and no policies, so nobody can read the invite
-- list directly. This function is security definer so it can answer the yes/no
-- question without exposing the rows behind it.
--
-- Only the service role gets execute: the verify-email edge function calls it.
-- Granting it to anon as well would turn it into an open oracle for probing who
-- is on the attendee list, and the edge function is the place to rate limit.
revoke all on function public.verify_email(text) from public;
grant execute on function public.verify_email(text) to service_role;
