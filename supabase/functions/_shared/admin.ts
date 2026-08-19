import { type Caller, requireUser } from "./auth.ts";
import { fail } from "./http.ts";
import { serviceClient } from "./supabase.ts";

export type AdminCaller = Caller;

/**
 * Resolves the caller from the Authorization header and requires public.users
 * .is_admin.
 *
 * Returns either the caller or the Response to send back.
 *
 * Note `verify_jwt` in config.toml is not enough on its own: the project's anon
 * key is itself a valid JWT, so the gateway would let an anonymous caller
 * through. requireUser plus the is_admin lookup below is what actually gates
 * these endpoints.
 */
export async function requireAdmin(
  req: Request,
): Promise<{ caller: AdminCaller } | { response: Response }> {
  const signedIn = await requireUser(req);
  if ("response" in signedIn) return signedIn;

  const { data: profile, error: profileError } = await serviceClient()
    .from("users")
    .select("is_admin")
    .eq("id", signedIn.caller.id)
    .maybeSingle();

  if (profileError) {
    console.error("admin lookup failed", profileError);
    return {
      response: fail("Something went wrong. Please try again.", 500),
    };
  }

  // Same message whether the profile is missing or simply not an admin — a
  // non-admin has no business learning which it was.
  if (!profile?.is_admin) {
    return { response: fail("Admin access is required.", 403) };
  }

  return signedIn;
}
