# Edge functions

Six functions. For the whole API surface the app talks to — profile, agenda,
chat, missions, notifications — see [../../postman/API.md](../../postman/API.md).

| What | Call | Auth needed |
| --- | --- | --- |
| Is this email on the attendee list? | `POST /functions/v1/verify-email` | anon key |
| Register | `POST /functions/v1/register` | anon key |
| Login | `POST /functions/v1/login` | anon key |
| Email a password reset code | `POST /functions/v1/forgot-password` | anon key |
| Set a new password with that code | `POST /functions/v1/reset-password` | anon key |
| Lookup lists (guilds, user types, days, stages) | `GET /functions/v1/config` | anon key |

Base URL:

- local: `http://127.0.0.1:54321`
- deployed: `https://<project-ref>.supabase.co`

All of them are public (no user session yet), but every request still needs the
project's anon/publishable key in the `apikey` header. `supabase-js` adds it for
you. `config` is documented in full in [../../postman/API.md](../../postman/API.md#5-config--reference-data).

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
| 201 | `{ success: true, email_in_stack: true, message, data: { token, token_type, expires_in, expires_at, refresh_token, user } }` | Account created and signed in |
| 403 | `{ success: false, email_in_stack: false, message }` | Email is not on the attendee list — nothing was created |
| 409 | `{ success: false, email_in_stack: true, message }` | Already registered → send them to login |
| 400 | `{ success: false, message }` | Missing/invalid field, password under 8 chars, or a bad `guild_id` / `user_type_config_id` |

`data.user` is the full `public.users` profile row. Registration returns a
session, so there is no need to call `login` afterwards.

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
```

Function logs (`console.error`) stream in the `supabase functions serve`
terminal. Confirmation emails, if you ever turn `email_confirm` off in
`register`, land in Mailpit at http://127.0.0.1:54324.
