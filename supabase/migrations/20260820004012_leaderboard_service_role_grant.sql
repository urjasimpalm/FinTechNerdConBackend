-- GET user/profile reports the caller's total XP and rank, which it reads from
-- public.leaderboard on the service role.
--
-- The view was created with a grant to `authenticated` only. Hosted projects
-- carry `alter default privileges ... grant all on tables to ... service_role`,
-- so it is readable there by accident; the local stack has no such default and
-- the same select fails with "permission denied for view leaderboard". Granting
-- it explicitly makes both behave the same.
grant select on public.leaderboard to service_role;
