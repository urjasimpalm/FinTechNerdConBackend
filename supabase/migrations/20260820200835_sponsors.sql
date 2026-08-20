-- Event sponsors, listed on their own screen: GET config/sponsors.
--
-- Reference data like guilds and configs, so it lives with them behind the config
-- function (public, CDN-cached) rather than behind a session.
create table if not exists public.sponsors (
  id integer generated always as identity primary key,
  name text not null,
  company_name text,
  description text,
  -- Logo or headshot URL. Uploads can go in the profile-images bucket, or
  -- anywhere else public — this is just the URL that is rendered.
  profile_image text,
  -- Display order; ties fall back to name.
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists sponsors_sort_idx on public.sponsors (sort_order, name);

alter table public.sponsors enable row level security;

-- Readable without a session, the same as guilds and configs: the sponsor screen
-- is event content, and the config function serves it to anon callers.
drop policy if exists "sponsors are readable by everyone" on public.sponsors;
create policy "sponsors are readable by everyone"
  on public.sponsors for select
  to anon, authenticated
  using (true);

revoke all on table public.sponsors from anon;
revoke all on table public.sponsors from authenticated;
grant select on table public.sponsors to anon;
grant select on table public.sponsors to authenticated;
grant select, insert, update, delete on table public.sponsors to service_role;

comment on table public.sponsors is
  'Event sponsors. Rows are managed in Studio or by the service role; the app only reads them.';
