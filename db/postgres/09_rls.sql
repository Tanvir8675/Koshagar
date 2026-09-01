-- =========================================================================
-- KoshAgar ERP — 09_rls.sql
--
-- Isolation. After this file, one account cannot read or write another
-- account's shop, and the database enforces it - not the frontend.
--
-- THREE LAYERS
--
--  1. READ  — every business table is filtered to the shops you belong to.
--
--  2. WRITE — split deliberately:
--       master data (products, parties, units, cash accounts) may be written
--       directly by an owner, because it is ordinary CRUD with no side effects;
--       transactional tables have NO write policy at all, so the only way to
--       create a sale, move stock or touch the cash ledger is to call one of
--       the posting functions. That is what guarantees a sale can never exist
--       without its stock movement and its cash row.
--
--  3. VIEWS — see the security_invoker note below. This is the part that is
--     easy to get wrong and silently catastrophic.
--
-- The posting functions are SECURITY DEFINER and therefore bypass RLS by
-- design; they re-check shop ownership on every id they are handed
-- (assert_party_in_shop, and the shop_id filters inside each lookup).
-- =========================================================================

-- =========================================================================
-- CRITICAL: views must run as the caller, not as their owner.
--
-- A Postgres view executes with the privileges of the view OWNER. Row Level
-- Security on the underlying tables is therefore NOT applied to the person
-- querying the view - so without this, v_party_due and v_monthly_trading would
-- happily return every shop's figures to every logged-in user, even with RLS
-- correctly enabled on every table underneath.
--
-- security_invoker makes the view run as the caller, so the policies below
-- apply to it exactly as they apply to a direct table read.
-- =========================================================================
do $$
declare v text;
begin
  foreach v in array array[
    'v_stock_on_hand', 'v_stock_value', 'v_product_stock', 'v_stock_reconciliation',
    'v_sale_totals', 'v_purchase_totals', 'v_return_totals', 'v_monthly_trading',
    'v_bill_balances', 'v_party_due', 'v_due_totals',
    'v_cash_daily', 'v_cash_balance', 'v_business_worth', 'v_sale_line_costing'
  ] loop
    execute format('alter view %I set (security_invoker = true)', v);
  end loop;
end $$;

-- =========================================================================
-- SHOPS AND MEMBERSHIP
-- =========================================================================
alter table shops        enable row level security;
alter table shop_members enable row level security;

create policy shops_read on shops for select
  using (id in (select current_shop_ids()));

create policy shops_update on shops for update
  using (has_shop_role(id, 'owner'))
  with check (has_shop_role(id, 'owner'));

create policy members_read on shop_members for select
  using (shop_id in (select current_shop_ids()));

create policy members_manage on shop_members for all
  using (has_shop_role(shop_id, 'owner'))
  with check (has_shop_role(shop_id, 'owner'));

-- =========================================================================
-- MASTER DATA — readable by any member, writable by the owner.
--
-- Direct writes are allowed here because creating a product has no financial
-- side effects. Note there is no DELETE policy: master data is deactivated
-- (is_active = false), never removed, so historical documents keep resolving.
-- =========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'units', 'products', 'product_units', 'parties',
    'cash_accounts', 'accounting_periods'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format($f$create policy %I_read on %I for select
                      using (shop_id in (select current_shop_ids()))$f$, t, t);
    execute format($f$create policy %I_insert on %I for insert
                      with check (has_shop_role(shop_id, 'owner'))$f$, t, t);
    execute format($f$create policy %I_update on %I for update
                      using (has_shop_role(shop_id, 'owner'))
                      with check (has_shop_role(shop_id, 'owner'))$f$, t, t);
  end loop;
end $$;

-- A party created through the API must carry a phone: is_legacy is reserved for
-- the import, which runs as the service role and bypasses RLS entirely.
drop policy if exists parties_insert on parties;
create policy parties_insert on parties for insert
  with check (has_shop_role(shop_id, 'owner') and is_legacy = false);

-- =========================================================================
-- TRANSACTIONAL TABLES — READ ONLY for clients.
--
-- Read policy only. No insert, update or delete policy exists, so with RLS on,
-- every direct write from the API is refused. A sale can only be created by
-- post_sale(), which writes the header, the lines, the FIFO consumption, the
-- stock ledger and the cash row in one transaction.
--
-- This is the structural version of "never trust the frontend": the frontend
-- is not merely discouraged from writing these tables, it is unable to.
-- =========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'document_reversals', 'sales', 'sale_lines', 'purchases', 'purchase_lines',
    'returns', 'return_lines', 'adjustments',
    'inventory_movements', 'stock_lots', 'stock_lot_consumption',
    'party_bills', 'payments', 'payment_allocations', 'cash_ledger',
    'expenses', 'capital_movements', 'cash_withdrawals', 'opening_cash'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format($f$create policy %I_read on %I for select
                      using (shop_id in (select current_shop_ids()))$f$, t, t);
  end loop;
end $$;

-- =========================================================================
-- AUDIT LOG — readable, never writable or amendable from the API.
-- The posting functions write it as SECURITY DEFINER.
-- =========================================================================
alter table audit_log enable row level security;

create policy audit_read on audit_log for select
  using (shop_id in (select current_shop_ids()));

-- =========================================================================
-- INTERNAL TABLES — no client access at all.
--
-- RLS on with no policy denies everything. Document numbering and idempotency
-- keys are machinery, not data: nothing outside the posting functions has any
-- business reading or writing them.
-- =========================================================================
alter table document_sequences enable row level security;
alter table idempotency_keys   enable row level security;

-- =========================================================================
-- GRANTS
--
-- RLS filters rows; grants decide whether the role may touch the table at all.
-- Both are needed - RLS alone does nothing if the role has no privilege, and a
-- privilege alone is unrestricted if RLS is off.
-- =========================================================================

-- service_role is the back-end identity - migrations, imports, scheduled jobs.
-- It must be granted explicitly: Supabase's default privileges do not reliably
-- cover tables created by a migration, and without this the import fails with
-- "permission denied for table shops".
grant usage on schema public to service_role;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

-- Nobody unauthenticated gets anything. This app has no public data.
revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon;

grant usage on schema public to authenticated;

-- Reads: RLS narrows these to the caller's own shop.
grant select on all tables in schema public to authenticated;

-- Writes: master data only. Everything else goes through a function.
grant insert, update on units, products, product_units, parties,
                        cash_accounts, accounting_periods to authenticated;

-- The posting functions are the write API.
grant execute on function
  post_sale(uuid, jsonb),
  post_purchase(uuid, jsonb),
  post_return(uuid, jsonb),
  record_payment(uuid, jsonb),
  post_expense(uuid, jsonb),
  post_capital_movement(uuid, jsonb),
  post_cash_withdrawal(uuid, jsonb),
  set_opening_cash(uuid, jsonb),
  reverse_document(uuid, text, uuid, text)
  to authenticated;

-- Read helpers the app calls directly.
grant execute on function
  cash_balance_as_of(uuid, uuid, date),
  bill_balance(uuid),
  payment_unallocated(uuid),
  current_shop_ids(),
  has_shop_role(uuid, text[])
  to authenticated;

-- Internal machinery stays internal, even to a logged-in caller.
revoke execute on function
  consume_fifo(uuid, uuid, numeric, text, uuid),
  reverse_sale(uuid, uuid, text),
  reverse_purchase(uuid, uuid, text),
  reverse_payment(uuid, uuid, text),
  seed_new_shop(uuid),
  write_audit(uuid, text, text, uuid, jsonb, jsonb, text),
  next_document_no(uuid, text, date)
  from authenticated, anon;

-- =========================================================================
-- VERIFICATION
--
-- 1. Every table should report rowsecurity = true.
-- 2. The second query lists tables that can be written directly. It should
--    contain only the six master-data tables - if a transactional table
--    appears there, a write policy has leaked in.
-- =========================================================================
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and rowsecurity = false
order by tablename;

select distinct tablename
from pg_policies
where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'ALL')
order by tablename;
