-- chat/create, chat (list)
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.chats enable row level security;
