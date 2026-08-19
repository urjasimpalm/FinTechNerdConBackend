# FinTechNerdCon — Front-end API guide

Every request/response example in this document was run against the local stack,
so the shapes are what the API actually returns.

A Postman collection covering every endpoint here lives next to this file:
import [FinTechNerdCon.postman_collection.json](FinTechNerdCon.postman_collection.json)
and [FinTechNerdCon.postman_environment.json](FinTechNerdCon.postman_environment.json),
then run **1. Auth → Login** — it stores the token for every other request.

The backend has two kinds of endpoint:

- **Edge functions** (`/functions/v1/...`) — custom logic. Right now: register and login.
- **Auto-generated REST** (`/rest/v1/...`) — direct table access, guarded by
  row-level security so a signed-in user can only ever reach their own data.
  Everything after login (profile, agenda, chat, missions, notifications) uses this.

---

## 1. Connecting

| | Base URL |
| --- | --- |
| Local | `http://127.0.0.1:54321` |
| Deployed | `https://<project-ref>.supabase.co` |

Headers on every request:

| Header | Value | When |
| --- | --- | --- |
| `apikey` | anon/publishable key | Always |
| `Authorization` | `Bearer <token>` | Always after login; omit for register/login |
| `Content-Type` | `application/json` | On POST/PATCH |

```ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

`supabase-js` sets `apikey` and `Authorization` for you. Get the local values
from `supabase status`.

---

## 2. Auth

### 2.1 Verify email — is this email on the attendee list?

Registration is invite-only: the email must already exist in `email_stack`.
Use this to show "you're not on the list" before asking for a password.
Matching ignores case and surrounding spaces.

```
POST /functions/v1/verify-email
```

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | string | yes | Email to look up |

Every response has the same three keys — `status` (`"Success"` / `"Error"`),
`message`, and `data`:

```json
{
  "status": "Success",
  "message": "This email is on the attendee list.",
  "data": { "email_exist": true }
}
```

| Status | Body |
| --- | --- |
| 200 | `{ "status": "Success", "message": "This email is on the attendee list.", "data": { "email_exist": true } }` |
| 200 | `{ "status": "Success", "message": "This email is not on the attendee list.", "data": { "email_exist": false } }` |
| 400 | `{ "status": "Error", "message": "Email is required.", "data": null }` |
| 400 | `{ "status": "Error", "message": "A JSON body is required.", "data": null }` |
| 405 | `{ "status": "Error", "message": "Method not allowed.", "data": null }` — must be POST |
| 500 | `{ "status": "Error", "message": "Something went wrong. Please try again.", "data": null }` |

A miss is a **`Success` with `email_exist: false`**, not an error — the lookup
worked, the answer is just no. Branch on `data.email_exist`, and `data` is
`null` on every error path so the three keys are always safe to read.

```ts
const { data: res } = await supabase.functions.invoke("verify-email", {
  body: { email },
});
if (!res.data.email_exist) showNotOnListMessage();
```

This step is optional — `register` runs the same check itself and returns
`403 { email_in_stack: false }` if the email isn't on the list.

The underlying SQL helper (`public.verify_email`) is executable by the service
role only, so this function is the single way to ask the question. Worth putting
rate limiting in front of it before the event, since it will confirm whether a
given address is an invited attendee.

### 2.2 Register

```
POST /functions/v1/register
```

| Parameter | Type | Required | Constraints |
| --- | --- | --- | --- |
| `email` | string | yes | Valid email, must be on the attendee list. Lower-cased server-side |
| `password` | string | yes | Min 8 characters |
| `first_name` | string | yes | Non-empty |
| `last_name` | string | yes | Non-empty |
| `user_type_config_id` | integer | no | `configs.id` where `type = 'user_type'` (Builder / Operator / Explorer) |
| `guild_id` | integer | no | `guilds.id` |
| `company_name` | string | no | |
| `job_title` | string | no | |
| `profile_image` | string | no | URL |
| `device_type` | integer | no | For push delivery |
| `device_token` | string | no | FCM/APNs token |

**201 — created and signed in**

```json
{
  "success": true,
  "email_in_stack": true,
  "message": "Registration successful.",
  "data": {
    "token": "eyJhbGciOi...",
    "token_type": "bearer",
    "expires_in": 3600,
    "expires_at": 1786728189,
    "refresh_token": "2r5psksaujyt",
    "user": {
      "id": "032b5171-0456-4db4-ab1e-571a77e15286",
      "first_name": "Test",
      "last_name": "User",
      "email": "you@example.com",
      "user_type_config_id": null,
      "guild_id": null,
      "company_name": null,
      "job_title": null,
      "profile_image": null,
      "device_type": null,
      "device_token": null,
      "created_at": "2026-08-14T16:23:09.433673+00:00",
      "updated_at": "2026-08-14T16:23:09.433673+00:00"
    }
  }
}
```

| Status | Body | What the UI should do |
| --- | --- | --- |
| 201 | above | Store the session, go to the app |
| 403 | `{ "success": false, "email_in_stack": false, "message": "This email is not on the attendee list." }` | Show "not on the list"; nothing was created |
| 409 | `{ "success": false, "email_in_stack": true, "message": "An account with this email already exists." }` | Send them to login |
| 400 | `{ "success": false, "message": "..." }` | Show the message (missing field, short password, bad `guild_id`/`user_type_config_id`) |
| 500 | `{ "success": false, "message": "Something went wrong. Please try again." }` | Generic retry |

Register already returns a session, so **do not** call login afterwards.

### 2.3 Login

```
POST /functions/v1/login
```

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | string | yes | Case-insensitive, trimmed |
| `password` | string | yes | |

| Status | Body |
| --- | --- |
| 200 | `{ "success": true, "message": "Login successful.", "data": { token, token_type, expires_in, expires_at, refresh_token, user } }` |
| 401 | `{ "success": false, "message": "Invalid email or password." }` |
| 400 | `{ "success": false, "message": "Email and password are required." }` |
| 405 | `{ "success": false, "message": "Method not allowed." }` — must be POST |

`data` is identical in shape to register's. Wrong password and unknown email
both return the same 401 on purpose, so no one can probe which emails have
accounts — don't try to distinguish them in the UI.

### 2.4 Forgot password

Step 1 of the reset: emails a 6-digit code. Uses the `{ status, message, data }`
envelope.

```
POST /functions/v1/forgot-password
```

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | string | yes | Case-insensitive, trimmed |
| `redirect_to` | string | no | Only for the web/link variant — where the emailed link should land |

| Status | Body |
| --- | --- |
| 200 | `{ "status": "Success", "message": "If that email has an account, a reset code is on its way.", "data": { "email_sent": true } }` |
| 400 | `{ "status": "Error", "message": "Please enter a valid email address.", "data": null }` |
| 429 | `{ "status": "Error", "message": "For security purposes, you can only request this after N seconds.", "data": null }` |
| 500 | `{ "status": "Error", "message": "Something went wrong. Please try again.", "data": null }` |

**An unknown email also returns 200.** That's deliberate: a different response
would turn this into a way to discover which addresses have accounts. So the UI
should say "check your email" without claiming an email was definitely sent, and
must not branch on whether the account exists.

### 2.5 Reset password

Step 2: exchanges the code for a new password. Owning the code is what authorises
the change, so no session is needed. Returns a session on success, so the app can
go straight into the logged-in state.

```
POST /functions/v1/reset-password
```

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | string | with `token` | The address the code was sent to |
| `token` | string | yes\* | The 6-digit code from the email |
| `token_hash` | string | yes\* | Alternative to `email` + `token`: the `token` query param from the emailed link (web flow) |
| `password` | string | yes | The new password, min 8 characters |

\* Send either `email` + `token`, or `token_hash` on its own.

| Status | Body |
| --- | --- |
| 200 | `{ "status": "Success", "message": "Your password has been reset.", "data": { token, token_type, expires_in, expires_at, refresh_token, user } }` |
| 400 | `{ "status": "Error", "message": "This reset code is invalid or has expired.", "data": null }` |
| 400 | `{ "status": "Error", "message": "Password must be at least 8 characters.", "data": null }` |
| 400 | `{ "status": "Error", "message": "Email and the reset code are required.", "data": null }` |
| 400 | `{ "status": "Error", "message": "New password should be different from the old password.", "data": null }` — passed through from auth |
| 405 | `{ "status": "Error", "message": "Method not allowed.", "data": null }` |

`data` matches login's, so the client can reuse the same session-handling path.
The code is single-use: a second attempt with the same one returns the
invalid-or-expired 400. Wrong, used and expired codes share one message on
purpose.

**Requesting a new code invalidates the previous one.** If the user taps "resend"
they must use the newest email — so don't keep a code the app captured earlier,
and expect the invalid-or-expired 400 when someone works from an older message.

```ts
// step 1
await supabase.functions.invoke("forgot-password", { body: { email } });

// step 2 — after the user types the code from the email
const { data: res } = await supabase.functions.invoke("reset-password", {
  body: { email, token: code, password: newPassword },
});
await supabase.auth.setSession({
  access_token: res.data.token,
  refresh_token: res.data.refresh_token,
});
```

The 6-digit code comes from the recovery email template, which must include
`{{ .Token }}`. That's configured for local dev in
[supabase/config.toml](../supabase/config.toml) →
[supabase/templates/recovery.html](../supabase/templates/recovery.html). **On the
hosted project it has to be set separately** under Authentication → Emails →
Reset Password, otherwise the deployed endpoint only works with `token_hash`.

Also worth knowing before launch: hosted projects rate limit the built-in email
sender hard (a couple of messages per hour), so real password resets need custom
SMTP configured.

### 2.6 Reading errors from `functions.invoke`

`invoke()` collapses every non-2xx into `error` and does not parse the body. The
403/409 cases above carry meaning, so unwrap them:

```ts
import { FunctionsHttpError } from "@supabase/supabase-js";

async function callFn(name: string, body: unknown) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error instanceof FunctionsHttpError) {
    throw await error.context.json();   // { success:false, email_in_stack?, message }
  }
  if (error) throw error;
  return data;
}
```

### 2.7 Holding the session

After register/login, hand the tokens to the SDK, or every later request runs as
anonymous and RLS returns empty results:

```ts
await supabase.auth.setSession({
  access_token: res.data.token,
  refresh_token: res.data.refresh_token,
});
```

The access token expires after 1 hour (`expires_in`). With `setSession` the SDK
refreshes it automatically; if you store tokens yourself, call
`supabase.auth.refreshSession({ refresh_token })` or send
`POST /auth/v1/token?grant_type=refresh_token` with `{ "refresh_token": "..." }`.

Logout is client-side: `supabase.auth.signOut()` (or
`POST /auth/v1/logout` with the bearer token).

---

## 3. Conventions for the REST endpoints

Query parameters (PostgREST syntax) used throughout the rest of this document:

| Parameter | Example | Meaning |
| --- | --- | --- |
| `select` | `select=id,name` | Columns to return; `*` for all |
| embedding | `select=id,agenda(name)` | Pull in a related table |
| filter | `id=eq.<uuid>`, `type=eq.user_type`, `read_at=is.null`, `points=gte.50` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is` |
| `order` | `order=created_at.desc` | Sort; add `.asc`/`.desc` |
| `limit` / `offset` | `limit=20&offset=40` | Paging |
| `Prefer: count=exact` | header | Total row count in the `Content-Range` response header |
| `Prefer: return=representation` | header | Return the written row(s); `supabase-js` sends this when you chain `.select()` |

Errors look like this (not the `{ success, message }` envelope the functions use):

```json
{ "code": "23503", "details": "Key is not present in table \"agenda\".", "hint": null, "message": "insert or update on table \"user_agenda\" violates foreign key constraint ..." }
```

Common codes: `23503` foreign key, `23505` duplicate, `42501` RLS/permission denied.

**Two behaviours worth knowing before you build screens:**

1. **Writes to rows you don't own return `200 []`, not an error.** RLS filters the
   rows out, so the statement matches nothing. Treat an empty array from a
   PATCH/DELETE as "not yours / not found".
2. **A few inserts must not ask for the row back** — see [§7 Chat](#7-chat).
   Asking for the inserted row (`.select()`) fails with `42501` when the row is
   only visible *after* a second row exists.

---

## 4. Profile and attendee directory

Table `users`. Columns: `id`, `first_name`, `last_name`, `email`,
`user_type_config_id`, `guild_id`, `company_name`, `job_title`, `profile_image`,
`device_type`, `device_token`, `created_at`, `updated_at`.

Rows are created only by `register`. Every signed-in user can read the whole
directory, but can update and delete only their own row.

| Action | Call |
| --- | --- |
| My profile | `GET /rest/v1/users?select=*&id=eq.<my-id>` |
| Update my profile | `PATCH /rest/v1/users?id=eq.<my-id>` |
| Directory | `GET /rest/v1/users?select=id,first_name,last_name,company_name,job_title,profile_image&limit=20` |
| Filter by guild | `...&guild_id=eq.2` |
| Search by name | `...&or=(first_name.ilike.*ann*,last_name.ilike.*ann*)` |
| Delete my account | `DELETE /rest/v1/users?id=eq.<my-id>` |

Updatable fields: `first_name`, `last_name`, `user_type_config_id`, `guild_id`,
`company_name`, `job_title`, `profile_image`, `device_type`, `device_token`.
(`email` lives in auth — change it with `supabase.auth.updateUser`.)

```ts
const { data: { user } } = await supabase.auth.getUser();

await supabase.from("users")
  .update({ job_title: "Engineer", guild_id: 1 })
  .eq("id", user.id)
  .select();

// directory with the guild name joined in
await supabase.from("users")
  .select("id, first_name, last_name, company_name, guilds(name)")
  .limit(20);
```

Register a push token at login by patching `device_type` and `device_token`.

---

## 5. Config / reference data

```
GET /functions/v1/config
```

Every lookup list the app needs to render pickers, in one call. **No session
required** — the register screen needs the guild and user-type lists before the
user has a token.

| Variant | Returns |
| --- | --- |
| `GET /functions/v1/config` | Everything |
| `GET /functions/v1/config/guilds` | `guilds` only |
| `GET /functions/v1/config/user_type` | That one config type |
| `GET /functions/v1/config?type=event-day,stage-type` | Several types (comma-separated) |

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| path segment | string | no | `guilds` or a `configs.type` value |
| `type` | string | no | Comma-separated list of `configs.type` values. Ignored if a path segment is given |

**200**

```json
{
  "success": true,
  "data": {
    "guilds": [
      { "id": 1, "name": "AI & Agentic Systems", "description": "..." },
      { "id": 2, "name": "Banking", "description": "..." }
    ],
    "user_type":   [{ "id": 1, "name": "Builder" }, { "id": 2, "name": "Operator" }, { "id": 3, "name": "Explorer" }],
    "event-quest": [{ "id": 4, "name": "Main Quests" }, { "id": 5, "name": "Side Quests" }, { "id": 6, "name": "Bonus Quests" }, { "id": 7, "name": "My Schedule" }],
    "event-day":   [{ "id": 8, "name": "Day 0" }, { "id": 9, "name": "Day 1" }, { "id": 10, "name": "Day 2" }],
    "stage-type":  [{ "id": 11, "name": "Stage 1" }, { "id": 12, "name": "Stage 2" }, { "id": 13, "name": "Stage 3" }, { "id": 14, "name": "Stage 4" }]
  }
}
```

| Status | Body |
| --- | --- |
| 200 | above — `guilds` rows have `description`, config rows are `{ id, name }` |
| 404 | `{ "success": false, "message": "Unknown config type \"typo\".", "available": ["guilds", "event-day", ...] }` — path form only |
| 405 | `{ "success": false, "message": "Method not allowed." }` — GET only |

Keys are the literal `configs.type` values from the database, so hyphenated ones
need bracket access: `data["event-quest"]`, not `data.event_quest`. A new config
type appears here automatically with no backend change.

Responses carry `Cache-Control: public, max-age=300`. Fetch once at app start
and keep it in memory rather than per screen.

```ts
const { data: res } = await supabase.functions.invoke("config", { method: "GET" });
const guilds = res.data.guilds;
const userTypes = res.data.user_type;
const days = res.data["event-day"];

// or just the one list, e.g. on the signup screen
const { data: g } = await supabase.functions.invoke("config/guilds", { method: "GET" });
```

The ids are a single shared sequence across all types — `user_type` is 1–3,
`event-quest` 4–7, `event-day` 8–10, `stage-type` 11–14 — so always match on
`type` + `id`, never on `id` alone.

Note the two `type=` forms differ on unknown values on purpose: a bad path
segment is a typo and returns 404, while `?type=nope` returns `{"nope": []}` so
a multi-type request isn't derailed by one bad entry.

### Direct table access (signed-in users)

The same data is readable over REST once the user has a token, if you'd rather
filter server-side:

| Table | Call |
| --- | --- |
| `guilds` | `GET /rest/v1/guilds?select=id,name,description&order=id` |
| `configs` | `GET /rest/v1/configs?select=id,name&type=eq.user_type` |

---

## 6. Missions and leaderboard

`missions` (catalog, read-only): `id`, `title`, `description`, `points`, `is_active`.
`user_missions` (own rows only): `id`, `user_id`, `mission_id`, `status`,
`points_awarded`, `completed_at`, `created_at`, `updated_at`.

| Action | Call |
| --- | --- |
| Mission catalog | `GET /rest/v1/missions?select=*&is_active=eq.true&order=id` |
| My progress | `GET /rest/v1/user_missions?select=*,missions(title,points)` |
| Complete a mission | `POST /rest/v1/user_missions?on_conflict=user_id,mission_id` with `Prefer: resolution=merge-duplicates` |
| Leaderboard | `GET /rest/v1/leaderboard?select=*,users(first_name,last_name)&order=rank.asc&limit=50` |

`user_missions` insert parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `user_id` | uuid | yes | Must equal the signed-in user |
| `mission_id` | integer | yes | |
| `status` | string | no | `in_progress` (default) or `completed` |
| `points_awarded` | integer | no | Defaults to 0 |
| `completed_at` | timestamptz | no | |

One row per `(user_id, mission_id)`, so use upsert to avoid a `23505`. Naming the
conflict target matters: without `onConflict` (raw REST: `?on_conflict=...`)
PostgREST aims at the primary key instead and a repeat completion returns `409`.

```ts
await supabase.from("user_missions").upsert({
  user_id: user.id,
  mission_id: 1,
  status: "completed",
  points_awarded: 50,
  completed_at: new Date().toISOString(),
}, { onConflict: "user_id,mission_id" }).select();
```

`leaderboard` is a view of completed missions: `user_id`, `total_points`, `rank`.
It shows every attendee (not just you), and `users(...)` can be embedded for names.
`points_awarded` is set by the client, so it is only as trustworthy as the app.

---

## 7. Agenda

`agenda` (read-only): `id`, `name`, `description`, `day`, `start_time`,
`end_time`, `speaker_name`, `speaker_title`, `speaker_company`, `location`,
`event_quest_config_id`, `event_day_config_id`, `stage_config_id`,
`is_sponsored`, `sort_order`, `status`, `created_at`.

Guilds are many-to-many through `agenda_guilds (agenda_id, guild_id)` — the old
`agenda.guild_id` column was dropped, don't reference it.

`user_agenda` (own rows, insert/delete only — no update): `id`, `user_id`,
`agenda_id`, `day`, `created_at`, unique on `(user_id, agenda_id)`.

| Action | Call |
| --- | --- |
| Full agenda | `GET /rest/v1/agenda?select=*&order=sort_order` |
| Filter by day | `...&event_day_config_id=eq.8` or `day=eq.2026-09-01` |
| Filter by quest type | `...&event_quest_config_id=eq.4` |
| Filter by guild | `GET /rest/v1/agenda_guilds?select=agenda(*)&guild_id=eq.1` |
| My schedule | `GET /rest/v1/user_agenda?select=id,day,agenda(*)` |
| Add to my schedule | `POST /rest/v1/user_agenda?on_conflict=user_id,agenda_id` |
| Remove | `DELETE /rest/v1/user_agenda?agenda_id=eq.<agenda-id>` |

```ts
// agenda with the quest-type name and guild names resolved
await supabase.from("agenda").select(`
  id, name, start_time, end_time, location, speaker_name, status,
  event_quest_config:configs!agenda_event_quest_config_id_fkey(name),
  agenda_guilds(guilds(name))
`).order("sort_order");

// bookmark a session (unique per user+session, so upsert is safest)
await supabase.from("user_agenda")
  .upsert({ user_id: user.id, agenda_id, day }, { onConflict: "user_id,agenda_id" })
  .select();
```

`agenda` has three separate FKs to `configs`, so an embedded `configs(...)` is
ambiguous — name the constraint as shown above.

---

## 8. Chat

`chats`: `id`, `is_group`, `created_at` — visible only to participants.
`chat_participants`: `id`, `chat_id`, `user_id`, `joined_at`, unique per pair.
`chat_messages`: `id`, `chat_id`, `sender_id`, `body`, `created_at` — insert only,
messages cannot be edited or deleted.

**Creating a chat takes three writes, and the first two must not request the row
back.** A chat is only readable once you are a participant, so
`insert(...).select()` fails with `42501` — generate the id on the client instead:

```ts
const chatId = crypto.randomUUID();

// 1. the chat — no .select()
await supabase.from("chats").insert({ id: chatId, is_group: false });

// 2. yourself, then the other person — no .select()
await supabase.from("chat_participants").insert([
  { chat_id: chatId, user_id: user.id },
  { chat_id: chatId, user_id: otherUserId },
]);

// 3. from here on everything reads normally
await supabase.from("chat_messages")
  .insert({ chat_id: chatId, sender_id: user.id, body: text })
  .select();
```

| Action | Call |
| --- | --- |
| My chats | `GET /rest/v1/chats?select=id,is_group,created_at,chat_participants(user_id),chat_messages(body,created_at)&order=created_at.desc` |
| Messages in a chat | `GET /rest/v1/chat_messages?select=id,body,created_at,sender:users(id,first_name,last_name,profile_image)&chat_id=eq.<id>&order=created_at.asc` |
| Send | `POST /rest/v1/chat_messages` with `chat_id`, `sender_id` (must be you), `body` |
| Add a member | `POST /rest/v1/chat_participants` (you must already be in the chat) |

Live updates:

```ts
supabase.channel(`chat:${chatId}`)
  .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `chat_id=eq.${chatId}` },
      ({ new: message }) => append(message))
  .subscribe();
```

---

## 9. Notifications

`notifications`: `id`, `user_id`, `type`, `title`, `body`, `data` (jsonb),
`read_at`, `created_at`.

Rows are written server-side only — the app can list, mark read, and delete, but
never create. `type` is one of `chat_message`, `mission`, `agenda`,
`announcement`; `data` carries the deep-link target, e.g.
`{"chat_id": "96c8b869-..."}`.

| Action | Call |
| --- | --- |
| List | `GET /rest/v1/notifications?select=*&order=created_at.desc&limit=20` |
| Unread badge | `HEAD /rest/v1/notifications?select=id&read_at=is.null` with `Prefer: count=exact` → read `Content-Range: 0-0/1` |
| Mark one read | `PATCH /rest/v1/notifications?id=eq.<id>` body `{"read_at":"<now>"}` |
| Mark all read | `PATCH /rest/v1/notifications?read_at=is.null` body `{"read_at":"<now>"}` |
| Delete | `DELETE /rest/v1/notifications?id=eq.<id>` |

```ts
// unread count without pulling the rows
const { count } = await supabase.from("notifications")
  .select("id", { count: "exact", head: true })
  .is("read_at", null);

await supabase.from("notifications")
  .update({ read_at: new Date().toISOString() })
  .is("read_at", null);          // mark-all-read
```

**`read_at` is the only column the app may write.** Patching `title`, `body` or
`data` returns `42501 permission denied for table notifications` — by design, so
a notification can't be rewritten after it was sent. Don't send the whole object
back in an update; send `{ read_at }` alone.

---

## 10. Announcement

One event-wide banner that admins edit and every signed-in user reads. Admins
manage it through [§11.4](#114-get-adminannouncementget) and
[§11.5](#115-post-adminannouncementpost); reading it is plain REST.

| Action | Call |
| --- | --- |
| Read the announcement | `GET /rest/v1/announcements?select=text,updated_at` |

`announcements` holds a single row pinned to `id = 1`: `text`, `updated_by`,
`updated_at`. Signed-in users can read it and nothing more — a write on this path
is rejected even for an admin (those go through the admin function).

```json
[{ "text": "Keynote moved to 10am.", "updated_at": "2026-08-19T11:00:29.927669+00:00" }]
```

**Empty `text` means there is no announcement** — that is how an admin clears the
banner, so hide it rather than rendering an empty bar:

```ts
const { data } = await supabase
  .from("announcements")
  .select("text, updated_at")
  .single();

if (data.text) showBanner(data.text);
```

Needs a session: without one the request is a 401, since the policy grants select
`to authenticated` only. If the banner ever has to appear on the login screen,
that policy needs an `anon` equivalent.

Live updates work here too, which suits a banner that can change mid-event:

```ts
supabase.channel("announcement")
  .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "announcements" },
      ({ new: row }) => (row.text ? showBanner(row.text) : hideBanner()))
  .subscribe();
```

## 11. Admin routes

Admin-only routes, all on one function. `user/*` manages `public.email_stack` —
the invite list registration is gated on — and `announcement/*` edits the banner
from [§10](#10-announcement).

**Admin only:** the caller needs a signed-in session whose `public.users` row has
`is_admin = true`, sent as `Authorization: Bearer <token>` like any authenticated
request.

| Route | Method |
| --- | --- |
| `/functions/v1/admin/user/list` | `GET` |
| `/functions/v1/admin/user/add` | `POST` |
| `/functions/v1/admin/user/remove` | `DELETE` |
| `/functions/v1/admin/announcement/get` | `GET` |
| `/functions/v1/admin/announcement/post` | `POST` |

For the `user/*` routes, entries are **invitations, not accounts**: adding one
lets that address register, removing one stops future registrations but leaves any
account that already registered with it untouched.

Addresses are trimmed and lower-cased, and matching ignores case throughout — so
`NINA@Example.com` adds `nina@example.com`, and removing `TWO@Example.com`
removes `two@example.com`.

### 11.1 `GET admin/user/list`

| Query parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer | 1 | 1-based |
| `per_page` | integer | 50 | Capped at 200 |
| `search` | string | — | Case-insensitive substring of the email. `%` and `_` match literally, not as wildcards |
| `limit` / `offset` | integer | — | Accepted as aliases for `per_page` / raw offset, if you prefer that style |

```json
{
  "status": "Success",
  "message": "7 emails on the attendee list.",
  "data": {
    "users": [
      { "id": "9d1f92e1-...", "email": "ada@example.com", "first_name": "Ada", "last_name": null }
    ],
    "search": null,
    "pagination": {
      "total": 7,
      "page": 1,
      "per_page": 3,
      "total_pages": 3,
      "has_next": true,
      "has_prev": false
    }
  }
}
```

`pagination.total` counts what the filter matched, not the whole table, so it
drives the pager directly when a `search` is active. Asking for a page past the
end is not an error — it returns an empty `users` array with the real totals.

### 11.2 `POST admin/user/add`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | string | one of the two | A single address |
| `emails` | array | one of the two | Up to 200 per request. Items may be plain strings, or `{ email, first_name?, last_name? }` |
| `first_name` | string | no | Only with the single-`email` form |
| `last_name` | string | no | Only with the single-`email` form |

```json
{
  "status": "Success",
  "message": "Added 1 email to the attendee list.",
  "data": {
    "requested": 2,
    "added_count": 1,
    "added": ["four@example.com"],
    "already_on_list": ["one@example.com"]
  }
}
```

### 11.3 `DELETE admin/user/remove`

Same body shape as add.

```json
{
  "status": "Success",
  "message": "Removed 1 email from the attendee list.",
  "data": {
    "requested": 2,
    "removed_count": 1,
    "removed": ["one@example.com"],
    "not_found": ["nope@example.com"]
  }
}
```

Add and remove are both idempotent: adding an address already on the list reports
it under `already_on_list`, removing one that isn't there reports it under
`not_found`. Neither is an error, so the UI can replay a request safely.

### 11.4 `GET admin/announcement/get`

Reads the current announcement in the admin envelope, for the editor screen. Takes
no parameters.

```json
{
  "status": "Success",
  "message": "Announcement loaded.",
  "data": {
    "text": "Keynote moved to 10am.",
    "updated_by": "88fd8fc0-be29-4331-9917-d73a5473be1b",
    "updated_at": "2026-08-19T11:00:29.927669+00:00"
  }
}
```

When there is no announcement the call still succeeds, with `text: ""` and the
message `There is no announcement right now.`

Users read the same announcement over REST instead — see [§10](#10-announcement).

### 11.5 `POST admin/announcement/post`

Saves the announcement, replacing whatever was there.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes | Up to 2000 characters. **May be empty** — an empty string clears the banner. `null` clears it too, and the value is trimmed, so whitespace-only input also clears it |

```json
{
  "status": "Success",
  "message": "Announcement saved.",
  "data": { "text": "Keynote moved to 10am.", "updated_by": "88fd8fc0-...", "updated_at": "..." }
}
```

The message is `Announcement cleared.` when the result is empty. `updated_by` is
set to the admin who saved it; `updated_at` is maintained by a trigger.

Omitting `text` entirely is a 400 (`"text" is required. Send an empty string to
clear the announcement.`), so a client bug can't blank the banner by accident
while clearing it stays an explicit action. A non-string `text` is also a 400.

### Errors (all routes)

| Status | Body |
| --- | --- |
| 400 | `{ "status": "Error", "message": "\"not-an-email\" is not a valid email address.", "data": null }` — one bad address rejects the whole request, and nothing is written |
| 400 | `Provide "email" or a non-empty "emails" list.` / `At most 200 emails per request.` / `page must be 1 or more.` / `per_page must be 1 or more.` |
| 401 | `A user access token is required.` — no bearer token, or the anon key was sent instead of a user's |
| 403 | `Admin access is required.` — signed in, but `is_admin` is false |
| 404 | `Unknown admin route "user/whatever".` — the message lists every valid route |
| 405 | `Method not allowed. Use POST for admin/user/add.` |

**`is_admin` cannot be set through the API** — not even by an admin. It is
writable only by the service role, so an admin cannot promote another user
through this API. Do it in SQL:

```sql
update public.users set is_admin = true where email = 'you@yourdomain.com';
```

```ts
// list, paged and searchable
const { data: page } = await supabase.functions.invoke(
  `admin/user/list?page=1&per_page=25&search=${encodeURIComponent(term)}`,
  { method: "GET" },
);
page.data.users;              // rows
page.data.pagination;         // { total, page, per_page, total_pages, has_next, has_prev }

// add
await supabase.functions.invoke("admin/user/add", {
  body: { emails: ["nina@example.com", { email: "sam@example.com", first_name: "Sam" }] },
});

// remove — invoke() needs the method spelled out
await supabase.functions.invoke("admin/user/remove", {
  method: "DELETE",
  body: { email: "nina@example.com" },
});
```

New admin routes belong in this same function: it routes on the path after
`admin/`, so `admin/<area>/<action>` costs nothing extra to deploy.

## 12. Not built yet

These have no endpoint. The ones marked *SDK* need no backend work — call
`supabase.auth` directly:

| Route | Status |
| --- | --- |
| Logout | *SDK* — `supabase.auth.signOut()` |
| Refresh token | *SDK* — `supabase.auth.refreshSession()` |
| Forgot / reset password | Built — see [§2.4](#24-forgot-password) and [§2.5](#25-reset-password). Still needs the recovery template set on the hosted project, and custom SMTP for real volume |
| Verify email | Not wired up — `register` auto-confirms accounts, since the email was already vetted against the attendee list |
| Delete account | Partly — `DELETE /rest/v1/users?id=eq.<my-id>` removes the profile, but the `auth.users` row survives, so the email cannot be re-registered. Needs an edge function to do both |
| Profile image upload | No storage bucket yet; `users.profile_image` is just a URL |
| Sending push notifications | Rows can be inserted into `notifications` server-side, but nothing delivers to FCM/APNs yet |
