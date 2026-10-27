-- Agenda config rows (event quests, event days, stage types) that the agenda
-- migration maps source config ids onto by (type, name). Ids are assigned by the
-- identity column, so only type and name are fixed here. Safe to re-run.

insert into public.configs (type, name, description)
values
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
on conflict (type, name) do nothing;
