-- Update missions titles and descriptions
-- This ensures both fresh installs (seed.sql) and existing databases have the correct mission text

update public.missions
set description = 'Add a bonus quest to your schedule to earn XP for this mission.'
where id = 1;

update public.missions
set title = 'Add a content session to your schedule',
    description = 'Add any content session to your schedule to earn XP for this mission.'
where id = 2;

update public.missions
set title = 'Explore a sponsor activation in the Activation Hall',
    description = 'Visit a sponsor activation on the show floor and scan the QR code to earn XP.'
where id = 3;

update public.missions
set title = 'Connect with a Nerd',
    description = 'Go to the People tab and connect with a fellow nerd in the app.'
where id = 4;

update public.missions
set description = 'Enter a new NerdCon world and scan the QR code to earn XP.'
where id = 5;

update public.missions
set title = 'Nerd Flex',
    description = 'Find Simon, Colton, or Joy. Snap your nerdiest photo together and share it on social with #FintechNerdCon #NerdCon #Fintech. They''ll share a QR code for you to scan to redeem XP.'
where id = 6;
