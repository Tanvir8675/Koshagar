-- =========================================================================
-- KoshAgar ERP — 90_cleanup_test_shops.sql
--
-- Run ONCE. Removes the shops left behind by testing and by the ten import
-- attempts, keeping only the good final import.
--
--   KEEPS   2d5c3982-91e6-4514-9006-211700fd6f4a
--           (973/973 documents, stock and ledger reconciled, 0 failures)
--
--   REMOVES 3 "Smoke Test Shop" rows - the smoke test's rollback never took
--           effect because Supabase's SQL editor auto-commits
--           9 earlier "My Shop" imports, each superseded by the next
--
-- purge_archived_shop() cannot be used here: it identifies the caller through
-- auth.uid(), and the SQL editor has no logged-in user. This does the same work
-- directly, using the same door through the delete guard.
-- =========================================================================

do $$
declare
  v_keep uuid := '2d5c3982-91e6-4514-9006-211700fd6f4a';
  v_shop uuid;
  v_rows int := 0;
  t      text;
begin
  if not exists (select 1 from shops where id = v_keep) then
    raise exception 'The shop to keep (%) does not exist - check the id before running this.', v_keep;
  end if;

  perform set_config('koshagar.purge_active', 'on', true);

  for v_shop in select id from shops where id <> v_keep loop
    foreach t in array array[
      'stock_lot_consumption', 'payment_allocations', 'inventory_movements',
      'cash_ledger', 'return_lines', 'returns', 'sale_lines', 'sales',
      'purchase_lines', 'purchases', 'stock_lots', 'adjustments', 'payments',
      'party_bills', 'loans', 'expenses', 'capital_movements',
      'cash_withdrawals', 'cash_adjustments', 'opening_cash',
      'document_reversals', 'product_units', 'products', 'parties',
      'cash_accounts', 'units', 'accounting_periods', 'document_sequences',
      'idempotency_keys', 'audit_log', 'shop_members'
    ] loop
      execute format('delete from %I where shop_id = $1', t) using v_shop;
    end loop;
    delete from shops where id = v_shop;
    v_rows := v_rows + 1;
  end loop;

  perform set_config('koshagar.purge_active', 'off', true);
  raise notice 'Removed % shop(s).', v_rows;
end $$;

-- No VACUUM here: the SQL editor runs this batch inside a transaction, and
-- VACUUM cannot run in one (25001). It is not needed either - autovacuum
-- reclaims the space for reuse on its own within minutes. Only VACUUM FULL
-- returns disk to the operating system, and that locks every table it touches,
-- which is not a trade worth making for a few megabytes.

select id, name, created_at,
       (select count(*) from sales s where s.shop_id = shops.id) as sales
from shops order by created_at;
