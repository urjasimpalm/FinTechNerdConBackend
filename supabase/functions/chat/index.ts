// Chat. One function, routed on the path after its name:
//
//   POST /functions/v1/chat/create        { "user_id": "<uuid>" }
//   GET  /functions/v1/chat/list          ?search=&page=&per_page=
//   GET  /functions/v1/chat/details/{id}  ?page=&per_page=
//   POST /functions/v1/chat/send/{id}     { "message": "..." }
//
// Every route needs a real user token and only ever touches chats the caller is a
// participant of — membership is checked on the way in, so there is no way to read
// or post into someone else's conversation.
//
// Runs on the service role. The tables have participant-only RLS policies that a
// client could work with directly, but creating a chat that way takes three
// writes that cannot read their own rows back (see postman/API.md §8), and a chat
// list needs a last message and an unread count that PostgREST cannot express.
// public.start_direct_chat() and public.chat_overview do both in one round trip.
import { requireUser } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { fail, ok, readJson, text } from "../_shared/http.ts";
import { fetchPage, likeTerm, pageMeta, readPage } from "../_shared/pagination.ts";
import { ATTENDEE_ONLY, PERSON_SELECT, shapeProfile } from "../_shared/profile.ts";
import { serviceClient } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4000;
const MESSAGE_COLUMNS = "id, chat_id, sender_id, body, created_at";

const ROUTES = [
  "POST chat/create",
  "GET chat/list",
  "GET chat/details/{id}",
  "POST chat/send/{id}",
];

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value.trim()) ? value.trim() : null;
}

/** The cards for a page of chats, fetched once for every participant on it. */
async function peopleById(
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const cards = new Map<string, Record<string, unknown>>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return cards;

  const { data, error } = await serviceClient()
    .from("users")
    .select(PERSON_SELECT)
    .in("id", wanted);
  if (error) throw error;

  for (const row of data ?? []) {
    const person = row as Record<string, unknown>;
    cards.set(person.id as string, shapeProfile(person));
  }
  return cards;
}

/**
 * POST chat/create — start (or reopen) the 1:1 chat with someone.
 *
 * Find-or-create, so the button can be tapped twice without ending up with two
 * conversations: `created` says which happened.
 */
async function createChat(
  body: Record<string, unknown>,
  me: string,
): Promise<Response> {
  const otherId = uuid(body.user_id ?? body.other_user_id);
  if (!otherId) return fail('"user_id" must be an attendee id.', 400);
  if (otherId === me) return fail("You cannot start a chat with yourself.", 400);

  const service = serviceClient();

  // Staff accounts are not attendees: an admin id reads as "no such person" here,
  // the same as it does in the directory.
  const { data: other, error: otherError } = await service
    .from("users")
    .select(PERSON_SELECT)
    .eq("id", otherId)
    .eq(ATTENDEE_ONLY.column, ATTENDEE_ONLY.value)
    .maybeSingle();
  if (otherError) throw otherError;
  if (!other) return fail("That attendee could not be found.", 404);

  // Was there already one? Only to tell "opened" from "started" in the message —
  // the RPC is what decides, and it is race-safe.
  const existing = await service
    .from("chats")
    .select("id")
    .eq(
      "direct_key",
      [me, otherId].sort().join(":"),
    )
    .maybeSingle();
  if (existing.error) throw existing.error;

  const { data: chatId, error } = await service.rpc("start_direct_chat", {
    p_user_id: me,
    p_other_id: otherId,
  });

  if (error) {
    console.error("start_direct_chat failed", error);
    return fail(
      error.code === "P0001"
        ? error.message
        : "The chat could not be started. Please try again.",
      400,
    );
  }

  const created = existing.data === null;
  return ok(created ? "Chat started." : "Chat opened.", {
    chat_id: chatId,
    created,
    user: shapeProfile(other as Record<string, unknown>),
  });
}

/**
 * GET chat/list — my chats, most recently active first.
 *
 * Read from public.chat_overview, so each row already carries the other person,
 * the last message and the unread count. `search` matches the other person the
 * same way the directory does (name, nerd number, company, title).
 */
async function listChats(url: URL, me: string): Promise<Response> {
  const page = readPage(url.searchParams);
  if ("error" in page) return fail(page.error, 400);

  const search = url.searchParams.get("search")?.trim() || null;
  const service = serviceClient();

  // Searching means narrowing to the people who match first: the overview has the
  // other person's id, not their searchable text.
  let onlyOtherIds: string[] | null = null;
  if (search) {
    const { data, error } = await service
      .from("users")
      .select("id")
      .ilike("search_text", likeTerm(search));
    if (error) throw error;
    const matched = (data ?? []).map((row: { id: string }) => row.id);
    onlyOtherIds = matched;
    if (matched.length === 0) {
      return ok("No chats match.", { chats: [], search, pagination: pageMeta(0, page) });
    }
  }

  const build = (headOnly: boolean) => {
    let query = service
      .from("chat_overview")
      .select(
        "chat_id, is_group, created_at, other_user_id, last_message_id, last_message_body, last_message_sender_id, last_message_at, unread_count",
        { count: "exact", head: headOnly },
      )
      .eq("viewer_id", me)
      // Staff are invisible to attendees, including a chat an admin started.
      // `not.is.true` rather than `eq.false` so a group chat, where there is no
      // single other person, is not filtered out with them.
      .not("other_is_admin", "is", true)
      // A brand new chat has no messages yet, so it sorts on its own creation.
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (onlyOtherIds) query = query.in("other_user_id", onlyOtherIds);
    return query;
  };

  const result = await fetchPage(build, page);
  if ("error" in result) {
    console.error("chat list failed", result.error);
    return fail("Something went wrong. Please try again.", 500);
  }

  const cards = await peopleById(
    result.rows.map((row) => row.other_user_id as string),
  );

  const chats = result.rows.map((row) => ({
    chat_id: row.chat_id,
    is_group: row.is_group,
    created_at: row.created_at,
    unread_count: Number(row.unread_count ?? 0),
    user: cards.get(row.other_user_id as string) ?? null,
    last_message: row.last_message_id
      ? {
        id: row.last_message_id,
        body: row.last_message_body,
        sender_id: row.last_message_sender_id,
        is_mine: row.last_message_sender_id === me,
        created_at: row.last_message_at,
      }
      : null,
  }));

  const total = result.total;
  return ok(`${total} chat${total === 1 ? "" : "s"}.`, {
    chats,
    search,
    pagination: pageMeta(total, page),
  });
}

/**
 * GET chat/details/{id} — the chat, the other person, and a page of messages.
 *
 * Newest first, so page 1 is what the screen opens on; reverse the array to
 * render oldest-at-top. Opening the chat also marks it read, which is what clears
 * `unread_count` in the list — there is no separate "mark read" call.
 */
async function chatDetails(chatId: string, url: URL, me: string): Promise<Response> {
  const page = readPage(url.searchParams);
  if ("error" in page) return fail(page.error, 400);

  const service = serviceClient();

  const { data: overview, error: overviewError } = await service
    .from("chat_overview")
    .select("chat_id, is_group, created_at, other_user_id, unread_count")
    .eq("viewer_id", me)
    .eq("chat_id", chatId)
    // Same filter as the list, so a chat with a staff account is not merely
    // hidden from the list but unopenable by id too.
    .not("other_is_admin", "is", true)
    .maybeSingle();
  if (overviewError) throw overviewError;
  // Same answer for "no such chat" and "not yours": a caller has no business
  // learning that a conversation they are not in exists.
  if (!overview) return fail("That chat could not be found.", 404);

  const build = (headOnly: boolean) =>
    service
      .from("chat_messages")
      .select(MESSAGE_COLUMNS, { count: "exact", head: headOnly })
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

  const result = await fetchPage(build, page);
  if ("error" in result) {
    console.error("chat messages failed", result.error);
    return fail("Something went wrong. Please try again.", 500);
  }

  const [cards] = await Promise.all([
    peopleById([overview.other_user_id as string]),
    // Best effort: failing to bump the read marker should not fail the read.
    service
      .from("chat_participants")
      .update({ last_read_at: new Date().toISOString() })
      .eq("chat_id", chatId)
      .eq("user_id", me),
  ]);

  const messages = result.rows.map((row) => ({
    ...row,
    is_mine: row.sender_id === me,
  }));

  return ok("Chat loaded.", {
    chat_id: overview.chat_id,
    is_group: overview.is_group,
    created_at: overview.created_at,
    // The count from before this call marked everything read, so a badge can be
    // cleared with the same payload that fills the screen.
    unread_count: Number(overview.unread_count ?? 0),
    user: cards.get(overview.other_user_id as string) ?? null,
    messages,
    pagination: pageMeta(result.total, page),
  });
}

/** POST chat/send/{id} — post a message to a chat I am in. */
async function sendMessage(
  chatId: string,
  body: Record<string, unknown>,
  me: string,
): Promise<Response> {
  const message = text(body.message ?? body.body);
  if (!message) return fail('"message" cannot be empty.', 400);
  if (message.length > MAX_MESSAGE_LENGTH) {
    return fail(`Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.`, 400);
  }

  const service = serviceClient();

  // Membership plus the same staff filter the other two routes apply, so a chat
  // that is invisible cannot be posted into either.
  const { data: visible, error: visibleError } = await service
    .from("chat_overview")
    .select("chat_id")
    .eq("viewer_id", me)
    .eq("chat_id", chatId)
    .not("other_is_admin", "is", true)
    .maybeSingle();
  if (visibleError) throw visibleError;
  if (!visible) return fail("That chat could not be found.", 404);

  const { data, error } = await service
    .from("chat_messages")
    .insert({ chat_id: chatId, sender_id: me, body: message })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;

  // Sending is reading, as far as the unread badge goes.
  await service
    .from("chat_participants")
    .update({ last_read_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("user_id", me);

  return ok("Message sent.", { ...data, is_mine: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // The path arrives as /chat/<route> locally and /functions/v1/chat/<route>
  // through some gateways, so key off the function name rather than an offset.
  const parts = url.pathname.split("/").filter(Boolean);
  const nameAt = parts.indexOf("chat");
  const segments = nameAt >= 0 ? parts.slice(nameAt + 1) : [];
  const route = segments.join("/");

  const gate = await requireUser(req);
  if ("response" in gate) return gate.response;
  const me = gate.caller.id;

  try {
    if (route === "create") {
      if (req.method !== "POST") return methodNotAllowed(route, "POST");
      const body = await readJson(req);
      if (!body) return fail("A JSON body is required.", 400);
      return await createChat(body, me);
    }

    if (route === "list") {
      if (req.method !== "GET") return methodNotAllowed(route, "GET");
      return await listChats(url, me);
    }

    // details/{id} and send/{id}
    if (segments.length === 2 && (segments[0] === "details" || segments[0] === "send")) {
      const chatId = uuid(segments[1]);
      if (!chatId) return fail("That is not a chat id.", 400);

      if (segments[0] === "details") {
        if (req.method !== "GET") return methodNotAllowed(route, "GET");
        return await chatDetails(chatId, url, me);
      }

      if (req.method !== "POST") return methodNotAllowed(route, "POST");
      const body = await readJson(req);
      if (!body) return fail("A JSON body is required.", 400);
      return await sendMessage(chatId, body, me);
    }

    return fail(
      `Unknown chat route "${route}". Available: ${ROUTES.join(", ")}.`,
      404,
    );
  } catch (err) {
    console.error(`chat/${route} failed`, err);
    return fail("Something went wrong. Please try again.", 500);
  }
});

function methodNotAllowed(route: string, expected: string): Response {
  return fail(`Method not allowed. Use ${expected} for chat/${route}.`, 405);
}
