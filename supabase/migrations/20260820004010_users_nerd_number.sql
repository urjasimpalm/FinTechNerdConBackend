-- The Nerd number: every attendee's badge number, issued once at registration and
-- never changed.
--
-- Stored pre-formatted as text ('00427') rather than as an integer, so the value
-- the app prints is the value in the column and no caller has to remember the
-- padding. Serial order comes from a sequence, so numbers follow registration
-- order with no gaps beyond failed inserts.

create sequence if not exists public.nerd_number_seq as integer start with 1 minvalue 1;

alter table public.users
  add column if not exists nerd_number text;

-- Assignment lives in a trigger rather than a column default: the padding needs
-- nextval() wrapped in lpad(), and a generated column cannot call a sequence.
create or replace function public.assign_nerd_number()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- A caller-supplied number is honoured (only the service role can insert
    -- into public.users at all), which keeps backfills and data imports possible.
    if new.nerd_number is null then
      new.nerd_number := lpad(nextval('public.nerd_number_seq')::text, 5, '0');
    end if;
    return new;
  end if;

  -- Issued once. Silently pinned rather than raising, so a client that PUTs a
  -- whole profile object back — nerd_number included — still succeeds instead of
  -- erroring on a field it was never allowed to change.
  --
  -- The `old is not null` guard is what lets the backfill below run through this
  -- same trigger: a row that has no number yet can still be given one.
  if old.nerd_number is not null then
    new.nerd_number := old.nerd_number;
  end if;
  return new;
end;
$$;

drop trigger if exists users_assign_nerd_number on public.users;
create trigger users_assign_nerd_number
  before insert or update on public.users
  for each row
  execute function public.assign_nerd_number();

-- Existing rows predate the column. Numbered in registration order, one at a
-- time: nextval() in a set-returning update is not guaranteed to follow the
-- ORDER BY, and these numbers are meant to line up with who signed up first.
do $$
declare
  target record;
begin
  for target in
    select id from public.users where nerd_number is null order by created_at, id
  loop
    update public.users
      set nerd_number = lpad(nextval('public.nerd_number_seq')::text, 5, '0')
      where id = target.id;
  end loop;
end;
$$;

-- Safe now that every row has one. Uniqueness is the point of the number, so the
-- index is not optional.
alter table public.users
  alter column nerd_number set not null;

create unique index if not exists users_nerd_number_key
  on public.users (nerd_number);

-- Deliberately absent from the column-level UPDATE grants added in
-- 20260818221724_users_is_admin.sql, so a PATCH /rest/v1/users carrying
-- nerd_number is rejected outright with 42501 rather than quietly ignored.
comment on column public.users.nerd_number is
  'Badge number, zero-padded to 5 digits (e.g. 00427). Issued once on insert by public.assign_nerd_number() and immutable thereafter, including for the service role.';
