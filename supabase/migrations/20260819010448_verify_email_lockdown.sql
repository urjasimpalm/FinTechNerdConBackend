-- Closes the invite-list oracle on databases that already ran
-- 20260819010013_verify_email_function.sql before it named anon/authenticated in
-- its revokes.
--
-- Hosted projects grant EXECUTE on new public functions to anon, authenticated
-- and service_role through default privileges, and `revoke ... from public` does
-- not remove a grant held by a named role. The result on the linked project was
--   proacl = {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- i.e. anyone holding the anon key could call
--   POST /rest/v1/rpc/verify_email {"p_email": "..."}
-- and probe which addresses are on the attendee list, bypassing the verify-email
-- edge function (which is the only intended caller, and the place to rate limit).
--
-- Idempotent: on a database created from the corrected migration these revokes
-- find nothing to remove.
revoke all on function public.verify_email(text) from public;
revoke all on function public.verify_email(text) from anon;
revoke all on function public.verify_email(text) from authenticated;
grant execute on function public.verify_email(text) to service_role;

-- public.is_chat_participant is deliberately left alone. It is also security
-- definer, but it answers only about the caller (`auth.uid()`), so reaching it
-- directly reveals nothing the caller could not already query — and it is invoked
-- from the chats / chat_participants / chat_messages RLS policies, so tightening
-- it risks breaking every chat read for no gain.
