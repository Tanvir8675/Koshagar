-- =========================================================================
-- KoshAgar ERP - 33_export_fix_and_archived_readonly.sql
--
-- 1. EXPORT WAS IMPOSSIBLE TO CALL
--    "cannot execute INSERT in a read-only transaction", every time.
--
--    export_shop_data() is declared STABLE, and PostgREST runs a STABLE
--    function inside a READ-ONLY transaction - correctly, that is what stable
--    means. But the function ends by writing an audit row saying the data was
--    exported, and an INSERT in a read-only transaction is refused.
--
--    The audit row is the part worth keeping: an export is a copy of the whole
--    business leaving the system, and that should be on the record. So the
--    function stops claiming to be stable. Nothing else about it changes.
--
-- 2. AN ARCHIVED SHOP WAS STILL WRITABLE
--    Reset archives the old books and opens new ones. The shop switcher can
--    still open the archived set - that is the point, so history stays
--    readable - but nothing stopped a sale being ENTERED into it. Two live sets
--    of books on one account is exactly the confusion archiving exists to end,
--    and it would be discovered weeks later by a total that would not add up.
--
--    Archived now means read-only. unarchive_shop() brings a set back into use
--    in one deliberate step, and the error message says so.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. The export
-- -------------------------------------------------------------------------
-- The body is already right; only the volatility marking is wrong, so that is
-- all this changes. PostgREST reads volatility from the catalogue on each
-- schema reload, so nothing else has to be touched.
alter function export_shop_data(uuid) volatile;

comment on function export_shop_data is
  'Full shop backup as one JSON document, with checksums so a restore can be verified rather than assumed. VOLATILE deliberately: it records every export in audit_log, and a stable function cannot write.';

-- -------------------------------------------------------------------------
-- 2. Archived books are read-only
--
-- assert_period_writable() is the single call every posting function makes
-- before it writes anything (16_lock_writes.sql), which is why the membership
-- check lives here. The archive check belongs in the same place, for the same
-- reason: it cannot be forgotten when the next posting function is written.
-- -------------------------------------------------------------------------
create or replace function assert_period_writable(p_shop uuid, p_date date)
returns void language plpgsql stable security definer set search_path = public as $$
declare v_archived boolean; v_name text;
begin
  -- WHO. Checked first: a caller with no right to this shop should be told
  -- that, not told the month is closed.
  if not exists (select 1 from shop_members
                  where shop_id = p_shop and user_id = auth.uid()) then
    raise exception 'NOT_A_MEMBER: you do not have access to this shop.';
  end if;

  -- WHICH BOOKS. An archived set is history: readable, exportable, finished.
  -- This is the only line added to the function; the month rule below is
  -- unchanged and still delegated to period_is_writable().
  select name, is_archived into v_name, v_archived from shops where id = p_shop;
  if coalesce(v_archived, false) then
    raise exception
      'SHOP_ARCHIVED: "%" is an archived set of books and cannot be added to. Reopen it from the shop list first if you meant to keep using it.',
      v_name;
  end if;

  -- WHEN.
  if not period_is_writable(p_shop, p_date) then
    raise exception
      'PERIOD_CLOSED: % is in a closed month. Unlock the month first, or post the correction into the current month.',
      to_char(p_date, 'FMMonth YYYY');
  end if;
end $$;

comment on function assert_period_writable is
  'The write gate: asserts the caller is a member of this shop, that the shop is not archived, AND that the date is in an open period. Every posting function calls it before writing.';

grant execute on function assert_period_writable(uuid, date) to authenticated;

select 'export works, and archived books are read-only' as note;
