/*
 * Production has mission codes on the wrong rows: each code sits one row off from
 * its mission (e.g. id 6 'Nerd Flex' carries visit_activation). mint_qr_codes()
 * looks missions up by code, so codes minted for one mission would award another.
 *
 * Ids 1..7 are pinned by seed.sql, and production uses those same ids and titles,
 * so the codes are set by id. Matching by title would miss ids 2, 3 and 4, whose
 * titles differ from the FRD sheet wording.
 *
 * Two steps: missions_code_key is a unique index, so a direct swap of codes
 * between rows can fail mid-update.
 */
update public.missions
  set code = null
  where id between 1 and 7;

update public.missions m
  set code = v.code
  from (values
    (1, 'book_first_quest'),
    (2, 'add_session'),
    (3, 'visit_activation'),
    (4, 'connect_nerd'),
    (5, 'explore_zone'),
    (6, 'nerd_flex'),
    (7, 'quest_master')
  ) as v (id, code)
  where m.id = v.id;

/*
 * QR codes minted before this fix were attached to the mission whose code was
 * wrong at the time, so their mission_id is wrong too. Point each kind at its mission:
 *
 *   activation -> 3 (Visit an Activation, visit_activation)
 *   zone       -> 5 (Explore a New Zone, explore_zone)
 *   nerd_flex  -> 6 (Nerd Flex, nerd_flex)
 */
update public.qr_codes
  set mission_id = case kind
    when 'activation' then 3
    when 'zone'       then 5
    when 'nerd_flex'  then 6
  end
  where kind in ('activation', 'zone', 'nerd_flex')
    and mission_id is distinct from case kind
    when 'activation' then 3
    when 'zone'       then 5
    when 'nerd_flex'  then 6
  end;
