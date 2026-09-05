-- =========================================================================
-- KoshAgar ERP - 57_backend_check_survives_key_rotation.sql
--
-- THE BACK-END CHECK MUST NOT DEPEND ON WHICH GENERATION OF KEY IS IN USE
--
-- Supabase has two kinds of secret now. The old one is a JWT that carries
-- "role":"service_role" in its claims; the new one is an opaque sb_secret_...
-- string. is_service_role() reads the role out of the JWT claims, which is the
-- only place the OLD key puts it.
--
-- 53 already met this problem from the other side - the SQL editor sends no JWT
-- at all - and answered it with is_backend_session(): the service key OR a
-- direct connection as a role that RLS does not apply to. A new secret key
-- arrives as the service_role database role, which carries bypassrls, so
-- is_backend_session() recognises it whichever kind of key was used.
--
-- Two places still ask the narrower question, and both are on the import path:
--
--   assert_period_writable()  (55) - the membership exemption. Without it the
--                             importer is told NOT_A_MEMBER and stops on its
--                             first call, which is exactly what happened when
--                             33 dropped the exemption.
--   allow_negative            (50) - lets the import replay days when the old
--                             app let the drawer go below zero.
--
-- Neither would fail today. Both would fail silently-ish the first time an
-- import was run after the leaked JWT was disabled and a new secret key put in
-- its place - and the error would point at membership or at cash, not at the
-- key. That is a bad afternoon to schedule for later.
--
-- Nothing widens: is_backend_session() is false for anon and for authenticated,
-- neither of which holds superuser or bypassrls. The app cannot reach either
-- behaviour, before or after.
-- =========================================================================

-- -------------------------------------------------------------------------
-- The write gate. Identical to 55 except for the question it asks.
-- -------------------------------------------------------------------------
create or replace function assert_period_writable(p_shop uuid, p_date date)
returns void language plpgsql stable security definer set search_path = public as $$
declare v_archived boolean; v_name text;
begin
  -- WHO. The back end is exempt - it holds the service key and belongs to no
  -- shop, which is the whole point of it. Everyone else must be a member.
  if not is_backend_session()
     and not exists (select 1 from shop_members
                      where shop_id = p_shop and user_id = auth.uid()) then
    raise exception 'NOT_A_MEMBER: you do not have access to this shop.';
  end if;

  -- WHICH BOOKS. No exemption: the back end may not add to closed books either.
  select name, is_archived into v_name, v_archived from shops where id = p_shop;
  if coalesce(v_archived, false) then
    raise exception
      'SHOP_ARCHIVED: "%" is an archived set of books and cannot be added to. Reopen it from the shop list first if you meant to keep using it.',
      v_name;
  end if;

  -- WHEN. Applies to the back end as well: an import must not quietly write
  -- into a month the owner has closed.
  if not period_is_writable(p_shop, p_date) then
    raise exception
      'PERIOD_CLOSED: % is in a closed month. Unlock the month first, or post the correction into the current month.',
      to_char(p_date, 'FMMonth YYYY');
  end if;
end $$;

grant execute on function assert_period_writable(uuid, date) to authenticated;

-- -------------------------------------------------------------------------
-- EVERY OTHER FUNCTION THAT ASKS THE NARROW QUESTION
--
-- Rather than list them - the list is exactly the kind of thing that goes out
-- of date, as 33 proved by dropping a rule while rewriting a function - each
-- one is found by what it actually contains and rewritten in place. Only the
-- call changes; the rest of the body is whatever the latest migration left.
--
-- At the time of writing that is the allow_negative flag in post_purchase,
-- post_expense, record_payment, post_capital_movement, post_return and
-- post_cash_withdrawal, plus the owner-or-back-end check in create_product,
-- create_unit and their kin. Whatever the set turns out to be, it is the set
-- the database itself reports.
--
-- is_service_role() is left in place and unchanged: is_backend_session() calls
-- it as its first test, and a function that only ever runs through PostgREST
-- may legitimately want the narrow question.
-- -------------------------------------------------------------------------
do $$
declare
  r     record;
  v_src text;
  v_n   int := 0;
begin
  for r in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname <> 'is_backend_session'
       and p.prosrc like '%is_service_role()%'
     order by p.proname
  loop
    v_src := pg_get_functiondef(r.oid);
    execute replace(v_src, 'is_service_role()', 'is_backend_session()');
    v_n := v_n + 1;
    raise notice '%() now recognises either kind of key', r.proname;
  end loop;
  raise notice '% function(s) rewritten', v_n;
end $$;

select 'the back end is recognised by the new secret keys as well as the old JWT' as note;
