// Everything a signed-in attendee does: their own profile, other attendees, the
// agenda, missions, QR codes and the leaderboard. One function, routed on the
// path after its name:
//
//   GET  /functions/v1/user/home                 → announcement, map, quick-start card
//   GET  /functions/v1/user/profile              → my profile
//   PUT  /functions/v1/user/profile              → update my profile
//   GET  /functions/v1/user/profile/{id}         → someone else's, with our connection state
//   GET  /functions/v1/user/people               → attendee directory (search, filter, paged)
//   POST /functions/v1/user/connection/request    → ask to connect
//   POST /functions/v1/user/connection/respond    → action: accept | reject
//   GET  /functions/v1/user/connection/list       → my requests / connections (paged)
//   GET  /functions/v1/user/guild/list            → every guild, flagged is_joined
//   POST /functions/v1/user/guild/membership      → action: join | leave
//   GET  /functions/v1/user/guild/members         → who else is in a guild (paged)
//   GET  /functions/v1/user/agenda                → events (filter by day, tag, quest…)
//   GET  /functions/v1/user/agenda/days           → the day tabs, and which to open on
//   GET  /functions/v1/user/agenda/schedule       → My Schedule
//   POST /functions/v1/user/agenda/schedule       → save | unsave | interest | withdraw
//   GET  /functions/v1/user/agenda/{id}           → one event
//   GET  /functions/v1/user/mission/list          → missions with my progress
//   POST /functions/v1/user/qr/scan               → claim a scanned QR code
//   GET  /functions/v1/user/leaderboard           → rankings, plus my own card
//
// Every route needs a real user token (see requireUser) and acts as that caller:
// there is no id in the path except the one being looked at, and nothing here can
// write another attendee's row.
//
// Runs on the service role, because reading a profile joins in the lookups, and
// because every write that carries XP — saving a session, claiming a QR code —
// has to go through one place rather than being a client's to make.
import { requireUser } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { fail, readJson } from "../_shared/http.ts";
import {
  changeSchedule,
  getAgenda,
  getAgendaDays,
  getEvent,
  getMySchedule,
} from "./agenda.ts";
import { listConnections, respondToRequest, sendRequest } from "./connections.ts";
import { changeGuild, listGuilds } from "./guilds.ts";
import { getHome } from "./home.ts";
import { getLeaderboard } from "./leaderboard.ts";
import { listMissions } from "./missions.ts";
import { getGuildMembers, getPeople } from "./people.ts";
import { getOtherProfile, getProfile, updateProfile } from "./profile.ts";
import { scanQrCode } from "./qr.ts";

// For the 404 body, so a typo lists what does exist.
const ROUTES = [
  "GET user/home",
  "GET user/profile",
  "PUT user/profile",
  "GET user/profile/{id}",
  "GET user/people",
  "POST user/connection/request",
  'POST user/connection/respond (action: "accept" | "reject")',
  "GET user/connection/list",
  "GET user/guild/list",
  'POST user/guild/membership (action: "join" | "leave")',
  "GET user/guild/members",
  "GET user/agenda",
  "GET user/agenda/days",
  "GET user/agenda/schedule",
  'POST user/agenda/schedule (action: "save" | "unsave" | "interest" | "withdraw")',
  "GET user/agenda/{id}",
  "GET user/mission/list",
  "POST user/qr/scan",
  "GET user/leaderboard",
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
      case "home":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await getHome(me);

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

      case "agenda":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await getAgenda(url, me);

      case "agenda/days":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await getAgendaDays(url, me);

      case "mission/list":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await listMissions(url, me);

      case "leaderboard":
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await getLeaderboard(url, me);

      // Reading My Schedule and changing it are the same noun, so they share a
      // route and are told apart by the method.
      case "agenda/schedule": {
        if (req.method === "GET") return await getMySchedule(url, me);
        if (req.method !== "POST") return methodNotAllowed(route, "GET or POST");

        const body = await readJson(req);
        if (!body) return fail("A JSON body is required.", 400);
        return await changeSchedule(
          body,
          me,
          url.searchParams.get("action")?.trim() ?? null,
        );
      }

      case "qr/scan": {
        if (req.method !== "POST") return methodNotAllowed(route, "POST");
        // The code may come on the query string instead, so an absent body is
        // not an error here — scanQrCode reports a missing code itself.
        const body = await readJson(req) ?? {};
        return await scanQrCode(
          body,
          me,
          url.searchParams.get("code")?.trim() ?? null,
        );
      }

      case "connection/request":
      case "connection/respond":
      case "guild/membership": {
        if (req.method !== "POST") return methodNotAllowed(route, "POST");
        const body = await readJson(req);
        if (!body) return fail("A JSON body is required.", 400);

        // accept/reject and join/leave are one route each, told apart by
        // `action` — in the body, or on the query string for a client that would
        // rather keep it out of the body.
        const action = url.searchParams.get("action")?.trim() ?? null;

        if (route === "connection/request") return await sendRequest(body, me);
        if (route === "connection/respond") {
          return await respondToRequest(body, me, action);
        }
        return await changeGuild(body, me, action);
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

    // GET user/agenda/{id}. Reached only after the named agenda routes above, so
    // "days" and "schedule" are never mistaken for an id.
    if (segments.length === 2 && segments[0] === "agenda") {
      if (req.method !== "GET") return methodNotAllowed(route, "GET");
      if (!UUID_RE.test(segments[1])) {
        return fail("That is not an event id.", 400);
      }
      return await getEvent(me, segments[1]);
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
