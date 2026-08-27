// GET admin/stats — the Admin UI's Usage Statistics screen.
//
// The FRD's Admin UI sheet asks for four things, and they arrive together so the
// dashboard is one call:
//
//   overview.signed_in_recently    people logged on in the last 24 hours
//   overview.total_sessions_added  sessions on attendees' schedules
//   overview.total_xp_earned       XP earned across the event
//   events[].scheduled_count       per event, how many people added it
//
// Overall figures come from public.admin_usage_stats(), which is one round trip
// and the only thing that can read auth.users.last_sign_in_at. The event list
// comes from public.agenda_stats, which aggregates in SQL so the list can be
// sorted by popularity across the whole agenda rather than a page at a time.
// See supabase/migrations/20260822000009_admin_usage_stats.sql.
//
// Admins are excluded from every count: event staff scheduling sessions on their
// own account would inflate the attendee numbers.
import { fail, integer, ok } from "../_shared/http.ts";
import { fetchPage, likeTerm, pageMeta, readPage } from "../_shared/pagination.ts";
import { isQuestSection, questSection } from "../_shared/quests.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 90;

const ALL = "all";

// Plain columns. public.agenda_stats is a view, so there is nothing to embed and
// nothing to disambiguate — the config names are resolved from a lookup map, the
// same approach user/agenda.ts uses.
const EVENT_SELECT = `
  id, name, description, day, start_time, end_time,
  location, speaker_name, speaker_title, speaker_company,
  xp_value, is_sponsored, is_invite_only, capacity, sort_order, status,
  event_quest_config_id, event_day_config_id, stage_config_id,
  scheduled_count, saved_count, approved_count,
  interested_count, rejected_count,
  checkin_count, checkin_xp,
  attendance_rate, capacity_used_percent
`;

/**
 * How the event list is ordered.
 *
 * `schedule` is chronological, which is what an organiser walking the day wants.
 * The rest are "what is working": most subscribed, best attended, biggest payout.
 */
const SORTS: Record<string, { column: string; ascending: boolean }[]> = {
  schedule: [
    { column: "day", ascending: true },
    { column: "start_time", ascending: true },
    { column: "sort_order", ascending: true },
  ],
  attendees: [
    { column: "scheduled_count", ascending: false },
    { column: "checkin_count", ascending: false },
  ],
  checkins: [
    { column: "checkin_count", ascending: false },
    { column: "scheduled_count", ascending: false },
  ],
  interest: [{ column: "interested_count", ascending: false }],
  xp: [{ column: "xp_value", ascending: false }],
  name: [{ column: "name", ascending: true }],
};

type Named = { id: number; name: string };

/** GET admin/stats — `?include=` narrows what is computed. */
export async function getStats(url: URL): Promise<Response> {
  const params = url.searchParams;

  const include = params.get("include")?.trim().toLowerCase() || "all";
  if (!["all", "overview", "events"].includes(include)) {
    return fail('"include" must be "all", "overview" or "events".', 400);
  }
  const wantsOverview = include === "all" || include === "overview";
  const wantsEvents = include === "all" || include === "events";

  const hoursRaw = params.get("hours")?.trim() ?? "";
  let hours = DEFAULT_WINDOW_HOURS;
  if (hoursRaw) {
    const parsed = integer(hoursRaw);
    if (parsed === null || parsed < 1 || parsed > MAX_WINDOW_HOURS) {
      return fail(`"hours" must be a whole number between 1 and ${MAX_WINDOW_HOURS}.`, 400);
    }
    hours = parsed;
  }

  const data: Record<string, unknown> = {};

  if (wantsOverview) {
    const overview = await loadOverview(hours);
    if ("error" in overview) return overview.error;
    data.overview = overview.value;
  }

  if (wantsEvents) {
    const events = await loadEvents(url);
    if ("error" in events) return events.error;
    Object.assign(data, events.value);
  }

  return ok("Usage statistics loaded.", data);
}

async function loadOverview(
  hours: number,
): Promise<{ value: Record<string, unknown> } | { error: Response }> {
  const { data, error } = await serviceClient().rpc("admin_usage_stats", {
    p_hours: hours,
  });

  if (error) {
    logDbFailure("admin usage stats", error);
    return { error: fail("Something went wrong. Please try again.", 500) };
  }

  const raw = (data ?? {}) as Record<string, unknown>;

  /*
   * count() and sum() are bigints, so PostgREST hands them back as strings.
   * Numbers are cast here rather than left for the dashboard to remember.
   *
   * signed_in_recently is the exception: null means the auth.users read was not
   * permitted, and it stays null so the UI can say "unavailable" instead of
   * rendering a confident zero.
   */
  const count = (key: string): number => Number(raw[key] ?? 0);

  return {
    value: {
      window_hours: Number(raw.window_hours ?? hours),
      since: raw.since ?? null,

      people: {
        total_attendees: count("total_attendees"),
        // null = could not be read. See the note above.
        signed_in_recently: raw.signed_in_recently == null
          ? null
          : Number(raw.signed_in_recently),
        registered_recently: count("registered_recently"),
        with_a_schedule: count("attendees_with_a_schedule"),
        with_xp: count("attendees_with_xp"),
      },

      schedules: {
        total_sessions_added: count("total_sessions_added"),
        pending_interest: count("pending_interest"),
      },

      xp: {
        total_earned: count("total_xp_earned"),
        top_score: count("top_xp"),
        // Averaged over attendees who have scored, not over everyone — dividing
        // by the whole roll would report the size of the guest list, not how the
        // players are doing.
        average_per_scoring_attendee: Number(raw.average_xp_per_scoring_attendee ?? 0),
      },

      engagement: {
        missions_completed: count("missions_completed"),
        mission_completions_logged: count("mission_completions_logged"),
        connections_made: count("connections_made"),
        qr_scans: count("qr_scans"),
        session_checkins: count("session_checkins"),
      },

      content: {
        total_events: count("total_events"),
        events_with_attendees: count("events_with_attendees"),
        active_qr_codes: count("active_qr_codes"),
      },
    },
  };
}

async function loadEvents(
  url: URL,
): Promise<{ value: Record<string, unknown> } | { error: Response }> {
  const params = url.searchParams;

  const page = readPage(params);
  if ("error" in page) return { error: fail(page.error, 400) };

  const sortKey = params.get("sort")?.trim().toLowerCase() || "schedule";
  const sort = SORTS[sortKey];
  if (!sort) {
    return {
      error: fail(
        `"sort" must be one of ${Object.keys(SORTS).join(", ")}.`,
        400,
      ),
    };
  }

  const search = params.get("search")?.trim() || null;

  // A date or a configs.id of type event-day, the same as GET user/agenda.
  const dayRaw = params.get("day")?.trim() ?? "";
  let date: string | null = null;
  let dayConfigId: number | null = null;
  if (dayRaw && dayRaw.toLowerCase() !== ALL) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dayRaw)) {
      date = dayRaw;
    } else {
      const parsed = integer(dayRaw);
      if (parsed === null) {
        return {
          error: fail(
            'day must be a date (YYYY-MM-DD), a configs.id of type event-day, or "all".',
            400,
          ),
        };
      }
      dayConfigId = parsed;
    }
  }

  const service = serviceClient();

  /*
   * The whole configs table — a dozen-odd rows — so quest / day / stage names can
   * be attached without an embed, and so a `?quest=main` filter can be resolved to
   * the ids whose name starts that way. Fetched before the page because the quest
   * filter has to go into the query.
   */
  const { data: configRows, error: configError } = await service
    .from("configs")
    .select("id, name, type");
  if (configError) {
    logDbFailure("admin stats configs", configError);
    return { error: fail("Something went wrong. Please try again.", 500) };
  }

  const configs = new Map<number, Named>();
  for (const row of configRows ?? []) {
    configs.set(row.id as number, { id: row.id as number, name: row.name as string });
  }

  let questIds: number[] | null = null;
  const questRaw = params.get("quest")?.trim().toLowerCase() ?? "";
  if (questRaw && questRaw !== ALL) {
    if (isQuestSection(questRaw)) {
      const matched: number[] = (configRows ?? [])
        .filter((row: { type: unknown; name: unknown }) =>
          row.type === "event-quest" && questSection(row.name) === questRaw
        )
        .map((row: { id: number }) => row.id);
      // No config row for that section, so no event can be in it.
      if (matched.length === 0) {
        return {
          value: { events: [], sort: sortKey, search, pagination: pageMeta(0, page) },
        };
      }
      questIds = matched;
    } else {
      const parsed = integer(questRaw);
      if (parsed === null) {
        return {
          error: fail(
            '"quest" must be "main", "side", "bonus", a configs.id of type event-quest, or "all".',
            400,
          ),
        };
      }
      questIds = [parsed];
    }
  }

  const build = (headOnly: boolean) => {
    let query = service
      .from("agenda_stats")
      .select(EVENT_SELECT, { count: "exact", head: headOnly });

    for (const key of sort) {
      query = query.order(key.column, {
        ascending: key.ascending,
        // Events with no date or no count sort last either way, rather than
        // heading the list on a descending sort.
        nullsFirst: false,
      });
    }
    // A total order, so paging cannot repeat or skip a row when several events
    // share the sort value.
    query = query.order("id");

    if (date) query = query.eq("day", date);
    if (dayConfigId !== null) query = query.eq("event_day_config_id", dayConfigId);
    if (questIds) query = query.in("event_quest_config_id", questIds);
    if (search) {
      const term = likeTerm(search);
      query = query.or(
        `name.ilike.${term},speaker_name.ilike.${term},speaker_company.ilike.${term},location.ilike.${term}`,
      );
    }
    return query;
  };

  const result = await fetchPage(build, page);
  if ("error" in result) {
    logDbFailure("admin stats events", result.error);
    return { error: fail("Something went wrong. Please try again.", 500) };
  }

  const pick = (id: unknown): Named | null =>
    typeof id === "number" ? configs.get(id) ?? null : null;

  const events = result.rows.map((row) => {
    const quest = pick(row.event_quest_config_id);
    return {
      ...row,
      // Named as the user-facing agenda names them, so an admin screen can reuse
      // the same row component.
      quest,
      quest_section: questSection(quest?.name),
      event_day: pick(row.event_day_config_id),
      stage: pick(row.stage_config_id),
      // The FRD's "total attendees" for the event, under a plainer name than the
      // view's column.
      total_attendees: Number(row.scheduled_count ?? 0),
      scheduled_count: Number(row.scheduled_count ?? 0),
      saved_count: Number(row.saved_count ?? 0),
      approved_count: Number(row.approved_count ?? 0),
      interested_count: Number(row.interested_count ?? 0),
      rejected_count: Number(row.rejected_count ?? 0),
      checkin_count: Number(row.checkin_count ?? 0),
      checkin_xp: Number(row.checkin_xp ?? 0),
      // null when nobody scheduled it — "nothing to measure", not "0% turned up".
      attendance_rate: row.attendance_rate == null
        ? null
        : Number(row.attendance_rate),
      capacity_used_percent: row.capacity_used_percent == null
        ? null
        : Number(row.capacity_used_percent),
    };
  });

  return {
    value: {
      events,
      sort: sortKey,
      search,
      pagination: pageMeta(result.total, page),
    },
  };
}
