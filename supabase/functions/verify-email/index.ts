// POST auth/verify-email
//   { "email": "..." }
//
// Answers whether an email is on the pre-approved attendee list
// (public.email_stack). The register screen calls this before collecting a
// password so it can say "you're not on the list" early.
//
// Public on purpose — there is no session yet at this point in the flow. It runs
// on the service role because public.email_stack has RLS enabled with no
// policies, so the list itself stays unreadable; only the yes/no answer is
// exposed.
import { corsHeaders } from "../_shared/cors.ts";
import { json, readJson, text } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

// { status, message, data } on every path, so the client can read the same three
// keys whether the call succeeded or not.
function ok(message: string, data: unknown): Response {
  return json({ status: "Success", message, data });
}

function fail(message: string, httpStatus: number): Response {
  return json({ status: "Error", message, data: null }, httpStatus);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return fail("Method not allowed.", 405);

  const body = await readJson(req);
  if (!body) return fail("A JSON body is required.", 400);

  const email = text(body.email)?.toLowerCase();
  if (!email) return fail("Email is required.", 400);

  try {
    // Matching is case-insensitive and trimmed inside the function.
    const { data: exists, error } = await serviceClient().rpc("verify_email", {
      p_email: email,
    });

    if (error) {
      console.error("verify_email lookup failed", error);
      return fail("Something went wrong. Please try again.", 500);
    }

    // The lookup itself succeeded either way — a miss is Success with
    // email_exist false, not an Error.
    const emailExists = exists === true;
    return ok(
      emailExists
        ? "This email is on the attendee list."
        : "This email is not on the attendee list.",
      { email_exist: emailExists },
    );
  } catch (err) {
    console.error("verify-email failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
});
