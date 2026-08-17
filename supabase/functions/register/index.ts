// POST auth/register
//   { "email": "...", "password": "...", "first_name": "...", "last_name": "...",
//     optional: user_type_config_id, guild_id, company_name, job_title,
//               profile_image, device_type, device_token }
//
// Registration is invite-only: the email must already be on the pre-approved
// attendee list in public.email_stack. If it is not, the response is
// { success: false, email_in_stack: false } and no account is created.
//
// The client can run that check on its own screen first by calling the same
// helper directly: POST /rest/v1/rpc/is_email_in_stack { "p_email": "..." }
// which returns a bare true/false.
import { guardPost, integer, json, readJson, text } from "../_shared/http.ts";
import { anonClient, serviceClient, USER_PROFILE_COLUMNS } from "../_shared/supabase.ts";

const MIN_PASSWORD_LENGTH = 8;

Deno.serve(async (req) => {
  const blocked = guardPost(req);
  if (blocked) return blocked;

  const body = await readJson(req);
  if (!body) {
    return json({ success: false, message: "A JSON body is required." }, 400);
  }

  const email = text(body.email)?.toLowerCase();
  const password = typeof body.password === "string" ? body.password : null;
  const firstName = text(body.first_name);
  const lastName = text(body.last_name);

  if (!email || !password || !firstName || !lastName) {
    return json({
      success: false,
      message: "email, password, first_name and last_name are required.",
    }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, message: "Please enter a valid email address." }, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return json({
      success: false,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    }, 400);
  }

  const service = serviceClient();

  try {
    // Step 1 — is this email on the invite list?
    const { data: inStack, error: stackError } = await service.rpc(
      "is_email_in_stack",
      { p_email: email },
    );
    if (stackError) {
      console.error("email_stack lookup failed", stackError);
      return json(
        { success: false, message: "Something went wrong. Please try again." },
        500,
      );
    }
    if (inStack !== true) {
      return json({
        success: false,
        email_in_stack: false,
        message: "This email is not on the attendee list.",
      }, 403);
    }

    // Step 2 — create the auth account. The email came off the vetted invite
    // list, so it is confirmed up front and the user can sign in immediately.
    const { data: created, error: createError } = await service.auth.admin
      .createUser({
        email,
        password,
        email_confirm: true,
      });

    if (createError || !created.user) {
      const alreadyExists = createError?.status === 422 ||
        /already/i.test(createError?.message ?? "");
      if (alreadyExists) {
        return json({
          success: false,
          email_in_stack: true,
          message: "An account with this email already exists.",
        }, 409);
      }
      console.error("createUser failed", createError);
      return json({
        success: false,
        message: createError?.message ?? "Could not create the account.",
      }, 400);
    }

    // Step 3 — the profile row. public.users has no insert policy, so this only
    // works through the service role.
    const { data: profile, error: profileError } = await service
      .from("users")
      .insert({
        id: created.user.id,
        first_name: firstName,
        last_name: lastName,
        email,
        user_type_config_id: integer(body.user_type_config_id),
        guild_id: integer(body.guild_id),
        company_name: text(body.company_name),
        job_title: text(body.job_title),
        profile_image: text(body.profile_image),
        device_type: integer(body.device_type),
        device_token: text(body.device_token),
      })
      .select(USER_PROFILE_COLUMNS)
      .single();

    if (profileError) {
      // Do not leave an auth account behind with no profile attached to it —
      // the next attempt would fail with "already exists" and strand the user.
      await service.auth.admin.deleteUser(created.user.id);
      console.error("profile insert failed", profileError);
      return json({
        success: false,
        message: "Could not save the profile. Please check the details and try again.",
      }, 400);
    }

    // Step 4 — hand back a session so the client does not have to call login.
    const { data: signIn } = await anonClient().auth.signInWithPassword({
      email,
      password,
    });

    return json({
      success: true,
      email_in_stack: true,
      message: "Registration successful.",
      data: {
        token: signIn?.session?.access_token ?? null,
        token_type: signIn?.session?.token_type ?? null,
        expires_in: signIn?.session?.expires_in ?? null,
        expires_at: signIn?.session?.expires_at ?? null,
        refresh_token: signIn?.session?.refresh_token ?? null,
        user: profile,
      },
    }, 201);
  } catch (err) {
    console.error("register failed", err);
    return json(
      { success: false, message: "Something went wrong. Please try again." },
      500,
    );
  }
});
