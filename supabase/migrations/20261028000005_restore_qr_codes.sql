/*
 * Re-mint the printed QR codes that were deleted by hand from production.
 *
 * Same targets as 20261014000001_qr_code_counts.sql, which is already recorded as
 * applied there, so it will not run again on its own:
 *
 *   13 x Visit an Activation  (visit_activation, repeatable)
 *    6 x Explore a New Zone   (explore_zone, repeatable)
 *    1 x Nerd Flex            (nerd_flex, once per person)
 *
 * Idempotent: it counts the active codes for each mission and mints only the
 * shortfall, so running it again after a full set exists does nothing.
 *
 * The new codes have new slugs. Any slugs printed before the deletion no longer
 * resolve and must be replaced with the ones returned by the mint calls.
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
