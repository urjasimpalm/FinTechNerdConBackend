// The guild routes for a signed-in caller:
//
//   GET  user/guild/list        → every guild, flagged with is_joined
//   POST user/guild/membership  { "guild_id": 1, "action": "join" | "leave" }
//
// Joining and leaving are one route told apart by `action`, and both edit the
// same 1..3 selection that shows on the profile, so they go through
// public.set_user_guilds() — a join is refused once the caller is in 3 guilds and
// a leave is refused at 1, because an attendee always belongs to at least one.
import { fail, integer, ok, text } from "../_shared/http.ts";
import { fetchPage, likeTerm, pageMeta, readPage } from "../_shared/pagination.ts";
import { MAX_GUILDS, MIN_GUILDS, setGuilds } from "../_shared/profile.ts";
import { serviceClient } from "../_shared/supabase.ts";

async function myGuildIds(userId: string): Promise<number[]> {
  const { data, error } = await serviceClient()
    .from("user_guilds")
    .select("guild_id")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((row) => row.guild_id as number).sort((a, b) => a - b);
}

/** GET user/guild/list?search=&page=&per_page= */
export async function listGuilds(url: URL, viewerId: string): Promise<Response> {
  const page = readPage(url.searchParams);
  if ("error" in page) return fail(page.error, 400);

  const search = url.searchParams.get("search")?.trim() || null;
  const service = serviceClient();

  const build = (headOnly: boolean) => {
    const query = service
      .from("guilds")
      .select("id, name, description", { count: "exact", head: headOnly })
      .order("id");
    return search ? query.ilike("name", likeTerm(search)) : query;
  };

  const [result, joined] = await Promise.all([
    fetchPage(build, page),
    myGuildIds(viewerId),
  ]);

  if ("error" in result) {
    console.error("guild list failed", result.error);
    return fail("Something went wrong. Please try again.", 500);
  }

  const guilds = result.rows.map((row) => ({
    ...row,
    is_joined: joined.includes(row.id as number),
  }));

  return ok(`${result.total} guild${result.total === 1 ? "" : "s"}.`, {
    guilds,
    joined_count: joined.length,
    max_guilds: MAX_GUILDS,
    search,
    pagination: pageMeta(result.total, page),
  });
}

/**
 * POST user/guild/membership — `action` is "join" or "leave". It may also come
 * from the query string (`?action=leave`), the same as the connection route.
 */
export async function changeGuild(
  body: Record<string, unknown>,
  viewerId: string,
  queryAction: string | null,
): Promise<Response> {
  const action = (text(body.action) ?? queryAction ?? "").toLowerCase();
  if (action !== "join" && action !== "leave") {
    return fail('"action" must be "join" or "leave".', 400);
  }
  const join = action === "join";

  const guildId = integer(body.guild_id);
  if (guildId === null) {
    return fail('"guild_id" is required. Fetch the list from GET user/guild/list.', 400);
  }

  const { data: guild, error } = await serviceClient()
    .from("guilds")
    .select("id, name")
    .eq("id", guildId)
    .maybeSingle();
  if (error) throw error;
  if (!guild) return fail(`Guild ${guildId} does not exist.`, 400);

  // The cap is checked here so the answer names the guild and says what to do
  // about it. public.set_user_guilds() re-checks 1..3 and the user_guilds_limit
  // trigger enforces the ceiling in the database, so it holds even if a future
  // caller skips this path.

  const current = await myGuildIds(viewerId);
  const already = current.includes(guildId);

  // Answered as a conflict rather than silently, so the client knows its idea of
  // the state was stale and can re-read the list.
  if (join && already) return fail(`You are already in ${guild.name}.`, 409);
  if (!join && !already) return fail(`You are not in ${guild.name}.`, 409);

  if (join && current.length >= MAX_GUILDS) {
    return fail(
      `You can belong to at most ${MAX_GUILDS} guilds. Leave one first.`,
      409,
    );
  }
  if (!join && current.length <= MIN_GUILDS) {
    return fail(
      `You have to belong to at least ${MIN_GUILDS} guild. Join another one first.`,
      409,
    );
  }

  const next = join
    ? [...current, guildId]
    : current.filter((id) => id !== guildId);

  const failed = await setGuilds(viewerId, next);
  if (failed) return fail(failed.error, 400);

  const guildsAfter = await serviceClient()
    .from("guilds")
    .select("id, name, description")
    .in("id", next)
    .order("id");
  if (guildsAfter.error) throw guildsAfter.error;

  return ok(
    join ? `You joined ${guild.name}.` : `You left ${guild.name}.`,
    { guilds: guildsAfter.data ?? [] },
  );
}
