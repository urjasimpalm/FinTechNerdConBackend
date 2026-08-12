create table if not exists public.email_stack (
                                                  id uuid primary key default gen_random_uuid(),
    email text not null unique,
    first_name text,
    last_name text
    );

alter table public.email_stack enable row level security;