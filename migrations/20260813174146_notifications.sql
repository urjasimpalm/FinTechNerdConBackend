-- notification/list, notification/read/{id}, notification/read-all, notification/{id} (delete)
-- Rows are written server-side (service role / edge functions) when a chat message
-- arrives, a mission is completed, an agenda session is starting, etc. The push
-- delivery target lives on public.users (device_type, device_token).
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  -- e.g. chat_message, mission, agenda, announcement
  type text not null,
  title text not null,
  body text,
  -- deep-link payload for the client (chat_id, mission_id, agenda_id, ...)
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- notification/list is always "my notifications, newest first"
create index if not exists notifications_user_id_created_at_idx
  on public.notifications (user_id, created_at desc);

-- unread badge count
create index if not exists notifications_unread_idx
  on public.notifications (user_id)
  where read_at is null;

alter table public.notifications enable row level security;

create policy "users can view their own notifications"
  on public.notifications for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can mark their own notifications read"
  on public.notifications for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users can delete their own notifications"
  on public.notifications for delete
  to authenticated
  using (auth.uid() = user_id);

-- RLS cannot restrict which columns an update touches, so the update policy above
-- is narrowed with column-level grants: a user may only flip read_at, never rewrite
-- the title/body/data of a notification they were sent.
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- No insert policy: notifications are created by the service role, which bypasses RLS.
