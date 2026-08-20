-- What the chat/* endpoints need on top of the original chats tables:
--
--  * direct_key, so "start a chat with this person" is find-or-create rather than
--    a new chat on every tap
--  * last_read_at, so a chat list can show an unread count
--  * start_direct_chat(), which creates the chat and both participant rows in one
--    transaction (over PostgREST those were three separate writes, and a failure
--    between them left an unreachable empty chat behind)
--  * chat_overview, one row per chat per participant with the last message and the
--    unread count already worked out

-- One 1:1 chat per pair. The key is the two ids in a fixed order, so it does not
-- matter who tapped first; group chats leave it null and are not constrained.
alter table public.chats
  add column if not exists direct_key text;

-- Existing 1:1 chats predate the column. Only pairs are backfilled — anything
-- with a different number of participants is left alone.
update public.chats c
set direct_key = pair.key
from (
  select
    cp.chat_id,
    -- min/max are already the two ids in sorted order, which is what the key is.
    min(cp.user_id::text) || ':' || max(cp.user_id::text) as key
  from public.chat_participants cp
  group by cp.chat_id
  having count(*) = 2
) as pair
where c.id = pair.chat_id
  and c.direct_key is null
  and c.is_group = false
  -- Skip a pair that somehow has two chats: the first one keeps the key.
  and not exists (
    select 1 from public.chats other where other.direct_key = pair.key
  );

create unique index if not exists chats_direct_key_key
  on public.chats (direct_key)
  where direct_key is not null;

-- Null means "never opened it", which counts every message as unread.
alter table public.chat_participants
  add column if not exists last_read_at timestamptz;

/*
 * Find-or-create the 1:1 chat between two people, and return its id.
 *
 * The insert races safely: if both tap at the same moment, the loser's insert
 * hits chats_direct_key_key and the existing row is returned instead.
 */
create or replace function public.start_direct_chat(p_user_id uuid, p_other_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  key text;
  chat_id uuid;
begin
  if p_user_id is null or p_other_id is null then
    raise exception 'Both attendees are required.' using errcode = 'P0001';
  end if;
  if p_user_id = p_other_id then
    raise exception 'You cannot start a chat with yourself.' using errcode = 'P0001';
  end if;

  key := least(p_user_id::text, p_other_id::text) || ':' ||
         greatest(p_user_id::text, p_other_id::text);

  select id into chat_id from public.chats where direct_key = key;
  if chat_id is not null then
    return chat_id;
  end if;

  insert into public.chats (is_group, direct_key)
  values (false, key)
  on conflict (direct_key) do nothing
  returning id into chat_id;

  if chat_id is null then
    -- Someone else created it in between.
    select id into chat_id from public.chats where direct_key = key;
    return chat_id;
  end if;

  insert into public.chat_participants (chat_id, user_id)
  values (chat_id, p_user_id), (chat_id, p_other_id)
  on conflict (chat_id, user_id) do nothing;

  return chat_id;
end;
$$;

revoke all on function public.start_direct_chat(uuid, uuid) from public;
revoke all on function public.start_direct_chat(uuid, uuid) from anon;
revoke all on function public.start_direct_chat(uuid, uuid) from authenticated;
grant execute on function public.start_direct_chat(uuid, uuid) to service_role;

/*
 * One row per chat per participant: "my chats", already carrying the other
 * person's id, the last message and how many messages I have not read.
 *
 * A chat list needs all three, and none of them can be expressed as a PostgREST
 * query — the last message is a per-chat limit 1, and the unread count is an
 * aggregate. security_invoker = true keeps the participant-only RLS policies in
 * force for direct callers; the service role bypasses them as usual.
 */
create or replace view public.chat_overview
  with (security_invoker = true)
  as
  select
    cp.user_id as viewer_id,
    c.id as chat_id,
    c.is_group,
    c.created_at,
    cp.last_read_at,
    other.user_id as other_user_id,
    last_message.id as last_message_id,
    last_message.body as last_message_body,
    last_message.sender_id as last_message_sender_id,
    last_message.created_at as last_message_at,
    (
      select count(*)
      from public.chat_messages m
      where m.chat_id = c.id
        and m.sender_id <> cp.user_id
        and (cp.last_read_at is null or m.created_at > cp.last_read_at)
    ) as unread_count
  from public.chat_participants cp
  join public.chats c on c.id = cp.chat_id
  left join lateral (
    select m.id, m.body, m.sender_id, m.created_at
    from public.chat_messages m
    where m.chat_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) as last_message on true
  -- Null for a group chat, which has no single "other person".
  left join lateral (
    select p.user_id
    from public.chat_participants p
    where p.chat_id = c.id and p.user_id <> cp.user_id
    order by p.joined_at, p.user_id
    limit 1
  ) as other on true;

grant select on public.chat_overview to authenticated;
grant select on public.chat_overview to service_role;

-- Spelled out because local and hosted disagree on defaults for new objects.
grant select, insert, update on table public.chats to service_role;
grant select, insert, update on table public.chat_participants to service_role;
grant select, insert on table public.chat_messages to service_role;

comment on column public.chats.direct_key is
  'The two participant ids in sorted order for a 1:1 chat, null for group chats. Unique, so a pair can only ever have one direct chat. Written by public.start_direct_chat().';
comment on column public.chat_participants.last_read_at is
  'When this participant last opened the chat. Bumped by GET chat/details/{id}; drives unread_count in public.chat_overview.';
