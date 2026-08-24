/*
 * Taking an event off your schedule takes its XP back.
 *
 * This reverses the rule 20260822000002_missions_frd.sql shipped with, which kept
 * the completion after a removal so that re-adding could not pay twice — the FRD's
 * "each session can only count once, removing and re-adding the same session will
 * not count".
 *
 * The new rule is not an exploit, which is worth spelling out because it looks
 * like one. Farming needs a net gain per cycle, and there isn't one: every add is
 * +1 and every remove is -1, so add/remove/add/remove lands on exactly the same
 * total as adding once. What changes is only *what the number means* — XP now
 * tracks the schedule as it currently stands, rather than everything you ever
 * touched. Nobody can outrank anyone by churning.
 *
 * Session check-ins (public.agenda_checkins) are deliberately NOT revoked here.
 * Un-scheduling an event you already attended does not un-attend it, and the QR
 * scan is the evidence.
 */

/*
 * Quest Master becomes award-or-revoke rather than award-only.
 *
 * It has to move both ways now: "complete every other mission at least once" can
 * stop being true when a completion is taken away, and leaving the badge awarded
 * would be the one place where XP does not follow the schedule.
 *
 * Replacing the body rather than adding a second function, so the single call site
 * in public.award_mission_id() keeps working and there is one definition of what
 * Quest Master means. The name still fits: it refreshes the badge either way.
 *
 * Note the delete direction can never fire spuriously from the award path —
 * awarding a mission can only ever *reduce* the outstanding count.
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
  earned boolean;
begin
  select id, points into quest_master_id, quest_master_points
    from public.missions
    where code = 'quest_master' and is_active
    limit 1;
  if quest_master_id is null then return; end if;

  select count(*) into outstanding
    from public.missions m
    where m.is_active
      and m.id <> quest_master_id
      and not exists (
        select 1 from public.mission_completions mc
        where mc.user_id = p_user_id and mc.mission_id = m.id
      );

  select exists (
    select 1 from public.mission_completions
    where user_id = p_user_id and mission_id = quest_master_id
  ) into earned;

  if outstanding = 0 and not earned then
    insert into public.mission_completions (
      user_id, mission_id, source_type, source_key, points_awarded
    )
    values (
      p_user_id, quest_master_id, 'derived', 'derived:all', quest_master_points
    )
    on conflict (user_id, mission_id, source_key) do nothing;

  elsif outstanding > 0 and earned then
    -- A prerequisite was taken away, so the badge goes with it. The roll-up
    -- trigger on public.mission_completions drops the user_missions row, which is
    -- what removes the points from public.leaderboard.
    delete from public.mission_completions
    where user_id = p_user_id and mission_id = quest_master_id;
  end if;
end;
$$;

comment on function public.refresh_quest_master(uuid) is
  'Awards Quest Master when every other active mission is complete, and revokes it when that stops being true. Called after any award or revocation.';


/*
 * The revocation itself.
 *
 * Fires when a row leaves the schedule, by either route:
 *
 *   DELETE  — the app's "unsave" / "withdraw"
 *   UPDATE  — status moving out of ('saved', 'approved'), e.g. an admin rejecting
 *             an invite-only request the attendee had already been approved for
 *
 * Keyed on the same source_key the award used ('agenda:<uuid>'), so it removes
 * exactly the completion that adding this event created and nothing else — a
 * different session's completion for the same mission is a different row and is
 * left alone. That is what keeps the "Times Completed" counter honest: it lands on
 * the number of sessions currently scheduled.
 */
create or replace function public.revoke_agenda_mission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user uuid;
  target_agenda uuid;
begin
  if tg_op = 'DELETE' then
    target_user := old.user_id;
    target_agenda := old.agenda_id;
  else
    -- Still on the schedule: nothing to take back.
    if new.status in ('saved', 'approved') then return null; end if;
    -- Was not on it to begin with (e.g. 'interested' → 'rejected'), so no XP was
    -- ever awarded for it and there is nothing to remove.
    if old.status not in ('saved', 'approved') then return null; end if;

    target_user := new.user_id;
    target_agenda := new.agenda_id;
  end if;

  /*
   * Belt and braces. public.user_agenda is unique on (user_id, agenda_id), so a
   * second row scheduling the same event cannot exist today and this always finds
   * nothing — but if that constraint is ever relaxed, revoking while another row
   * still holds the event would silently under-count.
   */
  if exists (
    select 1 from public.user_agenda
    where user_id = target_user
      and agenda_id = target_agenda
      and status in ('saved', 'approved')
  ) then
    return null;
  end if;

  delete from public.mission_completions
  where user_id = target_user
    and source_type = 'agenda'
    and source_key = 'agenda:' || target_agenda;

  -- Only worth re-checking if something was actually removed, but the function is
  -- cheap and idempotent, and calling it unconditionally means a future revocation
  -- path cannot forget to.
  perform public.refresh_quest_master(target_user);
  return null;
end;
$$;

/*
 * Named to sort after user_agenda_award_mission, which matters: PostgreSQL fires
 * same-event triggers in alphabetical order, and on an UPDATE both of them run.
 * 'award' before 'revoke' means a status change *onto* the schedule awards and
 * then the revoke trigger returns early, rather than the reverse order deleting
 * what was just awarded.
 */
drop trigger if exists user_agenda_revoke_mission on public.user_agenda;
create trigger user_agenda_revoke_mission
  after delete or update on public.user_agenda
  for each row
  execute function public.revoke_agenda_mission();

comment on function public.revoke_agenda_mission() is
  'Removes the mission completion that scheduling an event earned, when that event leaves the schedule. Session check-ins are not revoked — attendance already happened.';
