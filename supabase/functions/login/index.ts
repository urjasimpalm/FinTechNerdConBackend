// POST auth/login
//   { "email": "...", "password": "..." }
// Verifies the credentials against auth.users and, on success, returns the
// access token plus the caller's public.users profile.
import { guardPost, json, readJson, text } from "../_shared/http.ts";
import { anonClient, serviceClient, USER_PROFILE_COLUMNS } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const blocked = guardPost(req);
  if (blocked) return blocked;

  const body = await readJson(req);
  if (!body) {
    return json({ success: false, message: "A JSON body is required." }, 400);
  }

  const email = text(body.email)?.toLowerCase();
  const password = typeof body.password === "string" ? body.password : null;
  if (!email || !password) {
    return json(
      { success: false, message: "Email and password are required." },
      400,
    );
  }

  try {
    const { data, error } = await anonClient().auth.signInWithPassword({
      email,
      password,
    });

    // Deliberately one message for "no such user" and "wrong password" so the
    // endpoint cannot be used to discover which emails have accounts.
    if (error || !data.session || !data.user) {
      return json(
        { success: false, message: "Invalid email or password." },
        401,
      );
    }

    const { data: profile } = await serviceClient()
      .from("users")
      .select(USER_PROFILE_COLUMNS)
      .eq("id", data.user.id)
      .maybeSingle();

    return json({
      success: true,
      message: "Login successful.",
      data: {
        token: data.session.access_token,
        token_type: data.session.token_type,
        expires_in: data.session.expires_in,
        expires_at: data.session.expires_at,
        refresh_token: data.session.refresh_token,
        user: profile ?? { id: data.user.id, email: data.user.email },
      },
    });
  } catch (err) {
    console.error("login failed", err);
    return json(
      { success: false, message: "Something went wrong. Please try again." },
      500,
    );
  }
});
