// Invited attendees who have not registered yet. GET user/people returns them in
// their own `attendees` array, next to the registered `people`, as the same person
// card shape.
//
// They are read from public.directory_attendees, which already leaves out anyone
// with an account. Nothing here can connect to an attendee, since there is no
// users row behind one, so every attendee card reads as "no connection".
import { fetchPage, likeTerm, Page } from "./pagination.ts";
import { serviceClient } from "./supabase.ts";

export const ATTENDEE_SELECT = "id, first_name, last_name, company_name, job_title";

/**
 * An attendee as a person card. Same keys, in the same order, as a registered user
 * from PERSON_SELECT, with the fields an attendee cannot have set to null, or to the
 * empty structure, so a client can render either list with the same code.
 */
export function shapeAttendee(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    nerd_number: null,
    company_name: row.company_name ?? null,
    job_title: row.job_title ?? null,
    profile_image: null,
    user_type_config_id: null,
    user_type: null,
    guilds: [],
    connection: { status: "none", request_id: null },
    is_connected: false,
  };
}

/**
 * One page of the attendees who have not registered, with the same search and paging
 * as the registered list, and the exact count of matching attendees.
 */
export async function attendeesFor(
  search: string | null,
  page: Page,
): Promise<{ rows: Record<string, unknown>[]; total: number } | { error: unknown }> {
  const build = (headOnly: boolean) => {
    let query = serviceClient()
      .from("directory_attendees")
      .select(ATTENDEE_SELECT, { count: "exact", head: headOnly })
      .order("first_name")
      .order("last_name")
      .order("id");
    if (search) query = query.ilike("search_text", likeTerm(search));
    return query;
  };

  return await fetchPage(build, page);
}
