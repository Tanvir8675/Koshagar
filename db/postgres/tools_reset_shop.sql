-- =========================================================================
-- KoshAgar ERP — tools_reset_shop.sql
--
-- WHY THIS EXISTS
-- The online app has been tested against a live shop, so that shop now holds
-- entries like "testing1 x 100 PCS" alongside nothing else. The real history is
-- about to be imported from the old app's backup. Those two must not end up in
-- the same books: a test sale that consumed a FIFO lot changes the cost of a
-- real one, and no report afterwards can tell them apart.
--
-- This empties ONE shop of everything transactional and leaves the shop, its
-- members, products, units and parties alone - so the account keeps working and
-- the import has somewhere to land.
--
-- THIS IS THE ONE DESTRUCTIVE SCRIPT IN THE PROJECT. It deletes posted
-- documents, which every other part of the system refuses to do on purpose.
-- It is here for exactly one moment - clearing test data before the migration -
-- and it is guarded so it cannot be run by accident or from the app:
--
--   * service_role only. The app's key cannot execute it.
--   * the confirmation phrase must be typed in full.
--   * it prints what it deleted, per table.
--
-- HOW TO RUN (Supabase SQL Editor, which runs as service_role):
--
--   select * from reset_shop_data(
--     '00000000-0000-0000-0000-000000000000'::uuid,   -- the shop to empty
--     'DELETE EVERYTHING IN THIS SHOP');
--
-- Take a backup first. There is no undo - that is the point of the phrase.
-- =========================================================================

create or replace function reset_shop_data(p_shop uuid, p_confirm text)
returns table (table_name text, rows_deleted bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_t   text;
  v_n   bigint;
  -- Child rows first: every list below is in delete order, so no foreign key
  -- has to be relaxed to make this work.
  v_tables text[] := array[
    'document_edits', 'document_reversals',
    'payment_allocations', 'payments', 'party_bills',
    'return_lines', 'returns',
    'stock_lot_consumption', 'stock_lots', 'inventory_movements',
    'sale_lines', 'sales',
    'purchase_lines', 'purchases',
    'adjustments',
    'cash_ledger', 'cash_adjustments', 'expenses', 'cash_withdrawals',
    'capital_movements', 'loans', 'opening_cash',
    'document_sequences', 'idempotency_keys', 'accounting_periods',
    'audit_log'
  ];
begin
  if p_confirm is distinct from 'DELETE EVERYTHING IN THIS SHOP' then
    raise exception
      'NOT_CONFIRMED: pass the exact phrase DELETE EVERYTHING IN THIS SHOP as the second argument.';
  end if;
  if not exists (select 1 from shops where id = p_shop) then
    raise exception 'NO_SUCH_SHOP: % is not a shop in this database.', p_shop;
  end if;

  foreach v_t in array v_tables loop
    -- A table that a later migration has not created yet is skipped rather
    -- than aborting the run half-emptied.
    if to_regclass('public.' || v_t) is null then continue; end if;
    execute format('delete from %I where shop_id = $1', v_t) using p_shop;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      table_name := v_t; rows_deleted := v_n; return next;
    end if;
  end loop;

  -- Products, units, parties and members are KEPT. The import matches products
  -- by legacy_id and parties by phone, so leaving them costs nothing and losing
  -- them would take the account's access with it.
  return;
end $$;

revoke all on function reset_shop_data(uuid, text) from public, anon, authenticated;
grant execute on function reset_shop_data(uuid, text) to service_role;

comment on function reset_shop_data(uuid, text) is
  'Empties one shop of every transactional row, keeping the shop, its members and its master data. For clearing test entries before the historical import; service_role only, and refuses without the confirmation phrase.';

select 'reset_shop_data() is installed - it does nothing until you call it' as note;
