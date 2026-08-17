-- auth/register step 1: before collecting a password the app asks whether the
-- email is on the pre-approved attendee list (public.email_stack).
-- Matching is case-insensitive, so "Wasim@Simpalm.com" finds a stack row stored
-- as "wasim@simpalm.com".
create index if not exists email_stack_email_lower_idx
  on public.email_stack (lower(email));

create or replace function public.is_email_in_stack(p_email text)
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
-- list directly. This function is security definer so an unauthenticated
-- caller can get the yes/no answer without seeing the rows behind it.
revoke all on function public.is_email_in_stack(text) from public;
grant execute on function public.is_email_in_stack(text) to anon;
grant execute on function public.is_email_in_stack(text) to authenticated;
grant execute on function public.is_email_in_stack(text) to service_role;
