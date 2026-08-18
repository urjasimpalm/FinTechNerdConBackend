// POST auth/reset-password
//   { "email": "...", "token": "123456", "password": "..." }
//   or, for the emailed-link variant: { "token_hash": "...", "password": "..." }
//
// Step 2 of the password reset. Verifying the recovery code is what proves the
// caller owns the mailbox, so no session is needed — and once it's verified the
// same client is authenticated as that user, which is how the password change is
// authorised (rather than an admin override).
//
// Returns a session on success, so the app can go straight into the logged-in
// state instead of bouncing the user back to the login screen.
import { fail, guardPostEnvelope, ok, readJson, text } from "../_shared/http.ts";
import { anonClient, serviceClient, USER_PROFILE_COLUMNS } from "../_shared/supabase.ts";

const MIN_PASSWORD_LENGTH = 8;

Deno.serve(async (req) => {
  const blocked = guardPostEnvelope(req);
  if (blocked) return blocked;

  const body = await readJson(req);
  if (!body) return fail("A JSON body is required.", 400);

  const email = text(body.email)?.toLowerCase();
  const token = text(body.token);
  const tokenHash = text(body.token_hash);
  const password = typeof body.password === "string" ? body.password : null;

  if (!password) return fail("A new password is required.", 400);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      400,
    );
  }
  // token_hash comes from the emailed link and identifies the user on its own;
  // the 6-digit code has to be paired with the address it was sent to.
  if (!tokenHash && !(email && token)) {
    return fail("Email and the reset code are required.", 400);
  }

  try {
    // verifyOtp stores the resulting session on this client instance, so the
    // updateUser call below runs as the user who owns the code.
    const client = anonClient();
    const { data: verified, error: verifyError } = tokenHash
      ? await client.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" })
      : await client.auth.verifyOtp({
        email: email!,
        token: token!,
        type: "recovery",
      });

    if (verifyError || !verified.session || !verified.user) {
      // Wrong code, already-used code and expired code are deliberately one
      // message — distinguishing them helps an attacker more than a user.
      return fail("This reset code is invalid or has expired.", 400);
    }

    const { error: updateError } = await client.auth.updateUser({ password });
    if (updateError) {
      // e.g. "New password should be different from the old password."
      return fail(updateError.message, 400);
    }

    const { data: profile } = await serviceClient()
      .from("users")
      .select(USER_PROFILE_COLUMNS)
      .eq("id", verified.user.id)
      .maybeSingle();

    // The session from verifyOtp survives the password change, so hand it back.
    const session = verified.session;
    return ok("Your password has been reset.", {
      token: session.access_token,
      token_type: session.token_type,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      refresh_token: session.refresh_token,
      user: profile ?? { id: verified.user.id, email: verified.user.email },
    });
  } catch (err) {
    console.error("reset-password failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
});
