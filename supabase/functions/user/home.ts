// GET user/home — everything the Home screen needs, in one call.
//
// From the sheet: the announcement banner, the floor-plan map, and the quick-start
// card, which shows exactly one item depending on how far the user has got:
//
//   - hasn't saved 3 sessions yet  → "Save 3 sessions",        goes to Agenda
//   - saved 3 but no connections   → "Make your first connection", goes to Community
//   - both done                    → nothing; the card is hidden
//
// Resolved here rather than in the client, so the three-way rule lives in one
// place and the screen just renders `quick_start` or hides the card when it is
// null. The two navigation buttons the sheet lists ("Find more missions", "View
// Leaderboard") are static, so they need nothing from the API.
import { ok } from "../_shared/http.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

// The announcement is a single row pinned to this id — see
// supabase/migrations/20260819161552_announcements.sql.
const ANNOUNCEMENT_ID = 1;

// "Save 3 sessions".
const SESSION_TARGET = 3;

// On my schedule: an invite-only event counts once it has been approved.
const ON_SCHEDULE = ["saved", "approved"];

/** GET user/home */
export async function getHome(viewerId: string): Promise<Response> {
  const service = serviceClient();

  const [announcement, saved, connections, standing, missions] = await Promise.all([
    service
      .from("announcements")
      .select("text, map_image, updated_at")
      .eq("id", ANNOUNCEMENT_ID)
      .maybeSingle(),
    // head + count: the numbers are all this needs, not the rows.
    service
      .from("user_agenda")
      .select("agenda_id", { count: "exact", head: true })
      .eq("user_id", viewerId)
      .in("status", ON_SCHEDULE),
    service
      .from("connections")
      .select("id", { count: "exact", head: true })
      .eq("status", "accepted")
      .or(`requester_id.eq.${viewerId},addressee_id.eq.${viewerId}`),
    service.from("leaderboard").select("total_points, rank").eq("user_id", viewerId)
      .maybeSingle(),
    service
      .from("user_missions")
      .select("mission_id", { count: "exact", head: true })
      .eq("user_id", viewerId)
      .eq("status", "completed"),
  ]);

  // None of these is worth failing the screen over: an empty banner, a zero
  // counter or a missing score all render fine, and Home is the first thing the
  // app loads after signing in.
  for (const [label, result] of [
    ["announcement", announcement],
    ["saved sessions", saved],
    ["connections", connections],
    ["standing", standing],
    ["missions", missions],
  ] as const) {
    if (result.error) logDbFailure(`home ${label} read`, result.error);
  }

  const savedCount = saved.count ?? 0;
  const connectionCount = connections.count ?? 0;

  /*
   * One step at a time, in the sheet's order. null means both are done and the
   * card is hidden — an explicit "nothing to show" rather than an empty object,
   * so the client checks one field.
   */
  const quickStart = savedCount < SESSION_TARGET
    ? {
      step: "save_sessions",
      title: `Save ${SESSION_TARGET} sessions`,
      // Where the button goes, as the sheet specifies for each item.
      destination: "agenda",
      progress: savedCount,
      target: SESSION_TARGET,
    }
    : connectionCount < 1
    ? {
      step: "first_connection",
      title: "Make your first connection",
      destination: "community",
      progress: connectionCount,
      target: 1,
    }
    : null;

  return ok("Home loaded.", {
    announcement: {
      // Empty text is how an admin clears the banner, so the client should hide
      // it when this is empty rather than treating it as an error.
      text: announcement.data?.text ?? "",
      updated_at: announcement.data?.updated_at ?? null,
    },
    // The floor plan. null = nothing uploaded yet, so hide the map.
    map_image: announcement.data?.map_image ?? null,
    quick_start: quickStart,
    stats: {
      saved_sessions: savedCount,
      connections: connectionCount,
      missions_completed: missions.count ?? 0,
      total_xp: Number(standing.data?.total_points ?? 0),
      rank: standing.data?.rank == null ? null : Number(standing.data.rank),
    },
  });
}
