/*
 * Separate Agenda Tags from Guilds.
 *
 * Previously, agenda tags reused the public.guilds table via public.agenda_guilds.
 * This migration creates a dedicated public.tags table with the approved list of
 * agenda tags, and a public.agenda_tags mapping table to replace public.agenda_guilds
 * for tag functionality.
 *
 * The approved tags list:
 * - AI
 * - Payments
 * - Banking
 * - Lending
 * - Stablecoins
 * - Crypto
 * - Blockchain
 * - Embedded Finance
 * - Open Banking
 * - RegTech
 * - Compliance
 * - Fraud & Risk
 * - Credit
 * - Insurance
 * - Wealth Management
 * - Digital Assets
 * - Cross-Border
 * - Emerging Markets
 * - B2B Fintech
 * - Consumer Fintech
 * - Infrastructure
 * - Data & Analytics
 * - Policy & Regulation
 * - Investment & VC
 *
 * Constraints:
 * - An agenda can have a maximum of 2 tags
 * - One tag must be marked as primary (is_primary = true)
 * - The second tag, if present, must be secondary (is_primary = false)
 * - Primary and secondary tags must be different
 */

-- Create the tags table with the approved list
create table if not exists public.tags (
  id serial primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table public.tags enable row level security;

create policy "tags are readable by authenticated users"
  on public.tags for select
  to authenticated
  using (true);

grant select on table public.tags to authenticated;
grant select, insert, update, delete on table public.tags to service_role;

comment on table public.tags is
  'Approved agenda tag vocabulary. Tags are separate from guilds.';
comment on column public.tags.name is
  'The tag name (e.g., "AI", "Payments", "Banking").';

-- Insert the approved tags
insert into public.tags (name) values
  ('AI'),
  ('Payments'),
  ('Banking'),
  ('Lending'),
  ('Stablecoins'),
  ('Crypto'),
  ('Blockchain'),
  ('Embedded Finance'),
  ('Open Banking'),
  ('RegTech'),
  ('Compliance'),
  ('Fraud & Risk'),
  ('Credit'),
  ('Insurance'),
  ('Wealth Management'),
  ('Digital Assets'),
  ('Cross-Border'),
  ('Emerging Markets'),
  ('B2B Fintech'),
  ('Consumer Fintech'),
  ('Infrastructure'),
  ('Data & Analytics'),
  ('Policy & Regulation'),
  ('Investment & VC')
on conflict (name) do nothing;

-- Create the agenda_tags mapping table (separate from agenda_guilds)
create table if not exists public.agenda_tags (
  agenda_id uuid not null references public.agenda (id) on delete cascade,
  tag_id integer not null references public.tags (id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (agenda_id, tag_id)
);

create index if not exists idx_agenda_tags_tag_id
  on public.agenda_tags (tag_id);

alter table public.agenda_tags enable row level security;

create policy "agenda tags are readable by authenticated users"
  on public.agenda_tags for select
  to authenticated
  using (true);

grant select on table public.agenda_tags to authenticated;
grant select, insert, update, delete on table public.agenda_tags to service_role;

-- Enforce at most one primary tag per agenda
create unique index if not exists agenda_tags_one_primary
  on public.agenda_tags (agenda_id)
  where is_primary;

-- Enforce at most 2 tags per agenda
create or replace function public.enforce_agenda_tags_limit()
returns trigger
language plpgsql
as $$
declare
  total integer;
begin
  select count(*) into total
    from public.agenda_tags
    where agenda_id = new.agenda_id;

  if total > 2 then
    raise exception 'An event can have at most 2 tags (one primary, one secondary).'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

drop trigger if exists agenda_tags_limit on public.agenda_tags;
create trigger agenda_tags_limit
  after insert on public.agenda_tags
  for each row
  execute function public.enforce_agenda_tags_limit();

comment on table public.agenda_tags is
  'Mapping of agendas to tags. Each agenda can have 1-2 tags, one of which is marked primary.';
comment on column public.agenda_tags.is_primary is
  'When true, this is the agenda''s primary tag. At most one per agenda (agenda_tags_one_primary), at most 2 tags total.';

-- Migrate existing data from agenda_guilds to agenda_tags (if any)
insert into public.agenda_tags (agenda_id, tag_id, is_primary)
select
  ag.agenda_id,
  t.id as tag_id,
  ag.is_primary
from public.agenda_guilds ag
join public.guilds g on ag.guild_id = g.id
join public.tags t on g.name = t.name
on conflict (agenda_id, tag_id) do nothing;

comment on column public.agenda.guild_id is
  'DEPRECATED: Use public.agenda_tags instead. Kept for backward compatibility during migration.';

comment on table public.agenda_guilds is
  'DEPRECATED: Use public.agenda_tags instead. Kept for backward compatibility during migration. agenda_guilds used to serve double duty for both guilds and tags; agenda_tags now handles tags separately.';
