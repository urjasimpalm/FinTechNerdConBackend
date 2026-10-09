-- Update user type descriptions for Builder and Operator
-- This ensures both fresh installs (seed.sql) and existing databases have the correct descriptions

update public.configs
set description = 'I build products, tools, and systems.'
where type = 'user_type' and name = 'Builder';

update public.configs
set description = 'I keep things running and make them run better.'
where type = 'user_type' and name = 'Operator';
