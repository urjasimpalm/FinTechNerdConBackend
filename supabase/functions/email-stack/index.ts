// Admin-only management of the attendee list (public.email_stack), which is what
// registration is gated on.
//
//   POST   /functions/v1/email-stack   { "emails": ["a@b.com", ...] }
//                                      { "email": "a@b.com", "first_name": "A", "last_name": "B" }
//   DELETE /functions/v1/email-stack   { "emails": ["a@b.com", ...] }
//
// Requires a signed-in user whose public.users row has is_admin = true. The
// project's anon key is itself a valid JWT, so `verify_jwt` alone would not gate
// this — see requireAdmin.
//
// Runs on the service role because email_stack has RLS enabled with no policies:
// no client, admin or otherwise, can read or write it directly.
import { requireAdmin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { fail, ok, readJson, text } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

// Bounds the work per request; these are hand-managed lists, not bulk imports.
const MAX_EMAILS = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

async function addEmails(entries: Entry[]): Promise<Response> {
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

async function removeEmails(entries: Entry[]): Promise<Response> {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST" && req.method !== "DELETE") {
    return fail("Method not allowed. Use POST to add or DELETE to remove.", 405);
  }

  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await readJson(req);
  if (!body) return fail("A JSON body is required.", 400);

  const parsed = readEntries(body);
  if ("error" in parsed) return fail(parsed.error, 400);

  try {
    return req.method === "POST"
      ? await addEmails(parsed.entries)
      // Removing an address only stops future registrations: it does not touch an
      // account that already registered with it.
      : await removeEmails(parsed.entries);
  } catch (err) {
    console.error("email-stack failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
});
