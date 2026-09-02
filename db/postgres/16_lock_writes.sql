-- =========================================================================
-- KoshAgar ERP — 16_lock_writes.sql
-- SECURITY FIX. Run immediately.
--
-- Found while testing the API client with the PUBLISHABLE key and no login:
--
--   select from products  ->  permission denied      (correct)
--   rpc post_sale         ->  EMPTY_DOCUMENT         (WRONG - it ran)
--
-- Two separate holes, either of which is enough on its own.
--
-- 1. PUBLIC still had EXECUTE.
--    Postgres grants EXECUTE on every new function to PUBLIC by default.
--    09_rls.sql revoked from `anon`, but anon inherits PUBLIC, so the revoke
--    achieved nothing. An anonymous caller could invoke every posting function.
--
-- 2. The functions never checked WHO was calling.
--    They take p_shop as an argument and validate that products and parties
--    belong to that shop - but not that the CALLER does. They are SECURITY
--    DEFINER, so RLS does not stop them either. Anyone holding a shop_id could
--    write into that shop.
--
-- The publishable key is in the frontend by design, so this was reachable by
-- anyone who opened the app and read the page source.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Take EXECUTE away from PUBLIC, then give it back only where intended.
-- -------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
  end loop;
end $$;

-- -------------------------------------------------------------------------
-- 2. Every write path must prove the caller belongs to the shop.
--
-- assert_period_writable() is the one call every posting function already
-- makes before it writes anything - post_sale, post_purchase, post_return,
-- record_payment, post_expense, post_capital_movement, post_cash_withdrawal,
-- post_adjustment, post_cash_adjustment, post_loan, set_opening_cash and the
-- three reversals. Putting the membership check here covers all of them at
-- once, and cannot be forgotten when a new one is added.
-- -------------------------------------------------------------------------
create or replace function assert_period_writable(p_shop uuid, p_date date)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  -- WHO. Checked first: a caller with no right to this shop should be told
  -- that, not told the month is closed.
  if not exists (select 1 from shop_members
                  where shop_id = p_shop and user_id = auth.uid()) then
    raise exception 'NOT_A_MEMBER: you do not have access to this shop.';
  end if;

  -- WHEN.
  if not period_is_writable(p_shop, p_date) then
    raise exception
      'PERIOD_CLOSED: % is in a closed month. Unlock the month first, or post the correction into the current month.',
      to_char(p_date, 'FMMonth YYYY');
  end if;
end $$;

comment on function assert_period_writable is
  'The write gate: asserts the caller is a member of this shop AND that the date is in an open period. Every posting function calls it before writing.';

-- -------------------------------------------------------------------------
-- 3. Hand EXECUTE back to signed-in users only.
-- -------------------------------------------------------------------------
grant execute on function
  post_sale(uuid, jsonb), post_purchase(uuid, jsonb), post_return(uuid, jsonb),
  record_payment(uuid, jsonb), post_expense(uuid, jsonb),
  post_capital_movement(uuid, jsonb), post_cash_withdrawal(uuid, jsonb),
  post_adjustment(uuid, jsonb), post_cash_adjustment(uuid, jsonb),
  post_loan(uuid, jsonb), set_opening_cash(uuid, jsonb),
  reverse_document(uuid, text, uuid, text),
  export_shop_data(uuid), shop_is_empty(uuid), create_additional_shop(text),
  archive_shop(uuid, text), unarchive_shop(uuid), replace_shop(uuid, uuid, text),
  purge_archived_shop(uuid, text),
  cash_balance_as_of(uuid, uuid, date), bill_balance(uuid),
  payment_unallocated(uuid), current_shop_ids(), has_shop_role(uuid, text[])
  to authenticated;

-- -------------------------------------------------------------------------
-- VERIFY: should return no rows. Anything listed is still callable by an
-- anonymous visitor.
-- -------------------------------------------------------------------------
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
  and (has_function_privilege('anon', p.oid, 'EXECUTE')
    or has_function_privilege('public', p.oid, 'EXECUTE'))
order by 1;
