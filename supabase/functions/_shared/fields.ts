// Reading one field out of a request body, with the message to send back when it
// is wrong.
//
// ./http.ts has `text` and `integer`, which coerce or return null — enough when
// "absent" and "invalid" get the same treatment. These return either the value or
// the sentence to put in the 400, which is what a write route wants: an admin
// typing a body by hand should be told which field was wrong and why.
export type Read<T> = { value: T } | { error: string };

/** Accepts a real boolean, or the strings/numbers a form would send for one. */
export function readBoolean(value: unknown, field: string): Read<boolean> {
  if (typeof value === "boolean") return { value };
  const raw = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (raw === "true" || raw === 1 || raw === "1") return { value: true };
  if (raw === "false" || raw === 0 || raw === "0") return { value: false };
  return { error: `${field} must be true or false.` };
}

/** A whole number, at or above `min`. */
export function readInt(value: unknown, field: string, min: number): Read<number> {
  const parsed = typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^-?\d+$/.test(value.trim())
    ? Number.parseInt(value.trim(), 10)
    : null;
  if (parsed === null) return { error: `${field} must be a whole number.` };
  if (parsed < min) return { error: `${field} must be ${min} or more.` };
  return { value: parsed };
}

/**
 * A public image URL — a logo, a headshot, a floor plan. The bytes go to a storage
 * bucket (or anywhere else public) first; these columns hold the URL only, so the
 * check is that it is one.
 */
export function readHttpUrl(value: unknown, field: string): Read<string> {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { error: `${field} must be an http(s) URL.` };
  if (!/^https?:\/\//i.test(raw)) {
    return { error: `${field} must be an http(s) URL, or null to remove it.` };
  }
  return { value: raw };
}
