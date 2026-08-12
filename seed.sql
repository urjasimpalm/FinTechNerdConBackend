-- Reference data sourced from config.md.

insert into public.guilds (id, name, description) overriding system value values
  (1, 'AI & Agentic Systems', 'Lorem ipsum dolor sit amet, consectetur'),
  (2, 'Banking', 'Lorem ipsum dolor sit amet, consectetur'),
  (3, 'Payments', 'Lorem ipsum dolor sit amet, consectetur'),
  (4, 'Digital Currency & Stablecoins', 'Lorem ipsum dolor sit amet, consectetur'),
  (5, 'Lending', 'Lorem ipsum dolor sit amet, consectetur');

-- configs holds four config.md types on one shared id sequence, so rows are
-- inserted in doc order and get sequential ids rather than reusing config.md's
-- per-type ids (which restart at 1 for each type and would collide here).
insert into public.configs (type, name) values
  ('user_type', 'Builder'),
  ('user_type', 'Operator'),
  ('user_type', 'Explorer'),
  ('event-quest', 'Main Quests'),
  ('event-quest', 'Side Quests'),
  ('event-quest', 'Bonus Quests'),
  ('event-quest', 'My Schedule'),
  ('event-day', 'Day 0'),
  ('event-day', 'Day 1'),
  ('event-day', 'Day 2'),
  ('stage-type', 'Stage 1'),
  ('stage-type', 'Stage 2'),
  ('stage-type', 'Stage 3'),
  ('stage-type', 'Stage 4');

insert into public.missions (id, title, description, points) overriding system value values
  (1, 'Book Your First Quest', 'Add an offsite event to your schedule.', 50),
  (2, 'Add a session to your schedule', 'Check in to a Main Quest or Side Quest Stage session and level up your knowledge.', 50),
  (3, 'Visit an Activation', 'Explore a sponsor activation in the Activation Hall.', 50),
  (4, 'Connect with a New Nerd', 'Make a new connection through the event app with a fellow attendee.', 50);
