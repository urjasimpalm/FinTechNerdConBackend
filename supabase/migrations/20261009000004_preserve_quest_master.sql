-- Ensure Quest Master mission remains unchanged
-- This preserves the original Quest Master mission exactly as it should be

update public.missions
set title = 'Quest Master',
    description = 'Complete every core mission.',
    points = 50
where id = 7;
