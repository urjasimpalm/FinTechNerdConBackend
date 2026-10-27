/*
 * Production has mission codes on the wrong rows: each code sits one row off from its
 * title (e.g. 'Nerd Flex' carries visit_activation, 'Visit an Activation' carries
 * nerd_flex). mint_qr_codes() looks missions up by code, so codes minted for one
 * mission would award another.
 *
 * Re-points every code by title, the same mapping 20260822000002_missions_frd.sql
 * uses. Two steps: missions_code_key is a unique index, so a direct swap of codes
 * between rows can fail mid-update.
 */
update public.missions
  set code = null
  where lower(btrim(title)) in (
    'book your first quest',
    'add a session to your schedule',
    'visit an activation',
    'connect with a new nerd',
    'explore a new zone',
    'nerd flex',
    'quest master'
  );

update public.missions m
  set code = v.code
  from (values
    ('book your first quest',           'book_first_quest'),
    ('add a session to your schedule',  'add_session'),
    ('visit an activation',             'visit_activation'),
    ('connect with a new nerd',         'connect_nerd'),
    ('explore a new zone',              'explore_zone'),
    ('nerd flex',                       'nerd_flex'),
    ('quest master',                    'quest_master')
  ) as v (title, code)
  where lower(btrim(m.title)) = v.title;
