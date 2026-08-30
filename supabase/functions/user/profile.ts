// GET/PUT user/profile and GET user/profile/{id} — my own profile, and someone
// else's.
//
// A picked image is uploaded here: PUT accepts multipart/form-data with the file
// under `profile_image`, stores it in the profile-images bucket and saves the
// public URL. JSON callers can send a data URI, an https URL, or null instead.
import { fail, integer, ok, text } from "../_shared/http.ts";
import {
  bucketPath as pathInBucket,
  contentTypeFor,
  decodeDataUri as decodeImageDataUri,
  isDataUri,
  uploadImage as putImage,
} from "../_shared/images.ts";
import { findConnection, summarise } from "../_shared/connections.ts";
import {
  findUnknownGuild,
  PROFILE_SELECT,
  readGuildIds,
  setGuilds,
  shapeProfile,
  withoutPrivateFields,
} from "../_shared/profile.ts";
import { serviceClient } from "../_shared/supabase.ts";

// Avatars live under the user's own id in this bucket. The upload itself, the
// accepted types and the size cap are in _shared/images.ts, shared with the
// sponsor logos in admin/sponsor.ts.
const BUCKET = "profile-images";

// The editable set. Anything else in the body is ignored rather than rejected, so
// a client can PUT a whole profile object back — including nerd_number and email,
// which are not the user's to change.
//
// `guild_ids` is the 1..3 guild selection and is handled apart from the rest: it
// lands in public.user_guilds, not in a column on public.users. `guild_id` is
// accepted as a one-guild alias so an older client keeps working.
const EDITABLE = [
  "first_name",
  "last_name",
  "user_type_config_id",
  "guild_ids",
  "guild_id",
  "company_name",
  "job_title",
  "profile_image",
] as const;

/**
 * The profile as every response shapes it: the columns, the two embedded lookup
 * objects, and the leaderboard numbers.
 *
 * total_xp and rank come from public.leaderboard, which only contains users with
 * at least one completed mission — so a user who has completed nothing scores 0
 * and has no rank yet (null) rather than being reported last.
 */
export async function loadProfile(userId: string): Promise<
  { profile: Record<string, unknown> } | { response: Response }
> {
  const service = serviceClient();

  const [{ data: row, error }, { data: standing, error: standingError }] = await Promise.all([
    service.from("users").select(PROFILE_SELECT).eq("id", userId).maybeSingle(),
    service.from("leaderboard").select("total_points, rank").eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (error) {
    console.error("profile read failed", error);
    return { response: fail("Something went wrong. Please try again.", 500) };
  }
  if (!row) {
    // The auth account exists (the token verified) but its profile row does not.
    return { response: fail("Your profile could not be found.", 404) };
  }
  if (standingError) {
    // Not fatal: the profile is still worth returning without the score.
    console.error("leaderboard read failed", standingError);
  }

  return {
    profile: {
      ...shapeProfile(row),
      // sum() and rank() come back as bigints, i.e. strings over PostgREST.
      total_xp: Number(standing?.total_points ?? 0),
      rank: standing?.rank == null ? null : Number(standing.rank),
    },
  };
}

/**
 * Collects the submitted fields from either body format into one map, plus the
 * uploaded file if there was one.
 *
 * A key that is absent means "leave it alone", which is what makes a partial
 * update possible. In multipart there is no null, so an empty value is how a
 * field is cleared.
 */
async function readSubmission(
  req: Request,
): Promise<
  { fields: Map<string, unknown>; file: File | null } | { error: string }
> {
  const contentType = req.headers.get("Content-Type") ?? "";
  const fields = new Map<string, unknown>();

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return { error: "The form data could not be read." };
    }

    let file: File | null = null;
    for (const key of EDITABLE) {
      // A form has no arrays, so a multi-guild selection arrives either as
      // repeated `guild_ids` parts or as one comma-separated value. Collect every
      // part and let readGuildIds sort out which it was.
      if (key === "guild_ids") {
        const values = [...form.getAll(key), ...form.getAll(`${key}[]`)].filter(
          (part): part is string => typeof part === "string",
        );
        if (values.length > 0) fields.set(key, values.length === 1 ? values[0] : values);
        continue;
      }

      const value = form.get(key);
      if (value === null) continue;
      if (value instanceof File) {
        if (key !== "profile_image") {
          return { error: `${key} must be a text field, not a file.` };
        }
        // Some clients always append the file part, empty when nothing was
        // picked. That means "no change", not "upload nothing".
        if (value.size === 0 && value.name === "") continue;
        file = value;
        continue;
      }
      // Empty (or a literal "null") clears the field, since a form cannot carry
      // a real null.
      fields.set(key, value.trim() === "" || value === "null" ? null : value);
    }
    return { fields, file };
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { error: "A JSON body is required." };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A JSON body is required." };
  }

  const record = body as Record<string, unknown>;
  for (const key of EDITABLE) {
    if (key in record) fields.set(key, record[key]);
  }
  return { fields, file: null };
}

/** The user type has to exist, or the update would fail on a foreign key. */
async function validateLookups(
  updates: Record<string, unknown>,
): Promise<string | null> {
  if (typeof updates.user_type_config_id !== "number") return null;

  const { data, error } = await serviceClient()
    .from("configs")
    .select("id")
    .eq("id", updates.user_type_config_id)
    .eq("type", "user_type")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return `user_type_config_id ${updates.user_type_config_id} is not a user type. Fetch the list from GET config/user_type.`;
  }

  return null;
}

export async function getProfile(userId: string): Promise<Response> {
  const result = await loadProfile(userId);
  if ("response" in result) return result.response;
  return ok("Profile loaded.", result.profile);
}

export async function updateProfile(req: Request, userId: string): Promise<Response> {
  const submission = await readSubmission(req);
  if ("error" in submission) return fail(submission.error, 400);

  const { fields, file } = submission;
  const updates: Record<string, unknown> = {};

  for (const key of ["first_name", "last_name"] as const) {
    if (!fields.has(key)) continue;
    const value = text(fields.get(key));
    if (!value) return fail(`${key} cannot be empty.`, 400);
    updates[key] = value;
  }

  for (const key of ["company_name", "job_title"] as const) {
    if (!fields.has(key)) continue;
    const raw = fields.get(key);
    if (raw !== null && typeof raw !== "string") {
      return fail(`${key} must be a string, or null to clear it.`, 400);
    }
    updates[key] = raw === null ? null : text(raw);
  }

  if (fields.has("user_type_config_id")) {
    const raw = fields.get("user_type_config_id");
    if (raw === null) {
      updates.user_type_config_id = null;
    } else {
      const value = integer(raw);
      if (value === null) {
        return fail(
          "user_type_config_id must be a whole number, or null to clear it.",
          400,
        );
      }
      updates.user_type_config_id = value;
    }
  }

  // The guild selection. Sent as guild_ids (a JSON list, repeated form parts or a
  // comma-separated string); `guild_id` still works for one guild. Unlike the
  // other optional fields it cannot be cleared — a user always belongs to at
  // least one guild — so leave the key out to keep the current selection.
  const guildField = fields.has("guild_ids")
    ? fields.get("guild_ids")
    : fields.has("guild_id")
    ? fields.get("guild_id")
    : undefined;
  const guilds = readGuildIds(guildField);
  if (guilds !== null && "error" in guilds) return fail(guilds.error, 400);

  if (guilds !== null) {
    const unknownGuild = await findUnknownGuild(guilds.ids);
    if (unknownGuild !== null) {
      return fail(
        `Guild ${unknownGuild} does not exist. Fetch the list from GET config/guilds.`,
        400,
      );
    }
  }

  // Checked before the image is uploaded, so a bad user_type_config_id does not
  // leave an orphaned file in the bucket.
  const lookupError = await validateLookups(updates);
  if (lookupError) return fail(lookupError, 400);

  // The image, in whichever form it arrived. A file always wins over a
  // profile_image text field sent alongside it.
  if (file) {
    const uploaded = await putImage(
      BUCKET,
      userId,
      new Uint8Array(await file.arrayBuffer()),
      contentTypeFor(file),
    );
    if ("error" in uploaded) return fail(uploaded.error, 400);
    updates.profile_image = uploaded.url;
  } else if (fields.has("profile_image")) {
    const raw = fields.get("profile_image");
    if (raw === null) {
      updates.profile_image = null;
    } else if (typeof raw !== "string") {
      return fail("profile_image must be a string, or null to clear it.", 400);
    } else if (isDataUri(raw)) {
      const decoded = decodeImageDataUri(raw, "profile_image");
      if ("error" in decoded) return fail(decoded.error, 400);
      const uploaded = await putImage(BUCKET, userId, decoded.bytes, decoded.contentType);
      if ("error" in uploaded) return fail(uploaded.error, 400);
      updates.profile_image = uploaded.url;
    } else if (/^https?:\/\//i.test(raw.trim())) {
      updates.profile_image = raw.trim();
    } else {
      return fail(
        "profile_image must be an uploaded file, a data URI, an http(s) URL, or null.",
        400,
      );
    }
  }

  if (Object.keys(updates).length === 0 && guilds === null) {
    return fail(
      `Nothing to update. Editable fields: ${EDITABLE.join(", ")}.`,
      400,
    );
  }

  const service = serviceClient();

  // Read the old image first: if this update replaces it, the file it points at
  // is about to be orphaned.
  const previousImage = "profile_image" in updates
    ? (await service.from("users").select("profile_image").eq("id", userId).maybeSingle())
      .data?.profile_image
    : null;

  if (Object.keys(updates).length > 0) {
    const { error } = await service.from("users").update(updates).eq("id", userId);
    if (error) {
      console.error("profile update failed", error);
      return fail("Your profile could not be saved. Please try again.", 400);
    }
  }

  // Applied by the RPC in one transaction, so the selection is never left
  // half-replaced and never ends up empty.
  if (guilds !== null) {
    const guildError = await setGuilds(userId, guilds.ids);
    if (guildError) return fail(guildError.error, 400);
  }

  // Best effort, and only for files we uploaded ourselves under this user's
  // folder — never for an external URL, and never after a failed save.
  const stalePath = pathInBucket(previousImage, BUCKET);
  if (stalePath && stalePath !== pathInBucket(updates.profile_image, BUCKET)) {
    if (stalePath.startsWith(`${userId}/`)) {
      const { error: removeError } = await service.storage.from(BUCKET).remove([stalePath]);
      if (removeError) console.error("old profile image cleanup failed", removeError);
    }
  }

  const result = await loadProfile(userId);
  if ("response" in result) return result.response;
  return ok("Profile updated.", result.profile);
}


/**
 * GET user/profile/{id} — another attendee's profile.
 *
 * The same detail as my own profile, plus where we stand: `connection.status` is
 * none / pending_sent / pending_received / connected / rejected, and
 * `is_connected` is the shorthand for the button.
 *
 * Email is only included once connected. Everything else about an attendee is
 * directory information — their address is not, and neither is `is_admin`.
 *
 * An admin account answers 404 here: staff are not attendees, and they are absent
 * from the directory for the same reason.
 */
export async function getOtherProfile(
  viewerId: string,
  targetId: string,
): Promise<Response> {
  if (targetId === viewerId) return await getProfile(viewerId);

  const result = await loadProfile(targetId);
  if ("response" in result) {
    // loadProfile's 404 message is written for the caller's own missing row.
    return result.response.status === 404
      ? fail("That attendee could not be found.", 404)
      : result.response;
  }

  if (result.profile.is_admin === true) {
    return fail("That attendee could not be found.", 404);
  }

  const connection = summarise(await findConnection(viewerId, targetId), viewerId);
  const profile = withoutPrivateFields(result.profile);
  if (connection.status !== "connected") delete profile.email;

  return ok("Profile loaded.", {
    ...profile,
    connection,
    is_connected: connection.status === "connected",
  });
}
