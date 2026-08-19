-- Attendees pick between 1 and 3 guilds, so the single users.guild_id column is
-- replaced by a join table — the same move public.agenda made in
-- 20260812083442_update_agenda_schema.sql.
--
-- The 1..3 rule lives in public.set_user_guilds() below rather than in the API
-- alone: register and PUT user/profile both go through it, so the selection can
-- never be half-applied and can never end up empty or oversized.
create table if not exists public.user_guilds (
  user_id uuid not null references public.users (id) on delete cascade,
  guild_id integer not null references public.guilds (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, guild_id)
);

-- "who is in this guild" — the directory filter that users.guild_id used to serve.
create index if not exists user_guilds_guild_id_idx
  on public.user_guilds (guild_id);

-- Carry over what each user already had. Runs before the column is dropped, so
-- nothing is lost.
insert into public.user_guilds (user_id, guild_id)
select id, guild_id from public.users where guild_id is not null
on conflict (user_id, guild_id) do nothing;

alter table public.users drop constraint if exists users_guild_id_fkey;
alter table public.users drop column if exists guild_id;

-- The upper bound as a database invariant, not just an API check. Min 1 cannot be
-- expressed this way (a user with no guilds simply has no rows), so that half is
-- enforced by set_user_guilds().
create or replace function public.enforce_user_guild_limit()
returns trigger
language plpgsql
as $$
declare
  total integer;
begin
  select count(*) into total from public.user_guilds where user_id = new.user_id;
  if total > 3 then
    raise exception 'A user can belong to at most 3 guilds.' using errcode = 'P0001';
  end if;
  return null;
end;
$$;

drop trigger if exists user_guilds_limit on public.user_guilds;
create trigger user_guilds_limit
  after insert on public.user_guilds
  for each row
  execute function public.enforce_user_guild_limit();

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
  if ids is null or array_length(ids, 1) < 1 or array_length(ids, 1) > 3 then
    raise exception 'Pick between 1 and 3 guilds.' using errcode = 'P0001';
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

-- security definer, so the grant is the whole access control: only the service
-- role (i.e. register and user/profile) may change a selection.
revoke all on function public.set_user_guilds(uuid, integer[]) from public;
revoke all on function public.set_user_guilds(uuid, integer[]) from anon;
revoke all on function public.set_user_guilds(uuid, integer[]) from authenticated;
grant execute on function public.set_user_guilds(uuid, integer[]) to service_role;

alter table public.user_guilds enable row level security;

-- Readable by any signed-in user: the attendee directory shows which guilds
-- someone is in, and filters by guild.
drop policy if exists "user guilds are readable by authenticated users"
  on public.user_guilds;
create policy "user guilds are readable by authenticated users"
  on public.user_guilds for select
  to authenticated
  using (true);

-- No insert/update/delete policies. A client cannot write its own rows directly,
-- because that would bypass the 1..3 rule — it goes through set_user_guilds().

-- Spelled out because the two environments disagree otherwise: hosted projects
-- grant new tables to every role by default, the local stack grants nothing.
revoke all on table public.user_guilds from anon;
revoke all on table public.user_guilds from authenticated;
grant select on table public.user_guilds to authenticated;
grant select, insert, delete on table public.user_guilds to service_role;

comment on table public.user_guilds is
  'Which guilds a user belongs to: at least 1, at most 3. Written only through public.set_user_guilds().';
