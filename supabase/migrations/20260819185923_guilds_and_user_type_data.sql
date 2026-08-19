-- Reference data for the register screen: the full guild list, and a blurb for
-- each user_type.
--
-- Guilds are names only — there is no copy to show under them, so the
-- placeholder descriptions the table shipped with are cleared here. The column
-- stays (nullable) so this is data, not a schema break for anything reading it.
-- user_type is the opposite case: each option needs a one-line explanation next
-- to the radio button, so public.configs gains a description column.

alter table public.configs
  add column if not exists description text;

-- The first five guilds already exist with ids 1..5 and public.users rows point
-- at them, so those ids are left alone and only the remaining ten are added. The
-- sequence is nudged past the existing rows first: the original seed inserted
-- ids 1..5 with `overriding system value`, which does not advance the identity
-- sequence, so letting the database pick ids below would collide.
-- The third argument is false when the table is empty, so id 1 is still handed
-- out on a database that has no guilds yet.
select setval(
  pg_get_serial_sequence('public.guilds', 'id'),
  coalesce((select max(id) from public.guilds), 1),
  (select count(*) > 0 from public.guilds)
);

-- Matched on name rather than id so this is safe to re-run and does not care
-- what ids an environment already handed out.
--
-- The already-present names are filtered out in the select rather than left to
-- `on conflict`: the identity default is evaluated for every candidate row before
-- conflicts are resolved, so an `on conflict do nothing` here would burn five ids
-- on the rows it discards and start the new guilds at 11. `on conflict` stays as
-- a backstop.
with wanted (name, ord) as (
  values
    ('AI & Agentic Systems', 1),
    ('Banking', 2),
    ('Payments', 3),
    ('Digital Currency & Stablecoins', 4),
    ('Lending', 5),
    ('Investing & Wealth', 6),
    ('Embedded Finance', 7),
    ('Fraud, Identity & Risk', 8),
    ('Compliance & Regulation', 9),
    ('Product & Engineering', 10),
    ('Data & Infrastructure', 11),
    ('Cross-Border Finance', 12),
    ('Growth & Go-to-Market', 13),
    ('Venture Capital & Startups', 14),
    ('Bank-Fintech Partnerships', 15)
)
insert into public.guilds (name)
select w.name
from (select * from wanted order by ord) w
where not exists (
  select 1 from public.guilds g where g.name = w.name
)
on conflict (name) do nothing;

update public.guilds set description = null where description is not null;

insert into public.configs (type, name, description)
values
  ('user_type', 'Builder', 'I create products, tools, and systems.'),
  ('user_type', 'Operator', 'I run and optimize processes to keep things moving.'),
  ('user_type', 'Explorer', 'I discover new ideas, markets, and opportunities.')
on conflict (type, name) do update set description = excluded.description;
