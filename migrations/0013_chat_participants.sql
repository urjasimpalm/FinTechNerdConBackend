-- chat/create, chat/details/{id} (membership)
create table if not exists public.chat_participants (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (chat_id, user_id)
);

alter table public.chat_participants enable row level security;

-- security definer helper avoids RLS recursion between chats/chat_participants policies
create or replace function public.is_chat_participant(target_chat_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.chat_participants
    where chat_id = target_chat_id
      and user_id = auth.uid()
  );
$$;

create policy "chats are viewable by participants"
  on public.chats for select
  to authenticated
  using (public.is_chat_participant(id));

create policy "authenticated users can create chats"
  on public.chats for insert
  to authenticated
  with check (true);

create policy "participants can view chat membership"
  on public.chat_participants for select
  to authenticated
  using (public.is_chat_participant(chat_id));

-- Covers both the initial self-join on chat creation and adding other members
-- (e.g. group chats) once the inserting user is already part of the chat.
create policy "participants can add members to their chats"
  on public.chat_participants for insert
  to authenticated
  with check (
    user_id = auth.uid()
    or public.is_chat_participant(chat_id)
  );
