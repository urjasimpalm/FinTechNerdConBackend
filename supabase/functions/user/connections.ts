// Connection requests: send, accept, reject, and list.
//
//   POST user/connection/request  { "user_id": "<uuid>" }
//   POST user/connection/respond  { "request_id" | "user_id", "action": "accept" | "reject" }
//   GET  user/connection/list?status=pending|sent|accepted|rejected&search=
//
// One row per pair in public.connections, so the state machine is: none →
// pending → accepted | rejected, and a rejected pair can be asked again, which
// reopens the same row with whoever asked second as the requester.
import { fail, ok, text } from "../_shared/http.ts";
import {
  CONNECTION_COLUMNS,
  type ConnectionRow,
  type ConnectionStatus,
  findConnection,
  statusFor,
  summarise,
} from "../_shared/connections.ts";
import { fetchPage, likeTerm, pageMeta, readPage } from "../_shared/pagination.ts";
import { ATTENDEE_ONLY, PERSON_SELECT, shapeProfile } from "../_shared/profile.ts";
import { serviceClient } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What `?status=` means. `pending` is the inbox — requests waiting on me — which
// is what a "connection requests" screen shows; `sent` is the other direction.
// accepted and rejected cover both directions: the pair is settled either way.
const LISTS = {
  pending: { status: "pending", direction: "received" },
  sent: { status: "pending", direction: "sent" },
  accepted: { status: "accepted", direction: null },
  rejected: { status: "rejected", direction: null },
} as const;

type ListKey = keyof typeof LISTS;

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value.trim()) ? value.trim() : null;
}

/** Staff accounts are not attendees, so they cannot be sent a request either. */
async function requireAttendee(userId: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("users")
    .select("id")
    .eq("id", userId)
    .eq(ATTENDEE_ONLY.column, ATTENDEE_ONLY.value)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** POST user/connection/request */
export async function sendRequest(
  body: Record<string, unknown>,
  viewerId: string,
): Promise<Response> {
  const targetId = uuid(body.user_id ?? body.addressee_id);
  if (!targetId) return fail('"user_id" must be an attendee id.', 400);
  if (targetId === viewerId) {
    return fail("You cannot send a connection request to yourself.", 400);
  }
  if (!(await requireAttendee(targetId))) {
    return fail("That attendee could not be found.", 404);
  }

  const service = serviceClient();
  const existing = await findConnection(viewerId, targetId);

  if (existing) {
    const status = statusFor(existing, viewerId);
    if (status === "connected") {
      return fail("You are already connected to this attendee.", 409);
    }
    if (status === "pending_sent") {
      return fail("You have already sent this attendee a request.", 409);
    }
    if (status === "pending_received") {
      // They asked first and now the caller is asking back, which is a yes.
      const { data, error } = await service
        .from("connections")
        .update({ status: "accepted", responded_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select(CONNECTION_COLUMNS)
        .single();
      if (error) throw error;
      return ok(
        "You are now connected — they had already sent you a request.",
        summarise(data as ConnectionRow, viewerId),
      );
    }

    // Rejected: reopen the same row with the caller as the requester, so the pair
    // index stays satisfied.
    const { data, error } = await service
      .from("connections")
      .update({
        requester_id: viewerId,
        addressee_id: targetId,
        status: "pending",
        responded_at: null,
      })
      .eq("id", existing.id)
      .select(CONNECTION_COLUMNS)
      .single();
    if (error) throw error;
    return ok("Connection request sent.", summarise(data as ConnectionRow, viewerId));
  }

  const { data, error } = await service
    .from("connections")
    .insert({ requester_id: viewerId, addressee_id: targetId })
    .select(CONNECTION_COLUMNS)
    .single();

  if (error) {
    // 23505 = the pair index fired, i.e. the other side inserted a row between
    // the lookup above and this insert.
    if (error.code === "23505") {
      return fail("There is already a request between you and this attendee.", 409);
    }
    throw error;
  }

  return ok("Connection request sent.", summarise(data as ConnectionRow, viewerId));
}

/**
 * POST user/connection/respond — one route for both answers, told apart by
 * `action` ("accept" or "reject"). It may also come from the query string, so
 * `?action=reject` works for a client that would rather not put it in the body.
 *
 * Only the addressee of a pending request can answer it — the person who sent it
 * cannot accept their own, and neither side can re-answer one that is settled.
 */
export async function respondToRequest(
  body: Record<string, unknown>,
  viewerId: string,
  queryAction: string | null,
): Promise<Response> {
  const action = (text(body.action) ?? queryAction ?? "").toLowerCase();
  if (action !== "accept" && action !== "reject") {
    return fail('"action" must be "accept" or "reject".', 400);
  }
  const accept = action === "accept";

  const requestId = uuid(body.request_id);
  const targetId = uuid(body.user_id ?? body.requester_id);
  if (!requestId && !targetId) {
    return fail('Send either "request_id" or "user_id".', 400);
  }

  const service = serviceClient();
  let row: ConnectionRow | null;

  if (requestId) {
    const { data, error } = await service
      .from("connections")
      .select(CONNECTION_COLUMNS)
      .eq("id", requestId)
      .maybeSingle();
    if (error) throw error;
    row = data as ConnectionRow | null;
    // Same answer for "no such request" and "not yours": a caller has no business
    // learning that a request they are not part of exists.
    if (row && row.requester_id !== viewerId && row.addressee_id !== viewerId) row = null;
  } else {
    row = await findConnection(viewerId, targetId!);
  }

  if (!row) return fail("That connection request could not be found.", 404);

  if (row.status !== "pending") {
    return fail(
      row.status === "accepted"
        ? "You are already connected to this attendee."
        : "That request has already been rejected.",
      409,
    );
  }
  if (row.addressee_id !== viewerId) {
    return fail("Only the person who received a request can answer it.", 403);
  }

  const { data, error } = await service
    .from("connections")
    .update({
      status: accept ? "accepted" : "rejected",
      responded_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select(CONNECTION_COLUMNS)
    .single();
  if (error) throw error;

  return ok(
    accept ? "Connection request accepted." : "Connection request rejected.",
    summarise(data as ConnectionRow, viewerId),
  );
}

/**
 * GET user/connection/list
 *
 * Defaults to the inbox — requests waiting on the caller. Each row is the other
 * person's card plus the request itself, and the same `search` as the people list
 * (name, nerd number, company, title) narrows it.
 *
 * Paged over public.connection_people, which flattens each pair into one row per
 * side and carries the other person's search text — so the page and its count are
 * exact, and the cards are fetched for that page only.
 */
export async function listConnections(url: URL, viewerId: string): Promise<Response> {
  const requested = (url.searchParams.get("status") ?? "pending").trim().toLowerCase();
  const key = requested as ListKey;
  if (!(key in LISTS)) {
    return fail(
      `Unknown status "${requested}". Use ${Object.keys(LISTS).join(", ")}.`,
      400,
    );
  }
  const list = LISTS[key];

  const page = readPage(url.searchParams);
  if ("error" in page) return fail(page.error, 400);

  const search = url.searchParams.get("search")?.trim() || null;
  const service = serviceClient();

  const build = (headOnly: boolean) => {
    let query = service
      .from("connection_people")
      .select(
        "request_id, status, direction, other_id, created_at, responded_at",
        { count: "exact", head: headOnly },
      )
      .eq("viewer_id", viewerId)
      .eq("status", list.status)
      // Staff are invisible to attendees, including a request an admin sent.
      .not("other_is_admin", "is", true)
      .order("created_at", { ascending: false })
      .order("request_id");

    if (list.direction) query = query.eq("direction", list.direction);
    if (search) query = query.ilike("other_search_text", likeTerm(search));
    return query;
  };

  const result = await fetchPage(build, page);
  if ("error" in result) {
    console.error("connection list failed", result.error);
    return fail("Something went wrong. Please try again.", 500);
  }

  // The cards for this page only — at most per_page of them.
  const people = new Map<string, Record<string, unknown>>();
  const ids = result.rows.map((row) => row.other_id as string);
  if (ids.length > 0) {
    const { data, error } = await service.from("users").select(PERSON_SELECT).in("id", ids);
    if (error) throw error;
    for (const row of data ?? []) {
      people.set((row as Record<string, unknown>).id as string, shapeProfile(row));
    }
  }

  const requests = result.rows.map((row) => ({
    request_id: row.request_id as string,
    status: viewStatus(row.status as string, row.direction as string),
    created_at: row.created_at as string,
    responded_at: row.responded_at as string | null,
    user: people.get(row.other_id as string) ?? null,
  }));

  const noun = result.total === 1 ? "request" : "requests";
  return ok(
    key === "accepted"
      ? `${result.total} ${result.total === 1 ? "connection" : "connections"}.`
      : `${result.total} ${key === "sent" ? "sent " : ""}${noun}.`,
    {
      requests,
      status: key,
      search,
      pagination: pageMeta(result.total, page),
    },
  );
}

/** The view's (status, direction) pair as the status the client reads. */
function viewStatus(status: string, direction: string): ConnectionStatus {
  if (status === "accepted") return "connected";
  if (status === "rejected") return "rejected";
  return direction === "sent" ? "pending_sent" : "pending_received";
}
