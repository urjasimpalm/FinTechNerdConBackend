# FinTechNerdCon — Front-end API guide

Every request/response example in this document was run against the local stack,
so the shapes are what the API actually returns.

A Postman collection covering every endpoint here lives next to this file:
import [FinTechNerdCon.postman_collection.json](FinTechNerdCon.postman_collection.json)
and [FinTechNerdCon.postman_environment.json](FinTechNerdCon.postman_environment.json),
then run **1. Auth → Login** — it stores the token for every other request.

The backend has two kinds of endpoint:

- **Edge functions** (`/functions/v1/...`) — custom logic: auth (register, login, password reset), `config`, the `user/*` routes (home, profile, directory, connections, guilds, agenda, missions, QR codes, leaderboard), `chat/*` and the admin routes.
- **Auto-generated REST** (`/rest/v1/...`) — direct table access, guarded by
  row-level security so a signed-in user can only ever reach their own data. Used
  for reading reference data and your own rows (notifications, the announcement,
  the mission catalog).

Anything that awards XP — saving a session, scanning a QR code — goes through an
edge function and is **not** writable over REST. See
[§6.5](#65-how-xp-is-earned).

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
| `guild_ids` | integer[] | **yes** | 1 to 3 `guilds.id` values, e.g. `[1, 4]`. `guild_id` (a single id) is still accepted as a one-guild selection |
| `user_type_config_id` | integer | no | `configs.id` where `type = 'user_type'` (Builder / Operator / Explorer) |
| `company_name` | string | no | |
| `job_title` | string | no | |
| `profile_image` | string | no | URL |
| `device_type` | integer | no | For push delivery |
| `device_token` | string | no | FCM/APNs token |

**201 — created**

```json
{
  "success": true,
  "message": "Registration successful."
}
```

Success carries the status and message only — no token, no session, no profile.

| Status | Body | What the UI should do |
| --- | --- | --- |
| 201 | above | Go to login and sign in with the same credentials |
| 403 | `{ "success": false, "email_in_stack": false, "message": "This email is not on the attendee list." }` | Show "not on the list"; nothing was created |
| 409 | `{ "success": false, "email_in_stack": true, "message": "An account with this email already exists." }` | Send them to login |
| 400 | `{ "success": false, "message": "..." }` | Show the message (missing field, short password, no guilds or more than 3, bad `guild_ids`/`user_type_config_id`) |
| 500 | `{ "success": false, "message": "Something went wrong. Please try again." }` | Generic retry |

Guilds are picked at sign-up: **at least 1, at most 3**. Sending none is a 400
(`guild_ids is required — pick between 1 and 3 guilds.`), and so is sending four.
Nothing is created when the selection is rejected.

The badge number is assigned here: every new profile gets the next `nerd_number`
in registration order (`"00427"`), which nothing can change afterwards. Read it
back from `GET user/profile` or login's `data.user`.

The account is created already confirmed, so **call login right after a 201** to
get the token and the profile row. The two failure cases still carry
`email_in_stack` so the UI can tell "not invited" from "already registered".

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

`data.user` is the full `public.users` profile row — this is where the client
picks it up after registering — with `user_type` and the `guilds` array embedded,
the same as `GET user/profile`. Wrong password and unknown email
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

Tokens come from login only — register returns none — so after logging in, hand
them to the SDK, or every later request runs as anonymous and RLS returns empty
results:

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

### 3.1 Pagination

Every listing endpoint on the edge functions (`user/people`,
`user/connection/list`, `user/guild/list`, `user/guild/members`,
`admin/user/list`) takes the same parameters and answers with the same object:

| Parameter | Default | Notes |
| --- | --- | --- |
| `page` | 1 | 1-based |
| `per_page` | 20 | Capped at 100 |
| `limit` / `offset` | — | Accepted as aliases; `offset` wins over `page` if both are sent |

```json
"pagination": {
  "total": 128, "page": 1, "per_page": 20,
  "total_pages": 7, "has_next": true, "has_prev": false
}
```

`total` counts what the filters matched, not the whole table, and `has_next` is
derived from `total` — so a full last page does not look like there is more to
fetch. A page past the end is an empty list, not an error.

### 3.2 REST query parameters

Errors look like this (not the `{ success, message }` envelope the functions use):

```json
{ "code": "23503", "details": "Key is not present in table \"agenda\".", "hint": null, "message": "insert or update on table \"user_agenda\" violates foreign key constraint ..." }
```

Common codes: `23503` foreign key, `23505` duplicate, `42501` RLS/permission denied.

**Two behaviours worth knowing before you build screens:**

1. **Writes to rows you don't own return `200 []`, not an error.** RLS filters the
   rows out, so the statement matches nothing. Treat an empty array from a
   PATCH/DELETE as "not yours / not found".
2. **A few inserts must not ask for the row back** — see [§8 Chat](#8-chat).
   Asking for the inserted row (`.select()`) fails with `42501` when the row is
   only visible *after* a second row exists.

---

## 4. Profile and attendee directory

Table `users`. Columns: `id`, `first_name`, `last_name`, `email`, `nerd_number`,
`user_type_config_id`, `company_name`, `job_title`, `profile_image`,
`device_type`, `device_token`, `is_admin`, `created_at`, `updated_at`.

Guilds are **many-to-many** through `user_guilds (user_id, guild_id)` — a user
belongs to 1 to 3 of them, and the old `users.guild_id` column was dropped, so
don't reference it. The selection is only writable through `register`,
`PUT user/profile` and `user/guild/join|leave`, which is what keeps the 1..3 rule
true.

**Admin accounts are invisible to attendees.** A user whose `is_admin` is true is
event staff, not an attendee, so they are left out of every attendee-facing
response:

| Endpoint | Behaviour |
| --- | --- |
| `GET user/people`, `GET user/guild/members` | Not in the list, and not counted in `pagination.total` |
| `GET user/profile/{id}` | `404 That attendee could not be found.` |
| `POST user/connection/request`, `POST chat/create` | `404 That attendee could not be found.` |
| `GET user/connection/list`, `GET chat/list`, `GET chat/details/{id}`, `POST chat/send/{id}` | Rows where the other person is staff are filtered out — so a request or chat an admin *started* never surfaces either |

The `is_admin` flag itself is only returned for **the signed-in user** (in
`GET user/profile` and in login's `data.user`, where the app needs it to decide
whether to show admin screens). It is not part of anyone else's profile or card.

If a staff member should also appear as an attendee, give them a second account
and leave `is_admin` false on it.

Who is connected to whom lives in `public.connections` (one row per pair) and is
only writable through the `user/connection/*` routes. There is also a generated
`users.search_text` column behind the directory search — never write it, and
there is no reason to select it.

Rows are created only by `register`. Every signed-in user can read the whole
directory, but can update and delete only their own row.

`nerd_number` is the attendee's badge number — zero-padded to five digits
(`"00427"`), issued in registration order, unique, and **not editable by anyone**,
including through the endpoints below.

### 4.1 `GET user/profile` — my profile

```
GET /functions/v1/user/profile
Authorization: Bearer <token>
```

Everything a profile screen needs in one call: the editable fields, the badge
number, the guild and user type as objects, and the caller's standing on the
leaderboard. Uses the `{ status, message, data }` envelope.

```json
{
  "status": "Success",
  "message": "Profile loaded.",
  "data": {
    "id": "032b5171-0456-4db4-ab1e-571a77e15286",
    "first_name": "Wasim",
    "last_name": "Raza",
    "email": "wasim@simpalm.com",
    "nerd_number": "00427",
    "company_name": "Simpalm",
    "job_title": "CTO",
    "profile_image": "https://<project>.supabase.co/storage/v1/object/public/profile-images/032b5171-.../1787184000000.jpg",
    "user_type_config_id": 1,
    "is_admin": false,
    "created_at": "2026-08-14T16:23:09.433673+00:00",
    "updated_at": "2026-08-20T09:02:11.120044+00:00",
    "user_type": { "id": 1, "name": "Builder", "description": "I create products, tools, and systems." },
    "guilds": [
      { "id": 2, "name": "Banking", "description": null },
      { "id": 3, "name": "Payments", "description": null }
    ],
    "total_xp": 150,
    "rank": 3
  }
}
```

| Field | Notes |
| --- | --- |
| `guilds` | The user's 1 to 3 guilds as `{ id, name, description }`, ordered by id. Map to ids for the edit form: `data.guilds.map(g => g.id)` |
| `user_type` | `{ id, name, description }`, or `null` when the user has not picked one. The raw `user_type_config_id` is alongside it, so the edit form can prefill without unwrapping |
| `profile_image` | Full public URL, or `null`. Renderable as-is — no signing |
| `total_xp` | Points from completed missions. `0` for a user who has completed none |
| `rank` | Leaderboard position, or `null` while `total_xp` is 0 — the leaderboard only ranks users with a completed mission |

| Status | Body |
| --- | --- |
| 200 | above |
| 401 | `{ "status": "Error", "message": "A user access token is required.", "data": null }` — or "Your session is invalid or has expired." The anon key alone is not enough |
| 404 | `{ "status": "Error", "message": "Your profile could not be found.", "data": null }` |
| 405 | `{ "status": "Error", "message": "Method not allowed. Use GET or PUT for user/profile.", "data": null }` |

### 4.2 `PUT user/profile` — update my profile

```
PUT /functions/v1/user/profile
Authorization: Bearer <token>
```

Editable: `first_name`, `last_name`, `user_type_config_id`, `guild_ids`,
`company_name`, `job_title`, `profile_image`. Everything else in the body is
ignored, so a client can send a whole profile object back untouched.

**Partial by design.** A field you leave out is left alone; send `null` to clear
an optional one (`user_type_config_id`, `company_name`, `job_title`,
`profile_image`). `first_name` and `last_name` cannot be emptied.

**Guilds.** `guild_ids` replaces the whole selection and must contain 1 to 3
existing `guilds.id` values — there is no way to clear it, because an attendee
always belongs to at least one guild. Leave the key out to keep the current
selection. Duplicates collapse, so `[2, 2, 3]` is a two-guild selection, and a
single `guild_id` is still accepted as a one-guild alias. The replacement is
applied in one transaction, so a rejected selection leaves the old one intact.

The response body is the same shape as `GET user/profile`, with
`message: "Profile updated."`, so the screen can re-render from it directly.

**Uploading a picture.** Send the file as `multipart/form-data` under
`profile_image` and it is stored in the `profile-images` bucket under the caller's
own folder; the saved `profile_image` is its public URL. The previous upload is
deleted once the new one is saved.

```ts
const form = new FormData();
form.append("first_name", "Wasim");
// A form cannot carry an array: repeat the key, or send "2,3" in one value.
form.append("guild_ids", "2");
form.append("guild_ids", "3");
form.append("profile_image", file); // File / Blob from the picker

await fetch(`${SUPABASE_URL}/functions/v1/user/profile`, {
  method: "PUT",
  headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  body: form, // no Content-Type header — the browser sets the boundary
});
```

In a multipart form there is no `null`, so an empty value (or the literal
`"null"`) clears a field, and an empty file part means "no change". `guild_ids`
accepts repeated parts (`guild_ids=2`, `guild_ids=3`), one comma-separated value
(`guild_ids=2,3`), or a JSON array as a string (`guild_ids=[2,3]`).

JSON works too, with three ways to set the picture:

```json
{
  "first_name": "Wasim",
  "job_title": "CTO",
  "guild_ids": [2, 3],
  "user_type_config_id": 1,
  "profile_image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
}
```

| `profile_image` value | Effect |
| --- | --- |
| A file part (multipart) | Uploaded to storage, URL saved |
| `data:image/jpeg;base64,…` | Decoded, uploaded to storage, URL saved |
| `https://…` | Saved as-is, for an image already hosted elsewhere |
| `null` | Picture removed (and the stored file deleted) |

JPEG, PNG, WebP and HEIC/HEIF are accepted, up to 5 MB.

| Status | Body |
| --- | --- |
| 200 | Updated profile, same shape as GET |
| 400 | `{ "status": "Error", "message": "...", "data": null }` — empty name, fewer than 1 or more than 3 guilds, unknown `guild_ids`/`user_type_config_id`, unsupported or oversized image, or nothing to update |
| 401 | Missing or expired token |
| 404 | Profile row not found |

Unknown ids are checked before the write, so the message names the id:
`Guild 99 does not exist. Fetch the list from GET config/guilds.` A bad selection
size says so too: `Pick between 1 and 3 guilds — 4 were sent.`

### 4.3 `GET user/profile/{id}` — another attendee's profile

```
GET /functions/v1/user/profile/<user-id>
Authorization: Bearer <token>
```

The same detail as [§4.1](#41-get-userprofile--my-profile) for someone else, plus
where the two of you stand:

```json
{
  "status": "Success",
  "message": "Profile loaded.",
  "data": {
    "id": "9d0f...",
    "first_name": "Ada",
    "last_name": "Byron",
    "nerd_number": "00042",
    "company_name": "Analytical Engines",
    "job_title": "Mathematician",
    "profile_image": "https://.../profile-images/9d0f.../1787184000000.jpg",
    "user_type": { "id": 1, "name": "Builder", "description": "I create products, tools, and systems." },
    "guilds": [{ "id": 1, "name": "AI & Agentic Systems", "description": null }],
    "total_xp": 100,
    "rank": 7,
    "connection": { "status": "pending_received", "request_id": "3f1c..." },
    "is_connected": false
  }
}
```

| `connection.status` | Meaning |
| --- | --- |
| `none` | No history. Show "Connect" |
| `pending_sent` | You asked, they have not answered. Show "Requested" |
| `pending_received` | They asked you. Show Accept / Reject, using `connection.request_id` |
| `connected` | Show "Connected" (or a message button) |
| `rejected` | Answered no. Either side may ask again |

`is_connected` is the shorthand for `status === "connected"`. `is_admin` is not
returned here at all, and an admin's id answers 404. **`email` is only
included once you are connected** — everything else here is directory
information, an address is not. Passing your own id returns your own profile
(same as §4.1).

| Status | Body |
| --- | --- |
| 200 | above |
| 400 | `{ "status": "Error", "message": "That is not an attendee id.", "data": null }` — the path segment is not a uuid |
| 404 | `{ "status": "Error", "message": "That attendee could not be found.", "data": null }` |

### 4.4 `GET user/people` — attendee directory

```
GET /functions/v1/user/people?search=&user_type=&guild_id=&page=&per_page=
Authorization: Bearer <token>
```

| Parameter | Notes |
| --- | --- |
| `search` | One term matched against name, nerd number, company and job title — `"wasim raza"`, `"00427"` and `"simpalm"` all work. Case-insensitive, partial |
| `user_type` | A `configs.id` where `type = 'user_type'` (1 = Builder, 2 = Operator, 3 = Explorer), or `all` / omitted for every type |
| `guild_id` | Only people in that guild, or `all` / omitted for every guild |
| `page`, `per_page` | See [§3.1](#31-pagination). Default 20 per page, max 100 |

```json
{
  "status": "Success",
  "message": "128 attendees found.",
  "data": {
    "people": [
      {
        "id": "9d0f...",
        "first_name": "Ada",
        "last_name": "Byron",
        "nerd_number": "00042",
        "company_name": "Analytical Engines",
        "job_title": "Mathematician",
        "profile_image": "https://.../1787184000000.jpg",
        "user_type_config_id": 1,
        "user_type": { "id": 1, "name": "Builder", "description": "I create products, tools, and systems." },
        "guilds": [{ "id": 1, "name": "AI & Agentic Systems", "description": null }],
        "connection": { "status": "none", "request_id": null },
        "is_connected": false
      }
    ],
    "search": "ada",
    "pagination": { "total": 128, "page": 1, "per_page": 20, "total_pages": 7, "has_next": true, "has_prev": false }
  }
}
```

Your own row is never in the list, and neither is any admin account. Each card
carries the same `connection` object as §4.3, so the right button can be drawn without a second call. No email or
device fields are returned here.

### 4.5 Connections

Four routes, all in the `{ status, message, data }` envelope. One request exists
per pair of people, whichever way round it went.

```
POST /functions/v1/user/connection/request   { "user_id": "<uuid>" }
POST /functions/v1/user/connection/respond   { "request_id": "<uuid>", "action": "accept" | "reject" }
GET  /functions/v1/user/connection/list?status=pending&search=&page=&per_page=
```

Accepting and rejecting are the same route, told apart by `action`. It takes
`request_id` or `user_id`, and `action` may also be sent on the query string
(`?action=reject`) if you would rather keep it out of the body.

Both routes answer with the pair's new state:

```json
{
  "status": "Success",
  "message": "Connection request sent.",
  "data": { "status": "pending_sent", "request_id": "3f1c..." }
}
```

| Route | Status | Body |
| --- | --- | --- |
| request | 200 | `{ status: "pending_sent", request_id }` |
| request | 200 | `"You are now connected — they had already sent you a request."` — asking someone who already asked you accepts theirs |
| request | 400 | Not a uuid, or your own id |
| request | 404 | No such attendee |
| request | 409 | Already connected, or you have already asked |
| respond | 200 | `{ status: "connected" \| "rejected", request_id }` |
| respond | 400 | `"action" must be "accept" or "reject".`, or neither id was sent |
| respond | 403 | `"Only the person who received a request can answer it."` |
| respond | 404 | No such request, or it is not yours |
| respond | 409 | Already answered |

A rejected pair can be asked again — the same row reopens as `pending` with
whoever asked second as the requester.

**`GET user/connection/list`** — the inbox by default:

| `status=` | Returns |
| --- | --- |
| `pending` (default) | Requests waiting on **you** to answer |
| `sent` | Requests you sent that have not been answered |
| `accepted` | Your connections, whoever asked |
| `rejected` | Pairs that were answered no |

```json
{
  "status": "Success",
  "message": "3 requests.",
  "data": {
    "requests": [
      {
        "request_id": "3f1c...",
        "status": "pending_received",
        "created_at": "2026-08-20T09:02:11.120044+00:00",
        "responded_at": null,
        "user": { "id": "9d0f...", "first_name": "Ada", "last_name": "Byron", "nerd_number": "00042", "company_name": "Analytical Engines", "job_title": "Mathematician", "profile_image": null, "user_type": { "id": 1, "name": "Builder", "description": "..." }, "guilds": [] }
      }
    ],
    "status": "pending",
    "search": null,
    "pagination": { "total": 3, "page": 1, "per_page": 20, "total_pages": 1, "has_next": false, "has_prev": false }
  }
}
```

`user` is the other person's card, the same shape as in `people`. `search`
narrows by their name, company or job title (and nerd number), exactly like §4.4.

### 4.6 Guilds — join, leave, and who else is in one

```
GET  /functions/v1/user/guild/list?search=&page=&per_page=
POST /functions/v1/user/guild/membership   { "guild_id": 1, "action": "join" | "leave" }
GET  /functions/v1/user/guild/members?guild_id=1&search=&page=&per_page=
```

Joining and leaving are the same route, told apart by `action` (which also works
as `?action=leave` on the query string).

`guild/list` is every guild with the caller's membership flagged, which is what a
"my guilds" picker needs:

```json
{
  "status": "Success",
  "message": "15 guilds.",
  "data": {
    "guilds": [
      { "id": 1, "name": "AI & Agentic Systems", "description": null, "is_joined": true },
      { "id": 2, "name": "Banking", "description": null, "is_joined": false }
    ],
    "joined_count": 1,
    "max_guilds": 3,
    "search": null,
    "pagination": { "total": 15, "page": 1, "per_page": 20, "total_pages": 1, "has_next": false, "has_prev": false }
  }
}
```

`membership` edits the same 1–3 selection that shows on the profile, and answers
with the selection afterwards:

```json
{ "status": "Success", "message": "You joined Banking.", "data": { "guilds": [ { "id": 1, "name": "AI & Agentic Systems", "description": null }, { "id": 2, "name": "Banking", "description": null } ] } }
```

| Status | Body |
| --- | --- |
| 200 | The guilds the caller now belongs to |
| 400 | `"action" must be "join" or "leave".`, `"guild_id" is required...` or `Guild 99 does not exist.` |
| 409 | `You are already in Banking.` / `You are not in Banking.` |
| 409 | `You can belong to at most 3 guilds. Leave one first.` — `action: "join"` |
| 409 | `You have to belong to at least 1 guild. Join another one first.` — `action: "leave"` |

**The cap of 3 is enforced three deep:** this route refuses the join,
`public.set_user_guilds()` rejects any selection outside 1–3, and the
`user_guilds_limit` trigger raises on a fourth row — so no path, including the
service role, can push someone over.

`guild/members` is `user/people` scoped to one guild — same card, same
`search` / `user_type` / paging, and it also excludes you. `guild_id` is required.

### 4.7 Direct table access

| Action | Call |
| --- | --- |
| My profile | `GET /rest/v1/users?select=*&id=eq.<my-id>` |
| Update my profile | `PATCH /rest/v1/users?id=eq.<my-id>` |
| Directory | `GET /rest/v1/users?select=id,first_name,last_name,company_name,job_title,profile_image&limit=20` |
| Filter by guild | `GET /rest/v1/user_guilds?select=user_id,users(id,first_name,last_name)&guild_id=eq.2` |
| My guilds | `GET /rest/v1/user_guilds?select=guild:guilds(id,name)&user_id=eq.<my-id>` |
| Search by name | `...&or=(first_name.ilike.*ann*,last_name.ilike.*ann*)` |
| Delete my account | `DELETE /rest/v1/users?id=eq.<my-id>` |

Updatable fields: `first_name`, `last_name`, `user_type_config_id`,
`company_name`, `job_title`, `profile_image`, `device_type`, `device_token`.
(`email` lives in auth — change it with `supabase.auth.updateUser`.) `nerd_number`
and `is_admin` are not in that list: a PATCH carrying either is rejected with
`42501`, so use `PUT user/profile` for profile edits and leave those two alone.
`device_type` / `device_token` are the one pair the PUT does not cover — patch
them here. `user_guilds` is read-only over REST as well: the 1..3 rule is enforced
by `public.set_user_guilds()`, which only `register` and `PUT user/profile` can
call, so guild changes have to go through the PUT.

```ts
const { data: { user } } = await supabase.auth.getUser();

await supabase.from("users")
  .update({ job_title: "Engineer" })
  .eq("id", user.id)
  .select();

// directory with each attendee's guild names joined in
await supabase.from("users")
  .select("id, first_name, last_name, company_name, user_guilds(guild:guilds(name))")
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
      { "id": 1, "name": "AI & Agentic Systems", "description": null },
      { "id": 2, "name": "Banking", "description": null }
    ],
    "user_type":   [{ "id": 1, "name": "Builder", "description": "I create products, tools, and systems." }, { "id": 2, "name": "Operator", "description": "I run and optimize processes to keep things moving." }, { "id": 3, "name": "Explorer", "description": "I discover new ideas, markets, and opportunities." }],
    "event-quest": [{ "id": 4, "name": "Main Quests", "description": null }, { "id": 5, "name": "Side Quests", "description": null }, { "id": 6, "name": "Bonus Quests", "description": null }, { "id": 7, "name": "My Schedule", "description": null }],
    "event-day":   [{ "id": 8, "name": "Day 0", "description": null }, { "id": 9, "name": "Day 1", "description": null }, { "id": 10, "name": "Day 2", "description": null }],
    "stage-type":  [{ "id": 11, "name": "Stage 1", "description": null }, { "id": 12, "name": "Stage 2", "description": null }, { "id": 13, "name": "Stage 3", "description": null }, { "id": 14, "name": "Stage 4", "description": null }]
  }
}
```

Every row is `{ id, name, description }`, where `description` is only populated for
`user_type` today — guilds are names only, and the other config types have no
copy — so treat `null` as "nothing to show" rather than an error. `guilds` has 15
rows; the sample above is trimmed.

| Status | Body |
| --- | --- |
| 200 | above — config rows are `{ id, name, description }` (`description` null except for `user_type`) |
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

### `GET config/sponsors` — the sponsor list

```ts
const { data } = await supabase.functions.invoke("config/sponsors", { method: "GET" });
```

| Parameter | Meaning |
| --- | --- |
| `search` | Matches sponsor name or company name |
| `include_inactive` | `true` to include retired sponsors. Off by default |

```json
{
  "success": true,
  "data": {
    "sponsors": [
      {
        "id": 1,
        "name": "Jane Okafor",
        "company_name": "Acme Payments",
        "description": "Payment rails for the rest of us.",
        "profile_image": "https://…/acme.png",
        "sort_order": 1,
        "is_active": true
      }
    ]
  }
}
```

Ordered by `sort_order`, then name. `is_active = false` is how a sponsor is taken
down without deleting the row, so those are hidden unless you ask for them.

Needs no session (this function is `verify_jwt = false`) and is CDN-cached for 5
minutes like the rest of §5 — the sponsor screen is public event content.

**Sponsors are not in the bare `GET config` payload** and have to be asked for by
name. That call is what the register screen makes before the user has a token, and
it shouldn't carry a screen's worth of logos and copy that the register screen has
no use for. `GET config?type=sponsors,guilds` works if you want both in one call.

Adding, editing and removing sponsors has no route — rows are managed in Studio or
by the service role. See [§12](#12-not-built-yet).

### Direct table access (signed-in users)

The same data is readable over REST once the user has a token, if you'd rather
filter server-side:

| Table | Call |
| --- | --- |
| `guilds` | `GET /rest/v1/guilds?select=id,name,description&order=id` |
| `sponsors` | `GET /rest/v1/sponsors?select=id,name,company_name,description,profile_image&is_active=eq.true&order=sort_order` |
| `configs` | `GET /rest/v1/configs?select=id,name,description&type=eq.user_type` |

---

## 6. Home, missions, QR codes and the leaderboard

> **New in this release.** Unlike the rest of this document, the examples in §6
> and §7 come from the implementation rather than from a run against the local
> stack — the shapes are what the code returns, but they have not been captured
> from a live response yet.

All four routes live on the `user` function, need a user token, and answer in the
`{ status, message, data }` envelope.

### 6.1 `GET user/home` — the Home screen

Everything the home screen needs in one call: the announcement banner, the floor
plan, and the quick-start card.

```ts
const { data } = await supabase.functions.invoke("user/home", { method: "GET" });
```

```json
{
  "status": "Success",
  "message": "Home loaded.",
  "data": {
    "announcement": { "text": "Doors open at 9.", "updated_at": "2026-08-21T18:04:11.02Z" },
    "map_image": "https://<project>.supabase.co/storage/v1/object/public/…/floorplan.png",
    "quick_start": {
      "step": "save_sessions",
      "title": "Save 3 sessions",
      "destination": "agenda",
      "progress": 1,
      "target": 3
    },
    "stats": {
      "saved_sessions": 1,
      "connections": 0,
      "missions_completed": 1,
      "total_xp": 50,
      "rank": 12
    }
  }
}
```

`quick_start` is the one-item-at-a-time card, already resolved:

| `step` | Shown when | `destination` |
| --- | --- | --- |
| `save_sessions` | Fewer than 3 events on the schedule | `agenda` |
| `first_connection` | 3 saved, but no accepted connections | `community` |
| `null` | Both done — **hide the card** | — |

An empty `announcement.text` means there is no banner to show, and a null
`map_image` means there is no map — neither is an error. Admins set both through
[§11.5](#115-post-adminannouncementpost).

### 6.2 `GET user/mission/list` — the Missions screen

The catalog with the caller's progress folded in.

| Parameter | Meaning |
| --- | --- |
| `include_inactive` | `true` to include missions with `is_active = false`. Off by default |

```json
{
  "status": "Success",
  "message": "2 of 7 missions completed.",
  "data": {
    "missions": [
      {
        "id": 2,
        "code": "add_session",
        "title": "Add a session to your schedule",
        "description": "Check in to a Main Quest or Side Quest Stage session…",
        "xp": 50,
        "points": 50,
        "is_active": true,
        "is_repeatable": true,
        "max_completions": null,
        "how_to_earn": "Add a Main Quest or Side Quest session to your schedule.",
        "is_completed": true,
        "times_completed": 3,
        "xp_earned": 150,
        "completed_at": "2026-08-21T18:12:03.44Z",
        "remaining": null
      }
    ],
    "summary": {
      "total": 7,
      "completed": 2,
      "mission_xp": 200,
      "total_xp": 250,
      "rank": 4
    }
  }
}
```

- `is_completed` is the completion indicator; `times_completed` is the sheet's
  "Times Completed" counter and is only interesting when `is_repeatable`.
- `remaining` is `null` when there is no cap.
- `xp` and `points` are the same number. The column is `points`, the UI says XP.
- `summary.mission_xp` counts missions only; `summary.total_xp` also counts
  session check-ins, so the two are not expected to match.

**There is no route that completes a mission.** See [§6.5](#65-how-xp-is-earned).

### 6.3 `POST user/qr/scan` — claim a scanned QR code

The printed codes resolve to `https://<app>/q/<code>`. Read the slug off the URL
and post it here.

```ts
await supabase.functions.invoke("user/qr/scan", { body: { code: "9f2c1ab47e0d5c31" } });
```

| Field | Required | Notes |
| --- | --- | --- |
| `code` | yes | The slug, or the whole scanned URL — both work. May also be sent as `?code=` |

```json
{
  "status": "Success",
  "message": "Explore a New Zone — 3 times now. +50 XP.",
  "data": {
    "label": "Zone 3",
    "kind": "zone",
    "first_scan": true,
    "counted": true,
    "mission": {
      "id": 5,
      "code": "explore_zone",
      "title": "Explore a New Zone",
      "is_repeatable": true,
      "counted": true,
      "times_completed": 3
    },
    "session": null,
    "xp_awarded": 50,
    "total_xp": 300
  }
}
```

A code can award a mission, check you in to a session (`session` is non-null and
carries the event's XP value), or both.

| Case | Status | Response |
| --- | --- | --- |
| Earned something | 200 | `counted: true` — celebrate |
| Already scanned this code | 200 | `counted: false`, `"You have already scanned this one."` |
| Unknown code | 404 | `"That QR code is not one of ours."` |
| Code switched off | 409 | `"… is no longer active. Ask at the help desk."` |

A repeat scan is **not** an error — the attendee did nothing wrong, and the screen
still wants to show what the code was. Branch on `counted`, not on the status code.

`public.qr_codes` is deliberately **not readable** by attendees: the slug is the
whole proof that you stood in front of the poster, so a client that could list the
table could claim every mission from the hotel bar.

### 6.4 `GET user/leaderboard` — the Leaderboard screen

| Parameter | Meaning |
| --- | --- |
| `limit` / `per_page` | Defaults to **15**, the sheet's "top 15" |
| `page` / `offset` | See [§3.1](#31-pagination) — the board scrolls past the top 15 |

```json
{
  "status": "Success",
  "message": "128 ranked attendees.",
  "data": {
    "entries": [
      {
        "user_id": "8b1f…",
        "rank": 1,
        "total_xp": 450,
        "first_name": "Wasim",
        "last_name": "Raza",
        "nerd_number": "00427",
        "company_name": "Simpalm",
        "job_title": "Engineer",
        "profile_image": null,
        "user_type_config_id": 1,
        "last_award_at": "2026-09-01T14:22:08.51Z",
        "is_me": false
      }
    ],
    "me": { "user_id": "…", "rank": 12, "total_xp": 150, "…": "same shape" },
    "pagination": { "total": 128, "page": 1, "per_page": 15, "total_pages": 9, "has_next": true, "has_prev": false }
  }
}
```

- **Ranks are unique — no two attendees share a number.** Equal totals are ordered
  by who reached the total first, so `rank` is a total order and "you are 7th"
  always means exactly one person is 7th. Order by `rank` alone; no secondary sort
  key is needed, and the order is stable between requests.
- `last_award_at` is the tie-break key: when that attendee reached their current
  total. Earlier ranks higher.
- `me` is the caller's own card for the panel under the list, always present —
  even when they are also in `entries` (`is_me` marks that row).
- Someone who has earned nothing has `rank: null` and `total_xp: 0`: they are
  *unranked* rather than ranked last. `GET user/profile` reports the same numbers.
- `user_id` is what `GET user/profile/{id}` takes, for "click a name to view their
  profile".
- Admin accounts are excluded, as everywhere else in the attendee-facing API.
- Totals can go **down** (see [§6.5](#65-how-xp-is-earned)), so treat the board as
  live rather than monotonic.

### 6.5 How XP is earned

Every award happens server-side. There is **no endpoint that grants XP on
request** — the two triggers and the QR claim function below are the only paths,
so a client cannot promote itself.

| Mission (`code`) | Earned by | Counts once per | Repeatable | Taken back? |
| --- | --- | --- | --- | --- |
| `book_first_quest` | Saving a **Bonus Quest** (offsite) event | event | no | yes — on unsave |
| `add_session` | Saving a **Main/Side Quest** event | event | yes | yes — on unsave |
| `visit_activation` | Scanning a sponsor-booth QR | QR code | yes | no |
| `connect_nerd` | A connection being accepted (**both** people earn it) | person | yes | no |
| `explore_zone` | Scanning a zone QR | QR code | yes | no |
| `nerd_flex` | Scanning the lanyard QR | — | no | no |
| `quest_master` | Every other mission completed — awarded automatically | — | no | yes — if a prerequisite is |

Three consequences worth building against:

- **XP goes down when an event leaves the schedule.** Unsaving takes back exactly
  the XP that saving earned, and the "Times Completed" counter drops with it, so
  the number always reflects the schedule as it currently stands. This is not
  farmable: every add is matched by a remove, so churning an event lands on the
  same total as adding it once.
  `POST user/agenda/schedule` returns the updated `missions` counters and
  `total_xp` on **both** directions, so the screen never has to guess.
- **Quest Master can be revoked.** It means "every other mission is complete", so
  it is withdrawn if that stops being true.
- **Session XP is separate from mission XP, and is never taken back.** Saving an
  event earns the mission; *attending* it (scanning its QR) banks the event's own
  `xp_value`. Un-scheduling an event you already attended does not un-attend it.
  The leaderboard total is the sum of both.

### 6.6 Direct table access

Read-only. `missions` (catalog: `id`, `code`, `title`, `description`, `points`,
`is_repeatable`, `max_completions`, `sort_order`, `is_active`), `user_missions`
(own rows: `+ times_completed`), `mission_completions` (own rows — the ledger),
`qr_scans` and `agenda_checkins` (own rows), and `leaderboard` /
`leaderboard_people` (everyone).

| Action | Call |
| --- | --- |
| Mission catalog | `GET /rest/v1/missions?select=*&is_active=eq.true&order=sort_order` |
| My progress | `GET /rest/v1/user_missions?select=*,missions(code,title,points)` |
| My completion history | `GET /rest/v1/mission_completions?select=*&order=created_at.desc` |
| Leaderboard | `GET /rest/v1/leaderboard_people?select=*&order=rank.asc&limit=15` |

> **Breaking change.** `user_missions` was previously client-writable and API.md
> told you to upsert your own completions. Those grants are revoked — a write now
> returns `42501`. Nothing replaces it: completions are awarded by the paths in
> [§6.5](#65-how-xp-is-earned).

---

## 7. Agenda

Five routes on the `user` function. Every event carries the caller's own state, so
a list screen can draw the `+` / checkmark button and grey out past events without
a second call.

### 7.1 `GET user/agenda` — the event list

| Parameter | Example | Meaning |
| --- | --- | --- |
| `day` | `2026-09-01`, `9`, `all` | A date **or** a `configs.id` of type `event-day` |
| `quest` | `main`, `side`, `bonus`, `4`, `all` | The Agenda screen's three sections |
| `guild_id` | `3` | Filter by tag (guilds are the event tags — see below) |
| `user_type` | `1` | Builder / Operator / Explorer, a `configs.id` of type `user_type` |
| `search` | `stablecoin` | Matches name, speaker name, speaker company or location |
| `saved` | `true` | Only what is on my schedule |
| `sponsored` | `true` | Only sponsored events |
| `page`, `per_page` | | See [§3.1](#31-pagination) |

Events come back in chronological order (`day`, then `start_time`, then
`sort_order`).

```json
{
  "status": "Success",
  "message": "42 events.",
  "data": {
    "events": [
      {
        "id": "3f9a…",
        "name": "Stablecoins in 2027",
        "description": "…",
        "day": "2026-09-01",
        "start_time": "2026-09-01T15:00:00Z",
        "end_time": "2026-09-01T15:45:00Z",
        "speaker_name": "Joy Adams",
        "speaker_title": "VP Payments",
        "speaker_company": "Acme",
        "location": "Main Hall",
        "xp_value": 25,
        "is_sponsored": false,
        "is_invite_only": false,
        "capacity": null,
        "sort_order": 3,
        "status": "scheduled",
        "quest": { "id": 4, "name": "Main Quests" },
        "quest_section": "main",
        "event_day": { "id": 8, "name": "Day 1" },
        "stage": { "id": 11, "name": "Stage 1" },
        "tags": [
          { "id": 4, "name": "Digital Currency & Stablecoins", "is_primary": true },
          { "id": 3, "name": "Payments", "is_primary": false }
        ],
        "primary_tag": { "id": 4, "name": "Digital Currency & Stablecoins", "is_primary": true },
        "secondary_tags": [{ "id": 3, "name": "Payments", "is_primary": false }],
        "user_types": [{ "id": 1, "name": "Builder" }],
        "is_past": false,
        "my_status": "saved",
        "is_saved": true,
        "is_checked_in": false
      }
    ],
    "search": null,
    "pagination": { "…": "as everywhere else" }
  }
}
```

- **`quest_section`** is `main` | `side` | `bonus` | `null` — the three sections of
  the screen. Bonus Quests are the offsite events.
- **Tags** are `public.guilds` rows: at most two per event, one `is_primary`.
  `primary_tag` and `secondary_tags` are the same list, pre-split.
- **`is_past`** is computed from `end_time` (falling back to `start_time`, then to
  the day being over). Past events are returned, not hidden — grey them out.
- **`my_status`** is `null` | `saved` | `interested` | `approved` | `rejected`.
  `is_saved` is the shorthand for the button: true for `saved` and `approved`.
- **`is_checked_in`** means they scanned this session's QR code.

### 7.2 `GET user/agenda/days` — the day tabs

Answers the sheet's "jump to the current day of the conference when the agenda is
loaded" rule.

| Parameter | Meaning |
| --- | --- |
| `today` | `YYYY-MM-DD`. Pass the **client's** local date — otherwise the server's UTC date decides, and a US conference would flip over mid-afternoon |

```json
{
  "status": "Success",
  "message": "3 days.",
  "data": {
    "today": "2026-09-01",
    "days": [
      { "day": "2026-08-31", "event_day_config_id": 8, "name": "Day 0", "event_count": 4, "saved_count": 1, "is_today": false, "is_past": true },
      { "day": "2026-09-01", "event_day_config_id": 9, "name": "Day 1", "event_count": 22, "saved_count": 3, "is_today": true, "is_past": false }
    ],
    "current_day": "2026-09-01",
    "current_day_config_id": 9
  }
}
```

Open on `current_day`: today if the conference is running, otherwise the next day
still to come, otherwise the last one — so the screen is never blank before the
event starts or after it ends.

### 7.3 `GET user/agenda/schedule` — My Schedule

Takes every filter from [§7.1](#71-get-useragenda--the-event-list), plus:

| Parameter | Meaning |
| --- | --- |
| `status` | `scheduled` (default — `saved` + `approved`), `saved`, `interested`, `approved`, `rejected`, `all` |

Same `events` shape as §7.1, so one renderer serves both. `?status=interested` is
the "waiting on an admin" list for invite-only events.

### 7.4 `POST user/agenda/schedule` — add, remove, or ask

```ts
await supabase.functions.invoke("user/agenda/schedule", {
  body: { agenda_id: "3f9a…", action: "save" },
});
```

| Field | Required | Notes |
| --- | --- | --- |
| `agenda_id` | yes | |
| `action` | yes | `save`, `unsave`, `interest`, `withdraw`. May also be sent as `?action=` |

| Action | For | Result |
| --- | --- | --- |
| `save` | Open events | `my_status: "saved"`, mission XP awarded. **409** on an invite-only event — use `interest` |
| `interest` | Invite-only events | `my_status: "interested"`, awaiting an admin. No XP until approved. **409** on an open event |
| `unsave` / `withdraw` | Either | The row is removed, `my_status: null`, and **the XP that saving earned is taken back** |

```json
{
  "status": "Success",
  "message": "Stablecoins in 2027 was added to your schedule.",
  "data": {
    "agenda_id": "3f9a…",
    "my_status": "saved",
    "is_saved": true,
    "missions": [
      { "mission_id": 2, "times_completed": 3, "points_awarded": 150, "missions": { "code": "add_session", "title": "Add a session to your schedule" } }
    ],
    "total_xp": 250
  }
}
```

`missions` and `total_xp` are the caller's standing **after** the write, on every
action — so the "Add a session 3/…" counter moves both up on `save` and back down
on `unsave` without a second call.

Repeating an action you have already taken answers 200 with the current state
rather than erroring — and an `approved` row is never quietly downgraded to
`saved`.

### 7.5 `GET user/agenda/{id}` — one event

The same object as one element of `events` in §7.1. `404` if the id is unknown.

### 7.6 Direct table access

`agenda` is still readable directly: `id`, `name`, `description`, `day`,
`start_time`, `end_time`, `speaker_name`, `speaker_title`, `speaker_company`,
`location`, `xp_value`, `is_sponsored`, `is_invite_only`, `capacity`,
`event_quest_config_id`, `event_day_config_id`, `stage_config_id`, `sort_order`,
`status`, `created_at`.

Tags are `agenda_guilds (agenda_id, guild_id, is_primary)` and audiences are
`agenda_user_types (agenda_id, user_type_config_id)`.

> **Embedding `configs` from `agenda` is a trap.** `agenda` reaches `configs` by
> **four** routes: the three direct FKs, plus a many-to-many through
> `agenda_user_types` (whose primary key is exactly its two FKs, which is how
> PostgREST recognises a junction table). An unhinted `configs(...)` therefore
> fails the *whole query* with `400 PGRST201`, and `agenda_user_types(configs(...))`
> is ambiguous rather than scoped to the join table.
>
> `GET user/agenda` avoids this by not embedding at all: it selects plain columns
> and resolves `configs` and `guilds` in memory, since both are reference tables of
> a dozen-odd rows. If you query `agenda` directly, either do the same or name the
> constraint on every `configs` embed:

```ts
await supabase.from("agenda").select(`
  id, name, start_time, xp_value, location, status,
  quest:configs!agenda_event_quest_config_id_fkey(name),
  agenda_guilds(is_primary, guilds(name))
`).order("sort_order");
```

> **Breaking change.** `user_agenda` is no longer client-writable — the insert and
> delete policies and grants are revoked, so the upsert this section used to
> document returns `42501`. Use `POST user/agenda/schedule`
> ([§7.4](#74-post-useragendaschedule--add-remove-or-ask)) instead. Reading your
> own rows still works, and the row now carries `status`.
>
> The reason is the invite-only flow: a client that can write its own row can
> write `status: "approved"` and let itself into a restricted event.

---

## 8. Chat

Four endpoints on the `chat` function, all needing a user token and all in the
`{ status, message, data }` envelope:

```
POST /functions/v1/chat/create        { "user_id": "<uuid>" }
GET  /functions/v1/chat/list          ?search=&page=&per_page=
GET  /functions/v1/chat/details/{id}  ?page=&per_page=
POST /functions/v1/chat/send/{id}     { "message": "..." }
```

Tables behind them: `chats` (`id`, `is_group`, `direct_key`, `created_at`),
`chat_participants` (`chat_id`, `user_id`, `joined_at`, `last_read_at`) and
`chat_messages` (`id`, `chat_id`, `sender_id`, `body`, `created_at` — insert only,
messages cannot be edited or deleted). Every route checks that the caller is a
participant first, so a chat id from somewhere else answers 404, not 403.

### 8.1 `POST chat/create` — start a chat with someone

```json
{
  "status": "Success",
  "message": "Chat started.",
  "data": {
    "chat_id": "6b1e...",
    "created": true,
    "user": { "id": "9d0f...", "first_name": "Ada", "last_name": "Byron", "nerd_number": "00042", "company_name": "Analytical Engines", "job_title": "Mathematician", "profile_image": null, "user_type": { "id": 1, "name": "Builder", "description": "..." }, "guilds": [] }
  }
}
```

Admin accounts answer 404 here, the same as everywhere else attendee-facing.

**Find-or-create**, so the button can be tapped twice without making two
conversations: `created` is `false` and the message reads "Chat opened." when the
chat already existed. There is one direct chat per pair, whichever side started
it. No connection request is needed first — any attendee can be messaged.

| Status | Body |
| --- | --- |
| 200 | above |
| 400 | `"user_id" must be an attendee id.` / `You cannot start a chat with yourself.` |
| 404 | `That attendee could not be found.` |

### 8.2 `GET chat/list` — my chats

Most recently active first, paged ([§3.1](#31-pagination)). `search` matches the
other person the same way the directory does — name, nerd number, company, title.

```json
{
  "status": "Success",
  "message": "4 chats.",
  "data": {
    "chats": [
      {
        "chat_id": "6b1e...",
        "is_group": false,
        "created_at": "2026-08-20T09:02:11.120044+00:00",
        "unread_count": 2,
        "user": { "id": "9d0f...", "first_name": "Ada", "last_name": "Byron", "profile_image": null, "...": "same card as the directory" },
        "last_message": {
          "id": "af31...",
          "body": "See you at the Payments stage",
          "sender_id": "9d0f...",
          "is_mine": false,
          "created_at": "2026-08-20T10:14:52.001+00:00"
        }
      }
    ],
    "search": null,
    "pagination": { "total": 4, "page": 1, "per_page": 20, "total_pages": 1, "has_next": false, "has_prev": false }
  }
}
```

`last_message` is `null` for a chat nobody has written in yet — those sort by
their own `created_at`. `unread_count` counts messages from the other person since
you last opened the chat.

### 8.3 `GET chat/details/{id}` — open a chat

The chat, the other person, and a page of messages **newest first** — so page 1 is
what the screen opens on. Reverse the array to render oldest-at-top, and fetch
`page=2` for older history.

```json
{
  "status": "Success",
  "message": "Chat loaded.",
  "data": {
    "chat_id": "6b1e...",
    "is_group": false,
    "created_at": "2026-08-20T09:02:11.120044+00:00",
    "unread_count": 2,
    "user": { "id": "9d0f...", "first_name": "Ada", "...": "same card" },
    "messages": [
      { "id": "af31...", "chat_id": "6b1e...", "sender_id": "9d0f...", "body": "See you at the Payments stage", "created_at": "2026-08-20T10:14:52.001+00:00", "is_mine": false },
      { "id": "9c02...", "chat_id": "6b1e...", "sender_id": "032b...", "body": "Are you going to the keynote?", "created_at": "2026-08-20T10:12:07.441+00:00", "is_mine": true }
    ],
    "pagination": { "total": 2, "page": 1, "per_page": 20, "total_pages": 1, "has_next": false, "has_prev": false }
  }
}
```

**Opening a chat marks it read** — there is no separate call for that. The
`unread_count` in this payload is the count from *before* it was cleared, so the
badge can be updated from the same response that fills the screen.

| Status | Body |
| --- | --- |
| 200 | above |
| 400 | `That is not a chat id.` — the path segment is not a uuid |
| 404 | `That chat could not be found.` — no such chat, or you are not in it |

### 8.4 `POST chat/send/{id}` — send a message

```json
{ "message": "Are you going to the keynote?" }
```

Answers with the stored message:

```json
{
  "status": "Success",
  "message": "Message sent.",
  "data": { "id": "9c02...", "chat_id": "6b1e...", "sender_id": "032b...", "body": "Are you going to the keynote?", "created_at": "2026-08-20T10:12:07.441+00:00", "is_mine": true }
}
```

| Status | Body |
| --- | --- |
| 200 | above |
| 400 | `"message" cannot be empty.` / `Messages must be 4000 characters or fewer.` |
| 404 | `That chat could not be found.` — no such chat, or you are not in it |

Sending also marks the chat read for the sender.

### 8.5 Live updates

The endpoints above are for sending and loading; new messages arriving while the
screen is open still come over realtime, straight from the table:

```ts
supabase.channel(`chat:${chatId}`)
  .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `chat_id=eq.${chatId}` },
      ({ new: message }) => append(message))
  .subscribe();
```

The row from realtime has no `is_mine` — compare `sender_id` with your own id.

### 8.6 Direct table access

Still available, and still governed by the participant-only RLS policies, but the
function is the easier path: creating a chat over REST takes three writes and the
first two cannot read their own rows back (a chat is only readable once you are a
participant), and a chat list needs a per-chat last message and an unread count
that PostgREST cannot express. `public.chat_overview` is the view that does both —
`GET /rest/v1/chat_overview?viewer_id=eq.<my-id>&order=last_message_at.desc`.

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
| Read the announcement | `GET /rest/v1/announcements?select=text,map_image,updated_at` |

`announcements` holds a single row pinned to `id = 1`: `text`, `map_image`,
`updated_by`, `updated_at`. Signed-in users can read it and nothing more — a write
on this path is rejected even for an admin (those go through the admin function).

`map_image` is the Home screen's floor plan (a public URL, or `null` for "no map").
The Home screen gets both fields from
[`GET user/home`](#61-get-userhome--the-home-screen) already, so it needs no extra
call.

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

Saves the announcement banner and/or the Home floor plan, replacing whatever was
there.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | — | Up to 2000 characters. **May be empty** — an empty string clears the banner. `null` clears it too, and the value is trimmed, so whitespace-only input also clears it |
| `map_image` | string | — | Public URL (`http(s)`) of the floor plan shown on Home. `null` or `""` removes the map. Upload the image to a storage bucket first — this stores the URL, not the bytes |

Both are optional, so the banner and the map can be edited independently, but
sending **neither** is a 400 (`Send "text" (an empty string clears the banner)
and/or "map_image".`) — a client bug cannot blank the banner by accident while
clearing it stays an explicit action. A non-string `text`, or a `map_image` that is
not an `http(s)` URL, is also a 400.

```json
{
  "status": "Success",
  "message": "Announcement saved.",
  "data": { "text": "Keynote moved to 10am.", "map_image": null, "updated_by": "88fd8fc0-...", "updated_at": "..." }
}
```

The message is `Announcement cleared.` when the resulting text is empty, and
`Map updated.` when only `map_image` was sent. `updated_by` is set to the admin who
saved it; `updated_at` is maintained by a trigger.

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
| Profile image upload | Built — `PUT user/profile` uploads to the `profile-images` bucket, see [§4.2](#42-put-userprofile--update-my-profile) |
| Sending push notifications | Rows can be inserted into `notifications` server-side, but nothing delivers to FCM/APNs yet |
| Sponsor management | Reading is built — `GET config/sponsors`, see [§5](#5-config--reference-data). *Writing* has no route: rows are added in Studio or by the service role |
| Admin: agenda, missions, QR codes, leaderboard | **Deliberately not built** — the user side is done ([§6](#6-home-missions-qr-codes-and-the-leaderboard), [§7](#7-agenda)); authoring events, missions and QR codes is done in Studio or by the service role for now. `public.mint_qr_codes()` mints a batch of codes to print — see below |
| Admin: approve invite-only requests | Not built. Attendees can already express interest ([§7.4](#74-post-useragendaschedule--add-remove-or-ask)); approving means setting `public.user_agenda.status` to `approved` or `rejected`, which awards the mission XP through the same trigger. Until there is a route, an admin does it in Studio |
| Admin: usage statistics | Not built. The numbers the FRD asks for are all derivable — sessions added (`user_agenda`), total XP (`leaderboard`), per-event interest (`user_agenda` grouped by `agenda_id`) |
| Admin: mark an attendee as having shown up | Not built. `public.agenda_checkins` is the table it would write, and scanning the session's QR code already does it for the attendee |

### Minting QR codes to print

There is no endpoint for this on purpose — the codes are created once, before the
event, by whoever is printing them:

```sql
select * from public.mint_qr_codes('activation', 'Activation', 12, 'visit_activation');
select * from public.mint_qr_codes('zone',       'Zone',        8, 'explore_zone');
select * from public.mint_qr_codes('nerd_flex',  'Nerd Flex lanyard', 1, 'nerd_flex');

-- A session check-in code, worth that event's xp_value:
select * from public.mint_qr_codes('session', 'Stablecoins in 2027', 1, null, '<agenda-uuid>');
```

Each row returns a `qr_code` slug. Print `https://<app>/q/<slug>` as a QR image,
place it physically, and the attendee's scan lands on
[`POST user/qr/scan`](#63-post-userqrscan--claim-a-scanned-qr-code). Edit the
generated `label` afterwards so the app's "you earned…" copy names the real booth.
Set `is_active = false` to retire a code without losing its scan history.
