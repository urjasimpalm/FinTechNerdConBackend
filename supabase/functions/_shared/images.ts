// Taking an image out of a request and putting it in a storage bucket.
//
// Two callers, two buckets: PUT user/profile stores avatars in `profile-images`
// under the user's own id, and admin/sponsor/* stores logos in `sponsor-images`
// under the sponsor's id. The bucket and folder are arguments because that is the
// only thing that differs — the accepted types, the size cap, the data-URI
// decoding and the orphan cleanup are the same job either way.
//
// Both buckets are public and hold the URL in the row, not the bytes.
import { serviceClient } from "./supabase.ts";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Kept in line with allowed_mime_types on the buckets, so a rejection is a 400
// from here rather than an opaque storage error.
export const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export function isDataUri(value: string): boolean {
  return value.startsWith("data:");
}

/**
 * Mobile clients often post a file part with no (or a generic) content type, so
 * fall back to the filename extension before giving up on it.
 */
export function contentTypeFor(file: File): string {
  const declared = (file.type || "").toLowerCase();
  if (declared in IMAGE_TYPES) return declared;

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const matched = Object.entries(IMAGE_TYPES).find(([, ext]) =>
    ext === (extension === "jpeg" ? "jpg" : extension)
  );
  return matched ? matched[0] : declared;
}

/** Path of an object in `bucket`, or null if the URL points somewhere else. */
export function bucketPath(url: unknown, bucket: string): string | null {
  if (typeof url !== "string") return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const at = url.indexOf(marker);
  if (at < 0) return null;
  const path = url.slice(at + marker.length).split("?")[0];
  return path.length > 0 ? decodeURIComponent(path) : null;
}

/**
 * Puts the image in `bucket` under `folder` and hands back its public URL. Named
 * with an upload timestamp rather than a fixed filename, so a replaced image is
 * not served from a CDN cache of the old one.
 */
export async function uploadImage(
  bucket: string,
  folder: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ url: string } | { error: string }> {
  // image/jpg is not a registered type but plenty of clients send it.
  const type = contentType === "image/jpg" ? "image/jpeg" : contentType;
  const extension = IMAGE_TYPES[type];
  if (!extension) {
    return {
      error: `Unsupported image type "${contentType}". Use ${
        Object.keys(IMAGE_TYPES).join(", ")
      }.`,
    };
  }
  if (bytes.byteLength === 0) return { error: "The image file is empty." };
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { error: `Images must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.` };
  }

  const service = serviceClient();
  const path = `${folder}/${Date.now()}.${extension}`;
  const { error } = await service.storage.from(bucket).upload(path, bytes, {
    contentType: type,
    upsert: true,
  });

  if (error) {
    console.error(`${bucket} upload failed`, error);
    return { error: "The image could not be uploaded. Please try again." };
  }

  return { url: service.storage.from(bucket).getPublicUrl(path).data.publicUrl };
}

/**
 * data:image/png;base64,AAAA… → bytes plus the declared content type.
 *
 * `field` names the request field in the error messages, since that is what the
 * caller has to go and fix.
 */
export function decodeDataUri(
  value: string,
  field: string,
): { bytes: Uint8Array; contentType: string } | { error: string } {
  const comma = value.indexOf(",");
  if (comma < 0) return { error: `${field} is not a valid data URI.` };

  // Split on the first comma rather than pattern-matching the whole thing: the
  // header can carry extra parameters (data:image/jpeg;charset=utf-8;base64,…)
  // and the payload can contain commas.
  const header = value.slice("data:".length, comma).toLowerCase();
  const payload = value.slice(comma + 1);
  const contentType = header.split(";")[0].trim();
  if (!contentType) return { error: `${field} is missing its image type.` };

  try {
    if (!header.includes(";base64")) {
      return {
        bytes: new TextEncoder().encode(decodeURIComponent(payload)),
        contentType,
      };
    }
    // Line breaks are common in base64 that came off a file, and some clients
    // send the URL-safe alphabet; atob() accepts neither.
    const normalised = payload.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    return {
      bytes: Uint8Array.from(atob(normalised), (char) => char.charCodeAt(0)),
      contentType,
    };
  } catch {
    return { error: `${field} could not be decoded.` };
  }
}

/**
 * Deletes the file a replaced URL pointed at — best effort, and only for files we
 * uploaded ourselves under `folder`, never for an external URL.
 */
export async function removeReplacedImage(
  bucket: string,
  folder: string,
  previous: unknown,
  current: unknown,
): Promise<void> {
  const stalePath = bucketPath(previous, bucket);
  if (!stalePath || stalePath === bucketPath(current, bucket)) return;
  if (!stalePath.startsWith(`${folder}/`)) return;

  const { error } = await serviceClient().storage.from(bucket).remove([stalePath]);
  if (error) console.error(`${bucket} cleanup failed`, error);
}

/**
 * The image an admin/back-office route was given, as a URL to store.
 *
 * Accepts an uploaded file, a data URI, or an http(s) URL that is already hosted
 * somewhere — and returns null for "clear it". A file always wins over a text
 * value sent alongside it.
 */
export async function resolveImage(
  bucket: string,
  folder: string,
  file: File | null,
  value: unknown,
  field: string,
): Promise<{ url: string | null } | { error: string }> {
  if (file) {
    const uploaded = await uploadImage(
      bucket,
      folder,
      new Uint8Array(await file.arrayBuffer()),
      contentTypeFor(file),
    );
    return "error" in uploaded ? uploaded : { url: uploaded.url };
  }

  // Empty string means the same as null here: take the image down.
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    return { url: null };
  }
  if (typeof value !== "string") {
    return { error: `${field} must be a file, a data URI, an http(s) URL, or null.` };
  }

  const raw = value.trim();
  if (isDataUri(raw)) {
    const decoded = decodeDataUri(raw, field);
    if ("error" in decoded) return decoded;
    const uploaded = await uploadImage(
      bucket,
      folder,
      decoded.bytes,
      decoded.contentType,
    );
    return "error" in uploaded ? uploaded : { url: uploaded.url };
  }
  if (/^https?:\/\//i.test(raw)) return { url: raw };

  return { error: `${field} must be a file, a data URI, an http(s) URL, or null.` };
}
