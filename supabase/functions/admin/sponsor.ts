// Adding and editing sponsors, for the admin tooling:
//
//   POST admin/sponsor/create   name + the logo, as multipart/form-data or JSON
//   POST admin/sponsor/update   id + whatever is changing
//
// The app only reads sponsors — GET config/sponsors, which is public and
// CDN-cached — so these are back-office routes, the same shape as ./agenda.ts.
// Until now public.sponsors was Studio-only (see the table comment in
// 20260820200835_sponsors.sql).
//
// The logo is sent as **the image itself**, not a URL: post multipart/form-data
// with the file under `profile_image` (or JSON with a data URI) and it is stored
// in the sponsor-images bucket under `<sponsor-id>/<timestamp>.<ext>`, with
// public.sponsors.profile_image set to the public URL that comes back. An
// already-hosted http(s) URL is still accepted, for a logo that lives elsewhere.
// See 20260830000001_sponsor_images_storage.sql and _shared/images.ts.
//
// public.sponsors.sort_order is deliberately *not* settable here: display order is
// not something these routes decide. The column keeps its default of 0, so the
// sponsor screen orders by name (the tie-break in sponsors_sort_idx), and a
// deliberate ordering is set in Studio or SQL.
import { readBoolean } from "../_shared/fields.ts";
import { fail, integer, ok, text } from "../_shared/http.ts";
import { removeReplacedImage, resolveImage } from "../_shared/images.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

const BUCKET = "sponsor-images";

const MAX_NAME = 200;
const MAX_COMPANY = 200;
const MAX_DESCRIPTION = 2000;

type Row = Record<string, unknown>;

/** The columns GET config/sponsors returns, plus created_at. */
const SPONSOR_SELECT =
  "id, name, company_name, description, profile_image, sort_order, is_active, created_at";

/** name, company_name and description: length-capped text that null clears. */
const TEXT_FIELDS: [string, number][] = [
  ["name", MAX_NAME],
  ["company_name", MAX_COMPANY],
  ["description", MAX_DESCRIPTION],
];

/** Everything either route reads off the request. */
const FIELDS = [
  "id",
  "sponsor_id",
  "name",
  "company_name",
  "description",
  "profile_image",
  "is_active",
];

type Submission = { fields: Map<string, unknown>; file: File | null };

/**
 * Collects the submitted fields from either body format into one map, plus the
 * uploaded file if there was one — the same two-format handling as
 * PUT user/profile.
 *
 * A key that is absent means "leave it alone", which is what makes a partial
 * update possible. A form cannot carry a real null, so in multipart an empty
 * value is how a field is cleared.
 */
async function readSubmission(req: Request): Promise<Submission | { error: string }> {
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
    for (const key of FIELDS) {
      // getAll rather than get: a form can legitimately carry both a file part and
      // a text part under `profile_image` (a picker that also keeps the current
      // URL, say), and a picked file wins whichever order they arrive in.
      for (const value of form.getAll(key)) {
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
        fields.set(key, value.trim() === "" || value === "null" ? null : value);
      }
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

  const record = body as Row;
  for (const key of FIELDS) {
    if (key in record) fields.set(key, record[key]);
  }
  return { fields, file: null };
}

/*
 * The sponsor's text columns and its is_active flag. The image is handled apart
 * from these, because storing it needs the sponsor's id.
 *
 * Only `name` is required on create — a logo and copy arrive later in the run-up
 * to the event, so a row with just a name is a legitimate placeholder. On update
 * every key is optional and only the ones present are written, so changing the
 * name does not mean resending the description.
 */
function readColumns(
  fields: Map<string, unknown>,
  requireName: boolean,
): { row: Row } | { error: string } {
  const row: Row = {};

  for (const [key, limit] of TEXT_FIELDS) {
    const required = key === "name" && requireName;
    if (!required && !fields.has(key)) continue;

    const submitted = fields.get(key);
    if (submitted === null) {
      // name is NOT NULL, so there is nothing to clear it to.
      if (key === "name") return { error: '"name" cannot be null.' };
      row[key] = null;
      continue;
    }

    const value = text(submitted);
    if (!value) {
      return {
        error: required
          ? '"name" is required.'
          : `"${key}" must be a non-empty string, or null.`,
      };
    }
    if (value.length > limit) {
      return { error: `"${key}" must be ${limit} characters or fewer.` };
    }
    row[key] = value;
  }

  // is_active = false is how a sponsor is taken down without deleting the row, so
  // there is no delete route.
  if (fields.has("is_active") && fields.get("is_active") !== null) {
    const parsed = readBoolean(fields.get("is_active"), '"is_active"');
    if ("error" in parsed) return parsed;
    row.is_active = parsed.value;
  }

  return { row };
}

/**
 * POST admin/sponsor/create
 *
 * The row first, then the image, because the object is stored under the sponsor's
 * id and identity ids are assigned by the insert. If the upload fails the row is
 * deleted again rather than left behind as a sponsor nobody asked for — the same
 * rollback shape as admin/agenda/create.
 */
export async function createSponsor(req: Request): Promise<Response> {
  const submission = await readSubmission(req);
  if ("error" in submission) return fail(submission.error, 400);

  const columns = readColumns(submission.fields, true);
  if ("error" in columns) return fail(columns.error, 400);

  const service = serviceClient();
  const { data, error } = await service
    .from("sponsors")
    .insert(columns.row)
    .select(SPONSOR_SELECT)
    .single();

  if (error || !data) {
    logDbFailure("sponsor insert", error);
    return fail("Something went wrong. Please try again.", 500);
  }

  const sponsorId = String(data.id);
  const hasImage = submission.file !== null || submission.fields.has("profile_image");
  if (!hasImage) return ok(`Added "${data.name}".`, data);

  const image = await resolveImage(
    BUCKET,
    sponsorId,
    submission.file,
    submission.fields.get("profile_image") ?? null,
    '"profile_image"',
  );
  if ("error" in image) {
    const { error: cleanupError } = await service.from("sponsors").delete().eq(
      "id",
      data.id,
    );
    if (cleanupError) {
      logDbFailure(`sponsor rollback for ${sponsorId}`, cleanupError);
      return fail(
        `${image.error} Sponsor ${sponsorId} was created without it and could not be removed.`,
        500,
      );
    }
    return fail(`${image.error} The sponsor was not created.`, 400);
  }

  const saved = await service
    .from("sponsors")
    .update({ profile_image: image.url })
    .eq("id", data.id)
    .select(SPONSOR_SELECT)
    .single();

  if (saved.error || !saved.data) {
    // The file is in the bucket but the row does not point at it. Say so rather
    // than reporting a clean create: the image is what the admin will look for.
    logDbFailure("sponsor image save", saved.error);
    return fail(
      `"${data.name}" was created but its image could not be saved. Try setting it again with admin/sponsor/update.`,
      500,
    );
  }

  return ok(`Added "${saved.data.name}".`, saved.data);
}

/**
 * POST admin/sponsor/update
 *
 * A patch: only the keys present are written, absent keys are left alone, and an
 * explicit null (or an empty value in a form) clears an optional field. A new
 * image replaces the old one and the file it pointed at is deleted, so retired
 * logos do not accumulate in the bucket.
 */
export async function updateSponsor(req: Request): Promise<Response> {
  const submission = await readSubmission(req);
  if ("error" in submission) return fail(submission.error, 400);

  const identifier = integer(
    submission.fields.get("id") ?? submission.fields.get("sponsor_id"),
  );
  if (identifier === null || identifier < 1) {
    return fail('"id" must be the sponsor\'s id — a whole number.', 400);
  }

  const columns = readColumns(submission.fields, false);
  if ("error" in columns) return fail(columns.error, 400);

  const hasImage = submission.file !== null || submission.fields.has("profile_image");
  if (Object.keys(columns.row).length === 0 && !hasImage) {
    return fail("Nothing to change — send at least one field to update.", 400);
  }

  const service = serviceClient();
  // Read first: a 404 has to be reported before anything is uploaded, and the old
  // image URL is needed to clean up the file it points at.
  const existing = await service
    .from("sponsors")
    .select(SPONSOR_SELECT)
    .eq("id", identifier)
    .maybeSingle();

  if (existing.error) {
    logDbFailure("sponsor read for update", existing.error);
    return fail("Something went wrong. Please try again.", 500);
  }
  if (!existing.data) return fail("That sponsor could not be found.", 404);

  if (hasImage) {
    const image = await resolveImage(
      BUCKET,
      String(identifier),
      submission.file,
      submission.fields.get("profile_image") ?? null,
      '"profile_image"',
    );
    if ("error" in image) return fail(image.error, 400);
    columns.row.profile_image = image.url;
  }

  const { data, error } = await service
    .from("sponsors")
    .update(columns.row)
    .eq("id", identifier)
    .select(SPONSOR_SELECT)
    .single();

  if (error || !data) {
    logDbFailure("sponsor update", error);
    return fail("Something went wrong. Please try again.", 500);
  }

  // Only after the row is saved, and only for files we uploaded ourselves under
  // this sponsor's folder.
  if (hasImage) {
    await removeReplacedImage(
      BUCKET,
      String(identifier),
      existing.data.profile_image,
      data.profile_image,
    );
  }

  return ok(`Updated "${data.name}".`, data);
}
