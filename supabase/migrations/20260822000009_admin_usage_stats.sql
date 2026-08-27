/*
 * Usage Statistics for the admin UI — the FRD's Admin UI sheet:
 *
 *   - number of people logged on in the last 24 hours
 *   - total number of sessions added to schedules
 *   - total XP earned
 *   - for each event, how many people have added it to their schedule
 *
 * Two objects: public.agenda_stats for the per-event list (so it can be paged,
 * sorted and filtered in SQL rather than counted in memory a page at a time), and
 * public.admin_usage_stats() for the overall figures.
 *
 * Both are service-role only. These are aggregates over everyone's private rows,
 * and the admin edge function checks public.users.is_admin before it asks.
 */


/*
 * Per-event counts.
 *
 * A view rather than counting in the edge function, for one specific reason:
 * "which events are most popular" has to sort by a count, and a count assembled
 * in memory can only sort the page it already has. Aggregating here means
 * ORDER BY scheduled_count DESC pages correctly across the whole agenda.
 *
 * Admins are excluded from every count — event staff putting sessions on their own
 * schedule would inflate the attendee numbers. The same rule as ATTENDEE_ONLY in
 * supabase/functions/_shared/profile.ts.
 */
create or replace view public.agenda_stats
  with (security_invoker = false)
  as
  select
    a.id,
    a.name,
    a.description,
    a.day,
    a.start_time,
    a.end_time,
    a.location,
    a.speaker_name,
    a.speaker_title,
    a.speaker_company,
    a.xp_value,
    a.is_sponsored,
    a.is_invite_only,
    a.capacity,
    a.sort_order,
    a.status,
    a.event_quest_config_id,
    a.event_day_config_id,
    a.stage_config_id,
    a.created_at,

    -- "total attendees": on a schedule, which is saved plus admin-approved.
    coalesce(sched.scheduled_count, 0) as scheduled_count,
    coalesce(sched.saved_count, 0) as saved_count,
    coalesce(sched.approved_count, 0) as approved_count,
    -- Invite-only: waiting on an admin, and turned down.
    coalesce(sched.interested_count, 0) as interested_count,
    coalesce(sched.rejected_count, 0) as rejected_count,

    -- Actually turned up (scanned the session's QR code), and the XP that paid out.
    coalesce(been.checkin_count, 0) as checkin_count,
    coalesce(been.checkin_xp, 0) as checkin_xp,

    /*
     * Of the people who put this on their schedule, how many showed up. null
     * rather than 0 when nobody scheduled it, because "0% turned up" and "nobody
     * signed up, so there is nothing to measure" are different facts and a
     * dashboard should not render the second as the first.
     */
    case
      when coalesce(sched.scheduled_count, 0) = 0 then null
      else round(
        coalesce(been.checkin_count, 0)::numeric * 100
          / sched.scheduled_count, 1
      )
    end as attendance_rate,

    -- How full it is, for the invite-only events that set a capacity.
    case
      when a.capacity is null or a.capacity = 0 then null
      else round(
        coalesce(sched.scheduled_count, 0)::numeric * 100 / a.capacity, 1
      )
    end as capacity_used_percent
  from public.agenda a
  left join (
    select
      ua.agenda_id,
      count(*) filter (where ua.status in ('saved', 'approved')) as scheduled_count,
      count(*) filter (where ua.status = 'saved') as saved_count,
      count(*) filter (where ua.status = 'approved') as approved_count,
      count(*) filter (where ua.status = 'interested') as interested_count,
      count(*) filter (where ua.status = 'rejected') as rejected_count
    from public.user_agenda ua
    join public.users u on u.id = ua.user_id and u.is_admin = false
    group by ua.agenda_id
  ) sched on sched.agenda_id = a.id
  left join (
    select
      ac.agenda_id,
      count(*) as checkin_count,
      coalesce(sum(ac.points_awarded), 0) as checkin_xp
    from public.agenda_checkins ac
    join public.users u on u.id = ac.user_id and u.is_admin = false
    group by ac.agenda_id
  ) been on been.agenda_id = a.id;

/*
 * Not granted to `authenticated`. Per-event attendee counts are an organiser's
 * view, not an attendee's — and public.user_agenda is deliberately readable only
 * for your own rows, so exposing the aggregate to everyone would leak around that.
 */
revoke all on table public.agenda_stats from anon;
revoke all on table public.agenda_stats from authenticated;
grant select on table public.agenda_stats to service_role;

comment on view public.agenda_stats is
  'Per-event usage counts for the admin dashboard: scheduled, interested, checked in, attendance rate. Admins are excluded from the counts. Service role only.';


/*
 * The overall figures, in one round trip.
 *
 * security definer for one reason that matters: "people logged on in the last 24
 * hours" lives in auth.users.last_sign_in_at, and the auth schema is not in
 * config.toml's exposed `schemas`, so no amount of REST querying reaches it. This
 * is the only place that reads it, and it returns a count — never a row.
 */
create or replace function public.admin_usage_stats(p_hours integer default 24)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  window_hours integer := greatest(coalesce(p_hours, 24), 1);
  since timestamptz := now() - make_interval(hours => window_hours);
  signed_in integer;
  result jsonb;
begin
  /*
   * Guarded separately so the rest of the dashboard survives if this one read
   * fails. `postgres` owns this function and can normally read auth.users, but a
   * project whose auth grants have been tightened would otherwise take the whole
   * endpoint down over a single number. null means "unavailable", which the API
   * reports as null rather than as zero — zero would be a lie.
   */
  begin
    select count(*)
      into signed_in
      from auth.users au
      join public.users p on p.id = au.id
      where p.is_admin = false
        and au.last_sign_in_at is not null
        and au.last_sign_in_at >= since;
  exception
    when insufficient_privilege or undefined_table or undefined_column then
      signed_in := null;
  end;

  select jsonb_build_object(
    'window_hours', window_hours,
    'since', since,

    -- People
    'total_attendees', (
      select count(*) from public.users where is_admin = false
    ),
    'signed_in_recently', signed_in,
    'registered_recently', (
      select count(*) from public.users
      where is_admin = false and created_at >= since
    ),

    -- Schedules. The FRD's "total number of sessions added to schedules": rows on
    -- a schedule right now, not rows ever added — removing an event takes its XP
    -- back, so counting historic adds would disagree with the XP total.
    'total_sessions_added', (
      select count(*)
      from public.user_agenda ua
      join public.users u on u.id = ua.user_id and u.is_admin = false
      where ua.status in ('saved', 'approved')
    ),
    'pending_interest', (
      select count(*)
      from public.user_agenda ua
      join public.users u on u.id = ua.user_id and u.is_admin = false
      where ua.status = 'interested'
    ),
    'attendees_with_a_schedule', (
      select count(distinct ua.user_id)
      from public.user_agenda ua
      join public.users u on u.id = ua.user_id and u.is_admin = false
      where ua.status in ('saved', 'approved')
    ),

    -- XP. Read from public.leaderboard so this figure is the same one the
    -- leaderboard screen shows; it already excludes admins and already combines
    -- mission XP with session check-in XP.
    'total_xp_earned', (
      select coalesce(sum(total_points), 0) from public.leaderboard
    ),
    'attendees_with_xp', (select count(*) from public.leaderboard),
    'average_xp_per_scoring_attendee', (
      select case
        when count(*) = 0 then 0
        else round(coalesce(sum(total_points), 0)::numeric / count(*), 1)
      end
      from public.leaderboard
    ),
    'top_xp', (select coalesce(max(total_points), 0) from public.leaderboard),

    -- Engagement
    'missions_completed', (
      select count(*)
      from public.user_missions um
      join public.users u on u.id = um.user_id and u.is_admin = false
      where um.status = 'completed'
    ),
    'mission_completions_logged', (
      select count(*)
      from public.mission_completions mc
      join public.users u on u.id = mc.user_id and u.is_admin = false
    ),
    'connections_made', (
      select count(*) from public.connections where status = 'accepted'
    ),
    'qr_scans', (
      select count(*)
      from public.qr_scans qs
      join public.users u on u.id = qs.user_id and u.is_admin = false
    ),
    'session_checkins', (
      select count(*)
      from public.agenda_checkins ac
      join public.users u on u.id = ac.user_id and u.is_admin = false
    ),

    -- Content
    'total_events', (select count(*) from public.agenda),
    'events_with_attendees', (
      select count(*) from public.agenda_stats where scheduled_count > 0
    ),
    'active_qr_codes', (
      select count(*) from public.qr_codes where is_active
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_usage_stats(integer) from public, anon, authenticated;
grant execute on function public.admin_usage_stats(integer) to service_role;

comment on function public.admin_usage_stats(integer) is
  'Overall usage figures for the admin dashboard. security definer because "signed in recently" reads auth.users.last_sign_in_at, which is not reachable over REST. Service role only.';

-- The new view is a new relation in PostgREST's schema cache.
-- See 20260822000006_reload_schema_cache.sql.
notify pgrst, 'reload schema';
