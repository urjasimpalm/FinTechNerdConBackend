-- auth/register, auth/login, auth/logout, auth/forgot-password, auth/reset-password,
-- auth/refresh-token, auth/verify-email, auth/account (delete), user/profile (GET/PUT)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null unique,
  user_type_config_id integer references public.configs (id) on delete set null,
  guild_id integer references public.guilds (id) on delete set null,
  company_name text,
  job_title text,
  profile_image text,
  device_type integer,
  device_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_set_updated_at
  before update on public.users
  for each row
  execute function public.set_updated_at();

alter table public.users enable row level security;

-- user/people, user/guild/list, user/guild/filter need to browse other attendees,
-- so select is open to all authenticated users rather than restricted to self.
create policy "authenticated users can view user directory"
  on public.users for select
  to authenticated
  using (true);

create policy "users can update their own profile"
  on public.users for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "users can delete their own account"
  on public.users for delete
  to authenticated
  using (auth.uid() = id);
