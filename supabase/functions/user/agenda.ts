// The Agenda screen and My Schedule:
//
//   GET  user/agenda            → events, filtered and paged
//   GET  user/agenda/days       → the day tabs, and which one to open on
//   GET  user/agenda/schedule   → My Schedule
//   GET  user/agenda/{id}       → one event
//   POST user/agenda/schedule   → save | unsave | interest | withdraw
//
// Every event carries the caller's own state (`my_status`, `is_saved`,
// `is_checked_in`) so a list screen can draw the + / checkmark button without a
// second call, and `is_past` so events that have already happened can be greyed
// out.
//
// Saving a Main or Side Quest earns the "Add a session" mission and saving a
// Bonus Quest earns "Book Your First Quest" — awarded by a trigger on
// public.user_agenda, not here, so it holds however the row was written. See
// supabase/migrations/20260822000002_missions_frd.sql.
import { fail, integer, ok, text } from "../_shared/http.ts";
import { fetchPage, likeTerm, pageMeta, readPage } from "../_shared/pagination.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

/** `all` means "no filter" rather than being an error, as in user/people.ts. */
const ALL = "all";

// On my schedule. 'interested' is a request that has not been answered and
// 'rejected' was answered no, so neither is on it.
const ON_SCHEDULE = ["saved", "approved"];

// public.agenda has three separate foreign keys to public.configs, so an embedded
// `configs(...)` is ambiguous and each one has to name its constraint.
const AGENDA_SELECT = `
  id, name, description, day, start_time, end_time,
  speaker_name, speaker_title, speaker_company,
  location, xp_value, is_sponsored, is_invite_only, capacity,
  sort_order, status,
  event_quest_config_id, event_day_config_id, stage_config_id,
  quest:configs!agenda_event_quest_config_id_fkey (id, name),
  event_day:configs!agenda_event_day_config_id_fkey (id, name),
  stage:configs!agenda_stage_config_id_fkey (id, name),
  agenda_guilds (is_primary, guild:guilds (id, name)),
  agenda_user_types (user_type:configs (id, name))
`;

/**
 * Which section of the Agenda screen an event belongs to.
 *
 * Derived from the public.configs name rather than its id, because ids come from
 * a shared sequence and differ between environments — the same reason
 * public.award_agenda_mission() matches on the name.
 */
function questSection(name: unknown): "main" | "side" | "bonus" | null {
  const value = typeof name === "string" ? name.toLowerCase() : "";
  if (value.startsWith("main")) return "main";
  if (value.startsWith("side")) return "side";
  if (value.startsWith("bonus")) return "bonus";
  return null;
}

const QUEST_FILTERS = new Set(["main", "side", "bonus"]);

type Lookup = { id: number; name: string } | null;

type TagJoin = { is_primary: boolean; guild: Lookup };
type UserTypeJoin = { user_type: Lookup };

/** What the caller has done about an event. */
type MyState = { status: string | null; checked_in: boolean };

const NO_STATE: MyState = { status: null, checked_in: false };

/**
 * Flattens the two join arrays, splits the tags into primary and secondary, and
 * attaches the caller's own state.
 *
 * `is_past` is computed here rather than filtered in the query, because the FRD
 * wants past events *shown* and greyed out ("users can look back at past days"),
 * not hidden.
 */
function shapeEvent(
  row: Record<string, unknown>,
  state: MyState,
  now: number,
): Record<string, unknown> {
  const {
    agenda_guilds: tagJoins,
    agenda_user_types: typeJoins,
    quest,
    ...rest
  } = row as Record<string, unknown> & {
    agenda_guilds?: TagJoin[];
    agenda_user_types?: UserTypeJoin[];
    quest?: Lookup;
  };

  const tags = (tagJoins ?? [])
    .filter((join) => join.guild !== null)
    .map((join) => ({
      id: join.guild!.id,
      name: join.guild!.name,
      is_primary: join.is_primary === true,
    }))
    // Primary first, so a client that only has room for one shows the right one.
    .sort((a, b) =>
      a.is_primary === b.is_primary ? a.id - b.id : a.is_primary ? -1 : 1
    );

  const userTypes = (typeJoins ?? [])
    .map((join) => join.user_type)
    .filter((type): type is NonNullable<Lookup> => type !== null)
    .sort((a, b) => a.id - b.id);

  const endsAt = rest.end_time ?? rest.start_time;
  const day = typeof rest.day === "string" ? rest.day : null;
  const isPast = typeof endsAt === "string"
    ? Date.parse(endsAt) < now
    // No times on the event: fall back to the day being over.
    : day !== null
    ? Date.parse(`${day}T23:59:59Z`) < now
    : false;

  return {
    ...rest,
    quest,
    quest_section: questSection(quest?.name),
    tags,
    primary_tag: tags.find((tag) => tag.is_primary) ?? null,
    secondary_tags: tags.filter((tag) => !tag.is_primary),
    user_types: userTypes,
    is_past: isPast,
    my_status: state.status,
    is_saved: state.status !== null && ON_SCHEDULE.includes(state.status),
    is_checked_in: state.checked_in,
  };
}

/**
 * The caller's rows for a page of events, in two queries rather than one per
 * card.
 */
async function myStates(
  userId: string,
  agendaIds: string[],
): Promise<Map<string, MyState>> {
  const states = new Map<string, MyState>();
  if (agendaIds.length === 0) return states;

  const service = serviceClient();
  const [saved, checkins] = await Promise.all([
    service.from("user_agenda").select("agenda_id, status").eq("user_id", userId)
      .in("agenda_id", agendaIds),
    service.from("agenda_checkins").select("agenda_id").eq("user_id", userId)
      .in("agenda_id", agendaIds),
  ]);
  if (saved.error) throw saved.error;
  if (checkins.error) throw checkins.error;

  for (const row of saved.data ?? []) {
    states.set(row.agenda_id as string, {
      status: row.status as string,
      checked_in: false,
    });
  }
  for (const row of checkins.data ?? []) {
    const id = row.agenda_id as string;
    states.set(id, { status: states.get(id)?.status ?? null, checked_in: true });
  }
  return states;
}

/** Event ids carrying a given tag, or tagged for a given audience. */
async function idsFromJoin(
  table: "agenda_guilds" | "agenda_user_types",
  column: string,
  value: number,
): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from(table)
    .select("agenda_id")
    .eq(column, value);
  if (error) throw error;
  return (data ?? []).map((row) => row.agenda_id as string);
}

/** Reads an optional numeric filter that also accepts `all`. */
function optionalId(
  params: URLSearchParams,
  key: string,
  message: string,
): { value: number | null } | { error: string } {
  const raw = params.get(key)?.trim() ?? "";
  if (!raw || raw.toLowerCase() === ALL) return { value: null };
  const parsed = integer(raw);
  if (parsed === null) return { error: message };
  return { value: parsed };
}

type ListFilters = {
  /** A configs.id of type event-day, or an ISO date. */
  dayConfigId: number | null;
  date: string | null;
  quest: string | null;
  questConfigId: number | null;
  guildId: number | null;
  userTypeId: number | null;
  search: string | null;
  /** Restrict to my schedule (or, for the schedule route, to my rows). */
  onlyStatuses: string[] | null;
  sponsoredOnly: boolean;
};

function readFilters(
  params: URLSearchParams,
): ListFilters | { error: string } {
  const dayRaw = params.get("day")?.trim() ?? "";
  let dayConfigId: number | null = null;
  let date: string | null = null;
  if (dayRaw && dayRaw.toLowerCase() !== ALL) {
    // A date or a day config id — the app has whichever the previous screen gave
    // it, and both mean "this day".
    if (/^\d{4}-\d{2}-\d{2}$/.test(dayRaw)) {
      date = dayRaw;
    } else {
      const parsed = integer(dayRaw);
      if (parsed === null) {
        return {
          error:
            'day must be a date (YYYY-MM-DD), a configs.id of type event-day, or "all".',
        };
      }
      dayConfigId = parsed;
    }
  }

  const questRaw = params.get("quest")?.trim().toLowerCase() ?? "";
  let quest: string | null = null;
  let questConfigId: number | null = null;
  if (questRaw && questRaw !== ALL) {
    if (QUEST_FILTERS.has(questRaw)) {
      quest = questRaw;
    } else {
      const parsed = integer(questRaw);
      if (parsed === null) {
        return {
          error:
            'quest must be "main", "side", "bonus", a configs.id of type event-quest, or "all".',
        };
      }
      questConfigId = parsed;
    }
  }

  const guild = optionalId(params, "guild_id", "guild_id must be a guilds.id.");
  if ("error" in guild) return guild;

  const userType = optionalId(
    params,
    "user_type",
    "user_type must be a configs.id where type = 'user_type'.",
  );
  if ("error" in userType) return userType;

  const savedRaw = params.get("saved")?.trim().toLowerCase() ?? "";
  const sponsoredRaw = params.get("sponsored")?.trim().toLowerCase() ?? "";

  return {
    dayConfigId,
    date,
    quest,
    questConfigId,
    guildId: guild.value,
    userTypeId: userType.value,
    search: params.get("search")?.trim() || null,
    onlyStatuses: savedRaw === "true" || savedRaw === "1" ? ON_SCHEDULE : null,
    sponsoredOnly: sponsoredRaw === "true" || sponsoredRaw === "1",
  };
}

/**
 * One page of events. Shared by GET user/agenda and GET user/agenda/schedule,
 * which differ only in whether the caller's own rows are a filter.
 */
async function listEvents(
  url: URL,
  viewerId: string,
  filters: ListFilters,
  message: (total: number) => string,
): Promise<Response> {
  const page = readPage(url.searchParams);
  if ("error" in page) return fail(page.error, 400);

  const service = serviceClient();

  /*
   * The tag, audience and "my schedule" filters all live in other tables, so each
   * is resolved to a set of event ids first and intersected. Filtering an
   * embedded table inside the main query would also trim the `tags` array on
   * every card down to the one tag being filtered on, which is not what the
   * screen wants.
   */
  const idSets: string[][] = [];

  if (filters.guildId !== null) {
    idSets.push(await idsFromJoin("agenda_guilds", "guild_id", filters.guildId));
  }
  if (filters.userTypeId !== null) {
    idSets.push(
      await idsFromJoin("agenda_user_types", "user_type_config_id", filters.userTypeId),
    );
  }
  if (filters.onlyStatuses) {
    const { data, error } = await service
      .from("user_agenda")
      .select("agenda_id")
      .eq("user_id", viewerId)
      .in("status", filters.onlyStatuses);
    if (error) throw error;
    idSets.push((data ?? []).map((row) => row.agenda_id as string));
  }

  // Quest sections are named in public.configs, so "main" is resolved to the ids
  // whose name starts that way.
  let questIds: number[] | null = null;
  if (filters.quest) {
    const { data, error } = await service
      .from("configs")
      .select("id, name")
      .eq("type", "event-quest");
    if (error) throw error;

    const matched: number[] = (data ?? [])
      .filter((row: { name: unknown }) => questSection(row.name) === filters.quest)
      .map((row: { id: number }) => row.id);
    // No config row for that section, so nothing can be in it.
    if (matched.length === 0) {
      return ok(message(0), { events: [], pagination: pageMeta(0, page) });
    }
    questIds = matched;
  }

  let onlyIds: string[] | null = null;
  if (idSets.length > 0) {
    onlyIds = idSets.reduce((left, right) => {
      const keep = new Set(right);
      return left.filter((id) => keep.has(id));
    });
    if (onlyIds.length === 0) {
      return ok(message(0), { events: [], pagination: pageMeta(0, page) });
    }
  }

  const build = (headOnly: boolean) => {
    let query = service
      .from("agenda")
      .select(AGENDA_SELECT, { count: "exact", head: headOnly })
      // Chronological, as the sheet asks. sort_order breaks ties between events
      // starting at the same moment, and carries events that have no time at all.
      .order("day", { nullsFirst: false })
      .order("start_time", { nullsFirst: false })
      .order("sort_order")
      .order("name");

    if (filters.date) query = query.eq("day", filters.date);
    if (filters.dayConfigId !== null) {
      query = query.eq("event_day_config_id", filters.dayConfigId);
    }
    if (questIds) query = query.in("event_quest_config_id", questIds);
    if (filters.questConfigId !== null) {
      query = query.eq("event_quest_config_id", filters.questConfigId);
    }
    if (filters.sponsoredOnly) query = query.eq("is_sponsored", true);
    if (filters.search) {
      // Name, speaker or location — what someone types into an agenda search box.
      const term = likeTerm(filters.search);
      query = query.or(
        `name.ilike.${term},speaker_name.ilike.${term},speaker_company.ilike.${term},location.ilike.${term}`,
      );
    }
    if (onlyIds) query = query.in("id", onlyIds);
    return query;
  };

  const result = await fetchPage(build, page);
  if ("error" in result) {
    logDbFailure("agenda list", result.error);
    return fail("Something went wrong. Please try again.", 500);
  }

  const states = await myStates(viewerId, result.rows.map((row) => row.id as string));
  const now = Date.now();
  const events = result.rows.map((row) =>
    shapeEvent(row, states.get(row.id as string) ?? NO_STATE, now)
  );

  return ok(message(result.total), {
    events,
    search: filters.search,
    pagination: pageMeta(result.total, page),
  });
}

/** GET user/agenda?day=&quest=&guild_id=&user_type=&search=&saved=&sponsored= */
export async function getAgenda(url: URL, viewerId: string): Promise<Response> {
  const filters = readFilters(url.searchParams);
  if ("error" in filters) return fail(filters.error, 400);

  return await listEvents(
    url,
    viewerId,
    filters,
    (total) => (total === 1 ? "1 event." : `${total} events.`),
  );
}

/**
 * GET user/agenda/schedule — My Schedule.
 *
 * Saved plus approved: an invite-only event is on your schedule once an admin has
 * said yes, and `?status=interested` shows what you are still waiting on.
 */
export async function getMySchedule(url: URL, viewerId: string): Promise<Response> {
  const filters = readFilters(url.searchParams);
  if ("error" in filters) return fail(filters.error, 400);

  const requested = url.searchParams.get("status")?.trim().toLowerCase() ?? "";
  const statuses = requested === "" || requested === "scheduled"
    ? ON_SCHEDULE
    : requested === ALL
    ? ["saved", "interested", "approved", "rejected"]
    : ["saved", "interested", "approved", "rejected"].includes(requested)
    ? [requested]
    : null;

  if (!statuses) {
    return fail(
      'status must be "scheduled", "saved", "interested", "approved", "rejected" or "all".',
      400,
    );
  }

  return await listEvents(
    url,
    viewerId,
    { ...filters, onlyStatuses: statuses },
    (total) =>
      total === 1 ? "1 event on your schedule." : `${total} events on your schedule.`,
  );
}

/**
 * GET user/agenda/days — the day tabs.
 *
 * `is_today` is what the sheet's "jump to the current day of the conference when
 * the agenda is loaded" rule needs. The comparison is against a plain date, and
 * the client may pass `?today=YYYY-MM-DD` so it is *their* date rather than the
 * server's — a conference in California would otherwise flip over at 5pm.
 */
export async function getAgendaDays(url: URL, viewerId: string): Promise<Response> {
  const override = url.searchParams.get("today")?.trim() ?? "";
  if (override && !/^\d{4}-\d{2}-\d{2}$/.test(override)) {
    return fail("today must be a date in YYYY-MM-DD form.", 400);
  }
  const today = override || new Date().toISOString().slice(0, 10);

  const service = serviceClient();
  const [events, mine] = await Promise.all([
    service
      .from("agenda")
      .select(
        "id, day, event_day_config_id, event_day:configs!agenda_event_day_config_id_fkey (id, name)",
      )
      .order("day", { nullsFirst: false }),
    service.from("user_agenda").select("agenda_id, status").eq("user_id", viewerId)
      .in("status", ON_SCHEDULE),
  ]);
  if (events.error) throw events.error;
  if (mine.error) throw mine.error;

  const savedIds = new Set((mine.data ?? []).map((row) => row.agenda_id as string));

  // Grouped here rather than in SQL: a conference agenda is a hundred-odd rows,
  // and a view would have to be maintained alongside the table.
  type Day = {
    day: string | null;
    event_day_config_id: number | null;
    name: string | null;
    event_count: number;
    saved_count: number;
    is_today: boolean;
    is_past: boolean;
  };
  const days = new Map<string, Day>();

  for (const row of events.data ?? []) {
    const day = (row.day as string | null) ?? null;
    const config = row.event_day as Lookup;
    // Key on whichever identifies the day, so events with a date but no config
    // row (or the reverse) still group.
    const key = day ?? `config:${config?.id ?? "none"}`;
    const existing = days.get(key) ?? {
      day,
      event_day_config_id: config?.id ?? (row.event_day_config_id as number | null),
      name: config?.name ?? null,
      event_count: 0,
      saved_count: 0,
      is_today: day === today,
      is_past: day !== null && day < today,
    };
    existing.event_count += 1;
    if (savedIds.has(row.id as string)) existing.saved_count += 1;
    days.set(key, existing);
  }

  const list = [...days.values()].sort((a, b) =>
    (a.day ?? "9999-12-31").localeCompare(b.day ?? "9999-12-31")
  );

  /*
   * Which tab to open on. Today if the conference is running, otherwise the next
   * day still to come, otherwise the last one — so the screen is never blank
   * before the event starts or after it ends.
   */
  const current = list.find((entry) => entry.is_today) ??
    list.find((entry) => !entry.is_past) ??
    list[list.length - 1] ?? null;

  return ok(list.length === 1 ? "1 day." : `${list.length} days.`, {
    today,
    days: list,
    current_day: current?.day ?? null,
    current_day_config_id: current?.event_day_config_id ?? null,
  });
}

/** GET user/agenda/{id} */
export async function getEvent(viewerId: string, agendaId: string): Promise<Response> {
  const { data, error } = await serviceClient()
    .from("agenda")
    .select(AGENDA_SELECT)
    .eq("id", agendaId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return fail("That event could not be found.", 404);

  const states = await myStates(viewerId, [agendaId]);
  return ok(
    "Event loaded.",
    shapeEvent(data, states.get(agendaId) ?? NO_STATE, Date.now()),
  );
}

const ACTIONS = ["save", "unsave", "interest", "withdraw"];

/**
 * POST user/agenda/schedule
 *   { "agenda_id": "…", "action": "save" | "unsave" | "interest" | "withdraw" }
 *
 * `action` may also come from the query string, the same as
 * user/guild/membership.
 *
 * Removing an event does not take back the mission XP adding it earned: the FRD
 * is explicit that "removing and re-adding the same session will not count", so
 * the completion stays in the ledger keyed on this event and a re-add is a no-op.
 */
export async function changeSchedule(
  body: Record<string, unknown>,
  viewerId: string,
  queryAction: string | null,
): Promise<Response> {
  const action = (text(body.action) ?? queryAction ?? "").toLowerCase();
  if (!ACTIONS.includes(action)) {
    return fail(`"action" must be one of ${ACTIONS.join(", ")}.`, 400);
  }

  const agendaId = text(body.agenda_id) ?? text(body.id);
  if (!agendaId) return fail('"agenda_id" is required.', 400);

  const service = serviceClient();

  const { data: event, error } = await service
    .from("agenda")
    .select("id, name, day, is_invite_only")
    .eq("id", agendaId)
    .maybeSingle();
  if (error) throw error;
  if (!event) return fail("That event could not be found.", 404);

  const { data: existing, error: existingError } = await service
    .from("user_agenda")
    .select("id, status")
    .eq("user_id", viewerId)
    .eq("agenda_id", agendaId)
    .maybeSingle();
  if (existingError) throw existingError;

  // Leaving and withdrawing are the same operation: the row goes. Kept as two
  // action names because they read differently on the two buttons.
  if (action === "unsave" || action === "withdraw") {
    if (!existing) {
      return fail(`${event.name} is not on your schedule.`, 409);
    }

    const wasInterest = existing.status === "interested";

    const { error: deleteError } = await service
      .from("user_agenda")
      .delete()
      .eq("user_id", viewerId)
      .eq("agenda_id", agendaId);
    if (deleteError) throw deleteError;

    return ok(
      wasInterest
        ? `Your interest in ${event.name} was withdrawn.`
        : `${event.name} was removed from your schedule.`,
      { agenda_id: agendaId, my_status: null, is_saved: false },
    );
  }

  // The two ways on are not interchangeable: an invite-only event has to be
  // requested, and a normal one cannot be.
  if (action === "save" && event.is_invite_only) {
    return fail(
      `${event.name} is invite-only. Use action "interest" to request a place.`,
      409,
    );
  }
  if (action === "interest" && !event.is_invite_only) {
    return fail(
      `${event.name} is open to everyone. Use action "save" to add it to your schedule.`,
      409,
    );
  }

  const wanted = action === "save" ? "saved" : "interested";

  if (existing) {
    // Already settled in the caller's favour: say so rather than writing over it.
    // Overwriting 'approved' with 'saved' would quietly drop an admin's decision.
    if (existing.status === wanted || existing.status === "approved") {
      return ok(
        existing.status === "approved"
          ? `You are already approved for ${event.name}.`
          : action === "save"
          ? `${event.name} is already on your schedule.`
          : `You have already expressed interest in ${event.name}.`,
        {
          agenda_id: agendaId,
          my_status: existing.status,
          is_saved: ON_SCHEDULE.includes(existing.status as string),
        },
      );
    }

    const { error: updateError } = await service
      .from("user_agenda")
      .update({ status: wanted })
      .eq("id", existing.id);
    if (updateError) throw updateError;
  } else {
    const { error: insertError } = await service
      .from("user_agenda")
      .insert({
        user_id: viewerId,
        agenda_id: agendaId,
        // Denormalised on the row since 0011_user_agenda.sql; kept in step here.
        day: event.day,
        status: wanted,
      });
    if (insertError) throw insertError;
  }

  // Re-read the mission counters, so the client can show "Add a session 3/…"
  // moving without a second call. The award is a trigger, so it has already run.
  const { data: earned } = await service
    .from("user_missions")
    .select("mission_id, times_completed, points_awarded, missions (code, title)")
    .eq("user_id", viewerId);

  return ok(
    action === "save"
      ? `${event.name} was added to your schedule.`
      : `Your interest in ${event.name} was registered.`,
    {
      agenda_id: agendaId,
      my_status: wanted,
      is_saved: ON_SCHEDULE.includes(wanted),
      missions: earned ?? [],
    },
  );
}
