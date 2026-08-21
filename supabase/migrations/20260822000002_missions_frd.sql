/*
 * Missions, as the FRD's Missions sheet describes them.
 *
 * The sheet asks for three things public.user_missions cannot express, because it
 * holds one row per (user_id, mission_id) with a single status:
 *
 *   - a "Times Completed" counter for the repeatable missions,
 *   - "each session can only count once, removing and re-adding the same session
 *     will not count",
 *   - "each unique QR code scanned increases the counter by 1".
 *
 * All three are the same requirement: a completion has an *identity*, and the
 * same identity must never count twice. So completions become a ledger —
 * public.mission_completions, unique on (user_id, mission_id, source_key) — and
 * source_key is the dedup rule itself:
 *
 *   book_first_quest  save a Bonus Quest event      agenda:<uuid>       once
 *   add_session       save a Main/Side Quest event   agenda:<uuid>       repeatable
 *   visit_activation  scan a sponsor-booth QR        qr:<id>             repeatable
 *   connect_nerd      a connection is accepted       connection:<uuid>   repeatable
 *   explore_zone      scan a zone QR                 qr:<id>             repeatable
 *   nerd_flex         scan the lanyard QR            qr:<id>             once
 *   quest_master      every other mission completed   derived:all         once
 *
 * public.user_missions stays, as the roll-up a trigger maintains, so
 * public.leaderboard and GET user/profile keep reading what they already read.
 *
 * Nothing here is callable by a client. Awards happen in triggers on
 * public.user_agenda and public.connections, and inside public.claim_qr_code()
 * (next migration), so they hold whichever path wrote the row — and there is no
 * endpoint that grants a user XP on request.
 */

alter table public.missions
  add column if not exists code text;

-- Repeatable missions keep a counter; the rest complete once.
alter table public.missions
  add column if not exists is_repeatable boolean not null default false;

-- null = unlimited. The sheet says "around 10-12" activations and "7-8" zones,
-- but the real ceiling is how many QR codes exist, so this is left open and is
-- here for a mission that ever needs a hard cap.
alter table public.missions
  add column if not exists max_completions integer;

alter table public.missions
  add column if not exists sort_order integer not null default 0;

/*
 * A stable key for each mission, because the triggers below and every QR code
 * have to name one. Neither an id nor a title will do: seed.sql pins ids 1..7 but
 * 20260820200833_missions_more.sql inserts by title and lets the sequence pick,
 * so ids differ between environments — and titles are copy, which someone will
 * reword.
 *
 * Matched case-insensitively for the same reason: seed.sql has 'Visit an
 * Activation', the FRD sheet has 'Visit an activation'.
 */
update public.missions m
  set code = v.code
  from (values
    ('book your first quest',           'book_first_quest'),
    ('add a session to your schedule',  'add_session'),
    ('visit an activation',             'visit_activation'),
    ('connect with a new nerd',         'connect_nerd'),
    ('explore a new zone',              'explore_zone'),
    ('nerd flex',                       'nerd_flex'),
    ('quest master',                    'quest_master')
  ) as v (title, code)
  where lower(btrim(m.title)) = v.title
    and m.code is null;

-- Partial, so missions added later without a code do not collide on null.
create unique index if not exists missions_code_key
  on public.missions (code)
  where code is not null;

/*
 * Any of the seven that are still missing.
 *
 * The catalog cannot be left to seed.sql: there is no supabase/seed.sql and no
 * [db.seed] in config.toml, so the root seed.sql is a manual artifact and
 * `supabase db reset` never runs it. What migrations alone produce today is the
 * three rows in 20260820200833_missions_more.sql — which would leave the four
 * triggers and every QR code pointing at missions that do not exist, and
 * public.award_mission() would return false forever without saying why.
 *
 * Matched on `code`, after the backfill above, so an environment that already has
 * a mission under its title keeps that row (and its history) rather than gaining a
 * duplicate.
 *
 * The identity sequence is nudged past the existing rows first: seed.sql inserted
 * ids 1..7 with `overriding system value`, which does not advance the sequence, so
 * letting the database pick an id below would collide on the primary key. Same
 * move as 20260819185923_guilds_and_user_type_data.sql. The third argument is
 * false when the table is empty, so id 1 is still handed out on a fresh database.
 */
select setval(
  pg_get_serial_sequence('public.missions', 'id'),
  coalesce((select max(id) from public.missions), 1),
  (select count(*) > 0 from public.missions)
);

insert into public.missions (code, title, description, points, is_repeatable, sort_order)
select w.code, w.title, w.description, w.points, w.is_repeatable, w.ord
from (values
  (
    'book_first_quest', 'Book Your First Quest',
    'Add an offsite event to your schedule.',
    50, false, 1
  ),
  (
    'add_session', 'Add a session to your schedule',
    'Check in to a Main Quest or Side Quest Stage session and level up your knowledge.',
    50, true, 2
  ),
  (
    'visit_activation', 'Visit an Activation',
    'Explore a sponsor activation in the Activation Hall.',
    50, true, 3
  ),
  (
    'connect_nerd', 'Connect with a New Nerd',
    'Make a new connection through the event app with a fellow attendee.',
    50, true, 4
  ),
  (
    'explore_zone', 'Explore a New Zone',
    'Visit one of NerdCon''s themed worlds and discover what''s inside.',
    50, true, 5
  ),
  (
    'nerd_flex', 'Nerd Flex',
    'Find Simon, Colton, or Joy, snap a gloriously nerdy photo together (high-five, goofy grin, swag, props, or your best geeky pose), and share it on LinkedIn or your favorite social platform using #FintechNerdCon.',
    50, false, 6
  ),
  (
    'quest_master', 'Quest Master',
    'Complete every core mission.',
    50, false, 7
  )
) as w (code, title, description, points, is_repeatable, ord)
-- Filtered in the select rather than left to `on conflict`: the identity default
-- is evaluated for every candidate row before conflicts are resolved, so
-- `on conflict do nothing` would burn an id on each row it discards.
where not exists (
  select 1 from public.missions existing where existing.code = w.code
);

update public.missions
  set is_repeatable = true
  where code in ('add_session', 'visit_activation', 'connect_nerd', 'explore_zone')
    and not is_repeatable;

-- Display order: the sheet lists them in this order, and Quest Master reads last
-- because it depends on the rest.
update public.missions m
  set sort_order = v.ord
  from (values
    ('book_first_quest', 1),
    ('add_session',      2),
    ('visit_activation', 3),
    ('connect_nerd',     4),
    ('explore_zone',     5),
    ('nerd_flex',        6),
    ('quest_master',     7)
  ) as v (code, ord)
  where m.code = v.code and m.sort_order <> v.ord;

comment on column public.missions.code is
  'Stable machine name (book_first_quest, add_session, …). What triggers and QR codes reference — ids differ between environments and titles are copy.';
comment on column public.missions.is_repeatable is
  'When true the mission has a Times Completed counter and can be earned once per distinct source_key.';


-- The counter the sheet asks for. Derived from the ledger by the trigger below,
-- never written directly.
alter table public.user_missions
  add column if not exists times_completed integer not null default 0;


/*
 * The ledger: one row per completion that counted.
 *
 * source_key is what makes the FRD's rules hold. Re-adding a session reuses
 * agenda:<uuid>, so `on conflict do nothing` swallows it; each QR code is one
 * qr:<id>; each person you connect with is one connection:<uuid>.
 */
create table if not exists public.mission_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  mission_id integer not null references public.missions (id) on delete cascade,
  -- Where it came from, for support questions and the notification copy.
  source_type text not null
    check (source_type in ('qr', 'agenda', 'connection', 'derived', 'manual')),
  source_key text not null,
  -- FK added in 20260822000003_qr_codes.sql, which creates public.qr_codes.
  qr_code_id integer,
  -- Copied at award time rather than read through to missions.points, so
  -- re-pricing a mission does not silently restate everyone's history.
  points_awarded integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, mission_id, source_key)
);

-- "my completions for this mission", which the roll-up recomputes on every write.
create index if not exists mission_completions_user_mission_idx
  on public.mission_completions (user_id, mission_id);

alter table public.mission_completions enable row level security;

drop policy if exists "users can view their own mission completions"
  on public.mission_completions;
create policy "users can view their own mission completions"
  on public.mission_completions for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policies: awarding XP is not a client operation.
revoke all on table public.mission_completions from anon;
revoke all on table public.mission_completions from authenticated;
grant select on table public.mission_completions to authenticated;
grant select, insert, update, delete on table public.mission_completions to service_role;

comment on table public.mission_completions is
  'One row per mission completion that counted. unique (user_id, mission_id, source_key) is the dedup rule: agenda:<uuid>, qr:<id>, connection:<uuid>, derived:all.';


/*
 * public.user_missions as a roll-up of the ledger.
 *
 * Recomputed from scratch on every ledger write rather than incremented, so it
 * cannot drift, and so deleting a completion (a mis-scan, a support fix) puts the
 * counter back. completed_at is the first completion — when the mission was
 * earned, not when it was last repeated.
 */
create or replace function public.rollup_user_mission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user uuid;
  target_mission integer;
  total_count integer;
  total_points integer;
  first_at timestamptz;
begin
  -- Branched on tg_op rather than coalesce(new.…, old.…): NEW is *unassigned* in
  -- a DELETE trigger, not null, so reading a field off it raises "record new is
  -- not assigned yet" instead of falling through to OLD.
  if tg_op = 'DELETE' then
    target_user := old.user_id;
    target_mission := old.mission_id;
  else
    target_user := new.user_id;
    target_mission := new.mission_id;
  end if;

  select count(*), coalesce(sum(points_awarded), 0), min(created_at)
    into total_count, total_points, first_at
    from public.mission_completions
    where user_id = target_user and mission_id = target_mission;

  -- Last completion removed: drop the roll-up rather than leaving a zeroed
  -- "completed" row, which the leaderboard would still count as earned.
  if total_count = 0 then
    delete from public.user_missions
      where user_id = target_user and mission_id = target_mission;
    return null;
  end if;

  insert into public.user_missions (
    user_id, mission_id, status, points_awarded, times_completed, completed_at
  )
  values (
    target_user, target_mission, 'completed', total_points, total_count, first_at
  )
  on conflict (user_id, mission_id) do update
    set status = 'completed',
        points_awarded = excluded.points_awarded,
        times_completed = excluded.times_completed,
        completed_at = excluded.completed_at;

  return null;
end;
$$;

drop trigger if exists mission_completions_rollup on public.mission_completions;
create trigger mission_completions_rollup
  after insert or delete on public.mission_completions
  for each row
  execute function public.rollup_user_mission();


/*
 * Quest Master: "complete every other mission at least once."
 *
 * Derived, so it cannot be out of step with the rest — re-checked after every
 * award, and awarded at most once because of its own source_key.
 */
create or replace function public.refresh_quest_master(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  quest_master_id integer;
  quest_master_points integer;
  outstanding integer;
begin
  select id, points into quest_master_id, quest_master_points
    from public.missions
    where code = 'quest_master' and is_active
    limit 1;
  if quest_master_id is null then return; end if;

  if exists (
    select 1 from public.mission_completions
    where user_id = p_user_id and mission_id = quest_master_id
  ) then
    return;
  end if;

  select count(*) into outstanding
    from public.missions m
    where m.is_active
      and m.id <> quest_master_id
      and not exists (
        select 1 from public.mission_completions mc
        where mc.user_id = p_user_id and mc.mission_id = m.id
      );

  if outstanding > 0 then return; end if;

  insert into public.mission_completions (
    user_id, mission_id, source_type, source_key, points_awarded
  )
  values (
    p_user_id, quest_master_id, 'derived', 'derived:all', quest_master_points
  )
  on conflict (user_id, mission_id, source_key) do nothing;
end;
$$;


/*
 * The one way XP is awarded. Returns true only when this call is what counted it,
 * so a caller can tell "you earned something" from "you already had this".
 *
 * Everything routes through here: the two triggers below, and
 * public.claim_qr_code() in the next migration.
 */
create or replace function public.award_mission_id(
  p_user_id uuid,
  p_mission_id integer,
  p_source_type text,
  p_source_key text,
  p_qr_code_id integer default null,
  -- Overrides the mission's own points; used by a QR code with points_override.
  p_points integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  mission_points integer;
  mission_repeatable boolean;
  mission_max integer;
  done integer;
  inserted integer;
begin
  if p_user_id is null or p_mission_id is null or p_source_key is null then
    return false;
  end if;

  select points, is_repeatable, max_completions
    into mission_points, mission_repeatable, mission_max
    from public.missions
    where id = p_mission_id and is_active;
  if not found then return false; end if;

  select count(*) into done
    from public.mission_completions
    where user_id = p_user_id and mission_id = p_mission_id;

  -- Not repeatable: earned once, ever. Checked as well as relying on source_key,
  -- because a one-off mission reached from two different sources (a QR code and a
  -- manual fix, say) would otherwise count twice.
  if not mission_repeatable and done >= 1 then return false; end if;
  if mission_max is not null and done >= mission_max then return false; end if;

  insert into public.mission_completions (
    user_id, mission_id, source_type, source_key, qr_code_id, points_awarded
  )
  values (
    p_user_id, p_mission_id, p_source_type, p_source_key, p_qr_code_id,
    coalesce(p_points, mission_points, 0)
  )
  on conflict (user_id, mission_id, source_key) do nothing;

  get diagnostics inserted = row_count;
  -- Already had this exact completion. Not an error — scanning the same QR twice
  -- and re-adding a session are both normal.
  if inserted = 0 then return false; end if;

  perform public.refresh_quest_master(p_user_id);
  return true;
end;
$$;

/** The same thing by mission code, which is what callers usually hold. */
create or replace function public.award_mission(
  p_user_id uuid,
  p_code text,
  p_source_type text,
  p_source_key text,
  p_qr_code_id integer default null,
  p_points integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id integer;
begin
  select id into target_id from public.missions where code = p_code and is_active;
  if target_id is null then return false; end if;

  return public.award_mission_id(
    p_user_id, target_id, p_source_type, p_source_key, p_qr_code_id, p_points
  );
end;
$$;

-- security definer, so the grants are the whole access control. Deliberately not
-- granted to authenticated: this is the function that hands out XP.
revoke all on function public.refresh_quest_master(uuid) from public, anon, authenticated;
revoke all on function public.award_mission_id(uuid, integer, text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.award_mission(uuid, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.refresh_quest_master(uuid) to service_role;
grant execute on function public.award_mission_id(uuid, integer, text, text, integer, integer)
  to service_role;
grant execute on function public.award_mission(uuid, text, text, text, integer, integer)
  to service_role;


/*
 * "Add a session to your schedule" and "Book Your First Quest".
 *
 * Which one depends on the event's quest type: the sheet says a Bonus Quest (an
 * offsite event) earns Book Your First Quest, while "only sessions in the Main
 * Quests/Side Quests section count towards" Add a session.
 *
 * Matched on the config *name* rather than its id, because public.configs ids are
 * assigned by a shared sequence and differ between environments.
 *
 * Fires on update too, so an invite-only event earns its XP when an admin
 * approves the request ('interested' → 'approved'), not when interest was
 * expressed.
 */
create or replace function public.award_agenda_mission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  quest text;
begin
  -- 'interested' and 'rejected' are not on a schedule, so they earn nothing.
  if new.status not in ('saved', 'approved') then return null; end if;

  select lower(c.name) into quest
    from public.agenda a
    join public.configs c on c.id = a.event_quest_config_id
    where a.id = new.agenda_id;

  -- An event with no quest type set belongs to no section of the Agenda screen.
  if quest is null then return null; end if;

  if quest like 'bonus%' then
    perform public.award_mission(
      new.user_id, 'book_first_quest', 'agenda', 'agenda:' || new.agenda_id
    );
  elsif quest like 'main%' or quest like 'side%' then
    perform public.award_mission(
      new.user_id, 'add_session', 'agenda', 'agenda:' || new.agenda_id
    );
  end if;

  return null;
end;
$$;

drop trigger if exists user_agenda_award_mission on public.user_agenda;
create trigger user_agenda_award_mission
  after insert or update on public.user_agenda
  for each row
  execute function public.award_agenda_mission();


/*
 * "Connect with a New Nerd" — "add 1 to the counter each time you make a
 * connection", once per person.
 *
 * Both sides earn it: public.connections holds one row per pair, and the person
 * who accepted made a connection just as much as the person who asked. The key is
 * the *other* user, so a pair that is rejected and later re-accepted still counts
 * once.
 */
create or replace function public.award_connection_mission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'accepted' then return null; end if;

  -- Nested rather than `tg_op = 'UPDATE' and old.status = ...`: OLD is unassigned
  -- on INSERT, and one SQL expression gives no guarantee that the tg_op test is
  -- evaluated first, so the field access has to be unreachable rather than merely
  -- second.
  if tg_op = 'UPDATE' then
    -- Already accepted before this write: nothing new happened.
    if old.status = 'accepted' then return null; end if;
  end if;

  perform public.award_mission(
    new.requester_id, 'connect_nerd', 'connection', 'connection:' || new.addressee_id
  );
  perform public.award_mission(
    new.addressee_id, 'connect_nerd', 'connection', 'connection:' || new.requester_id
  );

  return null;
end;
$$;

drop trigger if exists connections_award_mission on public.connections;
create trigger connections_award_mission
  after insert or update on public.connections
  for each row
  execute function public.award_connection_mission();


/*
 * Client writes to public.user_missions are revoked.
 *
 * postman/API.md §6 documents the app upserting its own rows and admits
 * "points_awarded is set by the client, so it is only as trustworthy as the app"
 * — i.e. any attendee could POST themselves to the top of the leaderboard. Now
 * that every completion has a server-side path, close it.
 *
 * select stays: the app reads its own progress. The table is written only by
 * public.rollup_user_mission(), which is security definer.
 */
drop policy if exists "users can insert their own mission progress" on public.user_missions;
drop policy if exists "users can update their own mission progress" on public.user_missions;

revoke insert, update, delete on table public.user_missions from anon;
revoke insert, update, delete on table public.user_missions from authenticated;
grant select on table public.user_missions to authenticated;
grant select, insert, update, delete on table public.user_missions to service_role;

comment on table public.user_missions is
  'Roll-up of public.mission_completions, maintained by public.rollup_user_mission(). Read-only to clients — completions are awarded server-side.';
