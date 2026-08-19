# Edge functions

Seven functions. For the whole API surface the app talks to — profile, agenda,
chat, missions, notifications — see [../../postman/API.md](../../postman/API.md).

| What | Call | Auth needed |
| --- | --- | --- |
| Is this email on the attendee list? | `POST /functions/v1/verify-email` | anon key |
| Register | `POST /functions/v1/register` | anon key |
| Login | `POST /functions/v1/login` | anon key |
| Email a password reset code | `POST /functions/v1/forgot-password` | anon key |
| Set a new password with that code | `POST /functions/v1/reset-password` | anon key |
| Lookup lists (guilds, user types, days, stages) | `GET /functions/v1/config` | anon key |
| My profile | `GET /functions/v1/user/profile` | user token |
| Update my profile (incl. picture upload) | `PUT /functions/v1/user/profile` | user token |
| List attendee-list emails | `GET /functions/v1/admin/user/list` | **admin** user token |
| Add attendee-list emails | `POST /functions/v1/admin/user/add` | **admin** user token |
| Remove attendee-list emails | `DELETE /functions/v1/admin/user/remove` | **admin** user token |
| Read the announcement (editor) | `GET /functions/v1/admin/announcement/get` | **admin** user token |
| Save the announcement | `POST /functions/v1/admin/announcement/post` | **admin** user token |

Base URL:

- local: `http://127.0.0.1:54321`
- deployed: `https://<project-ref>.supabase.co`

The first six are public (no user session yet), but every request still needs the
project's anon/publishable key in the `apikey` header. `supabase-js` adds it for
you. `config` is documented in full in [../../postman/API.md](../../postman/API.md#5-config--reference-data),
and the admin routes in [§11](../../postman/API.md#11-admin-routes).

`admin` is the exception: it needs a real user's access token and checks
`public.users.is_admin`. `verify_jwt` alone would not gate it, because the anon
key is itself a valid JWT — the `is_admin` lookup in `_shared/admin.ts` is what
does.

The `admin` function routes on the path after its name, so further admin routes
(`admin/<area>/<action>`) go in the same function with nothing extra to deploy.

---

## 1. Verify email (optional pre-screen)

Case-insensitive, trimmed. A miss is a 200 `Success` with `email_exist: false`,
not an error.

```
POST /functions/v1/verify-email
{ "email": "wasim@simpalm.com" }
→ {
    "status": "Success",
    "message": "This email is on the attendee list.",
    "data": { "email_exist": true }
  }
```

Errors keep the same three keys with `data: null`, e.g.
`{ "status": "Error", "message": "Email is required.", "data": null }`.

Use it if you want a "this email isn't on the list" message before asking for a
password. `register` runs the same check itself, so skipping this step is safe.

Backed by `public.verify_email(text)`, which is granted to the service role only
— this function is the only way to reach it.

## 2. Register

```
POST /functions/v1/register
{
  "email": "wasim@simpalm.com",
  "password": "Passw0rd!23",
  "first_name": "Wasim",
  "last_name": "Raza",

  // all optional
  "user_type_config_id": 1,
  "guild_id": 2,
  "company_name": "Simpalm",
  "job_title": "CTO",
  "profile_image": "https://...",
  "device_type": 1,
  "device_token": "fcm-or-apns-token"
}
```

| Status | Body | Meaning |
| --- | --- | --- |
| 201 | `{ success: true, message }` | Account created — status and message only, no session or profile |
| 403 | `{ success: false, email_in_stack: false, message }` | Email is not on the attendee list — nothing was created |
| 409 | `{ success: false, email_in_stack: true, message }` | Already registered → send them to login |
| 400 | `{ success: false, message }` | Missing/invalid field, password under 8 chars, or a bad `guild_id` / `user_type_config_id` |

Registration returns no data of its own. The account is created already
confirmed, so call `login` straight after a 201 to get the token and the
`public.users` profile row.

## 3. Login

```
POST /functions/v1/login
{ "email": "wasim@simpalm.com", "password": "Passw0rd!23" }
```

| Status | Body |
| --- | --- |
| 200 | `{ success: true, message, data: { token, token_type, expires_in, expires_at, refresh_token, user } }` |
| 401 | `{ success: false, message: "Invalid email or password." }` |
| 400 | `{ success: false, message }` — email or password missing |

Wrong password and unknown email both return the same 401 on purpose, so the
endpoint can't be used to find out which emails have accounts.

## 4. Forgot password → 5. Reset password

Two steps, both using the `{ status, message, data }` envelope.

```
POST /functions/v1/forgot-password
{ "email": "wasim@simpalm.com" }
→ { "status": "Success",
    "message": "If that email has an account, a reset code is on its way.",
    "data": { "email_sent": true } }
```

An unknown email gets the same 200 — otherwise this would leak which addresses
have accounts. 429 means the per-address email throttle kicked in; its message
names the wait.

```
POST /functions/v1/reset-password
{ "email": "wasim@simpalm.com", "token": "923615", "password": "NewPassw0rd!" }
→ { "status": "Success", "message": "Your password has been reset.",
    "data": { token, token_type, expires_in, expires_at, refresh_token, user } }
```

`token` is the 6-digit code from the email; alternatively send `token_hash` on
its own (the `token` query param from the emailed link, for the web flow). Codes
are single-use, and wrong/used/expired all return the same
`This reset code is invalid or has expired.` 400.

`data` matches login's, so the app can drop straight into the logged-in state.

The code comes from the recovery email template, which needs `{{ .Token }}` in
it — set for local dev via [`config.toml`](../config.toml) and
[`templates/recovery.html`](../templates/recovery.html), and separately on the
hosted project under Authentication → Emails → Reset Password.

## 6. My profile

```
GET /functions/v1/user/profile
PUT /functions/v1/user/profile
Authorization: Bearer <user token>
```

Both use the `{ status, message, data }` envelope, and both answer with the same
`data`: the profile columns, `nerd_number`, `guild` and `user_type` as
`{ id, name, description }` objects, plus `total_xp` and `rank` from
`public.leaderboard` (0 / null for a user with no completed missions).

Editable by PUT: `first_name`, `last_name`, `user_type_config_id`, `guild_id`,
`company_name`, `job_title`, `profile_image`. Absent fields are left alone, `null`
clears an optional one, and anything else in the body (`nerd_number`, `email`,
`is_admin`) is ignored rather than rejected.

`profile_image` takes a `multipart/form-data` file part, a `data:` URI, an https
URL, or `null`. Uploads land in the `profile-images` storage bucket under
`<user-id>/<timestamp>.<ext>` and the saved value is the public URL; the previous
upload is deleted after a successful save. JPEG/PNG/WebP/HEIC, 5 MB max.

There is no id in the path or body — the row is resolved from the token, so a
caller can only ever read or write their own profile. Full request/response
examples are in [../../postman/API.md](../../postman/API.md#4-profile-and-attendee-directory).

---

## Calling from the front end

```ts
import { createClient, FunctionsHttpError } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// step 1 (optional)
const { data: check } = await supabase.functions.invoke("verify-email", {
  body: { email },
});
if (!check.data.email_exist) showNotOnListMessage();

// register
async function register(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("register", { body });

  // invoke() turns any non-2xx into an error, so read our JSON payload off it
  // to tell 403 (not on the list) apart from 409 (already registered).
  if (error instanceof FunctionsHttpError) {
    const payload = await error.context.json();
    throw payload; // { success: false, email_in_stack?: boolean, message }
  }
  if (error) throw error;
  // { success: true, message } — nothing else, so log in next for the session.
  return data;
}

// login
const { data, error } = await supabase.functions.invoke("login", {
  body: { email, password },
});
```

After either call, hand the tokens to the client SDK so subsequent queries run
as that user and satisfy the RLS policies:

```ts
await supabase.auth.setSession({
  access_token: data.data.token,
  refresh_token: data.data.refresh_token,
});
```

Plain `fetch` works too (React Native, or any non-JS client):

```ts
await fetch(`${SUPABASE_URL}/functions/v1/login`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
  },
  body: JSON.stringify({ email, password }),
});
```

---

## Testing locally

```bash
supabase start                  # once, if the stack isn't up
supabase functions serve        # leave running; reloads on file save
supabase status                 # prints API_URL and ANON_KEY
```

Registration is invite-only, so put a test email on the list first:

```bash
docker exec -i supabase_db_FinTechNerdConBackend \
  psql -U postgres -d postgres \
  -c "insert into public.email_stack (email) values ('you@example.com') on conflict do nothing;"
```

Then:

```bash
export ANON="$(supabase status -o json | python3 -c 'import json,sys;print(json.load(sys.stdin)["ANON_KEY"])')"
export B=http://127.0.0.1:54321

# register
curl -i -X POST "$B/functions/v1/register" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"Passw0rd!23","first_name":"Test","last_name":"User"}'

# login
curl -i -X POST "$B/functions/v1/login" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"Passw0rd!23"}'

# email check
curl -i -X POST "$B/functions/v1/verify-email" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'

# my profile (TOKEN comes from the login response above)
curl -i "$B/functions/v1/user/profile" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN"

# update it, picture included
curl -i -X PUT "$B/functions/v1/user/profile" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
  -F "job_title=CTO" -F "guild_id=2" -F "profile_image=@/path/to/photo.jpg"
```

Function logs (`console.error`) stream in the `supabase functions serve`
terminal. Confirmation emails, if you ever turn `email_confirm` off in
`register`, land in Mailpit at http://127.0.0.1:54324.
