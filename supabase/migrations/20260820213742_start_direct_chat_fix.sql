-- Fixes public.start_direct_chat() from 20260820213238_chat_direct.sql.
--
-- Its local variable was called `chat_id`, which is also the name of the column it
-- inserts into, so `values (chat_id, p_user_id)` was ambiguous and every call
-- failed with "42702: column reference "chat_id" is ambiguous". The variables are
-- prefixed now, which is the convention that avoids the whole class of problem.
create or replace function public.start_direct_chat(p_user_id uuid, p_other_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_chat_id uuid;
begin
  if p_user_id is null or p_other_id is null then
    raise exception 'Both attendees are required.' using errcode = 'P0001';
  end if;
  if p_user_id = p_other_id then
    raise exception 'You cannot start a chat with yourself.' using errcode = 'P0001';
  end if;

  -- The pair in a fixed order, so it does not matter who started it.
  v_key := least(p_user_id::text, p_other_id::text) || ':' ||
           greatest(p_user_id::text, p_other_id::text);

  select c.id into v_chat_id from public.chats c where c.direct_key = v_key;
  if v_chat_id is not null then
    return v_chat_id;
  end if;

  insert into public.chats (is_group, direct_key)
  values (false, v_key)
  on conflict (direct_key) do nothing
  returning id into v_chat_id;

  if v_chat_id is null then
    -- Someone else created it between the select and the insert.
    select c.id into v_chat_id from public.chats c where c.direct_key = v_key;
    return v_chat_id;
  end if;

  insert into public.chat_participants (chat_id, user_id)
  values (v_chat_id, p_user_id), (v_chat_id, p_other_id)
  on conflict (chat_id, user_id) do nothing;

  return v_chat_id;
end;
$$;

revoke all on function public.start_direct_chat(uuid, uuid) from public;
revoke all on function public.start_direct_chat(uuid, uuid) from anon;
revoke all on function public.start_direct_chat(uuid, uuid) from authenticated;
grant execute on function public.start_direct_chat(uuid, uuid) to service_role;
