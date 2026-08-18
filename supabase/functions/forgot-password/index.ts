// POST auth/forgot-password
//   { "email": "...", optional: "redirect_to": "https://..." }
//
// Step 1 of the password reset. Emails a 6-digit recovery code, which the client
// then sends to auth/reset-password together with the new password.
//
// The response is the same whether or not an account exists for that email —
// otherwise this endpoint would tell an attacker which addresses are registered.
// So "Success" here means "we've done our part", not "an email went out".
//
// Public: the caller has no session, that's the whole point.
import { fail, guardPostEnvelope, ok, readJson, text } from "../_shared/http.ts";
import { anonClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const blocked = guardPostEnvelope(req);
  if (blocked) return blocked;

  const body = await readJson(req);
  if (!body) return fail("A JSON body is required.", 400);

  const email = text(body.email)?.toLowerCase();
  if (!email) return fail("Email is required.", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail("Please enter a valid email address.", 400);
  }

  // Only used by the link-based (web) variant of the flow; harmless otherwise.
  const redirectTo = text(body.redirect_to) ?? undefined;

  try {
    const { error } = await anonClient().auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) {
      // GoTrue throttles recovery emails per address (60s by default). Its
      // message names the wait, so pass it through rather than inventing one.
      if (error.status === 429) return fail(error.message, 429);

      console.error("resetPasswordForEmail failed", error);
      return fail("Something went wrong. Please try again.", 500);
    }

    return ok(
      "If that email has an account, a reset code is on its way.",
      { email_sent: true },
    );
  } catch (err) {
    console.error("forgot-password failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
});
