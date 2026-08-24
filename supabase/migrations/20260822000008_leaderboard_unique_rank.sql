/*
 * Every attendee gets their own rank, and ties are broken by who got there first.
 *
 * 20260822000004_leaderboard_xp.sql used rank(), which is the standard sporting
 * ranking: two people on 200 XP are both 2nd and the next is 4th. That is correct
 * as statistics and wrong as a screen — "you are 2nd" means nothing when four
 * other people are also 2nd, and the FRD's leaderboard is a numbered list of
 * attendees.
 *
 * So: row_number() instead of rank(), which cannot produce a duplicate, ordered by
 *
 *   1. total XP, descending — the actual ranking
 *   2. last_award_at, ascending — first to reach the total wins the tie
 *   3. user_id — a final key so the order is total, deterministic and stable
 *      across requests even in the (impossible-in-practice) case of identical
 *      timestamps. Without it, a page of ties could reshuffle between requests and
 *      the list would appear to jump while being scrolled.
 *
 * "First to reach the total" is why last_award_at is a max() rather than a min():
 * it is the moment the attendee arrived at the score they now hold, not the moment
 * they started playing. Someone who hit 200 XP at 10:00 outranks someone who hit
 * 200 XP at 11:00.
 *
 * Note the totals still come from public.user_missions rather than straight from
 * public.mission_completions. Summing the ledger directly would be tidier, but any
 * user_missions row written by the old client-upsert path (the one revoked in
 * 20260822000002) has no ledger rows behind it, and switching the source would
 * silently zero those attendees' XP.
 */
drop view if exists public.leaderboard_people;
drop view if exists public.leaderboard;

create view public.leaderboard
  with (security_invoker = false)
  as
  with awards as (
    -- Mission XP. updated_at is maintained by the user_missions_set_updated_at
    -- trigger, so it moves whenever the roll-up recomputes — i.e. whenever this
    -- attendee's mission total last changed, in either direction.
    select
      um.user_id,
      sum(um.points_awarded)::bigint as points,
      max(um.updated_at) as at
    from public.user_missions um
    where um.status = 'completed'
    group by um.user_id

    union all

    -- Session XP, banked at check-in.
    select
      ac.user_id,
      sum(ac.points_awarded)::bigint,
      max(ac.created_at)
    from public.agenda_checkins ac
    group by ac.user_id
  ),
  totals as (
    select
      a.user_id,
      sum(a.points)::bigint as total_points,
      max(a.at) as last_award_at
    from awards a
    -- Admins are event staff, not attendees — the same rule as ATTENDEE_ONLY in
    -- supabase/functions/_shared/profile.ts.
    join public.users u on u.id = a.user_id and u.is_admin = false
    group by a.user_id
  )
  select
    t.user_id,
    t.total_points,
    row_number() over (
      order by t.total_points desc, t.last_award_at asc nulls last, t.user_id
    ) as rank,
    t.last_award_at
  from totals t;

grant select on public.leaderboard to authenticated;
grant select on public.leaderboard to service_role;

comment on view public.leaderboard is
  'Ranked XP totals: completed mission XP plus session check-in XP, admins excluded. Ranks are unique (row_number), ties broken by who reached the total first. Attendees who have earned nothing are absent, so they are unranked rather than ranked last.';
comment on column public.leaderboard.last_award_at is
  'When this attendee last reached their current total. The tie-break key: earlier ranks higher.';


create view public.leaderboard_people
  with (security_invoker = false)
  as
  select
    l.user_id,
    l.rank,
    l.total_points,
    l.last_award_at,
    u.first_name,
    u.last_name,
    u.nerd_number,
    u.company_name,
    u.job_title,
    u.profile_image,
    u.user_type_config_id
  from public.leaderboard l
  join public.users u on u.id = l.user_id;

grant select on public.leaderboard_people to authenticated;
grant select on public.leaderboard_people to service_role;

comment on view public.leaderboard_people is
  'public.leaderboard with the attendee card fields joined on, for the Leaderboard screen. Order by rank — it is unique, so no secondary sort key is needed.';

-- The new column and the changed rank semantics are both in PostgREST's schema
-- cache. See 20260822000006_reload_schema_cache.sql.
notify pgrst, 'reload schema';
