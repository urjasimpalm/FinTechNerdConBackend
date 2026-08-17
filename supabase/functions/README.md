# Edge functions

Three functions, plus one SQL helper the client can call directly. For the whole
API surface the app talks to — profile, agenda, chat, missions, notifications —
see [../../docs/API.md](../../docs/API.md).

| What | Call | Auth needed |
| --- | --- | --- |
| Is this email on the attendee list? | `POST /rest/v1/rpc/is_email_in_stack` | anon key |
| Register | `POST /functions/v1/register` | anon key |
| Login | `POST /functions/v1/login` | anon key |
| Lookup lists (guilds, user types, days, stages) | `GET /functions/v1/config` | anon key |

Base URL:

- local: `http://127.0.0.1:54321`
- deployed: `https://<project-ref>.supabase.co`

All of them are public (no user session yet), but every request still needs the
project's anon/publishable key in the `apikey` header. `supabase-js` adds it for
you. `config` is documented in full in [../../docs/API.md](../../docs/API.md#5-config--reference-data).

---

## 1. Email check (optional pre-screen)

Returns a bare `true` / `false`. Case-insensitive.

```
POST /rest/v1/rpc/is_email_in_stack
{ "p_email": "wasim@simpalm.com" }
→ true
```

Use it if you want a "this email isn't on the list" message before asking for a
password. `register` runs the same check itself, so skipping this step is safe.

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

---

## Calling from the front end

```ts
import { createClient, FunctionsHttpError } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// step 1 (optional)
const { data: onList } = await supabase.rpc("is_email_in_stack", {
  p_email: email,
});

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
curl -X POST "$B/rest/v1/rpc/is_email_in_stack" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" -d '{"p_email":"you@example.com"}'
```

Function logs (`console.error`) stream in the `supabase functions serve`
terminal. Confirmation emails, if you ever turn `email_confirm` off in
`register`, land in Mailpit at http://127.0.0.1:54324.
