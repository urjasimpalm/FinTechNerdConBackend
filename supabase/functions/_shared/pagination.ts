// Paging for the listing endpoints (people, connection requests, guilds, guild
// members). One place so every list answers with the same `pagination` object.
import { integer } from "./http.ts";

export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

export type Page = { page: number; perPage: number; offset: number };

/**
 * page/per_page is the documented pair; limit/offset are accepted as aliases so
 * either style works, and mixing them still resolves to one window.
 */
export function readPage(params: URLSearchParams): Page | { error: string } {
  const perPageRaw = integer(params.get("per_page")) ?? integer(params.get("limit")) ??
    DEFAULT_PER_PAGE;
  const pageRaw = integer(params.get("page")) ?? 1;
  const offsetRaw = integer(params.get("offset"));

  if (perPageRaw < 1) return { error: "per_page must be 1 or more." };
  if (pageRaw < 1) return { error: "page must be 1 or more." };
  if (offsetRaw !== null && offsetRaw < 0) return { error: "offset must be 0 or more." };

  const perPage = Math.min(perPageRaw, MAX_PER_PAGE);
  return {
    perPage,
    offset: offsetRaw ?? (pageRaw - 1) * perPage,
    page: Math.floor((offsetRaw ?? (pageRaw - 1) * perPage) / perPage) + 1,
  };
}

export function pageMeta(total: number, page: Page) {
  return {
    total,
    page: page.page,
    per_page: page.perPage,
    total_pages: Math.ceil(total / page.perPage),
    // Derived from `total` rather than the page size, so a full last page does
    // not look like there is more to fetch.
    has_next: page.offset + page.perPage < total,
    has_prev: page.offset > 0,
  };
}

// The query builders are shaped by whatever select() was called with, and typing
// that here would mean threading generics through every caller for no benefit.
// deno-lint-ignore no-explicit-any
type Query = any;

/**
 * Runs one window of a query and its exact count.
 *
 * `build(headOnly)` has to return a fresh query each time it is called: the count
 * has to be re-read when the range is rejected, and a builder cannot be reused.
 */
export async function fetchPage(
  build: (headOnly: boolean) => Query,
  page: Page,
): Promise<{ rows: Record<string, unknown>[]; total: number } | { error: unknown }> {
  let { data, count, error } = await build(false).range(
    page.offset,
    page.offset + page.perPage - 1,
  );

  // PostgREST rejects a range starting past the last row (PGRST103) instead of
  // returning nothing. Asking for a page beyond the end is normal for a pager, so
  // answer it as an empty page — but re-read the count, since the failed request
  // did not carry one.
  if (error?.code === "PGRST103") {
    const countOnly = await build(true);
    if (countOnly.error) return { error: countOnly.error };
    data = [];
    count = countOnly.count;
    error = null;
  }

  if (error) return { error };
  return { rows: (data ?? []) as Record<string, unknown>[], total: count ?? 0 };
}

/**
 * % and _ are wildcards in LIKE, so a search for "a_b" would otherwise match
 * "axb". Escape them (and the escape character itself) to keep the term literal.
 */
export function likeTerm(search: string): string {
  return `%${search.replace(/([\\%_])/g, "\\$1")}%`;
}
