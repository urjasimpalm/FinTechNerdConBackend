/*
 * The Home screen's floor plan.
 *
 * The Home sheet asks for a "Map — shows floor plan image - this will taken from
 * the supabase", alongside the announcement banner, and notes both are set from
 * the admin UI. 20260819161552_announcements.sql anticipated exactly this in its
 * own comment ("a table in supabase for changing the announcement text and the map
 * image"), so it goes on the same singleton row rather than in a table of one.
 *
 * A URL, not the bytes: upload the image to a public bucket (profile-images works,
 * or a new one) and store the public URL, the same way public.sponsors
 * .profile_image does.
 *
 * null means the app has no map to show — that is a valid state, not an error, and
 * the same convention as announcements.text being empty.
 */
alter table public.announcements
  add column if not exists map_image text;

comment on column public.announcements.map_image is
  'Public URL of the convention floor plan shown on Home. null = no map to show. Set by an admin.';
