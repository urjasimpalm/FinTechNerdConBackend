import { fail } from "./http.ts";
import { serviceClient } from "./supabase.ts";

export type Caller = { id: string; email: string | null };

/**
 * Resolves the caller from the Authorization header.
 *
 * Returns either the caller or the Response to send back, in the
 * { status, message, data } envelope.
 *
 * `verify_jwt` in config.toml is not a substitute for this: the project's anon
 * key is itself a valid JWT, so the gateway would wave through a request that
 * carries no user at all. auth.getUser() is what rejects that — an anon-key
 * token has no user attached.
 */
export async function requireUser(
  req: Request,
): Promise<{ caller: Caller } | { response: Response }> {
  const header = req.headers.get("Authorization");
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { response: fail("A user access token is required.", 401) };
  }

  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user) {
    return { response: fail("Your session is invalid or has expired.", 401) };
  }

  return { caller: { id: data.user.id, email: data.user.email ?? null } };
}
