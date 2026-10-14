/*
 * Pin the printed QR codes to the sheet's counts:
 *
 *   13 x Visit an Activation  (visit_activation, repeatable)
 *    6 x Explore a New Zone   (explore_zone, repeatable)
 *    1 x Nerd Flex            (nerd_flex, once per person)
 *
 * Who may scan what is not decided here. Each code can be scanned by any number of
 * people, and each person can claim a given code once: qr_scans is unique on
 * (user_id, qr_code_id), and the mission ledger is keyed per user.
 *
 * Idempotent, so it is safe to re-run: for each mission it counts the active codes
 * and mints only the shortfall. Excess codes are switched off with is_active = false
 * rather than deleted, so their scans stay in qr_scans and mission_completions.
 *
 * Labels for codes minted here are numbered from 1 by mint_qr_codes(). If codes are
 * ever added to a mission that already has some, check the labels afterwards.
 */
do $$
declare
  spec record;
  active_count integer;
begin
  for spec in
    select * from (values
      ('visit_activation', 'activation', 'Activation',       13),
      ('explore_zone',     'zone',       'Zone',              6),
      ('nerd_flex',        'nerd_flex',  'Nerd Flex lanyard', 1)
    ) as v (mission_code, kind, label_prefix, target)
  loop
    select count(*) into active_count
      from public.qr_codes q
      join public.missions m on m.id = q.mission_id
      where m.code = spec.mission_code
        and q.is_active;

    if active_count < spec.target then
      perform public.mint_qr_codes(
        spec.kind, spec.label_prefix, spec.target - active_count, spec.mission_code
      );
    elsif active_count > spec.target then
      -- Switch off the newest extras first, so the codes already printed keep working.
      update public.qr_codes
        set is_active = false
        where id in (
          select q.id
            from public.qr_codes q
            join public.missions m on m.id = q.mission_id
            where m.code = spec.mission_code
              and q.is_active
            order by q.id desc
            limit active_count - spec.target
        );
    end if;
  end loop;
end;
$$;
