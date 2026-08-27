// GET admin/stats — the Admin UI's Usage Statistics screen.
//
// Exactly what was asked for, and nothing else:
//
//   overview.people_logged_in_last_24_hours
//   overview.total_sessions_added
//   overview.total_xp_earned
//   events[]  → name, description, day, date, time, total_attendees (paged)
//
// The overall figures come from public.admin_usage_stats(), which is one round
// trip and the only thing that can read auth.users.last_sign_in_at. The per-event
// attendee count comes from public.agenda_stats, which aggregates in SQL rather
// than being tallied a page at a time. See
// supabase/migrations/20260822000009_admin_usage_stats.sql.
//
// That function and view compute more than is returned here. The extra numbers are
// cheap counts in the same round trip and are simply not read — trimming them
// would mean another migration, and this file is the contract.
//
// Admins are excluded from every count: event staff scheduling sessions on their
// own account would inflate the attendee numbers.
import { fail, ok } from "../_shared/http.ts";
import { fetchPage, type Page, pageMeta, readPage } from "../_shared/pagination.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

// Only the columns the four requested fields need.
const EVENT_SELECT =
  "id, name, description, day, start_time, end_time, event_day_config_id, sort_order, scheduled_count";

/** GET admin/stats?page=&per_page= */
export async function getStats(url: URL): Promise<Response> {
  const page = readPage(url.searchParams);
  if ("error" in page) return fail(page.error, 400);

  const [overview, events] = await Promise.all([
    loadOverview(),
    loadEvents(page),
  ]);

  if ("error" in overview) return overview.error;
  if ("error" in events) return events.error;

  return ok("Usage statistics loaded.", {
    overview: overview.value,
    events: events.value.events,
    pagination: events.value.pagination,
  });
}

async function loadOverview(): Promise<
  { value: Record<string, unknown> } | { error: Response }
> {
  // 24 hours is the window the screen asks for, so it is not a parameter.
  const { data, error } = await serviceClient().rpc("admin_usage_stats", {
    p_hours: 24,
  });

  if (error) {
    logDbFailure("admin usage stats", error);
    return { error: fail("Something went wrong. Please try again.", 500) };
  }

  const raw = (data ?? {}) as Record<string, unknown>;

  return {
    value: {
      /*
       * Signed in within the last 24 hours, from auth.users.last_sign_in_at.
       *
       * null is a real answer and means the auth.users read was not permitted —
       * show "unavailable" rather than 0, which would be a lie. Everything else
       * on this screen still works in that case.
       */
      people_logged_in_last_24_hours: raw.signed_in_recently == null
        ? null
        : Number(raw.signed_in_recently),

      // Sessions on attendees' schedules right now. Not sessions ever added:
      // removing an event takes its XP back, so a historic count would disagree
      // with the XP figure on the same screen.
      total_sessions_added: Number(raw.total_sessions_added ?? 0),

      // The same number the leaderboard shows — mission XP plus session
      // check-in XP, admins excluded.
      total_xp_earned: Number(raw.total_xp_earned ?? 0),
    },
  };
}

async function loadEvents(
  page: Page,
): Promise<
  { value: { events: unknown[]; pagination: unknown } } | { error: Response }
> {
  const service = serviceClient();

  /*
   * The event-day names ("Day 1"), so `day` can be the label and `date` the
   * calendar date. Three-odd rows, fetched as a flat list and joined in memory —
   * public.agenda has several foreign keys to public.configs, so an embed there
   * needs a constraint hint and is not worth the fragility.
   */
  const { data: dayRows, error: dayError } = await service
    .from("configs")
    .select("id, name")
    .eq("type", "event-day");
  if (dayError) {
    logDbFailure("admin stats event days", dayError);
    return { error: fail("Something went wrong. Please try again.", 500) };
  }

  const dayNames = new Map<number, string>();
  for (const row of dayRows ?? []) {
    dayNames.set(row.id as number, row.name as string);
  }

  const build = (headOnly: boolean) =>
    service
      .from("agenda_stats")
      .select(EVENT_SELECT, { count: "exact", head: headOnly })
      // Chronological. Events with no date sort last rather than heading the list.
      .order("day", { nullsFirst: false })
      .order("start_time", { nullsFirst: false })
      .order("sort_order")
      // A total order, so paging cannot repeat or skip a row when several events
      // share a start time.
      .order("id");

  const result = await fetchPage(build, page);
  if ("error" in result) {
    logDbFailure("admin stats events", result.error);
    return { error: fail("Something went wrong. Please try again.", 500) };
  }

  const events = result.rows.map((row) => {
    const configId = row.event_day_config_id;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      // The label ("Day 1"), null if the event has no day config set.
      day: typeof configId === "number" ? dayNames.get(configId) ?? null : null,
      // The calendar date, kept apart from the label above.
      date: row.day ?? null,
      start_time: row.start_time ?? null,
      end_time: row.end_time ?? null,
      // How many attendees have this on their schedule.
      total_attendees: Number(row.scheduled_count ?? 0),
    };
  });

  return { value: { events, pagination: pageMeta(result.total, page) } };
}
