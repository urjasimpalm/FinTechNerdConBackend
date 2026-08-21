/*
 * QR codes.
 *
 * From the FRD's QR Codes sheet: "scan these with normal camera app, this loads a
 * URL of the form example.com/access_code, and the user will get the
 * mission/session XP accordingly", and "QR codes will be physically placed
 * throughout the convention".
 *
 * So a code is a row created *before* the event, by an organizer, and printed:
 *
 *   1. Insert a row (Studio, seed SQL, or public.mint_qr_codes() for a batch).
 *      `code` mints itself, so nothing has to invent one.
 *   2. Print https://<app>/q/<code> as a QR image and stick it on the wall or the
 *      booth, or on a lanyard for Nerd Flex.
 *   3. An attendee scans it with the camera app, the PWA reads the slug off the
 *      URL and calls POST user/qr/scan { code }.
 *   4. public.claim_qr_code() below does the rest, in one transaction.
 *
 * There is no admin endpoint for minting them — that is admin-side and out of
 * scope; the SQL helper is what the organizers use.
 */
create table if not exists public.qr_codes (
  id integer generated always as identity primary key,
  /*
   * The slug in the printed URL, and the only secret involved: knowing it is what
   * proves you stood in front of the poster. 16 hex characters — 64 bits, long
   * enough that it cannot be guessed, short enough to survive being printed small.
   *
   * Derived from gen_random_uuid() rather than encode(gen_random_bytes(8), 'hex')
   * on purpose. gen_random_bytes() comes from pgcrypto, which hosted Supabase
   * projects install into the `extensions` schema — not on the search_path a
   * migration runs with — so the unqualified call fails with 42883 "function
   * gen_random_bytes(integer) does not exist". gen_random_uuid() is a *built-in*
   * (pg_catalog) as of PostgreSQL 13, so it resolves the same way in every
   * environment, which is why every other table here already defaults to it.
   *
   * A v4 UUID carries 122 random bits; taking the first 16 hex characters keeps 64
   * of them, and the unique constraint catches a collision rather than trusting it
   * cannot happen.
   */
  code text not null unique
    default substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  -- Which of the sheet's QR uses this is. Reporting and the response copy; the
  -- award itself is decided by mission_id / agenda_id.
  kind text not null
    check (kind in ('activation', 'zone', 'session', 'nerd_flex', 'mission')),
  -- What is printed underneath, e.g. 'Activation — Stripe booth', 'Zone 3'.
  label text not null,
  -- What scanning it earns. A code may award a mission, check the scanner in to a
  -- session, or both; the constraint below is what stops a code that does nothing.
  mission_id integer references public.missions (id) on delete set null,
  agenda_id uuid references public.agenda (id) on delete cascade,
  -- Overrides the mission's points / the event's xp_value for this code only.
  points_override integer,
  -- Turn a code off without deleting it, so its scans stay in the ledger.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint qr_codes_has_target
    check (mission_id is not null or agenda_id is not null)
);

create index if not exists qr_codes_kind_idx on public.qr_codes (kind);
create index if not exists qr_codes_agenda_idx on public.qr_codes (agenda_id);

alter table public.qr_codes enable row level security;

/*
 * No policy for authenticated, on purpose.
 *
 * The code is the whole proof of attendance. A signed-in client that could
 * `select * from qr_codes` would read every slug and claim all 20-odd missions
 * from the hotel bar, which is exactly what the physical placement is meant to
 * prevent. Only the service role sees this table, and only through
 * public.claim_qr_code(), which takes a code and never hands one out.
 */
revoke all on table public.qr_codes from anon;
revoke all on table public.qr_codes from authenticated;
grant select, insert, update, delete on table public.qr_codes to service_role;

comment on table public.qr_codes is
  'Physical QR codes, minted before the event. `code` is the slug in the printed URL and is a secret — this table is deliberately unreadable by attendees.';


/*
 * Every scan that landed, one row per person per code.
 *
 * The unique constraint is the FRD's "each unique QR code scanned increases the
 * counter by 1": a second scan of the same poster by the same person is a no-op.
 * Kept apart from public.mission_completions because a session-only code awards
 * no mission and would otherwise leave no trace.
 */
create table if not exists public.qr_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  qr_code_id integer not null references public.qr_codes (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, qr_code_id)
);

create index if not exists qr_scans_user_idx on public.qr_scans (user_id, created_at desc);

alter table public.qr_scans enable row level security;

-- A user may see what they have scanned. They may not write it: that is the
-- award, and it goes through public.claim_qr_code().
drop policy if exists "users can view their own scans" on public.qr_scans;
create policy "users can view their own scans"
  on public.qr_scans for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on table public.qr_scans from anon;
revoke all on table public.qr_scans from authenticated;
grant select on table public.qr_scans to authenticated;
grant select, insert, update, delete on table public.qr_scans to service_role;


/*
 * Session attendance, and the second half of the leaderboard total.
 *
 * Distinct from public.user_agenda: that is "I plan to go", this is "I was
 * there", and only this one carries the event's XP. One row per person per
 * session, so scanning the stage code twice does not pay twice.
 */
create table if not exists public.agenda_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  agenda_id uuid not null references public.agenda (id) on delete cascade,
  qr_code_id integer references public.qr_codes (id) on delete set null,
  -- Copied from agenda.xp_value at check-in, so re-pricing an event later does
  -- not restate everyone's total.
  points_awarded integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, agenda_id)
);

create index if not exists agenda_checkins_user_idx on public.agenda_checkins (user_id);
create index if not exists agenda_checkins_agenda_idx on public.agenda_checkins (agenda_id);

alter table public.agenda_checkins enable row level security;

drop policy if exists "users can view their own check-ins" on public.agenda_checkins;
create policy "users can view their own check-ins"
  on public.agenda_checkins for select
  to authenticated
  using (auth.uid() = user_id);

-- No client writes: this feeds the leaderboard.
revoke all on table public.agenda_checkins from anon;
revoke all on table public.agenda_checkins from authenticated;
grant select on table public.agenda_checkins to authenticated;
grant select, insert, update, delete on table public.agenda_checkins to service_role;

comment on table public.agenda_checkins is
  'Attended a session (scanned its QR code), and the XP that earned. Separate from public.user_agenda, which is only a bookmark.';


-- The ledger's reference, now that the table it points at exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.mission_completions'::regclass
      and conname = 'mission_completions_qr_code_id_fkey'
  ) then
    alter table public.mission_completions
      add constraint mission_completions_qr_code_id_fkey
      foreign key (qr_code_id) references public.qr_codes (id) on delete set null;
  end if;
end;
$$;


/*
 * Claiming a code: the whole of POST user/qr/scan.
 *
 * One function rather than four calls from the edge function, because the scan
 * log, the mission award and the session check-in have to succeed or fail
 * together — over PostgREST they would be separate transactions, and a failure
 * between them would leave a scan recorded that paid nothing, un-retryable
 * because the scan log would then say "already scanned".
 *
 * Returns everything the app needs to draw the "you earned…" sheet. Scanning the
 * same code twice is not an error: it answers already_scanned with the current
 * totals, so the screen still shows something true.
 */
create or replace function public.claim_qr_code(
  p_user_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  qr public.qr_codes;
  first_scan boolean := false;
  affected integer := 0;
  mission_counted boolean := false;
  mission_title text;
  mission_code text;
  mission_repeatable boolean;
  times integer := 0;
  session_name text;
  session_xp integer;
  session_counted boolean := false;
  session_points integer := 0;
  total integer := 0;
begin
  if p_user_id is null then
    return jsonb_build_object('found', false, 'reason', 'no_user');
  end if;

  select * into qr
    from public.qr_codes
    where code = lower(btrim(coalesce(p_code, '')));

  if not found then
    return jsonb_build_object('found', false, 'reason', 'unknown');
  end if;

  if not qr.is_active then
    return jsonb_build_object(
      'found', true, 'reason', 'inactive', 'label', qr.label, 'kind', qr.kind
    );
  end if;

  insert into public.qr_scans (user_id, qr_code_id)
  values (p_user_id, qr.id)
  on conflict (user_id, qr_code_id) do nothing;
  get diagnostics affected = row_count;
  first_scan := affected > 0;

  -- The mission half. award_mission_id re-checks repeatability and the ledger, so
  -- this stays correct even on a re-scan that slipped past first_scan.
  if qr.mission_id is not null then
    select title, code, is_repeatable
      into mission_title, mission_code, mission_repeatable
      from public.missions
      where id = qr.mission_id;

    mission_counted := public.award_mission_id(
      p_user_id, qr.mission_id, 'qr', 'qr:' || qr.id, qr.id, qr.points_override
    );

    select coalesce(um.times_completed, 0) into times
      from public.user_missions um
      where um.user_id = p_user_id and um.mission_id = qr.mission_id;
    times := coalesce(times, 0);
  end if;

  -- The session half: attending is worth the event's own XP Value.
  if qr.agenda_id is not null then
    select a.name, a.xp_value into session_name, session_xp
      from public.agenda a
      where a.id = qr.agenda_id;

    if session_name is not null then
      session_points := coalesce(qr.points_override, session_xp, 0);

      insert into public.agenda_checkins (user_id, agenda_id, qr_code_id, points_awarded)
      values (p_user_id, qr.agenda_id, qr.id, session_points)
      on conflict (user_id, agenda_id) do nothing;
      get diagnostics affected = row_count;
      session_counted := affected > 0;

      if not session_counted then session_points := 0; end if;
    end if;
  end if;

  select coalesce(l.total_points, 0)::integer into total
    from public.leaderboard l
    where l.user_id = p_user_id;
  total := coalesce(total, 0);

  return jsonb_build_object(
    'found', true,
    'code_kind', qr.kind,
    'label', qr.label,
    -- false when this person had already scanned this exact code.
    'first_scan', first_scan,
    'mission', case when qr.mission_id is null then null else jsonb_build_object(
      'id', qr.mission_id,
      'code', mission_code,
      'title', mission_title,
      'is_repeatable', mission_repeatable,
      'counted', mission_counted,
      'times_completed', times
    ) end,
    'session', case when qr.agenda_id is null or session_name is null then null
      else jsonb_build_object(
        'id', qr.agenda_id,
        'name', session_name,
        'checked_in', session_counted,
        'xp', session_points
      ) end,
    'xp_awarded', (
      case when mission_counted
        then coalesce(qr.points_override, (select points from public.missions where id = qr.mission_id), 0)
        else 0 end
      + session_points
    ),
    'total_xp', total
  );
end;
$$;


/*
 * Minting a batch, for the organizers.
 *
 * The sheet expects "around 10-12" activation codes and "7-8" zone codes, so:
 *
 *   select * from public.mint_qr_codes('activation', 'Activation', 12, 'visit_activation');
 *   select * from public.mint_qr_codes('zone', 'Zone', 8, 'explore_zone');
 *   select * from public.mint_qr_codes('nerd_flex', 'Nerd Flex lanyard', 1, 'nerd_flex');
 *
 * It returns the minted slugs, which is the list to hand to whoever prints them.
 * Labels are suffixed with a number ('Zone 1' … 'Zone 8') and are worth editing
 * afterwards so the response copy names the real booth.
 */
create or replace function public.mint_qr_codes(
  p_kind text,
  p_label_prefix text,
  p_count integer,
  p_mission_code text default null,
  p_agenda_id uuid default null
)
returns table (qr_id integer, qr_code text, qr_kind text, qr_label text)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_mission integer;
begin
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'p_count must be between 1 and 200.' using errcode = 'P0001';
  end if;

  if p_mission_code is not null then
    select id into target_mission from public.missions where code = p_mission_code;
    if target_mission is null then
      raise exception 'No mission with code %.', p_mission_code using errcode = 'P0001';
    end if;
  end if;

  if target_mission is null and p_agenda_id is null then
    raise exception 'Give a mission code, an agenda id, or both — a code that awards nothing is not useful.'
      using errcode = 'P0001';
  end if;

  return query
  with minted as (
    insert into public.qr_codes (kind, label, mission_id, agenda_id)
    select p_kind, p_label_prefix || ' ' || n, target_mission, p_agenda_id
    from generate_series(1, p_count) as n
    returning id, code, kind, label
  )
  select minted.id, minted.code, minted.kind, minted.label from minted;
end;
$$;

-- security definer, so the grants are the access control. claim_qr_code is
-- reached by the user edge function on the service role; mint_qr_codes is for an
-- organizer with database access.
revoke all on function public.claim_qr_code(uuid, text) from public, anon, authenticated;
revoke all on function public.mint_qr_codes(text, text, integer, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_qr_code(uuid, text) to service_role;
grant execute on function public.mint_qr_codes(text, text, integer, text, uuid) to service_role;
