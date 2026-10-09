-- Update guilds list: rename existing 9 and remove rest
-- This ensures both fresh installs (seed.sql) and existing databases have the correct guilds

-- Update the names of guilds 1-9
update public.guilds set name = 'AI & Agents' where id = 1;
update public.guilds set name = 'Banking & Partnerships' where id = 2;
update public.guilds set name = 'Payments & Stablecoins' where id = 3;
update public.guilds set name = 'Lending & Credit' where id = 4;
update public.guilds set name = 'Wealth & Investing' where id = 5;
update public.guilds set name = 'Fraud, Identity & Risk' where id = 6;
update public.guilds set name = 'Compliance & Regulation' where id = 7;
update public.guilds set name = 'Product, Data & Infrastructure' where id = 8;
update public.guilds set name = 'Startups, VC & Growth' where id = 9;

-- Delete guilds 10-15 that are no longer needed
delete from public.guilds where id > 9;
