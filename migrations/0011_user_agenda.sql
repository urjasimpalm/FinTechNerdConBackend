-- user/agenda (per-user session bookmarks)
create table if not exists public.user_agenda (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  agenda_id uuid not null references public.agenda (id) on delete cascade,
  day date,
  created_at timestamptz not null default now(),
  unique (user_id, agenda_id)
);

alter table public.user_agenda enable row level security;

create policy "users can view their own agenda"
  on public.user_agenda for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can add to their own agenda"
  on public.user_agenda for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users can remove from their own agenda"
  on public.user_agenda for delete
  to authenticated
  using (auth.uid() = user_id);
