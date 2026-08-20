// Everything a signed-in attendee does about themselves and other attendees. One
// function, routed on the path after its name:
//
//   GET  /functions/v1/user/profile              → my profile
//   PUT  /functions/v1/user/profile              → update my profile
//   GET  /functions/v1/user/profile/{id}         → someone else's, with our connection state
//   GET  /functions/v1/user/people               → attendee directory (search, filter, paged)
//   POST /functions/v1/user/connection/request   → ask to connect
//   POST /functions/v1/user/connection/accept    → answer yes
//   POST /functions/v1/user/connection/reject    → answer no
//   GET  /functions/v1/user/connection/list      → my requests / connections (paged)
//   GET  /functions/v1/user/guild/list           → every guild, flagged is_joined
//   POST /functions/v1/user/guild/join           → join a guild
//   POST /functions/v1/user/guild/leave          → leave a guild
//   GET  /functions/v1/user/guild/members        → who else is in a guild (paged)
//
// Every route needs a real user token (see requireUser) and acts as that caller:
// there is no id in the path except the one being looked at, and nothing here can
// write another attendee's row.
//
// Runs on the service role, because reading a profile joins in the lookups, and
// writing has to go through one place that decides what is editable.
import { requireUser } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { fail, readJson } from "../_shared/http.ts";
import { listConnections, respondToRequest, sendRequest } from "./connections.ts";
import { changeGuild, listGuilds } from "./guilds.ts";
import { getGuildMembers, getPeople } from "./people.ts";
import { getOtherProfile, getProfile, updateProfile } from "./profile.ts";

// For the 404 body, so a typo lists what does exist.
const ROUTES = [
  "GET user/profile",
  "PUT user/profile",
  "GET user/profile/{id}",
  "GET user/people",
  "POST user/connection/request",
  "POST user/connection/accept",
  "POST user/connection/reject",
  "GET user/connection/list",
  "GET user/guild/list",
  "POST user/guild/join",
  "POST user/guild/leave",
  "GET user/guild/members",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // The path arrives as /user/<route> locally and /functions/v1/user/<route>
  // through some gateways, so key off the function name rather than an offset.
  const parts = url.pathname.split("/").filter(Boolean);
  const nameAt = parts.indexOf("user");
  const segments = nameAt >= 0 ? parts.slice(nameAt + 1) : [];
  const route = segments.join("/");

  const gate = await requireUser(req);
  if ("response" in gate) return gate.response;
  const me = gate.caller.id;

  try {
    switch (route) {
      case "profile":
        if (req.method === "GET") return await getProfile(me);
        if (req.method === "PUT") return await updateProfile(req, me);
        return methodNotAllowed(route, "GET or PUT");

      case "people":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await getPeople(url, me);

      case "connection/list":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await listConnections(url, me);

      case "guild/list":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await listGuilds(url, me);

      case "guild/members":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await getGuildMembers(url, me);

      case "connection/request":
      case "connection/accept":
      case "connection/reject":
      case "guild/join":
      case "guild/leave": {
        if (req.method !== "POST") return methodNotAllowed(route, "POST");
        const body = await readJson(req);
        if (!body) return fail("A JSON body is required.", 400);

        if (route === "connection/request") return await sendRequest(body, me);
        if (route === "connection/accept") return await respondToRequest(body, me, true);
        if (route === "connection/reject") return await respondToRequest(body, me, false);
        return await changeGuild(body, me, route === "guild/join");
      }
    }

    // GET user/profile/{id}
    if (segments.length === 2 && segments[0] === "profile") {
      if (req.method !== "GET") return methodNotAllowed(route, "GET");
      if (!UUID_RE.test(segments[1])) {
        return fail("That is not an attendee id.", 400);
      }
      return await getOtherProfile(me, segments[1]);
    }

    return fail(
      `Unknown user route "${route}". Available: ${ROUTES.join(", ")}.`,
      404,
    );
  } catch (err) {
    console.error(`user/${route} failed`, err);
    return fail("Something went wrong. Please try again.", 500);
  }
});

function methodNotAllowed(route: string, expected: string): Response {
  return fail(`Method not allowed. Use ${expected} for user/${route}.`, 405);
}
