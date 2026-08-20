// Connection requests between attendees: who asked whom, and where it got to.
//
// public.connections holds one row per pair whichever way the request went, so
// "am I connected to this person" is always a single lookup — but the meaning of
// the row depends on which side is asking, which is what statusFor decides.
import { serviceClient } from "./supabase.ts";

export type ConnectionStatus =
  /** No row for the pair. */
  | "none"
  /** I asked, they have not answered. */
  | "pending_sent"
  /** They asked, it is mine to accept or reject. */
  | "pending_received"
  | "connected"
  /** Answered no. Either side may ask again, which reopens the same row. */
  | "rejected";

export type ConnectionRow = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  responded_at: string | null;
};

export const CONNECTION_COLUMNS =
  "id, requester_id, addressee_id, status, created_at, responded_at";

/** The row for a pair, in either direction, or null if they have no history. */
export async function findConnection(
  a: string,
  b: string,
): Promise<ConnectionRow | null> {
  const { data, error } = await serviceClient()
    .from("connections")
    .select(CONNECTION_COLUMNS)
    .or(
      `and(requester_id.eq.${a},addressee_id.eq.${b}),and(requester_id.eq.${b},addressee_id.eq.${a})`,
    )
    .maybeSingle();

  if (error) throw error;
  return (data as ConnectionRow | null) ?? null;
}

/** How the row reads from `viewerId`'s side. */
export function statusFor(
  row: ConnectionRow | null,
  viewerId: string,
): ConnectionStatus {
  if (!row) return "none";
  if (row.status === "accepted") return "connected";
  if (row.status === "rejected") return "rejected";
  return row.requester_id === viewerId ? "pending_sent" : "pending_received";
}

export type ConnectionSummary = {
  status: ConnectionStatus;
  /** The row id, for accept/reject. Null when there is nothing to act on. */
  request_id: string | null;
};

export function summarise(
  row: ConnectionRow | null,
  viewerId: string,
): ConnectionSummary {
  return { status: statusFor(row, viewerId), request_id: row?.id ?? null };
}

/**
 * The same summary for a whole page of people, in one query rather than one per
 * row — the people list needs it for every card it renders.
 */
export async function statusesFor(
  viewerId: string,
  otherIds: string[],
): Promise<Map<string, ConnectionSummary>> {
  const summaries = new Map<string, ConnectionSummary>();
  for (const id of otherIds) summaries.set(id, { status: "none", request_id: null });
  if (otherIds.length === 0) return summaries;

  const list = otherIds.join(",");
  const { data, error } = await serviceClient()
    .from("connections")
    .select(CONNECTION_COLUMNS)
    .or(
      `and(requester_id.eq.${viewerId},addressee_id.in.(${list})),and(addressee_id.eq.${viewerId},requester_id.in.(${list}))`,
    );

  if (error) throw error;

  for (const row of (data ?? []) as ConnectionRow[]) {
    const other = row.requester_id === viewerId ? row.addressee_id : row.requester_id;
    summaries.set(other, summarise(row, viewerId));
  }
  return summaries;
}
