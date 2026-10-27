-- Agenda config rows (event quests, event days, stage types) that the agenda
-- migration maps source config ids onto by (type, name). Ids are assigned by the
-- identity column, so only type and name are fixed here. Safe to re-run.

-- Production's configs table has no unique (type, name) constraint (it drifted from
-- 0005_configs.sql), so this inserts only the rows that are missing instead of
-- relying on on conflict.
insert into public.configs (type, name, description)
select v.type, v.name, v.description
from (values
  ('event-quest', 'Main Quests', null),
  ('event-quest', 'Side Quests', null),
  ('event-quest', 'Bonus Quests', null),
  ('event-quest', 'My Schedule', null),
  ('event-day', 'Day 0', null),
  ('event-day', 'Day 1', null),
  ('event-day', 'Day 2', null),
  ('stage-type', 'Main Quest', null),
  ('stage-type', 'Stableverse Powered by Tempo', null),
  ('stage-type', 'Compliance Nerd Corner', null),
  ('stage-type', 'The Vault', null),
  ('stage-type', 'AI Command Center', null),
  ('stage-type', 'Builder Zone', null),
  ('stage-type', 'Demo Stage', null),
  ('stage-type', 'Podcast Stage', null),
  ('stage-type', 'Bootcamp', null),
  ('stage-type', 'Roundtables', null),
  ('stage-type', 'Meetups', null)
) as v (type, name, description)
where not exists (
  select 1 from public.configs c
  where c.type = v.type and c.name = v.name
);
