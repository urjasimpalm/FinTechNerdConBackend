# Agenda Migration Feature — Setup Guide

This document describes the setup required for the one-click agenda migration feature between two Supabase projects.

## Overview

The migration feature allows admins to migrate the complete agenda from the source Supabase project ("Fintech NerdCon Agenda Main") to the target project ("Fintech Nerd Con App Simpalm") with one API call.

**Key characteristics:**
- **Idempotent**: Safe to run multiple times; already-migrated sessions are updated, not duplicated
- **Atomic per session**: Speakers are created/found, agenda is inserted/updated, mapping is recorded
- **Error reporting**: Validation failures don't stop the migration; they're reported in the response
- **Speaker deduplication**: Uses speaker name matching to avoid duplicates
- **Secure**: All credentials are server-side; never exposed to frontend

## Architecture

```
Frontend                Backend/Edge Function              Supabase Projects
   |                            |                                |
   | POST /admin/agenda/        |                                |
   | migrate-from-source        |                                |
   |---------->|                |                                |
   |           |                | Connect (service role)         |
   |           |                |-----source (SOURCE_URL)------->|
   |           |                |     public.public_agenda       |
   |           |                |<-----[rows]-----[rows]---------|
   |           |                |                                |
   |           | For each row:  | Connect (service role)         |
   |           |   - Match/create speakers        target (SUPABASE_URL)----->|
   |           |   - Insert/update agenda                       |
   |           |   - Record mapping in source_map               |
   |           |                | Write agenda                   |
   |           |                |------> public.agenda           |
   |           |                |                                |
   |           | Return stats   |                                |
   |<---------- {created, updated, failed}                       |
   |           |                |                                |
```

## Environment Variables (Server-Side Only)

The following environment variables must be set in your Supabase Edge Function environment. These are **never** sent to the frontend.

### Source Project

```
SOURCE_SUPABASE_URL=https://your-source-project.supabase.co
SOURCE_SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
```

Where:
- `SOURCE_SUPABASE_URL`: API URL of the source Supabase project (Fintech NerdCon Agenda Main)
- `SOURCE_SUPABASE_SERVICE_ROLE_KEY`: Service role key for the source project
  - Found in: Supabase dashboard → Settings → API → Service Role Key
  - Must have full access to `public.public_agenda` view

### Target Project

```
SUPABASE_URL=https://your-target-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
```

These are your existing Supabase environment variables (already configured for this project).

Where:
- `SUPABASE_URL`: API URL of the target project (Fintech Nerd Con App Simpalm)
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key for the target project
  - Must have write access to:
    - `public.speakers` table
    - `public.agenda` table
    - `public.agenda_source_map` table (created by migration 20260916000001_agenda_source_map.sql)

## Deployment Steps

### 1. Deploy Database Migration

Apply the migration that creates the `agenda_source_map` tracking table:

```bash
supabase db push
```

Or manually run the SQL:

```sql
-- supabase/migrations/20260916000001_agenda_source_map.sql
CREATE TABLE IF NOT EXISTS public.agenda_source_map (
  source_session_id TEXT NOT NULL,
  target_agenda_id UUID NOT NULL REFERENCES public.agenda(id) ON DELETE CASCADE,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_session_id),
  UNIQUE (target_agenda_id)
);
```

This table tracks which source sessions have been migrated to which target agenda items, enabling idempotent re-runs.

### 2. Set Environment Variables

In your Supabase project's Edge Function secrets, add:

```bash
# Via Supabase dashboard
Settings → Edge Functions → Secrets

SOURCE_SUPABASE_URL
SOURCE_SUPABASE_SERVICE_ROLE_KEY
```

Or via CLI:

```bash
supabase secrets set SOURCE_SUPABASE_URL "https://your-source-project.supabase.co"
supabase secrets set SOURCE_SUPABASE_SERVICE_ROLE_KEY "eyJhbGc..."
```

### 3. Deploy Edge Functions

The migration function is part of the admin routes:

```bash
supabase functions deploy admin
```

Or locally test with:

```bash
supabase start
# Edge functions are automatically deployed in local mode
```

### 4. Verify Deployment

Check that the migration endpoint is accessible:

```bash
curl -X POST https://your-target-project.supabase.co/functions/v1/admin/agenda/migrate-from-source \
  -H "Authorization: Bearer <admin_user_token>" \
  -H "apikey: <anon_key>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response (if no source sessions exist):

```json
{
  "status": "Success",
  "message": "Migration completed",
  "data": {
    "success": true,
    "total": 0,
    "created": 0,
    "updated": 0,
    "skipped": 0,
    "failed": 0,
    "errors": []
  }
}
```

## File Structure

New/modified files:

```
supabase/
  migrations/
    20260916000001_agenda_source_map.sql       ← New: tracking table
  functions/
    admin/
      migrate-agenda.ts                         ← New: migration logic
      index.ts                                  ← Modified: added route
  functions/
    _shared/
      supabase.ts                               ← Modified: added sourceClient()

postman/
  FinTechNerdCon.postman_collection.json       ← Modified: added migration request
  API.md                                        ← Modified: added §11.9 documentation

MIGRATION_SETUP.md                              ← This file
```

## API Usage

### Via Postman

1. Import [FinTechNerdCon.postman_collection.json](postman/FinTechNerdCon.postman_collection.json)
2. Run **1. Auth → Login as Admin** to get an admin token
3. Go to **9. Admin → Migrate agenda from source**
4. Click **Send**

The response shows:
- `created`: number of new agenda items
- `updated`: number of existing agenda items re-migrated
- `failed`: number of sessions that failed validation
- `errors`: detailed error messages for each failure

### Programmatically

```typescript
const { data, error } = await supabase.functions.invoke("admin/agenda/migrate-from-source", {
  method: "POST",
});

if (error) {
  console.error("Migration failed:", error);
} else {
  console.log(`Migration result: ${data.created} created, ${data.updated} updated, ${data.failed} failed`);
  if (data.errors && data.errors.length > 0) {
    data.errors.forEach(err => {
      console.error(`  ${err.title}: ${err.error}`);
    });
  }
}
```

## Validation & Error Handling

The migration validates each source session before inserting. Common validation errors:

| Error | Cause | Resolution |
| --- | --- | --- |
| `Description exceeds 650 characters` | Source description is too long | Trim the source description to ≤650 chars |
| `Sponsored session must have sponsor_name` | `sponsored = true` but `sponsor_name` is empty | Set sponsor_name in the source session |
| `Agenda requires at least 1 speaker` | No speakers found | Add at least 1 speaker to the source session |
| `Agenda cannot have more than 4 speakers` | More than 4 speakers | Remove speakers from the source session (max 4) |
| `Failed to search for existing speaker` | Database connection error | Check SOURCE_SUPABASE credentials |
| `Failed to create agenda` | Database constraint violation | Check target config IDs and schema |

**Validation errors do not stop the migration.** Sessions with validation errors are reported in the response's `errors` array, and the migration continues with the next session.

## Idempotency & Re-running

The migration is safe to run multiple times:

1. First run: Creates new `agenda_source_map` entries for each session
2. Second run: Finds existing mappings and updates existing agenda items instead

**Example:**

```
First run:
  - Source session "Keynote" → Created as agenda item abc-123
  - Mapping: source_session_id="session-001" → target_agenda_id="abc-123"
  - Result: {created: 1, updated: 0}

Second run (re-run without changes):
  - Source session "Keynote" still matches "Keynote"
  - Mapping found: session-001 → abc-123
  - Updates existing abc-123 with the same data
  - Result: {created: 0, updated: 1}

Second run (with changes to source):
  - Source "Keynote" description updated in source
  - Updates abc-123 with new description
  - Result: {created: 0, updated: 1}
```

## Logging

The migration function logs detailed information to Edge Function logs:

```
[MIGRATION] Started
[MIGRATION] Fetching source agenda
[MIGRATION] Source records found: 48
[MIGRATION] Processing session: "Stablecoin Rails, End to End" (session-001)
[MIGRATION] Speaker reused: "John Doe"
[MIGRATION] Speaker created: "Jane Smith"
[MIGRATION] Agenda created: "Stablecoin Rails, End to End"
[MIGRATION] Failed: "Keynote" - Description exceeds 650 characters
[MIGRATION] Completed
[MIGRATION] Summary: 45 created, 3 updated, 0 failed out of 48
```

Access logs via Supabase dashboard → Edge Functions → Logs.

## Troubleshooting

### "Missing environment variable SOURCE_SUPABASE_URL"

**Cause**: Environment variables not set in Supabase secrets

**Fix**:
```bash
supabase secrets set SOURCE_SUPABASE_URL "https://your-source-project.supabase.co"
supabase secrets set SOURCE_SUPABASE_SERVICE_ROLE_KEY "eyJhbGc..."
```

### "Failed to fetch source agenda data"

**Cause**: Source Supabase URL or key is incorrect, or source project is unreachable

**Fix**:
1. Verify `SOURCE_SUPABASE_URL` is correct (should be the source project's API URL)
2. Verify `SOURCE_SUPABASE_SERVICE_ROLE_KEY` is correct (from source project settings)
3. Ensure source Supabase project is running

### "Failed to create speaker"

**Cause**: Target `public.speakers` table has a constraint violation, or service role lacks write permission

**Fix**:
1. Verify `SUPABASE_SERVICE_ROLE_KEY` has write access to `public.speakers`
2. Check that speaker name is non-empty
3. Check for duplicate speaker IDs (should not happen with auto-generated IDs)

### "Failed to create agenda"

**Cause**: Target `public.agenda` table constraint violation, or invalid config IDs

**Fix**:
1. Verify config IDs (event_quest_config_id, stage_config_id, event_day_config_id) exist in target and are **identical** to source IDs
2. Check that all required fields are present (name, speakers, etc.)
3. Verify description is ≤ 650 characters
4. Check `public.agenda_source_map` table exists (run migrations)

### "Unknown admin route"

**Cause**: Edge function not deployed, or endpoint path incorrect

**Fix**:
```bash
supabase functions deploy admin
supabase functions list
# Should show: admin-migrate-from-source
```

## Security Notes

✅ **What is secure:**
- Service role keys are **never** sent to the frontend
- Credentials are stored in Supabase Edge Function secrets
- All writes use the service role (bypasses RLS, which is correct for admin operations)
- No user input is accepted by the migration endpoint

⚠️ **What requires care:**
- Service role keys have full database access; guard them carefully
- The migration endpoint requires `is_admin = true`; restrict admin access in your application
- Source and target projects must have identical config IDs for foreign keys to work correctly

## FAQ

**Q: Can I migrate back to the source?**

A: No, the migration is one-way (source → target). To reverse it, you would delete target rows manually or restore a backup of the target project.

**Q: What if the migration fails partway through?**

A: The migration processes sessions one at a time. If one fails, the others continue. The response shows `failed: 1` and the error in the `errors` array. Re-running will migrate the failed session again (idempotent).

**Q: Does the migration affect live users?**

A: The target `public.agenda` table is read-only to authenticated users (RLS policies). The migration writes using the service role, so it does not trigger user-facing side effects. However, if live users are viewing the agenda, they may see new/updated events appear during the migration.

**Q: Can I migrate specific sessions, not all?**

A: Not with the current endpoint. The migration always migrates all sessions from `public.public_agenda` in the source. To migrate a subset, you would need to filter in the source view or manually migrate individual sessions via `POST admin/agenda/create`.

**Q: How long does the migration take?**

A: Depends on the number of sessions. Typically ~100-200ms per session (including speaker lookup/creation). For 50 sessions, expect 5-10 seconds. This is logged in the response and Edge Function logs.

## Related Documentation

- [API.md § 11.9](postman/API.md#119-post-adminagendamigrate-from-source) — API documentation
- [Postman Collection](postman/FinTechNerdCon.postman_collection.json) — Example request
- [Database Migrations](supabase/migrations/) — Schema definitions
- [Admin Routes](supabase/functions/admin/) — Edge function source code
