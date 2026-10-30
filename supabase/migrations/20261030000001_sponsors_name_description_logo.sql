-- Trim public.sponsors to the three things the sponsor screen shows: name,
-- description and logo.
--
-- profile_image is renamed rather than replaced, so existing logo URLs carry over.
-- company_name and sort_order are dropped. Their data is discarded with the column,
-- so take a backup first if any company names need keeping. is_active stays: it is
-- how a sponsor is taken down without deleting the row.

drop index if exists public.sponsors_sort_idx;

alter table public.sponsors rename column profile_image to logo;
alter table public.sponsors drop column company_name;
alter table public.sponsors drop column sort_order;

-- The sponsor list is ordered by name, so index that instead of sort_order.
create index if not exists sponsors_name_idx on public.sponsors (name);

comment on table public.sponsors is
  'Event sponsors: name, description and logo. Written by POST admin/sponsor/create and POST admin/sponsor/update (admin only, service role); the app only reads them via GET config/sponsors. Rows are removed in Studio or SQL.';

comment on column public.sponsors.logo is
  'Public URL of the logo. Written by POST admin/sponsor/{create,update}, which stores the uploaded image in the sponsor-images bucket under <sponsor-id>/<timestamp>.<ext>. An externally hosted http(s) URL is also accepted.';
