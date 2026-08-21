/*
 * The leaderboard, now that XP comes from two places.
 *
 * The FRD's Agenda sheet gives every event an XP Value and the QR Codes sheet says
 * a scan grants "the mission/session XP accordingly", so attending sessions has to
 * count — but public.leaderboard (0009_leaderboard_view.sql) sums only
 * public.user_missions. Redefined here as mission XP + session check-in XP.
 *
 * It stays a *view*: nothing writes a total, so a total can never disagree with
 * the ledger it came from. Every award — a QR scan, a saved session, an accepted
 * connection — shows up on the next read.
 *
 * The three column names are unchanged (user_id, total_points, rank), so
 * loadProfile() in supabase/functions/user/profile.ts keeps working untouched and
 * picks up session XP for free.
 */
drop view if exists public.leaderboard_people;
drop view if exists public.leaderboard;

create view public.leaderboard
  with (security_invoker = false)
  as
  with awards as (
    -- Mission XP. status = 'completed' is what public.rollup_user_mission() sets;
    -- points_awarded there is the sum over that mission's completions, so a
    -- repeatable mission contributes every time it was earned.
    select um.user_id, sum(um.points_awarded)::bigint as points
    from public.user_missions um
    where um.status = 'completed'
    group by um.user_id

    union all

    -- Session XP: the event's own xp_value, banked at check-in.
    select ac.user_id, sum(ac.points_awarded)::bigint
    from public.agenda_checkins ac
    group by ac.user_id
  )
  select
    a.user_id,
    sum(a.points)::bigint as total_points,
    rank() over (order by sum(a.points) desc) as rank
  from awards a
  -- Admins are event staff, not attendees — the same rule as ATTENDEE_ONLY in
  -- supabase/functions/_shared/profile.ts. Ranking them would push every real
  -- attendee down a place.
  join public.users u on u.id = a.user_id and u.is_admin = false
  group by a.user_id;

/*
 * security_invoker = false, so the view is computed against the whole of
 * user_missions and agenda_checkins rather than being filtered to the caller's own
 * rows by their RLS policies — a leaderboard of one is not a leaderboard.
 *
 * Both grants are needed: `authenticated` for a direct read, `service_role`
 * because GET user/profile and GET user/leaderboard run on it. See
 * 20260820004012_leaderboard_service_role_grant.sql for why the hosted and local
 * stacks disagree without the second one.
 */
grant select on public.leaderboard to authenticated;
grant select on public.leaderboard to service_role;

comment on view public.leaderboard is
  'Ranked XP totals: completed mission XP plus session check-in XP, admins excluded. Users who have earned nothing are absent, so they have no rank rather than being ranked last.';


/*
 * The Leaderboard screen in one query.
 *
 * The sheet's entry is "Name, Nerd Number, Ranking, Total XP", and clicking a name
 * opens that person's profile — so the id and the card fields come along too.
 * Joining in the edge function instead would mean two round trips and re-sorting
 * the second result to match the first.
 */
create view public.leaderboard_people
  with (security_invoker = false)
  as
  select
    l.user_id,
    l.rank,
    l.total_points,
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
  'public.leaderboard with the attendee card fields joined on, for the Leaderboard screen.';
