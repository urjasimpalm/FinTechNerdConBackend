-- Storage for profile pictures, used by PUT user/profile.
--
-- The bucket is public: the app renders avatars in lists and chat, and a signed
-- URL would expire mid-session and has to be minted per image. Nothing sensitive
-- lives here — the alternative is re-signing every avatar on every screen.
-- Filenames are the user id plus an upload timestamp, so URLs are unguessable
-- only to the extent the ids are; treat these as public images.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-images',
  'profile-images',
  true,
  5242880, -- 5 MB, matched by the size check in the edge function
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The edge function uploads on the service role, which bypasses these policies.
-- They exist so a client can also upload straight to storage from the device
-- (skipping the function's body-size limit for large photos) without being able
-- to touch anyone else's avatar: the first path segment must be the caller's own
-- user id, i.e. `<uid>/<something>.jpg`.
drop policy if exists "profile images are readable by everyone" on storage.objects;
create policy "profile images are readable by everyone"
  on storage.objects for select
  using (bucket_id = 'profile-images');

drop policy if exists "users can upload their own profile image" on storage.objects;
create policy "users can upload their own profile image"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'profile-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users can replace their own profile image" on storage.objects;
create policy "users can replace their own profile image"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'profile-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'profile-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users can delete their own profile image" on storage.objects;
create policy "users can delete their own profile image"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'profile-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
