-- =========================================================================
-- KoshAgar ERP - 52_wipe_all_data.sql
--
-- EMPTY THE WHOLE DATABASE OF DATA, KEEPING THE DATABASE
--
-- Everything in these books was typed to test the app. Before real shopkeepers
-- sign up, it has to go - a test sale consumed a FIFO lot, and a real sale
-- costed against that lot is wrong in a way no report afterwards can spot.
--
-- tools_reset_shop.sql already empties ONE shop and leaves its products, units
-- and parties behind, because it was written for the moment before the import.
-- This is the other job: every shop, and the master data with it, so a new
-- account starts from nothing at all.
--
-- WHAT IT KEEPS, AND WHY
--   * the schema - every table, function, view, policy and trigger
--   * accounts (auth.users) and their profiles
--   * shops and shop_members
--
-- Accounts and shops stay because deleting them breaks the people who already
-- signed in: nothing re-runs handle_new_user() for an existing user, so an
-- account whose shop was deleted would open the app and be told it has no
-- books. Every remaining shop is left EMPTY - no products, no parties, no
-- documents, not one row of cash - and seeded again the way a brand new shop
-- is, so it opens and works like the first day.
--
-- WHAT IT DELETES
--   every document, every ledger row, every lot, every bill and payment,
--   every product, unit, party, cash account, opening balance, sequence,
--   idempotency key, accounting period and audit entry - in every shop.
--
-- HOW TO RUN (Supabase SQL Editor, which runs as service_role)
--
--   select * from wipe_all_business_data('DELETE ALL DATA IN EVERY SHOP');
--
-- It prints what it deleted, per table, so the result is a receipt rather than
-- a claim.
--
-- EXPORT FIRST IF THERE IS ANY DOUBT. There is no undo - that is what the
-- phrase is for. From the app: Settings -> Export Data, for each shop.
--
-- THE GUARDS
--   * service_role only. The app's key cannot execute it, so no screen, no
--     bug and no signed-in user can reach it.
--   * the phrase must be typed in full and exactly.
-- =========================================================================

create or replace function wipe_all_business_data(p_confirm text)
returns table (table_name text, rows_deleted bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_t text;
  v_n bigint;
  v_shop uuid;
  -- Children before parents, so no foreign key has to be relaxed and the order
  -- itself documents what depends on what.
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
    'audit_log',
    -- Master data goes too. This is the difference from reset_shop_data():
    -- a fresh start means no leftover test products or parties either.
    'product_units', 'products', 'parties', 'cash_accounts', 'units'
  ];
begin
  if not is_service_role() then
    raise exception
      'SERVICE_ROLE_ONLY: this can only be run from the SQL editor or with the service key, never from the app.';
  end if;

  if p_confirm is distinct from 'DELETE ALL DATA IN EVERY SHOP' then
    raise exception
      'NOT_CONFIRMED: pass the exact phrase DELETE ALL DATA IN EVERY SHOP as the argument.';
  end if;

  foreach v_t in array v_tables loop
    execute format('delete from %I', v_t);
    get diagnostics v_n = row_count;
    table_name := v_t;
    rows_deleted := v_n;
    return next;
  end loop;

  -- Every surviving shop is put back to the state a new one is created in:
  -- the default units and a Main Counter cash account. Without this the first
  -- entry after the wipe would fail on a missing default cash account, which
  -- reads as a broken app rather than an empty one.
  for v_shop in select id from shops loop
    perform seed_new_shop(v_shop);
  end loop;

  table_name := '(shops re-seeded)';
  rows_deleted := (select count(*) from shops);
  return next;

  -- The wipe is itself worth recording. This is the first row of the new
  -- history: it says the books were emptied deliberately, on purpose, by
  -- somebody holding the service key.
  insert into audit_log (shop_id, action, entity_table, note)
  select id, 'database_wiped', 'shops',
         'All business data deleted before opening the app to real users.'
  from shops;
end $$;

revoke all on function wipe_all_business_data(text) from public, anon, authenticated;

comment on function wipe_all_business_data(text) is
  'Deletes every document, ledger row and piece of master data in EVERY shop, keeping the schema, the accounts and the shops themselves. service_role only, exact phrase required, no undo.';

select 'wipe_all_business_data() is ready - it has NOT run. Read the header, export first, then call it with the phrase.' as note;
