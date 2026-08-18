# Environments

Three places the backend runs:

| Environment | Where | Deployed by |
| --- | --- | --- |
| Local | Docker on your machine (`supabase start`) | You, manually |
| Staging | A real Supabase project | Push to the `staging` branch |
| Production | A separate Supabase project | Push to `main` |

Staging and production are **two separate Supabase projects**. Nothing is shared
between them — separate databases, separate auth users, separate keys. The free
tier allows two projects per organisation, so this costs nothing to start.

[.github/workflows/supabase-deploy.yml](../.github/workflows/supabase-deploy.yml)
picks the target from the branch and reads that project's credentials from a
GitHub Environment of the same name.

---

## One-time setup for staging

### 1. Create the Supabase project

In the dashboard: **New project**, name it something like
`fintechnerdcon-staging`. Save the database password — you need it in step 3.

From **Project Settings → General**, copy the **project ref** (the 20-character
string, also the first part of the project URL).

### 2. Create the GitHub Environments

Repo → **Settings → Environments → New environment**. Create both:

- `staging`
- `production`

(Both must exist even though only staging is new, because the workflow selects
one by name on every run.)

### 3. Add the secrets

For **each** environment, add these three secrets:

| Secret | Where to find it |
| --- | --- |
| `SUPABASE_PROJECT_REF` | Project Settings → General → Reference ID |
| `SUPABASE_ACCESS_TOKEN` | [Account → Access Tokens](https://supabase.com/dashboard/account/tokens) — a personal token, the same one can serve both environments |
| `SUPABASE_DB_PASSWORD` | The database password from step 1 (`db push` needs it) |

Your existing repo-level secrets keep working as a fallback, so production
carries on deploying even before you move its secrets into the environment.
Moving them is still worth doing — it stops a staging run from ever reaching the
production project.

If you want a human to confirm production deploys, tick **Required reviewers** on
the `production` environment.

### 4. Create the branch

```bash
git checkout -b staging
git push -u origin staging
```

From then on, pushing to `staging` deploys migrations and edge functions to the
staging project. `main` continues to deploy to production.

### 5. Configure staging's auth settings

These live in the dashboard, not in the repo, and the reset-password flow does
not work until the first one is done:

- **Authentication → Emails → Reset Password** — the template must include
  `{{ .Token }}`, or `reset-password` only accepts `token_hash`. Copy the body
  from [supabase/templates/recovery.html](../supabase/templates/recovery.html).
- **Authentication → URL Configuration** — set Site URL and any redirect URLs to
  the staging app's, not localhost.
- **Authentication → SMTP** — the built-in sender is capped at a few emails per
  hour, which the reset flow will hit immediately. Configure real SMTP before
  testing password resets in earnest.

Alternatively these can be pushed from `config.toml` — see
[Pushing auth config](#pushing-auth-config) below, and read the warning first.

### 6. Seed the reference data

`db push` applies migrations but does **not** run [seed.sql](../seed.sql), so
`guilds`, `configs` and `missions` come up empty — and registering with a
`guild_id` or `user_type_config_id` will fail on a foreign key until they're
populated. Run it once against staging:

```bash
supabase link --project-ref <staging-ref>
psql "$(supabase db url)" -f seed.sql        # or paste seed.sql into the SQL editor
```

### 7. Add yourself to the attendee list

Registration is invite-only, so nothing can register on staging until
`email_stack` has rows. In the SQL editor:

```sql
insert into public.email_stack (email, first_name, last_name)
values ('you@yourdomain.com', 'Your', 'Name')
on conflict (email) do nothing;
```

### 8. Make yourself an admin (optional)

`is_admin` cannot be set by the app — by design, or any user could promote
themselves. Set it from the SQL editor:

```sql
update public.users set is_admin = true where email = 'you@yourdomain.com';
```

---

## Testing against staging

Import [FinTechNerdCon.postman_environment.staging.json](FinTechNerdCon.postman_environment.staging.json)
alongside the collection, fill in `base_url`, `anon_key`, `test_email` and
`test_password`, and select it. Everything in [API.md](API.md) then runs against
the real project.

```bash
npx newman run postman/FinTechNerdCon.postman_collection.json \
  -e postman/FinTechNerdCon.postman_environment.staging.json
```

Three differences from local worth knowing:

- **Emails are real.** There's no Mailpit — reset codes arrive in the actual
  inbox, subject to the project's rate limits.
- **`allow_destructive` still guards** the delete-account and logout requests.
  Leave it `false` unless you mean it.
- **A collection run writes real rows** (a chat, a message, mission progress).
  Fine on staging, which is what it's for.

---

## Local

Unchanged from before:

```bash
supabase start                  # whole stack in Docker
supabase functions serve        # edge functions; leave running in its own terminal
supabase db reset               # reapply every migration from scratch
```

`supabase db reset` is the cheapest way to find out whether the migrations still
apply cleanly from nothing — which is exactly what a fresh staging project does
on its first deploy.

Emails land in Mailpit at http://127.0.0.1:54324.

---

## Pushing auth config

`supabase config push` sends the `[auth]` section of
[supabase/config.toml](../supabase/config.toml) to the linked project, email
templates included. **Read this before running it:** the local config has
`site_url = "http://localhost:3000"`, so pushing as-is would repoint a hosted
project's auth redirects at localhost and break sign-in links.

The CLI supports per-project overrides for exactly this. Add a block like the
following (the commented example is in `config.toml`), then push:

```toml
[remotes.staging]
project_id = "your-staging-project-ref"

[remotes.staging.auth]
site_url = "https://staging.yourdomain.com"
additional_redirect_urls = ["https://staging.yourdomain.com/**"]
```

```bash
supabase link --project-ref <staging-ref>
supabase config push
```

Until those overrides are written and verified against a project you don't mind
disturbing, configure staging's auth settings in the dashboard (step 5). The
deploy workflow deliberately does not run `config push`.

---

## Known issue: migration history

Local and production migration histories have diverged. Production has four
migrations with no file in this repo:

```
20260811134109  20260811143644  20260811160000  20260812090000
```

and the repo has `0001`–`0014`, which production has never recorded.
`supabase migration list` against production shows both columns.

This does not affect a **new** staging project: it starts empty and applies every
local migration in order, which is a genuinely useful check that the migration
set is coherent. It does affect production — the next `db push` there will try to
apply the `0001`–`0014` files against a database that already has those objects.
Worth resolving (with `supabase migration repair`) before the next production
deploy, separately from the staging work.
