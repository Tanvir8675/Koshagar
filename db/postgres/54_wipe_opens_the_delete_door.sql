-- =========================================================================
-- KoshAgar ERP - 54_wipe_opens_the_delete_door.sql
--
-- THE WIPE RAN INTO THE RULE THAT POSTED DOCUMENTS ARE NEVER DELETED
--
--   ERROR: DELETE_FORBIDDEN: payment_allocations is a posted document and
--          cannot be deleted. Post a reversal instead.
--
-- That rule is correct and is doing its job. Seventeen tables carry a
-- before-delete trigger (03_operations.sql, 04_finance.sql, 11, 12) so that a
-- sale can be reversed but never quietly removed - the whole reason the books
-- can be trusted.
--
-- 15_storage.sql already built the one door through it. forbid_delete_posted()
-- lets a delete pass while koshagar.purge_active is 'on', a setting that lives
-- for the length of one transaction and that no client can reach:
--
--   if coalesce(current_setting('koshagar.purge_active', true), 'off') = 'on'
--   then return old;   -- inside purge_archived_shop(), and nowhere else
--
-- purge_archived_shop() opens it, does its work and closes it again. The wipes
-- in 52 and 53 simply never opened it. Nothing was deleted when they failed -
-- the exception rolled the whole transaction back, which is the behaviour you
-- want from a half-finished wipe.
--
-- So they open the same door, the same way, and close it again in the same
-- transaction. The guard itself is untouched: it still refuses every delete
-- from the app, from a screen, from a mistake.
--
-- HOW TO RUN, unchanged: paste this file, then
--
--   select * from wipe_everything('DELETE EVERYTHING AND EVERY ACCOUNT');
-- =========================================================================

create or replace function wipe_all_business_data(p_confirm text)
returns table (table_name text, rows_deleted bigint)
language plpgsql security invoker set search_path = public as $$
declare
  v_t text;
  v_n bigint;
  v_shop uuid;
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
    'product_units', 'products', 'parties', 'cash_accounts', 'units'
  ];
begin
  if not is_backend_session() then
    raise exception
      'BACKEND_ONLY: run this from the Supabase SQL editor or with the service key. It is not reachable from the app.';
  end if;

  if p_confirm is distinct from 'DELETE ALL DATA IN EVERY SHOP' then
    raise exception
      'NOT_CONFIRMED: pass the exact phrase DELETE ALL DATA IN EVERY SHOP as the argument.';
  end if;

  -- The door, for this transaction only. Anything that fails below rolls the
  -- setting back with everything else, so it cannot be left standing open.
  perform set_config('koshagar.purge_active', 'on', true);

  foreach v_t in array v_tables loop
    -- A table a later migration has not created yet is skipped rather than
    -- aborting the run half-emptied.
    if to_regclass('public.' || v_t) is null then continue; end if;
    execute format('delete from %I', v_t);
    get diagnostics v_n = row_count;
    table_name := v_t;
    rows_deleted := v_n;
    return next;
  end loop;

  -- Each surviving shop goes back to the state a new one is created in, so the
  -- first entry afterwards does not fail on a missing default cash account and
  -- read as a broken app rather than an empty one.
  for v_shop in select id from shops loop
    perform seed_new_shop(v_shop);
  end loop;

  table_name := '(shops re-seeded)';
  rows_deleted := (select count(*) from shops);
  return next;

  insert into audit_log (shop_id, action, entity_table, note)
  select id, 'database_wiped', 'shops',
         'All business data deleted before opening the app to real users.'
  from shops;

  perform set_config('koshagar.purge_active', 'off', true);
end $$;

create or replace function wipe_everything(p_confirm text)
returns table (table_name text, rows_deleted bigint)
language plpgsql security invoker set search_path = public as $$
declare v_n bigint;
begin
  if not is_backend_session() then
    raise exception
      'BACKEND_ONLY: run this from the Supabase SQL editor or with the service key. It is not reachable from the app.';
  end if;

  if p_confirm is distinct from 'DELETE EVERYTHING AND EVERY ACCOUNT' then
    raise exception
      'NOT_CONFIRMED: pass the exact phrase DELETE EVERYTHING AND EVERY ACCOUNT as the argument.';
  end if;

  -- The same table list, run through the same function, so the two cannot drift.
  -- It opens the door and closes it again; this one re-opens it for the few
  -- deletes that follow.
  for table_name, rows_deleted in
    select w.table_name, w.rows_deleted
    from wipe_all_business_data('DELETE ALL DATA IN EVERY SHOP') w
    where w.table_name <> '(shops re-seeded)'
  loop
    return next;
  end loop;

  perform set_config('koshagar.purge_active', 'on', true);

  -- The audit row and the seeding the first function just wrote are about to go
  -- with the shops. Cleared here rather than left to a foreign key error.
  delete from audit_log;
  delete from units;
  delete from cash_accounts;

  delete from shop_members;
  get diagnostics v_n = row_count;
  table_name := 'shop_members'; rows_deleted := v_n; return next;

  delete from shops;
  get diagnostics v_n = row_count;
  table_name := 'shops'; rows_deleted := v_n; return next;

  -- profiles follow the user by cascade. Counted first, so the receipt says how
  -- many accounts actually went.
  select count(*) into v_n from auth.users;
  delete from auth.users;
  table_name := 'auth.users (profiles cascade)'; rows_deleted := v_n; return next;

  perform set_config('koshagar.purge_active', 'off', true);
end $$;

revoke all on function wipe_all_business_data(text) from public, anon, authenticated;
revoke all on function wipe_everything(text)        from public, anon, authenticated;

select 'the wipe can now pass the no-delete guard, for its own transaction only. Nothing has been deleted yet.' as note;
