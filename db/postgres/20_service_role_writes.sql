-- =========================================================================
-- KoshAgar ERP — 20_service_role_writes.sql
-- Run now. The import fails with NOT_A_MEMBER without it.
--
-- 16_lock_writes.sql put a membership check into assert_period_writable(), so
-- every posting function now proves the caller belongs to the shop. Correct for
-- the app - and fatal for the back end, because service_role authenticates with
-- a key, not a user, so auth.uid() is null and it belongs to no shop at all.
--
-- The obvious shortcut is "allow it when auth.uid() is null". That would be
-- wrong: an anonymous visitor also has a null uid. It is only EXECUTE having
-- been revoked from anon that stops them, and one grant made carelessly later
-- would silently reopen the hole.
--
-- So the role is named explicitly instead. service_role is the back end -
-- migrations, imports, scheduled jobs - and it already bypasses RLS everywhere
-- else, so this changes nothing about who can reach what. It only stops the
-- function pretending the back end is a customer standing at the till.
-- =========================================================================

create or replace function is_service_role()
returns boolean language plpgsql stable set search_path = public as $$
declare v_role text;
begin
  -- The JWT role travels in request.jwt.claims. Absent outside a request (in
  -- psql, say), which correctly yields false.
  begin
    v_role := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    );
  exception when others then
    v_role := null;
  end;
  return coalesce(v_role, '') = 'service_role';
end $$;

comment on function is_service_role is
  'True only for the back-end key. Used to let migrations and imports post documents without belonging to a shop - never to widen access for a browser.';

create or replace function assert_period_writable(p_shop uuid, p_date date)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  -- WHO. The back end is exempt - everyone else must be a member of the shop.
  if not is_service_role()
     and not exists (select 1 from shop_members
                      where shop_id = p_shop and user_id = auth.uid()) then
    raise exception 'NOT_A_MEMBER: you do not have access to this shop.';
  end if;

  -- WHEN. Applies to the back end as well: an import must not quietly write
  -- into a month the owner has closed.
  if not period_is_writable(p_shop, p_date) then
    raise exception
      'PERIOD_CLOSED: % is in a closed month. Unlock the month first, or post the correction into the current month.',
      to_char(p_date, 'FMMonth YYYY');
  end if;
end $$;

-- export_shop_data is deliberately NOT changed here. It is called by the app,
-- which always has a signed-in user, so its membership check is right as it
-- stands. Loosening it for the back end would widen access for no benefit.

revoke all on function is_service_role() from public, anon;
grant execute on function is_service_role() to authenticated;

-- VERIFY: a browser session is still refused a shop it does not belong to.
-- Expect NOT_A_MEMBER when called with the publishable key.
select 'run the connection test to confirm a normal session is still blocked' as note;
