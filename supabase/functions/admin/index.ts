// Admin routes. One function, routed on the path after its name:
//
//   GET    /functions/v1/admin/user/list          ?limit=&offset=&search=
//   POST   /functions/v1/admin/user/add           { "emails": ["a@b.com", ...] }
//   DELETE /functions/v1/admin/user/remove        { "emails": ["a@b.com", ...] }
//   GET    /functions/v1/admin/announcement/get
//   POST   /functions/v1/admin/announcement/post  { "text": "...", "map_image": "..." }
//   GET    /functions/v1/admin/stats              usage statistics + per-event list
//   POST   /functions/v1/admin/agenda/create      { "name": "...", ... }
//   POST   /functions/v1/admin/agenda/update      { "id": "...", ...fields }
//
// user/* manages public.email_stack — the attendee list that registration is
// gated on. Entries there are invitations, not accounts: adding one lets that
// address register, removing one stops future registrations but leaves any
// account that already registered with it untouched.
//
// agenda/* authors the schedule the Agenda screen reads. See ./agenda.ts.
//
// Every route requires a signed-in user whose public.users row has
// is_admin = true. The project's anon key is itself a valid JWT, so `verify_jwt`
// alone would not gate this — see requireAdmin.
//
// Runs on the service role because email_stack has RLS enabled with no policies:
// no client, admin or otherwise, can read or write it directly.
import { requireAdmin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { fail, integer, ok, readJson, text } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { createEvent, updateEvent } from "./agenda.ts";
import { getStats } from "./stats.ts";

const MAX_EMAILS = 200;
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROUTES: Record<string, string> = {
  "user/list": "GET",
  "user/add": "POST",
  "user/remove": "DELETE",
  "announcement/get": "GET",
  "announcement/post": "POST",
  "stats": "GET",
  "agenda/create": "POST",
  "agenda/update": "POST",
};

// The announcement is a single row pinned to this id.
const ANNOUNCEMENT_ID = 1;
const MAX_ANNOUNCEMENT_LENGTH = 2000;
const ANNOUNCEMENT_COLUMNS = "text, map_image, updated_by, updated_at";

type Entry = { email: string; first_name: string | null; last_name: string | null };

/**
 * Accepts either a single { email, first_name?, last_name? } or a list under
 * `emails`, whose items may be plain strings or the same object shape.
 * Addresses are lower-cased and trimmed, matching how the table is stored.
 */
function readEntries(
  body: Record<string, unknown>,
): { entries: Entry[] } | { error: string } {
  const raw: unknown[] = Array.isArray(body.emails)
    ? body.emails
    : body.email !== undefined
    ? [{
      email: body.email,
      first_name: body.first_name,
      last_name: body.last_name,
    }]
    : [];

  if (raw.length === 0) {
    return { error: 'Provide "email" or a non-empty "emails" list.' };
  }
  if (raw.length > MAX_EMAILS) {
    return { error: `At most ${MAX_EMAILS} emails per request.` };
  }

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const source = typeof item === "string" ? { email: item } : item;
    if (source === null || typeof source !== "object") {
      return { error: "Each entry must be an email string or an object." };
    }
    const record = source as Record<string, unknown>;
    const email = text(record.email)?.toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return { error: `"${String(record.email ?? "")}" is not a valid email address.` };
    }
    // Silently collapse repeats inside one request rather than reporting them.
    if (seen.has(email)) continue;
    seen.add(email);
    entries.push({
      email,
      first_name: text(record.first_name),
      last_name: text(record.last_name),
    });
  }

  return { entries };
}

async function listUsers(url: URL): Promise<Response> {
  const params = url.searchParams;

  // page/per_page is the documented pair; limit/offset are accepted as aliases so
  // either style works, and mixing them still resolves to one window.
  const perPageRaw = integer(params.get("per_page")) ?? integer(params.get("limit")) ??
    DEFAULT_PER_PAGE;
  const pageRaw = integer(params.get("page")) ?? 1;
  const offsetRaw = integer(params.get("offset"));

  if (perPageRaw < 1) return fail("per_page must be 1 or more.", 400);
  if (pageRaw < 1) return fail("page must be 1 or more.", 400);
  if (offsetRaw !== null && offsetRaw < 0) return fail("offset must be 0 or more.", 400);

  const perPage = Math.min(perPageRaw, MAX_PER_PAGE);
  const offset = offsetRaw ?? (pageRaw - 1) * perPage;

  const search = text(url.searchParams.get("search"))?.toLowerCase();

  const baseQuery = (headOnly: boolean) => {
    const query = serviceClient()
      .from("email_stack")
      .select("id, email, first_name, last_name", { count: "exact", head: headOnly })
      .order("email");
    if (!search) return query;
    // % and _ are wildcards in LIKE, so a search for "a_b" would otherwise match
    // "axb". Escape them (and the escape character itself) to keep the term
    // literal.
    const escaped = search.replace(/([\\%_])/g, "\\$1");
    return query.ilike("email", `%${escaped}%`);
  };

  let { data, count, error } = await baseQuery(false).range(offset, offset + perPage - 1);

  // PostgREST rejects a range that starts past the last row (PGRST103) instead of
  // returning nothing. A page beyond the end is a normal thing for a pager to
  // ask for, so answer it as an empty page — but re-read the count, since the
  // failed request did not carry one.
  if (error?.code === "PGRST103") {
    const countOnly = await baseQuery(true);
    if (countOnly.error) {
      console.error("email_stack count failed", countOnly.error);
      return fail("Something went wrong. Please try again.", 500);
    }
    data = [];
    count = countOnly.count;
    error = null;
  }

  if (error) {
    console.error("email_stack list failed", error);
    return fail("Something went wrong. Please try again.", 500);
  }

  // `total` counts what the filter matched, not the whole table, so say so.
  const total = count ?? 0;
  const noun = total === 1 ? "email" : "emails";
  const page = Math.floor(offset / perPage) + 1;
  const totalPages = Math.ceil(total / perPage);

  return ok(
    search
      ? `${total} ${noun} matching "${search}".`
      : `${total} ${noun} on the attendee list.`,
    {
      users: data ?? [],
      search: search ?? null,
      pagination: {
        total,
        page,
        per_page: perPage,
        total_pages: totalPages,
        // Derived from `total` rather than the page size, so a full last page
        // does not look like there is more to fetch.
        has_next: offset + perPage < total,
        has_prev: offset > 0,
      },
    },
  );
}

async function addUsers(entries: Entry[]): Promise<Response> {
  const service = serviceClient();
  const added: string[] = [];
  const alreadyOnList: string[] = [];

  // One row at a time so a single duplicate doesn't fail the whole batch: a
  // multi-row insert is one statement, so one conflict would roll back the rest.
  for (const entry of entries) {
    const { error } = await service.from("email_stack").insert(entry);
    if (!error) {
      added.push(entry.email);
      continue;
    }
    // 23505 = unique violation, i.e. already on the list (the unique index is on
    // lower(email), so this covers a differently-cased duplicate too).
    if (error.code === "23505") {
      alreadyOnList.push(entry.email);
      continue;
    }
    console.error("email_stack insert failed", entry.email, error);
    return fail("Something went wrong. Please try again.", 500);
  }

  return ok(
    added.length > 0
      ? `Added ${added.length} email${added.length === 1 ? "" : "s"} to the attendee list.`
      : "No new emails to add.",
    {
      requested: entries.length,
      added_count: added.length,
      added,
      already_on_list: alreadyOnList,
    },
  );
}

async function removeUsers(entries: Entry[]): Promise<Response> {
  const emails = entries.map((entry) => entry.email);

  // Stored lower-cased, so an exact `in` match is complete.
  const { data: deleted, error } = await serviceClient()
    .from("email_stack")
    .delete()
    .in("email", emails)
    .select("email");

  if (error) {
    console.error("email_stack delete failed", error);
    return fail("Something went wrong. Please try again.", 500);
  }

  const removed = (deleted ?? []).map((row) => row.email as string);
  const notFound = emails.filter((email) => !removed.includes(email));

  return ok(
    removed.length > 0
      ? `Removed ${removed.length} email${removed.length === 1 ? "" : "s"} from the attendee list.`
      : "None of those emails were on the list.",
    {
      requested: emails.length,
      removed_count: removed.length,
      removed,
      not_found: notFound,
    },
  );
}

async function getAnnouncement(): Promise<Response> {
  const { data, error } = await serviceClient()
    .from("announcements")
    .select(ANNOUNCEMENT_COLUMNS)
    .eq("id", ANNOUNCEMENT_ID)
    .maybeSingle();

  if (error) {
    console.error("announcement read failed", error);
    return fail("Something went wrong. Please try again.", 500);
  }

  // The migration seeds the row, but fall back to an empty announcement rather
  // than a 404 so the client always has something to render.
  const announcement = data ?? { text: "", updated_by: null, updated_at: null };
  return ok(
    announcement.text ? "Announcement loaded." : "There is no announcement right now.",
    announcement,
  );
}

async function saveAnnouncement(
  body: Record<string, unknown>,
  adminId: string,
): Promise<Response> {
  const updates: Record<string, unknown> = { id: ANNOUNCEMENT_ID, updated_by: adminId };
  let value: string | null = null;

  // Both fields are optional, so the banner and the map can be edited
  // independently — but sending neither is a no-op worth reporting.
  if ("text" in body) {
    // Empty is a real value — it clears the banner — so only a non-string is
    // rejected. null is treated as clearing it.
    const raw = body.text === null ? "" : body.text;
    if (typeof raw !== "string") {
      return fail('"text" must be a string.', 400);
    }
    // Trailing whitespace only would render as a blank banner rather than none.
    value = raw.trim();
    if (value.length > MAX_ANNOUNCEMENT_LENGTH) {
      return fail(
        `Announcement must be ${MAX_ANNOUNCEMENT_LENGTH} characters or fewer.`,
        400,
      );
    }
    updates.text = value;
  }

  // The Home screen's floor plan. A public URL, not the bytes — upload the image
  // to a storage bucket first, the same as public.sponsors.profile_image. null
  // removes the map.
  if ("map_image" in body) {
    const raw = body.map_image;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      updates.map_image = null;
    } else if (typeof raw !== "string") {
      return fail('"map_image" must be a URL string, or null to remove it.', 400);
    } else if (!/^https?:\/\//i.test(raw.trim())) {
      return fail('"map_image" must be an http(s) URL, or null to remove it.', 400);
    } else {
      updates.map_image = raw.trim();
    }
  }

  if (!("text" in updates) && !("map_image" in updates)) {
    return fail(
      'Send "text" (an empty string clears the banner) and/or "map_image".',
      400,
    );
  }

  const { data, error } = await serviceClient()
    .from("announcements")
    .upsert(updates, { onConflict: "id" })
    .select(ANNOUNCEMENT_COLUMNS)
    .single();

  if (error) {
    console.error("announcement save failed", error);
    return fail("Something went wrong. Please try again.", 500);
  }

  return ok(
    // "map updated" when only the map changed, so the response reflects what the
    // admin actually did.
    value === null
      ? "Map updated."
      : value
      ? "Announcement saved."
      : "Announcement cleared.",
    data,
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // The path arrives as /admin/<route> locally and /functions/v1/admin/<route>
  // through some gateways, so key off the function name rather than an offset.
  const parts = url.pathname.split("/").filter(Boolean);
  const nameAt = parts.indexOf("admin");
  const route = nameAt >= 0 ? parts.slice(nameAt + 1).join("/") : "";

  const expectedMethod = ROUTES[route];
  if (!expectedMethod) {
    return fail(
      `Unknown admin route "${route}". Available: ${
        Object.entries(ROUTES).map(([path, method]) => `${method} admin/${path}`).join(", ")
      }.`,
      404,
    );
  }
  if (req.method !== expectedMethod) {
    return fail(`Method not allowed. Use ${expectedMethod} for admin/${route}.`, 405);
  }

  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  try {
    // Read-only routes first: they take no body.
    if (route === "user/list") return await listUsers(url);
    if (route === "announcement/get") return await getAnnouncement();
    if (route === "stats") return await getStats(url);

    const body = await readJson(req);
    if (!body) return fail("A JSON body is required.", 400);

    if (route === "announcement/post") {
      return await saveAnnouncement(body, gate.caller.id);
    }
    if (route === "agenda/create") return await createEvent(body);
    if (route === "agenda/update") return await updateEvent(body);

    const parsed = readEntries(body);
    if ("error" in parsed) return fail(parsed.error, 400);

    return route === "user/add"
      ? await addUsers(parsed.entries)
      : await removeUsers(parsed.entries);
  } catch (err) {
    console.error(`admin/${route} failed`, err);
    return fail("Something went wrong. Please try again.", 500);
  }
});
