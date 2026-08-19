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
