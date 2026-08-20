-- Attendee-to-attendee connections, and the text column the people search runs on.
--
-- One row per pair, whichever way round the request went: requester_id asked,
-- addressee_id answers. The pair index below is what stops two rows existing for
-- the same two people, so "A asked B" and "B asked A" cannot both be open.
create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.users (id) on delete cascade,
  addressee_id uuid not null references public.users (id) on delete cascade,
  -- rejected is kept rather than deleted, so the pair can be asked again later
  -- (the row flips back to pending) and so a rejection is not silently lost.
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connections_not_self check (requester_id <> addressee_id)
);

-- Direction-independent uniqueness: the pair is ordered before being indexed.
create unique index if not exists connections_pair_key
  on public.connections (
    least(requester_id, addressee_id),
    greatest(requester_id, addressee_id)
  );

-- "my requests" and "my connections", from either side.
create index if not exists connections_requester_idx
  on public.connections (requester_id, status);
create index if not exists connections_addressee_idx
  on public.connections (addressee_id, status);

drop trigger if exists connections_set_updated_at on public.connections;
create trigger connections_set_updated_at
  before update on public.connections
  for each row
  execute function public.set_updated_at();

alter table public.connections enable row level security;

-- A user can read the rows they are part of, and nothing else — the directory is
-- public but who asked whom is not.
drop policy if exists "users can view their own connections" on public.connections;
create policy "users can view their own connections"
  on public.connections for select
  to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- No insert/update/delete policies: requesting, accepting and rejecting are a
-- state machine, and it lives in the user edge function on the service role. A
-- direct write could accept a request on someone else's behalf.
revoke all on table public.connections from anon;
revoke all on table public.connections from authenticated;
grant select on table public.connections to authenticated;
grant select, insert, update, delete on table public.connections to service_role;

-- GET user/people searches "any match with name, nerd number, company, title".
-- Doing that as one ilike over a generated column beats five or-ed filters: the
-- terms can span two fields ("wasim raza"), and there is one place to add a field
-- to later.
alter table public.users
  add column if not exists search_text text
  generated always as (
    lower(
      first_name || ' ' || last_name || ' ' || nerd_number ||
      ' ' || coalesce(company_name, '') || ' ' || coalesce(job_title, '')
    )
  ) stored;

-- No index on it: the search is `ilike '%term%'`, which a btree cannot serve, and
-- a few thousand attendees scan fine. If the directory ever gets slow, the fix is
-- `create extension pg_trgm` plus a gin (search_text gin_trgm_ops) index — not a
-- btree.

comment on column public.users.search_text is
  'Lower-cased first_name, last_name, nerd_number, company_name and job_title in one string. Generated — search only, never write or return it.';

/*
 * One row per person per connection, from that person's point of view.
 *
 * public.connections holds a pair once, so "my requests" would otherwise mean
 * looking at requester_id or addressee_id depending on the row, and searching by
 * the *other* person's name would mean joining differently in each case. This
 * view does that once: viewer_id is always "me", other_id always "them", and
 * other_search_text is their searchable text, so every list is one flat query
 * that pages and counts properly.
 *
 * security_invoker = true, so the RLS policy above still decides which rows a
 * signed-in caller sees. The service role bypasses RLS as usual.
 */
create or replace view public.connection_people
  with (security_invoker = true)
  as
  select
    c.id as request_id,
    c.status,
    c.created_at,
    c.responded_at,
    c.requester_id as viewer_id,
    c.addressee_id as other_id,
    'sent' as direction,
    other.search_text as other_search_text
  from public.connections c
  join public.users other on other.id = c.addressee_id
  union all
  select
    c.id,
    c.status,
    c.created_at,
    c.responded_at,
    c.addressee_id,
    c.requester_id,
    'received',
    other.search_text
  from public.connections c
  join public.users other on other.id = c.requester_id;

grant select on public.connection_people to authenticated;
grant select on public.connection_people to service_role;

