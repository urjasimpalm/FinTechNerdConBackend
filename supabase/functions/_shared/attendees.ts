// Invited attendees who have not registered yet. GET user/people lists them after
// the registered users, in the same `people` array, as the same person card.
//
// They are read from public.directory_attendees, which already leaves out anyone
// with an account. Nothing here can connect to an attendee, since there is no
// users row behind one, so every attendee card reads as "no connection".
import { fetchPage, likeTerm, Page } from "./pagination.ts";
import { serviceClient } from "./supabase.ts";

export const ATTENDEE_SELECT = "id, first_name, last_name, company_name, job_title";

/**
 * Which slice of the attendee list falls on this page, given the registered people
 * that come before it in the combined list.
 *
 * `offset` is where the attendees start (0 once the page is past the registered
 * people), and `limit` is how many attendee cards are still needed to fill the page.
 */
export function attendeeWindow(
  page: Page,
  registeredTotal: number,
  registeredOnPage: number,
): { offset: number; limit: number } {
  return {
    offset: Math.max(0, page.offset - registeredTotal),
    limit: Math.max(0, page.perPage - registeredOnPage),
  };
}

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
 * The attendees that fall on `page` of the combined list, plus the total number of
 * matching attendees (so the caller can add it to the registered total).
 */
export async function attendeesFor(
  search: string | null,
  page: Page,
  registeredTotal: number,
  registeredOnPage: number,
): Promise<{ rows: Record<string, unknown>[]; total: number } | { error: unknown }> {
  const window = attendeeWindow(page, registeredTotal, registeredOnPage);

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

  // Nothing left to show on this page, so only the count is needed.
  if (window.limit === 0) {
    const { count, error } = await build(true);
    if (error) return { error };
    return { rows: [], total: count ?? 0 };
  }

  return await fetchPage(build, {
    page: page.page,
    perPage: window.limit,
    offset: window.offset,
  });
}
