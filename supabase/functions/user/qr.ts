// POST user/qr/scan — claim a physical QR code.
//
// The sheet's flow: the codes are printed and placed around the convention, the
// attendee scans one with the normal camera app, which opens
// https://<app>/q/<code>, and the PWA hands the slug here. Scanning is how you
// prove you were at a sponsor booth, in a zone, or in the room for a session — so
// this is the only route that turns an attendee's action into XP directly.
//
// All of the work is public.claim_qr_code(): the scan log, the mission award and
// the session check-in have to land together or not at all, and that is one
// transaction in the database rather than three calls from here. See
// supabase/migrations/20260822000003_qr_codes.sql.
import { fail, ok, text } from "../_shared/http.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

/**
 * Accepts the bare slug or the whole scanned URL.
 *
 * A camera app hands the PWA a full https://…/q/<code>, and a client that passes
 * it through verbatim should work rather than 404 — it is the same information.
 */
function readCode(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed.toLowerCase();

  try {
    const url = new URL(trimmed);
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    // ?code= wins if the link is built that way instead of as a path.
    return (url.searchParams.get("code") ?? last).trim().toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

type Claim = {
  found: boolean;
  reason?: string;
  label?: string;
  code_kind?: string;
  first_scan?: boolean;
  mission?: {
    id: number;
    code: string | null;
    title: string | null;
    is_repeatable: boolean;
    counted: boolean;
    times_completed: number;
  } | null;
  session?: {
    id: string;
    name: string;
    checked_in: boolean;
    xp: number;
  } | null;
  xp_awarded?: number;
  total_xp?: number;
};

/** POST user/qr/scan { "code": "…" } — `?code=` also works. */
export async function scanQrCode(
  body: Record<string, unknown>,
  viewerId: string,
  queryCode: string | null,
): Promise<Response> {
  const raw = text(body.code) ?? text(body.access_code) ?? queryCode;
  if (!raw) {
    return fail('"code" is required — it is the last part of the scanned URL.', 400);
  }

  const code = readCode(raw);
  if (!code) return fail("That QR code could not be read.", 400);

  const { data, error } = await serviceClient().rpc("claim_qr_code", {
    p_user_id: viewerId,
    p_code: code,
  });

  if (error) {
    logDbFailure("qr claim", error);
    return fail("That code could not be claimed. Please try again.", 500);
  }

  const claim = (data ?? { found: false }) as Claim;

  if (!claim.found) {
    // Same answer for an unknown code and a malformed one: there is nothing
    // useful to tell someone holding a slug that is not ours.
    return fail("That QR code is not one of ours.", 404);
  }
  if (claim.reason === "inactive") {
    return fail(
      `${claim.label ?? "That code"} is no longer active. Ask at the help desk.`,
      409,
    );
  }

  const mission = claim.mission ?? null;
  const session = claim.session ?? null;
  const counted = (mission?.counted ?? false) || (session?.checked_in ?? false);

  /*
   * A repeat scan is answered 200, not an error: the attendee did nothing wrong,
   * and the screen still wants to show what the code was and where they stand.
   * `counted` is the flag that decides whether to celebrate.
   */
  const parts: string[] = [];
  if (mission?.counted) {
    parts.push(
      mission.is_repeatable && mission.times_completed > 1
        ? `${mission.title} — ${mission.times_completed} times now`
        : `${mission.title} completed`,
    );
  }
  if (session?.checked_in) {
    parts.push(`checked in to ${session.name}`);
  }

  const message = counted
    ? `${parts.join(", ")}. +${claim.xp_awarded ?? 0} XP.`
    : mission || session
    ? "You have already scanned this one."
    : `${claim.label ?? "Scanned"}.`;

  return ok(message, {
    label: claim.label ?? null,
    kind: claim.code_kind ?? null,
    // false when this person had already scanned this exact code before.
    first_scan: claim.first_scan ?? false,
    // Did this call earn anything?
    counted,
    mission,
    session,
    xp_awarded: claim.xp_awarded ?? 0,
    total_xp: claim.total_xp ?? 0,
  });
}
