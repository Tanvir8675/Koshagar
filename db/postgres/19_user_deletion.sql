-- =========================================================================
-- KoshAgar ERP — 19_user_deletion.sql
--
-- Makes deleting a user possible without losing the shop's history.
--
-- WHY IT WAS IMPOSSIBLE
-- Supabase reports only "Database error deleting user". Underneath, three
-- kinds of reference were blocking it:
--
--   shop_members.user_id   ON DELETE RESTRICT
--   created_by             on twenty-odd tables, defaulting to NO ACTION
--   audit_log.actor, accounting_periods.closed_by / unlocked_by
--
-- WHAT SHOULD HAPPEN INSTEAD
-- A sale does not stop being a sale because the person who entered it left. The
-- row must survive; only the attribution goes. So created_by becomes SET NULL -
-- the entry stays, and "who made this" becomes unknown rather than the whole
-- record becoming undeletable.
--
-- shop_members becomes CASCADE: removing a user removes their access, and the
-- shop and its books remain. If that was the last member the shop is left with
-- no one - readable by the service role, and re-attachable with
-- grant_shop_access() below.
-- =========================================================================

-- 1. Attribution should never block a deletion.
do $$
declare r record;
begin
  for r in
    select c.conname, c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'auth.users'::regclass
      and c.connamespace = 'public'::regnamespace
      and a.attname in ('created_by', 'actor', 'closed_by', 'unlocked_by')
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I foreign key (%I) references auth.users(id) on delete set null',
                   r.tbl, r.conname, r.col);
  end loop;
end $$;

-- 2. Removing a user removes their access, not the shop.
alter table shop_members drop constraint if exists shop_members_user_id_fkey;
alter table shop_members
  add constraint shop_members_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

comment on constraint shop_members_user_id_fkey on shop_members is
  'CASCADE: deleting a user revokes their access. The shop and every document in it survive - use grant_shop_access() to attach a new owner.';

-- =========================================================================
-- ATTACH A SHOP TO A USER
--
-- Needed for two things: adopting a shop whose owner was deleted, and claiming
-- the shop created by the data import, which ran as the service role and so
-- belongs to nobody.
--
-- Service role only - it has no auth.uid(), which is exactly why it must not be
-- callable from the app.
-- =========================================================================
create or replace function grant_shop_access(p_shop uuid, p_email text, p_role text default 'owner')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_name text;
begin
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'USER_NOT_FOUND: no account for %.', p_email;
  end if;
  select name into v_name from shops where id = p_shop;
  if v_name is null then
    raise exception 'SHOP_NOT_FOUND: no shop with that id.';
  end if;
  if p_role not in ('owner', 'viewer') then
    raise exception 'INVALID_ROLE: role must be owner or viewer.';
  end if;

  insert into shop_members (shop_id, user_id, role)
  values (p_shop, v_user, p_role)
  on conflict (shop_id, user_id) do update set role = excluded.role;

  perform write_audit(p_shop, 'access_granted', 'shop_members', p_shop, null,
                      jsonb_build_object('email', p_email, 'role', p_role));

  return jsonb_build_object('ok', true, 'shop', v_name, 'user', p_email, 'role', p_role);
end $$;

revoke all on function grant_shop_access(uuid, text, text) from public, anon, authenticated;

-- Verify: nothing should still block a user deletion.
select c.conrelid::regclass::text as referencing_table,
       a.attname                  as column_name,
       c.confdeltype              as on_delete   -- a=no action, r=restrict, c=cascade, n=set null
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
  and c.connamespace = 'public'::regnamespace
  and c.confdeltype in ('a', 'r')
order by 1;
