-- =========================================================================
-- KoshAgar ERP - 55_restore_backend_exemption.sql
--
-- THE IMPORT WAS TURNED AWAY FROM A SHOP IT WAS POINTED AT
--
--   Error: 400 /rpc/set_opening_cash - NOT_A_MEMBER: you do not have access
--          to this shop.
--
-- assert_period_writable() is the single gate every posting function passes
-- through, so its membership check is the one that matters. 20 wrote it with
-- the back end exempt, in as many words:
--
--   if not is_service_role()
--      and not exists (select 1 from shop_members ...)
--
-- 33 then rewrote the same function to add the archived-books rule - and
-- rebuilt the membership check from scratch without the exemption. Nothing
-- noticed, because the exemption only matters to a caller that holds the
-- service key and belongs to no shop: the importer, and nothing else. There was
-- no import between 33 and today.
--
-- THE SHAPE OF THE BUG IS WORTH MORE THAN THE FIX
-- A later migration reproduced an earlier one's function and silently dropped
-- one of its rules. That is the same failure as the build's hand-written file
-- list and the health check's double-counted loan: something restated in a
-- second place, and the second copy left behind. Whenever a migration rewrites
-- a function whole, every rule the previous version carried has to be carried
-- over deliberately - the diff will not tell you, because the whole body is new.
--
-- WHAT THIS RESTORES, AND WHAT IT DOES NOT
-- The exemption is for MEMBERSHIP only. Everything else in 33 stays exactly as
-- it is and applies to the back end too:
--
--   * an archived set of books is still refused - history stays history,
--     whoever is asking;
--   * a closed month is still refused - an import must not quietly write into
--     a month the owner has closed.
--
-- Nothing was written when the import failed. It stopped on its first call.
-- =========================================================================

create or replace function assert_period_writable(p_shop uuid, p_date date)
returns void language plpgsql stable security definer set search_path = public as $$
declare v_archived boolean; v_name text;
begin
  -- WHO. The back end is exempt - it holds the service key and belongs to no
  -- shop, which is the whole point of it. Everyone else must be a member.
  -- Checked first: a caller with no right to this shop should be told that,
  -- not told the month is closed.
  if not is_service_role()
     and not exists (select 1 from shop_members
                      where shop_id = p_shop and user_id = auth.uid()) then
    raise exception 'NOT_A_MEMBER: you do not have access to this shop.';
  end if;

  -- WHICH BOOKS. An archived set is history: readable, exportable, finished.
  -- No exemption here - the back end may not add to closed books either.
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

comment on function assert_period_writable is
  'The write gate: the caller must be a member of this shop OR hold the service key, the shop must not be archived, and the date must be in an open period. Every posting function calls it before writing.';

grant execute on function assert_period_writable(uuid, date) to authenticated;

select 'the back end can post into a shop again; archived books and closed months still refuse everyone' as note;
