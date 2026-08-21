/*
 * Tell PostgREST to re-read the schema.
 *
 * PostgREST keeps an in-memory cache of tables, columns and — the part that
 * matters here — the foreign keys it uses to resolve embedded resources. The
 * migrations before this one add a table (public.agenda_user_types), a column
 * (public.agenda_guilds.is_primary) and several columns on public.agenda, all of
 * which GET user/agenda selects and embeds.
 *
 * Supabase installs a DDL event trigger that normally sends this automatically,
 * but it does not fire for every path (and does not fire at all if the API was
 * already mid-restart), which shows up as a 400 on a query that is perfectly
 * valid:
 *
 *   PGRST200  Could not find a relationship between 'agenda' and
 *             'agenda_user_types' in the schema cache
 *   PGRST204  Could not find the 'is_primary' column of 'agenda_guilds' in the
 *             schema cache
 *
 * Both are stale-cache errors, not schema errors — retrying does not help, and
 * nothing is wrong with the database. Sending the reload explicitly at the end of
 * the migration set makes the new relationships reachable as soon as the last
 * migration commits.
 *
 * Safe to re-run: NOTIFY with no listener is a no-op, and it is delivered on
 * commit rather than immediately, so it cannot fire for a migration that then
 * rolls back.
 */
notify pgrst, 'reload schema';
