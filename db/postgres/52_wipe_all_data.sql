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
-- TWO LEVELS, BECAUSE THEY ARE DIFFERENT DECISIONS
--
--   wipe_all_business_data()  empties every shop but keeps the shops and the
--                             accounts that own them. Use it when the people
--                             signed in are real and only their test entries
--                             are not.
--
--   wipe_everything()         also deletes the shops, the memberships, the
--                             profiles and the accounts themselves. Nothing is
--                             left but the empty schema.
--
-- Both keep the schema itself - every table, function, view, policy and
-- trigger. Neither can be reached from the app.
--
-- WHAT wipe_all_business_data() DELETES
--   every document, every ledger row, every lot, every bill and payment,
--   every product, unit, party, cash account, opening balance, sequence,
--   idempotency key, accounting period and audit entry - in every shop.
--
-- It then re-seeds each surviving shop the way a brand new one is created,
-- because an empty shop with no default cash account fails on the first entry
-- and reads as broken rather than as empty.
--
-- HOW TO RUN (Supabase SQL Editor, which runs as service_role)
--
--   select * from wipe_all_business_data('DELETE ALL DATA IN EVERY SHOP');
--   select * from wipe_everything('DELETE EVERYTHING AND EVERY ACCOUNT');
--
-- Each prints what it deleted, per table, so the result is a receipt rather
-- than a claim.
--
-- EXPORT FIRST IF THERE IS ANY DOUBT. There is no undo - that is what the
-- phrase is for. From the app: Settings -> Export Data, for each shop.
--
-- AFTER wipe_everything() NOBODY CAN SIGN IN, INCLUDING YOU. That is the point:
-- the accounts were mock accounts too. Sign up again and the trigger that has
-- always run on a new account - handle_new_user() - makes the profile, the
-- shop, the membership and the starting units, exactly as it does for the first
-- real shopkeeper. Nothing has to be repaired by hand afterwards.
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

-- =========================================================================
-- THE HARDER ONE: NOTHING LEFT BUT THE SCHEMA
--
-- The shops were mock shops and the logins were mock logins, so they go with
-- the data. Deleting the accounts is what makes this a true fresh start rather
-- than an empty one - a leftover account carries a username, an email and a
-- shop it owns, and the first real shopkeeper should not be sharing a database
-- with the ghost of a test.
--
-- ORDER MATTERS AND IS NOT NEGOTIABLE
--   1. business data      - shops are referenced with ON DELETE RESTRICT by
--                           almost every table, so nothing else can go first
--   2. shop_members       - restrict on BOTH sides (shop and user)
--   3. shops
--   4. auth.users         - profiles follow by cascade (17_auth_profiles), and
--                           so do the sessions and identities Supabase keeps
--
-- created_by columns were made ON DELETE SET NULL in 19_user_deletion.sql, so
-- deleting a user can never be blocked by a document they entered. Here every
-- document is already gone, but the order still holds if this is ever run on a
-- database that has kept some.
--
-- IF THE LAST STEP IS REFUSED
-- auth.users belongs to Supabase, not to this schema, and on some projects a
-- function cannot delete from it however it is owned. If that line raises a
-- permission error, everything before it has still been committed - run the one
-- remaining statement directly in the SQL editor, which is the postgres role:
--
--   delete from auth.users;
--
-- or remove the accounts by hand in Authentication -> Users. profiles follow
-- either way, by cascade.
-- =========================================================================
create or replace function wipe_everything(p_confirm text)
returns table (table_name text, rows_deleted bigint)
language plpgsql security definer set search_path = public as $$
declare v_n bigint;
begin
  if not is_service_role() then
    raise exception
      'SERVICE_ROLE_ONLY: this can only be run from the SQL editor or with the service key, never from the app.';
  end if;

  if p_confirm is distinct from 'DELETE EVERYTHING AND EVERY ACCOUNT' then
    raise exception
      'NOT_CONFIRMED: pass the exact phrase DELETE EVERYTHING AND EVERY ACCOUNT as the argument.';
  end if;

  -- Everything transactional and every piece of master data, reported as it
  -- goes. This is the same list as above, run through the same function, so the
  -- two can never drift apart.
  for table_name, rows_deleted in
    select w.table_name, w.rows_deleted
    from wipe_all_business_data('DELETE ALL DATA IN EVERY SHOP') w
    where w.table_name <> '(shops re-seeded)'
  loop
    return next;
  end loop;

  -- The audit row wipe_all_business_data() wrote, and the seeding it did, are
  -- both about to be deleted with the shops. Cleared here rather than left to a
  -- foreign key error.
  delete from audit_log;
  delete from units;
  delete from cash_accounts;

  delete from shop_members;
  get diagnostics v_n = row_count;
  table_name := 'shop_members'; rows_deleted := v_n; return next;

  delete from shops;
  get diagnostics v_n = row_count;
  table_name := 'shops'; rows_deleted := v_n; return next;

  -- profiles goes with the user, by cascade. Counted before, so the receipt
  -- says how many accounts were actually removed.
  select count(*) into v_n from auth.users;
  delete from auth.users;
  table_name := 'auth.users (profiles cascade)'; rows_deleted := v_n; return next;
end $$;

revoke all on function wipe_everything(text) from public, anon, authenticated;

comment on function wipe_everything(text) is
  'Deletes all data, all shops, all memberships, all profiles and all accounts, leaving only the schema. Nobody can sign in afterwards until someone signs up again, which recreates a shop through handle_new_user(). service_role only, exact phrase required, no undo.';

select 'wipe_all_business_data() and wipe_everything() are ready - NEITHER has run. Read the header, export first, then call the one you mean with its phrase.' as note;
