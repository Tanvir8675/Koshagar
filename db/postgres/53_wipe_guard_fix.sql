-- =========================================================================
-- KoshAgar ERP - 53_wipe_guard_fix.sql
--
-- THE WIPE REFUSED THE ONE PLACE IT WAS MEANT TO BE RUN FROM
--
--   select * from wipe_everything('DELETE EVERYTHING AND EVERY ACCOUNT');
--   ERROR: SERVICE_ROLE_ONLY: this can only be run from the SQL editor ...
--
-- 52 guarded both functions with is_service_role(), and 52's header claimed the
-- Supabase SQL editor "runs as service_role". It does not. is_service_role()
-- reads the role out of the request's JWT (20_service_role_writes.sql), and the
-- SQL editor sends no JWT at all - it connects to the database directly as the
-- postgres role. So the claim is absent, the function correctly answers false,
-- and the guard turned away the only caller it was written for.
--
-- WHAT THE GUARD ACTUALLY WANTED TO ASK
-- Not "did this arrive with the service key" but "is this the back end at all".
-- Two things are the back end: a request carrying the service key, and a direct
-- connection as a role that RLS does not apply to. The second is what the SQL
-- editor is, and it is exactly the case that was missing.
--
-- AND SECURITY DEFINER HAD TO GO
-- Under SECURITY DEFINER a function runs as its OWNER, so current_user inside
-- it is postgres no matter who called - a role check written that way answers
-- "yes" for everybody, which is worse than the bug it replaces. These two are
-- SECURITY INVOKER instead: they run as whoever called them, so the check means
-- what it says AND the table grants apply underneath it. A signed-in user has
-- no DELETE on these tables, so even with the guard removed the app could not
-- empty the books.
--
-- Nothing else about the two functions changes: same tables, same order, same
-- phrases, same receipt.
--
-- HOW TO RUN, corrected: paste this file, then
--
--   select * from wipe_everything('DELETE EVERYTHING AND EVERY ACCOUNT');
--
-- in the Supabase SQL editor, which is the postgres role and now passes.
-- =========================================================================

create or replace function is_backend_session()
returns boolean language plpgsql stable set search_path = public as $$
declare v_bypass boolean;
begin
  -- A request that carried the service key.
  if is_service_role() then return true; end if;

  -- Or a direct connection as a role RLS does not apply to - the SQL editor,
  -- psql as postgres, a migration runner. `authenticated` and `anon` have
  -- neither flag, so a browser can never satisfy this.
  select coalesce(rolsuper, false) or coalesce(rolbypassrls, false)
    into v_bypass
    from pg_roles where rolname = current_user;

  return coalesce(v_bypass, false);
end $$;

comment on function is_backend_session is
  'True for the service key OR a direct superuser/bypassrls connection such as the Supabase SQL editor. is_service_role() alone answers false there, because the editor sends no JWT.';

-- -------------------------------------------------------------------------
-- The two wipes, guarded correctly. SECURITY INVOKER on purpose - see above.
-- -------------------------------------------------------------------------
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

  foreach v_t in array v_tables loop
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
  for table_name, rows_deleted in
    select w.table_name, w.rows_deleted
    from wipe_all_business_data('DELETE ALL DATA IN EVERY SHOP') w
    where w.table_name <> '(shops re-seeded)'
  loop
    return next;
  end loop;

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
end $$;

revoke all on function wipe_all_business_data(text) from public, anon, authenticated;
revoke all on function wipe_everything(text)        from public, anon, authenticated;

select 'guard fixed - the SQL editor can now run the wipe. Nothing has been deleted yet.' as note;
