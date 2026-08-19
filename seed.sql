-- Reference data sourced from config.md.

-- Guilds are names only: the app shows the list as picker options with no copy
-- beneath them, so description is left null.
insert into public.guilds (id, name) overriding system value values
  (1, 'AI & Agentic Systems'),
  (2, 'Banking'),
  (3, 'Payments'),
  (4, 'Digital Currency & Stablecoins'),
  (5, 'Lending'),
  (6, 'Investing & Wealth'),
  (7, 'Embedded Finance'),
  (8, 'Fraud, Identity & Risk'),
  (9, 'Compliance & Regulation'),
  (10, 'Product & Engineering'),
  (11, 'Data & Infrastructure'),
  (12, 'Cross-Border Finance'),
  (13, 'Growth & Go-to-Market'),
  (14, 'Venture Capital & Startups'),
  (15, 'Bank-Fintech Partnerships')
on conflict (name) do nothing;

-- configs holds four config.md types on one shared id sequence, so rows are
-- inserted in doc order and get sequential ids rather than reusing config.md's
-- per-type ids (which restart at 1 for each type and would collide here).
--
-- Only user_type carries a description — it is the one picker whose options need
-- explaining to the user.
insert into public.configs (type, name, description) values
  ('user_type', 'Builder', 'I create products, tools, and systems.'),
  ('user_type', 'Operator', 'I run and optimize processes to keep things moving.'),
  ('user_type', 'Explorer', 'I discover new ideas, markets, and opportunities.'),
  ('event-quest', 'Main Quests', null),
  ('event-quest', 'Side Quests', null),
  ('event-quest', 'Bonus Quests', null),
  ('event-quest', 'My Schedule', null),
  ('event-day', 'Day 0', null),
  ('event-day', 'Day 1', null),
  ('event-day', 'Day 2', null),
  ('stage-type', 'Stage 1', null),
  ('stage-type', 'Stage 2', null),
  ('stage-type', 'Stage 3', null),
  ('stage-type', 'Stage 4', null)
on conflict (type, name) do update set description = excluded.description;

insert into public.missions (id, title, description, points) overriding system value values
  (1, 'Book Your First Quest', 'Add an offsite event to your schedule.', 50),
  (2, 'Add a session to your schedule', 'Check in to a Main Quest or Side Quest Stage session and level up your knowledge.', 50),
  (3, 'Visit an Activation', 'Explore a sponsor activation in the Activation Hall.', 50),
  (4, 'Connect with a New Nerd', 'Make a new connection through the event app with a fellow attendee.', 50);

-- guilds and missions were inserted with `overriding system value`, which does
-- not advance their identity sequences: both were left unused while ids 1..15 and
-- 1..4 are taken. The next insert that lets the database pick an id (adding a
-- guild in Studio, say) would ask for id 1 and fail on the primary key. Move each
-- sequence past the rows just inserted. configs uses the sequence normally, so it
-- is already correct — set it too, so this stays right if that ever changes.
select setval(pg_get_serial_sequence('public.guilds', 'id'), coalesce((select max(id) from public.guilds), 1));
select setval(pg_get_serial_sequence('public.missions', 'id'), coalesce((select max(id) from public.missions), 1));
select setval(pg_get_serial_sequence('public.configs', 'id'), coalesce((select max(id) from public.configs), 1));
