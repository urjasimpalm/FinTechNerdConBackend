import { fail } from "./http.ts";
import { serviceClient } from "./supabase.ts";

export type AdminCaller = { id: string; email: string | null };

/**
 * Resolves the caller from the Authorization header and requires public.users
 * .is_admin.
 *
 * Returns either the caller or the Response to send back.
 *
 * Note `verify_jwt` in config.toml is not enough on its own: the project's anon
 * key is itself a valid JWT, so the gateway would let an anonymous caller
 * through. The is_admin lookup below is what actually gates these endpoints.
 */
export async function requireAdmin(
  req: Request,
): Promise<{ caller: AdminCaller } | { response: Response }> {
  const header = req.headers.get("Authorization");
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { response: fail("A user access token is required.", 401) };
  }

  const service = serviceClient();

  // Validates the signature and expiry, and rejects the anon key (it carries no
  // user).
  const { data: userResult, error: userError } = await service.auth.getUser(token);
  if (userError || !userResult.user) {
    return { response: fail("Your session is invalid or has expired.", 401) };
  }

  const { data: profile, error: profileError } = await service
    .from("users")
    .select("is_admin")
    .eq("id", userResult.user.id)
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

  return {
    caller: { id: userResult.user.id, email: userResult.user.email ?? null },
  };
}
