-- Recreates public.verify_email, which backs the verify-email edge function and
-- step 1 of register. Without it both return
--   { "status": "Error", "message": "Something went wrong. Please try again." }
-- because the RPC call fails.
--
-- Why a new migration rather than a fix to 20260814214202_email_stack_lookup.sql:
-- that file is already recorded in the remote migration history, so `db push`
-- will never run it again. Only a newer timestamp gets applied.
--
-- A `supabase db pull` had generated 20260818192546_remote_schema.sql containing
-- just `drop function if exists "public"."verify_email"(p_email text)` — the
-- pull's way of saying "the remote doesn't have this". That file was deleted, as
-- keeping it would recreate the same gap on any fresh project: create the
-- function at 20260814214202, then drop it again at 20260818192546.
--
-- Everything here is idempotent, so it is safe to re-run anywhere.
create index if not exists email_stack_email_lower_idx
  on public.email_stack (lower(email));

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

-- email_stack has RLS enabled and no policies, so the invite list is unreadable
-- to clients. security definer lets this answer the yes/no question without
-- exposing the rows behind it.
--
-- Service role only: the verify-email edge function is the single caller.
-- Granting execute to anon would turn it into an open oracle for probing which
-- addresses are on the attendee list.
-- anon and authenticated have to be named explicitly. Hosted projects carry
-- `alter default privileges ... grant all on functions to anon, authenticated,
-- service_role`, so a new function is created already executable by them, and
-- `revoke ... from public` does not touch those grants (PUBLIC is a different
-- thing from a named role). The local stack does not have that default, which is
-- why revoking only PUBLIC looked correct locally while leaving the function
-- callable by anon on the real project.
revoke all on function public.verify_email(text) from public;
revoke all on function public.verify_email(text) from anon;
revoke all on function public.verify_email(text) from authenticated;
grant execute on function public.verify_email(text) to service_role;
