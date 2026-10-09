-- Update guilds list: rename existing 9 and remove rest
-- This ensures both fresh installs (seed.sql) and existing databases have the correct guilds

-- Delete guilds 10-15 that are no longer needed
delete from public.guilds where id > 9;

-- Update the names of guilds 1-9 using a single statement to avoid unique constraint conflicts
update public.guilds
set name = case id
  when 1 then 'AI & Agents'
  when 2 then 'Banking & Partnerships'
  when 3 then 'Payments & Stablecoins'
  when 4 then 'Lending & Credit'
  when 5 then 'Wealth & Investing'
  when 6 then 'Fraud, Identity & Risk'
  when 7 then 'Compliance & Regulation'
  when 8 then 'Product, Data & Infrastructure'
  when 9 then 'Startups, VC & Growth'
end
where id between 1 and 9;
