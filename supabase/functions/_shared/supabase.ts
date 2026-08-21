import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// Edge functions are stateless request handlers, so never let the client try to
// persist or auto-refresh a session between invocations.
const authOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
};

/** Anon-key client: used for password sign-in, subject to RLS. */
export function anonClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    authOptions,
  );
}

/**
 * Service-role client: bypasses RLS. Needed because public.users has no insert
 * policy (profiles are only ever created server-side) and because the invite
 * list in public.email_stack is not readable by anon.
 */
export function serviceClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    authOptions,
  );
}

// The profile shape every endpoint returns lives in ./profile.ts.

/*
 * PostgREST error codes that mean "the API's schema cache is stale", not "the
 * request was wrong".
 *
 *   PGRST200  no relationship found between two tables (a new FK or join table)
 *   PGRST204  a column is not in the cache (a newly added column)
 *   42703     the column really does not exist — a migration that did not run
 *
 * These are deployment problems: the caller cannot fix them and retrying will not
 * help, so they are worth shouting about rather than folding into a generic
 * "something went wrong".
 */
const SCHEMA_CACHE_CODES = new Set(["PGRST200", "PGRST204", "42703", "42P01"]);

/**
 * Logs a failed query with everything PostgREST actually said.
 *
 * `console.error("...", error)` on its own tends to render as `[object Object]`
 * in the function logs, which is how a 400 with a precise explanation attached
 * ends up being diagnosed by guesswork. Pull the fields out by name instead.
 */
export function logDbFailure(where: string, error: unknown): void {
  const detail = error as {
    code?: string;
    message?: string;
    details?: string;
    hint?: string;
  } | null;

  const code = detail?.code ?? "unknown";
  const stale = SCHEMA_CACHE_CODES.has(code);

  console.error(
    [
      stale ? `${where} failed — STALE SCHEMA CACHE OR MISSING MIGRATION` : `${where} failed`,
      `code=${code}`,
      `message=${detail?.message ?? String(error)}`,
      detail?.details ? `details=${detail.details}` : null,
      detail?.hint ? `hint=${detail.hint}` : null,
      // The fix, in the log line, so nobody has to go and look it up.
      stale
        ? "fix=run `notify pgrst, 'reload schema';` (or redeploy) and confirm every migration in supabase/migrations applied"
        : null,
    ].filter(Boolean).join(" | "),
  );
}
