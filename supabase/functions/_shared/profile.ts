// One definition of "a profile" for every endpoint that returns one: login,
// register's follow-up read, and GET/PUT user/profile.
//
// Guilds are a 1..3 selection held in public.user_guilds, so they arrive as a
// nested embed and are flattened here into a plain `guilds` array. Changing the
// selection goes through the set_user_guilds() RPC — see setGuilds below.
import { serviceClient } from "./supabase.ts";

export const MIN_GUILDS = 1;
export const MAX_GUILDS = 3;

const PROFILE_COLUMNS =
  "id, first_name, last_name, email, nerd_number, user_type_config_id, company_name, job_title, profile_image, is_admin, created_at, updated_at";

const USER_TYPE_EMBED = "user_type:configs (id, name, description)";
const GUILDS_EMBED = "user_guilds (guild:guilds (id, name, description))";

/** What GET/PUT user/profile reads. */
export const PROFILE_SELECT = `${PROFILE_COLUMNS}, ${USER_TYPE_EMBED}, ${GUILDS_EMBED}`;

/**
 * What login returns: the same profile plus the push-delivery columns, which the
 * app needs to decide whether to re-register the device.
 */
export const SESSION_PROFILE_SELECT =
  `${PROFILE_COLUMNS}, device_type, device_token, ${USER_TYPE_EMBED}, ${GUILDS_EMBED}`;

type GuildJoin = { guild: { id: number; name: string; description: string | null } | null };

/** Collapses the user_guilds join rows into `guilds`, ordered by id. */
export function shapeProfile(row: Record<string, unknown>): Record<string, unknown> {
  const { user_guilds: joins, ...rest } = row as Record<string, unknown> & {
    user_guilds?: GuildJoin[];
  };

  const guilds = (joins ?? [])
    .map((join) => join.guild)
    .filter((guild): guild is NonNullable<GuildJoin["guild"]> => guild !== null)
    .sort((a, b) => a.id - b.id);

  return { ...rest, guilds };
}

/**
 * Reads the guild selection out of a request body.
 *
 * Accepts what the different callers can actually send: a JSON array
 * (`[1, 2]`), one id, a comma-separated string or a JSON array as a string —
 * multipart forms cannot carry arrays, so `guild_ids=1,2` and repeated
 * `guild_ids` parts both have to work.
 *
 * Returns null when nothing was supplied, so a partial update can tell "leave the
 * selection alone" from "set it to this".
 */
export function readGuildIds(
  value: unknown,
): { ids: number[] } | { error: string } | null {
  if (value === undefined) return null;
  if (value === null) {
    return { error: `Pick between ${MIN_GUILDS} and ${MAX_GUILDS} guilds.` };
  }

  let raw: unknown[];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return { error: `Pick between ${MIN_GUILDS} and ${MAX_GUILDS} guilds.` };
    }
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return { error: "guild_ids must be a list of guild ids." };
        raw = parsed;
      } catch {
        return { error: "guild_ids must be a list of guild ids." };
      }
    } else {
      raw = trimmed.split(",");
    }
  } else {
    raw = [value];
  }

  const ids: number[] = [];
  for (const item of raw) {
    const asNumber = typeof item === "number"
      ? item
      : typeof item === "string" && /^\d+$/.test(item.trim())
      ? Number.parseInt(item.trim(), 10)
      : null;
    if (asNumber === null || !Number.isInteger(asNumber) || asNumber < 1) {
      return { error: `"${String(item)}" is not a guild id.` };
    }
    // Duplicates are the client sending the same pick twice, not an error.
    if (!ids.includes(asNumber)) ids.push(asNumber);
  }

  if (ids.length < MIN_GUILDS || ids.length > MAX_GUILDS) {
    return {
      error: `Pick between ${MIN_GUILDS} and ${MAX_GUILDS} guilds — ${ids.length} were sent.`,
    };
  }

  return { ids: ids.sort((a, b) => a - b) };
}

/** Every id has to exist, or set_user_guilds would reject the whole selection. */
export async function findUnknownGuild(ids: number[]): Promise<number | null> {
  const { data, error } = await serviceClient().from("guilds").select("id").in("id", ids);
  if (error) throw error;
  const known = new Set((data ?? []).map((row) => row.id as number));
  return ids.find((id) => !known.has(id)) ?? null;
}

/**
 * Replaces the selection through the RPC, which applies it in one transaction and
 * re-checks the 1..3 rule. Returns the message to show if it refused.
 */
export async function setGuilds(
  userId: string,
  ids: number[],
): Promise<{ error: string } | null> {
  const { error } = await serviceClient().rpc("set_user_guilds", {
    p_user_id: userId,
    p_guild_ids: ids,
  });
  if (!error) return null;

  console.error("set_user_guilds failed", error);
  // P0001 is what the function raises for a selection it will not accept; its
  // message is written for the user. Anything else is ours to swallow.
  return {
    error: error.code === "P0001"
      ? error.message
      : "Your guild selection could not be saved. Please try again.",
  };
}
