-- user/mission (per-user progress feeding the leaderboard)
create table if not exists public.user_missions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  mission_id integer not null references public.missions (id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  points_awarded integer not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, mission_id)
);

create trigger user_missions_set_updated_at
  before update on public.user_missions
  for each row
  execute function public.set_updated_at();

alter table public.user_missions enable row level security;

create policy "users can view their own mission progress"
  on public.user_missions for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can insert their own mission progress"
  on public.user_missions for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users can update their own mission progress"
  on public.user_missions for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
