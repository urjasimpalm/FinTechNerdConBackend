/*
 * Remove the 3-guild ceiling. An attendee now picks at least 1 guild, with no upper
 * limit.
 *
 * Drops the user_guilds_limit trigger and its function, and replaces
 * public.set_user_guilds() so it only rejects an empty selection.
 */

drop trigger if exists user_guilds_limit on public.user_guilds;
drop function if exists public.enforce_user_guild_limit();

/*
 * Replaces a user's whole guild selection in one statement.
 *
 * Called by register and PUT user/profile. Doing it here rather than as a
 * delete-then-insert pair from the edge function is what makes it atomic: over
 * PostgREST those would be two separate transactions, and a failure between them
 * would leave the user with no guilds at all.
 *
 * Duplicates in the input are collapsed, so [2,2,3] is a two-guild selection.
 */
create or replace function public.set_user_guilds(
  p_user_id uuid,
  p_guild_ids integer[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ids integer[];
  missing integer;
begin
  select array_agg(distinct wanted.id)
    into ids
    from unnest(p_guild_ids) as wanted(id)
    where wanted.id is not null;

  -- array_length is null for an empty array, so the null check covers "none sent".
  if ids is null or array_length(ids, 1) < 1 then
    raise exception 'Pick at least 1 guild.' using errcode = 'P0001';
  end if;

  select wanted.id
    into missing
    from unnest(ids) as wanted(id)
    where not exists (select 1 from public.guilds g where g.id = wanted.id)
    limit 1;

  if missing is not null then
    raise exception 'Guild % does not exist.', missing using errcode = 'P0001';
  end if;

  -- Drop what was deselected, add what is new; rows that stay are untouched.
  delete from public.user_guilds
  where user_id = p_user_id and guild_id <> all (ids);

  insert into public.user_guilds (user_id, guild_id)
  select p_user_id, wanted.id from unnest(ids) as wanted(id)
  on conflict (user_id, guild_id) do nothing;
end;
$$;

-- Grants are unchanged from 20260820013705_user_guilds.sql: create or replace keeps
-- the existing privileges on the function.

comment on table public.user_guilds is
  'Which guilds a user belongs to: at least 1, no upper limit. Written only through public.set_user_guilds().';
