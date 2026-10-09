-- Comprehensive fix for all missions - ensure all titles and descriptions are correct

update public.missions
set title = case id
  when 1 then 'Book Your First Quest'
  when 2 then 'Add a content session to your schedule'
  when 3 then 'Explore a sponsor activation in the Activation Hall'
  when 4 then 'Connect with a Nerd'
  when 5 then 'Explore a New Zone'
  when 6 then 'Nerd Flex'
  when 7 then 'Quest Master'
end,
description = case id
  when 1 then 'Add a bonus quest to your schedule to earn XP for this mission.'
  when 2 then 'Add any content session to your schedule to earn XP for this mission.'
  when 3 then 'Visit a sponsor activation on the show floor and scan the QR code to earn XP.'
  when 4 then 'Go to the People tab and connect with a fellow nerd in the app.'
  when 5 then 'Enter a new NerdCon world and scan the QR code to earn XP.'
  when 6 then 'Find Simon, Colton, or Joy. Snap your nerdiest photo together and share it on social with #FintechNerdCon #NerdCon #Fintech. They''ll share a QR code for you to scan to redeem XP.'
  when 7 then 'Complete every core mission.'
end
where id between 1 and 7;
