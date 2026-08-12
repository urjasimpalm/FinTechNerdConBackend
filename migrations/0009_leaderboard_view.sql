-- user/leaderboard
-- security_invoker = false (the default for functions, and explicitly set here for the view)
-- so the leaderboard is computed against the full user_missions table rather than being
-- filtered down to the caller's own rows by the underlying RLS policies.
create view public.leaderboard
  with (security_invoker = false)
  as
  select
    user_id,
    sum(points_awarded) as total_points,
    rank() over (order by sum(points_awarded) desc) as rank
  from public.user_missions
  where status = 'completed'
  group by user_id;

grant select on public.leaderboard to authenticated;
