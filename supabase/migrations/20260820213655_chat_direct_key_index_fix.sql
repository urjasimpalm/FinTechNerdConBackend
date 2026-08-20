-- Fixes the index added in 20260820213238_chat_direct.sql.
--
-- It was created as a partial index (`where direct_key is not null`), which
-- Postgres will not use to infer an ON CONFLICT target unless the predicate is
-- repeated in the statement — so public.start_direct_chat() failed with
-- "42P10: there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" on the very first call.
--
-- A plain unique index is the right shape here anyway: unique indexes treat nulls
-- as distinct, so any number of group chats can carry direct_key = null while a
-- pair still gets exactly one direct chat.
drop index if exists public.chats_direct_key_key;

create unique index if not exists chats_direct_key_key
  on public.chats (direct_key);
