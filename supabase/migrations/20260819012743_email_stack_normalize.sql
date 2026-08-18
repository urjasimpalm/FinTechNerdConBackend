-- Makes the attendee list canonical, ahead of the admin add/remove API writing to
-- it. public.email_stack.email is unique, but only case-sensitively, so
-- 'Wasim@Simpalm.com' and 'wasim@simpalm.com' can both exist. verify_email
-- compares with lower(), so such a pair behaves as one entry when checking, while
-- an admin removing "the" address would delete only one of them.
--
-- Collapse any case-variant duplicates, keeping the row that was inserted first.
delete from public.email_stack a
using public.email_stack b
where lower(trim(a.email)) = lower(trim(b.email))
  and a.ctid > b.ctid;

-- Store addresses one way from here on.
update public.email_stack
set email = lower(trim(email))
where email <> lower(trim(email));

-- Now the constraint the table should have had: unique regardless of case. This
-- also lets the admin API treat a 23505 as "already on the list".
create unique index if not exists email_stack_email_lower_key
  on public.email_stack (lower(email));

-- Superseded by the unique index above, which serves the same lookups
-- (verify_email filters on lower(email)).
drop index if exists public.email_stack_email_lower_idx;
