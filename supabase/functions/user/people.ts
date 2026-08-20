// GET user/people and GET user/guild/members — the attendee directory.
//
// Both answer with the same person card, so a list screen can render either
// without special-casing: name, nerd number, company, title, picture, user type,
// guilds, and where the caller stands with them.
import { fail, integer, ok } from "../_shared/http.ts";
import { fetchPage, likeTerm, pageMeta, readPage } from "../_shared/pagination.ts";
import { PERSON_SELECT, shapeProfile } from "../_shared/profile.ts";
import { statusesFor } from "../_shared/connections.ts";
import { serviceClient } from "../_shared/supabase.ts";

/** `user_type=all` is the same as leaving it out — say so rather than 400ing. */
const ALL = "all";

type ListOptions = {
  viewerId: string;
  search: string | null;
  /** configs.id of a user_type, or null for every type. */
  userType: number | null;
  /** Only people in this guild. */
  guildId: number | null;
  message: (total: number) => string;
};

/**
 * One page of people, with the caller's own row left out — a directory is other
 * people — and each card's connection status attached.
 */
async function listPeople(
  url: URL,
  options: ListOptions,
): Promise<Response> {
  const page = readPage(url.searchParams);
  if ("error" in page) return fail(page.error, 400);

  const service = serviceClient();

  // Guild membership lives in public.user_guilds, so the filter is resolved to a
  // set of ids first. Filtering an embedded table in the same query would also
  // trim the `guilds` array on each card down to the one guild being filtered on.
  let onlyIds: string[] | null = null;
  if (options.guildId !== null) {
    const { data, error } = await service
      .from("user_guilds")
      .select("user_id")
      .eq("guild_id", options.guildId);
    if (error) throw error;
    const memberIds = (data ?? []).map((row: { user_id: string }) => row.user_id);
    onlyIds = memberIds;
    if (memberIds.length === 0) {
      return ok(options.message(0), { people: [], pagination: pageMeta(0, page) });
    }
  }

  const build = (headOnly: boolean) => {
    let query = service
      .from("users")
      .select(PERSON_SELECT, { count: "exact", head: headOnly })
      .neq("id", options.viewerId)
      .order("first_name")
      .order("last_name")
      .order("id");

    // One ilike over users.search_text, which holds the name, nerd number,
    // company and title in one lower-cased string — so "wasim raza", "00427" and
    // "simpalm" all hit.
    if (options.search) query = query.ilike("search_text", likeTerm(options.search));
    if (options.userType !== null) {
      query = query.eq("user_type_config_id", options.userType);
    }
    if (onlyIds) query = query.in("id", onlyIds);
    return query;
  };

  const result = await fetchPage(build, page);
  if ("error" in result) {
    console.error("people list failed", result.error);
    return fail("Something went wrong. Please try again.", 500);
  }

  const statuses = await statusesFor(
    options.viewerId,
    result.rows.map((row) => row.id as string),
  );

  const people = result.rows.map((row) => {
    const person = shapeProfile(row);
    const connection = statuses.get(row.id as string) ??
      { status: "none" as const, request_id: null };
    return { ...person, connection, is_connected: connection.status === "connected" };
  });

  return ok(options.message(result.total), {
    people,
    search: options.search,
    pagination: pageMeta(result.total, page),
  });
}

/** GET user/people?search=&user_type=&guild_id=&page=&per_page= */
export async function getPeople(url: URL, viewerId: string): Promise<Response> {
  const params = url.searchParams;

  const rawType = params.get("user_type")?.trim() ?? "";
  let userType: number | null = null;
  if (rawType && rawType.toLowerCase() !== ALL) {
    userType = integer(rawType);
    if (userType === null) {
      return fail(
        `user_type must be a configs.id where type = 'user_type', or "${ALL}".`,
        400,
      );
    }
  }

  const rawGuild = params.get("guild_id")?.trim() ?? "";
  let guildId: number | null = null;
  if (rawGuild && rawGuild.toLowerCase() !== ALL) {
    guildId = integer(rawGuild);
    if (guildId === null) return fail("guild_id must be a guilds.id.", 400);
  }

  const search = params.get("search")?.trim() || null;

  return await listPeople(url, {
    viewerId,
    search,
    userType,
    guildId,
    message: (total) =>
      total === 1 ? "1 attendee found." : `${total} attendees found.`,
  });
}

/** GET user/guild/members?guild_id=&search=&page=&per_page= */
export async function getGuildMembers(url: URL, viewerId: string): Promise<Response> {
  const guildId = integer(url.searchParams.get("guild_id"));
  if (guildId === null) {
    return fail("guild_id is required. Fetch the list from GET user/guild/list.", 400);
  }

  const { data: guild, error } = await serviceClient()
    .from("guilds")
    .select("id, name")
    .eq("id", guildId)
    .maybeSingle();
  if (error) throw error;
  if (!guild) return fail(`Guild ${guildId} does not exist.`, 400);

  return await listPeople(url, {
    viewerId,
    search: url.searchParams.get("search")?.trim() || null,
    userType: integer(url.searchParams.get("user_type")),
    guildId,
    message: (total) =>
      total === 1
        ? `1 other member of ${guild.name}.`
        : `${total} other members of ${guild.name}.`,
  });
}
