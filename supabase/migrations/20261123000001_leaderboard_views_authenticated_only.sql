/*
 * The leaderboard views are for signed-in attendees only.
 *
 * public.leaderboard and public.leaderboard_people are security_invoker = false
 * views, so they read through their owner and bypass the RLS on users and
 * user_missions. Their grants were never narrowed, and new public views pick up
 * anon privileges by default, so an anonymous caller could read every attendee's
 * name, company and XP rank. Only the Leaderboard screen, which runs signed in,
 * needs them, so anon loses access and authenticated keeps it.
 */

revoke all on public.leaderboard from anon;
revoke all on public.leaderboard_people from anon;

grant select on public.leaderboard to authenticated;
grant select on public.leaderboard_people to authenticated;
