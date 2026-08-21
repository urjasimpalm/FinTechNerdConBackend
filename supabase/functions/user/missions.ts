// GET user/mission/list — the Missions screen.
//
// The catalog with the caller's progress folded in: the sheet wants a name, a
// description and an XP value per mission, a completion indicator once it is
// done, and a "Times Completed" counter for the ones that can be earned more
// than once.
//
// There is deliberately no route here that completes a mission. Progress is
// awarded server-side — by triggers on public.user_agenda and public.connections,
// and by public.claim_qr_code() when a QR code is scanned — so there is no way for
// a client to grant itself XP. See
// supabase/migrations/20260822000002_missions_frd.sql.
import { fail, ok } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

/**
 * How each mission is earned, as one line the app can show under the description.
 * Keyed on missions.code, so a mission with no code (added later, in Studio) just
 * has no hint rather than breaking the list.
 */
const HOW_TO_EARN: Record<string, string> = {
  book_first_quest: "Add a Bonus Quest — an offsite event — to your schedule.",
  add_session: "Add a Main Quest or Side Quest session to your schedule.",
  visit_activation: "Scan the QR code at a sponsor booth.",
  connect_nerd: "Connect with a fellow attendee in the app.",
  explore_zone: "Scan the QR code in a zone you have not visited yet.",
  nerd_flex: "Find Simon, Colton or Joy and scan the QR code on their lanyard.",
  quest_master: "Complete every other mission at least once.",
};

type Progress = {
  times_completed: number;
  points_awarded: number;
  completed_at: string | null;
};

/** GET user/mission/list */
export async function listMissions(url: URL, viewerId: string): Promise<Response> {
  const service = serviceClient();

  // Inactive missions are hidden by default: the catalog is a screen, not an
  // audit. ?include_inactive=true is there for support.
  const includeInactive = ["true", "1"].includes(
    url.searchParams.get("include_inactive")?.trim().toLowerCase() ?? "",
  );

  const catalogQuery = service
    .from("missions")
    .select("id, code, title, description, points, is_repeatable, max_completions, is_active")
    .order("sort_order")
    .order("id");

  const [catalog, progress, standing] = await Promise.all([
    includeInactive ? catalogQuery : catalogQuery.eq("is_active", true),
    service
      .from("user_missions")
      .select("mission_id, times_completed, points_awarded, completed_at, status")
      .eq("user_id", viewerId),
    service.from("leaderboard").select("total_points, rank").eq("user_id", viewerId)
      .maybeSingle(),
  ]);

  if (catalog.error) {
    console.error("mission catalog failed", catalog.error);
    return fail("Something went wrong. Please try again.", 500);
  }
  if (progress.error) {
    console.error("mission progress failed", progress.error);
    return fail("Something went wrong. Please try again.", 500);
  }
  if (standing.error) {
    // Not fatal — the list is still worth returning without the totals.
    console.error("leaderboard read failed", standing.error);
  }

  const mine = new Map<number, Progress>();
  for (const row of progress.data ?? []) {
    mine.set(row.mission_id as number, {
      times_completed: Number(row.times_completed ?? 0),
      points_awarded: Number(row.points_awarded ?? 0),
      completed_at: (row.completed_at as string | null) ?? null,
    });
  }

  const missions = (catalog.data ?? []).map((row) => {
    const code = row.code as string | null;
    const done = mine.get(row.id as number);
    const times = done?.times_completed ?? 0;
    const max = row.max_completions as number | null;

    return {
      id: row.id,
      code,
      title: row.title,
      description: row.description,
      // `xp` alongside `points` because the FRD (and the UI) call it XP while the
      // column is points; both are here so neither side has to translate.
      xp: row.points,
      points: row.points,
      is_active: row.is_active,
      is_repeatable: row.is_repeatable === true,
      max_completions: max,
      how_to_earn: code ? HOW_TO_EARN[code] ?? null : null,
      is_completed: times > 0,
      times_completed: times,
      xp_earned: done?.points_awarded ?? 0,
      completed_at: done?.completed_at ?? null,
      // null = no limit. Only meaningful for the repeatable ones.
      remaining: max === null ? null : Math.max(0, max - times),
    };
  });

  const completed = missions.filter((mission) => mission.is_completed).length;

  return ok(
    `${completed} of ${missions.length} mission${
      missions.length === 1 ? "" : "s"
    } completed.`,
    {
      missions,
      summary: {
        total: missions.length,
        completed,
        // Mission XP only — the leaderboard total below also counts session
        // check-ins, so the two are not expected to match.
        mission_xp: missions.reduce((sum, mission) => sum + mission.xp_earned, 0),
        total_xp: Number(standing.data?.total_points ?? 0),
        rank: standing.data?.rank == null ? null : Number(standing.data.rank),
      },
    },
  );
}
