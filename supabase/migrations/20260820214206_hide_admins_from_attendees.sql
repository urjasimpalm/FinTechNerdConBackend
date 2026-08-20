-- Admin accounts are event staff, not attendees, and nothing attendee-facing
-- should show them.
--
-- The edge functions filter them out of the directory, guild member lists, profile
-- lookups by id, and as the target of a connection request or a chat. The two
-- views need the flag as well, so a chat or a request that an admin *started* is
-- filtered out for the attendee on the other side rather than only being
-- unreachable in one direction.
--
-- Both are re-created with the flag appended, which is all CREATE OR REPLACE VIEW
-- allows — existing columns keep their name, type and position.

create or replace view public.connection_people
  with (security_invoker = true)
  as
  select
    c.id as request_id,
    c.status,
    c.created_at,
    c.responded_at,
    c.requester_id as viewer_id,
    c.addressee_id as other_id,
    'sent' as direction,
    other.search_text as other_search_text,
    other.is_admin as other_is_admin
  from public.connections c
  join public.users other on other.id = c.addressee_id
  union all
  select
    c.id,
    c.status,
    c.created_at,
    c.responded_at,
    c.addressee_id,
    c.requester_id,
    'received',
    other.search_text,
    other.is_admin
  from public.connections c
  join public.users other on other.id = c.requester_id;

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
    ) as unread_count,
    -- Null for a group chat, which has no single "other person".
    other.is_admin as other_is_admin
  from public.chat_participants cp
  join public.chats c on c.id = cp.chat_id
  left join lateral (
    select m.id, m.body, m.sender_id, m.created_at
    from public.chat_messages m
    where m.chat_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) as last_message on true
  left join lateral (
    select p.user_id, u.is_admin
    from public.chat_participants p
    join public.users u on u.id = p.user_id
    where p.chat_id = c.id and p.user_id <> cp.user_id
    order by p.joined_at, p.user_id
    limit 1
  ) as other on true;

grant select on public.connection_people to authenticated;
grant select on public.connection_people to service_role;
grant select on public.chat_overview to authenticated;
grant select on public.chat_overview to service_role;
