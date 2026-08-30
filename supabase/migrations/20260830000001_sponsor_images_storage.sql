-- Storage for sponsor logos and headshots, used by POST admin/sponsor/create and
-- POST admin/sponsor/update.
--
-- Mirrors 20260820004011_profile_images_storage.sql: public, 5 MB, the same five
-- image types the edge function checks for. Public because the sponsor screen is
-- public event content — GET config/sponsors needs no session at all, so a signed
-- URL would be no use to it.
--
-- A separate bucket rather than a folder in profile-images: the two have different
-- write rules. An attendee may upload into their own folder in profile-images from
-- the device; nobody uploads here except an admin, through the function, on the
-- service role. Keeping them apart means that stays true by construction rather
-- than by a path check.
--
-- Objects are named `<sponsor-id>/<upload-timestamp>.<ext>`, so replacing a logo
-- does not serve the old one out of a CDN cache, and one sponsor's files are all
-- in one place.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sponsor-images',
  'sponsor-images',
  true,
  5242880, -- 5 MB, matched by the size check in _shared/images.ts
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anyone can read: these URLs are rendered on a public screen.
drop policy if exists "sponsor images are readable by everyone" on storage.objects;
create policy "sponsor images are readable by everyone"
  on storage.objects for select
  using (bucket_id = 'sponsor-images');

-- No insert/update/delete policy on purpose. The admin function uploads on the
-- service role, which bypasses RLS; without a policy, no anon or authenticated
-- caller — admin or not — can write here directly. Sponsor logos are event
-- branding, and the only path to them should be the route that also writes the
-- row.

-- The table comment in 20260820200835_sponsors.sql predates this bucket and the
-- admin routes; correct both statements here rather than editing an applied
-- migration.
comment on column public.sponsors.profile_image is
  'Public URL of the logo/headshot. Written by POST admin/sponsor/{create,update}, which stores the uploaded image in the sponsor-images bucket under <sponsor-id>/<timestamp>.<ext>. An externally hosted http(s) URL is also accepted.';

comment on table public.sponsors is
  'Event sponsors. Written by POST admin/sponsor/create and POST admin/sponsor/update (admin only, service role); the app only reads them via GET config/sponsors. sort_order is not settable through the API — set it in Studio or SQL.';
