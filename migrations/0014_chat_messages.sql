-- chat/details/{id}, chat/send/{id}
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  sender_id uuid not null references public.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

create policy "participants can view messages in their chats"
  on public.chat_messages for select
  to authenticated
  using (public.is_chat_participant(chat_id));

create policy "participants can send messages to their chats"
  on public.chat_messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_chat_participant(chat_id)
  );
