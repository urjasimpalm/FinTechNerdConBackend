-- Three more missions for the catalog. Matched on title (there is no unique
-- constraint on it) so re-running this does not duplicate them.
--
-- Points match the four that already exist: every mission is worth 50. If Quest
-- Master should be worth more for completing the rest, change it here.
insert into public.missions (title, description, points)
select m.title, m.description, m.points
from (values
  (
    'Explore a New Zone',
    'Visit one of NerdCon''s themed worlds and discover what''s inside.',
    50
  ),
  (
    'Nerd Flex',
    'Find Simon, Colton, or Joy, snap a gloriously nerdy photo together (high-five, goofy grin, swag, props, or your best geeky pose), and share it on LinkedIn or your favorite social platform using #FintechNerdCon.',
    50
  ),
  (
    'Quest Master',
    'Complete every core mission.',
    50
  )
) as m (title, description, points)
where not exists (
  select 1 from public.missions existing where existing.title = m.title
);
