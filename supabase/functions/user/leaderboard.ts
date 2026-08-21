// GET user/leaderboard — the Leaderboard screen.
//
// The sheet: rankings by XP, the top 15 in a scrolling list, each entry showing
// name, nerd number, ranking and total XP, tapping a name opens that profile —
// and the caller's own card below the list, in the same shape, whether or not
// they made the cut.
//
// Reads public.leaderboard_people, which is public.leaderboard (mission XP plus
// session check-in XP, admins excluded) with the card fields joined on. Nothing
// writes a total anywhere: it is derived, so it cannot fall out of step with the
// completions it came from.
import { fail, ok } from "../_shared/http.ts";
import { fetchPage, pageMeta, readPage } from "../_shared/pagination.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

const BOARD_SELECT =
  "user_id, rank, total_points, first_name, last_name, nerd_number, company_name, job_title, profile_image, user_type_config_id";

// The sheet's "displays top 15 rankings".
const DEFAULT_LIMIT = 15;

type Row = Record<string, unknown>;

/**
 * One leaderboard card. `total_xp` and `rank` come back from PostgREST as strings
 * — sum() and rank() are bigints — so both are cast here rather than at every
 * call site.
 */
function shapeEntry(row: Row, viewerId: string): Record<string, unknown> {
  return {
    user_id: row.user_id,
    rank: row.rank == null ? null : Number(row.rank),
    total_xp: Number(row.total_points ?? 0),
    first_name: row.first_name,
    last_name: row.last_name,
    nerd_number: row.nerd_number,
    company_name: row.company_name,
    job_title: row.job_title,
    profile_image: row.profile_image,
    user_type_config_id: row.user_type_config_id,
    is_me: row.user_id === viewerId,
  };
}

/**
 * The caller's own card.
 *
 * public.leaderboard only holds people who have earned something, so someone who
 * has done nothing yet is absent from it — they score 0 and have no rank rather
 * than being ranked last. That is the same semantics GET user/profile already
 * reports, so the two screens agree.
 */
async function myCard(viewerId: string): Promise<Record<string, unknown>> {
  const service = serviceClient();

  const { data: ranked, error } = await service
    .from("leaderboard_people")
    .select(BOARD_SELECT)
    .eq("user_id", viewerId)
    .maybeSingle();
  if (error) throw error;
  if (ranked) return shapeEntry(ranked, viewerId);

  const { data: profile, error: profileError } = await service
    .from("users")
    .select(
      "id, first_name, last_name, nerd_number, company_name, job_title, profile_image, user_type_config_id",
    )
    .eq("id", viewerId)
    .maybeSingle();
  if (profileError) throw profileError;

  return shapeEntry(
    { ...(profile ?? {}), user_id: viewerId, rank: null, total_points: 0 },
    viewerId,
  );
}

/** GET user/leaderboard?limit=15&page= */
export async function getLeaderboard(url: URL, viewerId: string): Promise<Response> {
  // The shared pager reads limit/per_page and page/offset, so the board scrolls
  // past the top 15 with the same parameters as every other list.
  const params = new URLSearchParams(url.searchParams);
  if (!params.has("per_page") && !params.has("limit")) {
    params.set("per_page", String(DEFAULT_LIMIT));
  }

  const page = readPage(params);
  if ("error" in page) return fail(page.error, 400);

  const service = serviceClient();
  const build = (headOnly: boolean) =>
    service
      .from("leaderboard_people")
      .select(BOARD_SELECT, { count: "exact", head: headOnly })
      .order("rank")
      // Ties share a rank, so without a second key their order would drift
      // between requests and the list would appear to shuffle while scrolling.
      .order("nerd_number");

  const [result, me] = await Promise.all([fetchPage(build, page), myCard(viewerId)]);

  if ("error" in result) {
    logDbFailure("leaderboard", result.error);
    return fail("Something went wrong. Please try again.", 500);
  }

  return ok(
    result.total === 1 ? "1 ranked attendee." : `${result.total} ranked attendees.`,
    {
      entries: result.rows.map((row) => shapeEntry(row, viewerId)),
      // The caller's own card, for the panel under the scrolling list. Present
      // even when they are also in `entries`, so the client never has to search.
      me,
      pagination: pageMeta(result.total, page),
    },
  );
}
