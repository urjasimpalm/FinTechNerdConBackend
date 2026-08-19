// GET config
//   /functions/v1/config              → every lookup list in one payload
//   /functions/v1/config/guilds       → guilds only
//   /functions/v1/config/user_type    → one config type only
//   /functions/v1/config?type=user_type,event-day
//
// Serves the reference data the app needs to render pickers: guilds plus the
// public.configs rows grouped by their type.
//
// This runs on the service role and is reachable without a session on purpose:
// the register screen needs the guild and user_type lists before the user has a
// token, and public.configs / public.guilds are select-only to authenticated
// users under RLS.
import { corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

const GUILDS_KEY = "guilds";

// Reference data changes rarely, so let clients and the CDN hold it briefly.
const cacheHeaders = { "Cache-Control": "public, max-age=300" };

function cached(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...(status === 200 ? cacheHeaders : {}),
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json({ success: false, message: "Method not allowed." }, 405);
  }

  const url = new URL(req.url);

  // Anything after the function name. The path arrives as /config/<segment>
  // locally and /functions/v1/config/<segment> through some gateways, so key off
  // the function name rather than a fixed offset.
  const parts = url.pathname.split("/").filter(Boolean);
  const nameAt = parts.indexOf("config");
  const segment = nameAt >= 0 ? parts.slice(nameAt + 1).join("/") : "";

  // ?type=a,b takes over when no path segment was given.
  const requested = segment
    ? [segment]
    : (url.searchParams.get("type")?.split(",").map((t) => t.trim()).filter(Boolean) ?? []);

  try {
    const service = serviceClient();
    const wantsGuilds = requested.length === 0 || requested.includes(GUILDS_KEY);
    const configTypes = requested.filter((t) => t !== GUILDS_KEY);

    const [guildsResult, configsResult] = await Promise.all([
      wantsGuilds
        ? service.from("guilds").select("id, name, description").order("id")
        : Promise.resolve({ data: [], error: null }),
      requested.length === 0 || configTypes.length > 0
        ? (() => {
          const query = service.from("configs").select("id, type, name, description").order("id");
          return configTypes.length > 0 ? query.in("type", configTypes) : query;
        })()
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (guildsResult.error || configsResult.error) {
      console.error("config lookup failed", guildsResult.error ?? configsResult.error);
      return json(
        { success: false, message: "Something went wrong. Please try again." },
        500,
      );
    }

    // Grouped under the type value as it is stored, so a new config type shows
    // up here without a code change.
    const data: Record<string, unknown[]> = {};
    if (wantsGuilds) data[GUILDS_KEY] = guildsResult.data ?? [];
    // description is carried through for every type so the shape is uniform;
    // only user_type has copy today, so it is null elsewhere.
    for (const row of (configsResult.data ?? []) as Array<
      { id: number; type: string; name: string; description: string | null }
    >) {
      (data[row.type] ??= []).push({
        id: row.id,
        name: row.name,
        description: row.description,
      });
    }
    // Keep an explicitly requested but empty type present as [], so the client
    // never has to null-check the key it asked for.
    for (const type of configTypes) data[type] ??= [];

    // A single unknown path segment is a typo worth surfacing rather than
    // answering with a silent empty list. A config type only exists because it
    // has rows, so empty means unknown — except for guilds, which is a real
    // table and may legitimately be empty.
    if (segment && segment !== GUILDS_KEY && (data[segment] as unknown[] | undefined)?.length === 0) {
      const { data: known } = await service.from("configs").select("type");
      const types = [...new Set((known ?? []).map((r) => r.type as string))];
      return cached({
        success: false,
        message: `Unknown config type "${segment}".`,
        available: [GUILDS_KEY, ...types.sort()],
      }, 404);
    }

    return cached({ success: true, data });
  } catch (err) {
    console.error("config failed", err);
    return json(
      { success: false, message: "Something went wrong. Please try again." },
      500,
    );
  }
});
