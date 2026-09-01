-- =========================================================================
-- KoshAgar ERP — 99_smoke_test.sql
--
-- Run AFTER 01–06. Proves the schema actually works, not merely that it
-- loaded. Every check raises on failure, so a clean run means every assertion
-- passed.
--
-- Everything happens inside one transaction and is ROLLED BACK at the end.
-- Your database is left exactly as it was - nothing here persists.
--
-- Run it as a single batch in the Supabase SQL editor.
-- Expected final output:  SMOKE TEST PASSED
-- =========================================================================

begin;

-- -------------------------------------------------------------------------
-- Assertion helper (dropped by the rollback)
-- -------------------------------------------------------------------------
create or replace function assert_eq(p_actual numeric, p_expected numeric, p_label text)
returns void language plpgsql set search_path = public as $$
begin
  if p_actual is null or abs(p_actual - p_expected) > 0.005 then
    raise exception 'FAILED: % — expected %, got %', p_label, p_expected, coalesce(p_actual::text, 'NULL');
  end if;
  raise notice 'ok  %  = %', p_label, p_expected;
end $$;

do $test$
declare
  v_shop     uuid;
  v_piece    uuid;
  v_carton   uuid;
  v_prod     uuid;
  v_party    uuid;
  v_res      jsonb;
  v_res2     jsonb;
  v_qty      numeric;
  v_val      numeric;
  v_due      numeric;
  v_cash     numeric;
  v_count    int;
  v_caught   boolean;
begin
  -- =====================================================================
  -- SETUP
  -- =====================================================================
  insert into shops (name) values ('Smoke Test Shop')
  returning id into v_shop;

  perform seed_new_shop(v_shop);

  select id into v_piece  from units where shop_id = v_shop and name = 'PIECE';
  select id into v_carton from units where shop_id = v_shop and name = 'CARTON';

  insert into products (shop_id, name, base_unit_id)
  values (v_shop, 'Test Fan', v_piece)
  returning id into v_prod;

  -- 1 CARTON = 12 PIECE. Conversions are master data, so this must exist
  -- before anything can be bought or sold in cartons.
  insert into product_units (shop_id, product_id, unit_id, factor)
  values (v_shop, v_prod, v_carton, 12);

  insert into parties (shop_id, phone, name, kind)
  values (v_shop, '01712345678', 'Test Customer', 'both')
  returning id into v_party;

  raise notice '--- setup complete ---';

  -- =====================================================================
  -- 1. PURCHASE 100 @ 10  →  stock 100, value 1000
  -- =====================================================================
  v_res := post_purchase(v_shop, jsonb_build_object(
    'business_date', current_date, 'cash_paid', 1000,
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'unit_id', v_piece,
      'qty_entered', 100, 'unit_price', 10))));

  select qty into v_qty from v_stock_on_hand where product_id = v_prod;
  perform assert_eq(v_qty, 100, 'stock after purchase of 100');
  select value into v_val from v_stock_value where product_id = v_prod;
  perform assert_eq(v_val, 1000, 'stock value after purchase');

  -- =====================================================================
  -- 2. SELL 10 @ 15  →  stock 90, COGS 100, gross profit 50
  -- =====================================================================
  v_res := post_sale(v_shop, jsonb_build_object(
    'business_date', current_date, 'cash_paid', 150,
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'unit_id', v_piece,
      'qty_entered', 10, 'unit_price', 15))));

  perform assert_eq((v_res->>'net_total')::numeric,   150, 'sale net total');
  perform assert_eq((v_res->>'cogs')::numeric,        100, 'FIFO cost of 10 @ 10');
  perform assert_eq((v_res->>'gross_profit')::numeric, 50, 'gross profit');

  select qty into v_qty from v_stock_on_hand where product_id = v_prod;
  perform assert_eq(v_qty, 90, 'stock after selling 10');

  -- =====================================================================
  -- 3. SECOND PURCHASE AT A DIFFERENT PRICE, THEN A SALE THAT SPANS LOTS
  --    Buy 50 @ 12. Sell 100 → 90 from the first lot (900) + 10 from the
  --    second (120) = 1020. This is the check that FIFO is genuinely
  --    consuming oldest-first rather than averaging.
  -- =====================================================================
  v_res := post_purchase(v_shop, jsonb_build_object(
    'business_date', current_date, 'cash_paid', 600,
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'unit_id', v_piece,
      'qty_entered', 50, 'unit_price', 12))));

  select qty into v_qty from v_stock_on_hand where product_id = v_prod;
  perform assert_eq(v_qty, 140, 'stock after second purchase');

  v_res := post_sale(v_shop, jsonb_build_object(
    'business_date', current_date, 'cash_paid', 2000,
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'unit_id', v_piece,
      'qty_entered', 100, 'unit_price', 20))));

  perform assert_eq((v_res->>'cogs')::numeric, 1020, 'FIFO across two lots (90@10 + 10@12)');

  select qty into v_qty from v_stock_on_hand where product_id = v_prod;
  perform assert_eq(v_qty, 40, 'stock after selling 100');

  -- =====================================================================
  -- 4. UNIT CONVERSION — sell 1 CARTON, expect 12 PIECE to leave stock
  -- =====================================================================
  v_res := post_sale(v_shop, jsonb_build_object(
    'business_date', current_date, 'cash_paid', 300,
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'unit_id', v_carton,
      'qty_entered', 1, 'unit_price', 25))));

  select qty into v_qty from v_stock_on_hand where product_id = v_prod;
  perform assert_eq(v_qty, 28, 'stock after selling 1 CARTON (= 12 PIECE)');
  perform assert_eq((v_res->>'cogs')::numeric, 144, 'cost of 12 @ 12');

  -- =====================================================================
  -- 5. NEGATIVE STOCK MUST BE REFUSED  (your decision: block the sale)
  -- =====================================================================
  v_caught := false;
  begin
    perform post_sale(v_shop, jsonb_build_object(
      'business_date', current_date, 'cash_paid', 0,
      'lines', jsonb_build_array(jsonb_build_object(
        'product_id', v_prod, 'unit_id', v_piece,
        'qty_entered', 9999, 'unit_price', 20))));
  exception when others then
    if sqlerrm like 'INSUFFICIENT_STOCK%' then v_caught := true;
    else raise; end if;
  end;
  if not v_caught then
    raise exception 'FAILED: overselling was allowed — the stock guard did not fire';
  end if;
  raise notice 'ok  overselling refused';

  select qty into v_qty from v_stock_on_hand where product_id = v_prod;
  perform assert_eq(v_qty, 28, 'stock unchanged after the refused sale');

  -- =====================================================================
  -- 6. CREDIT SALE WITHOUT A CUSTOMER MUST BE REFUSED
  -- =====================================================================
  v_caught := false;
  begin
    perform post_sale(v_shop, jsonb_build_object(
      'business_date', current_date, 'cash_paid', 0,
      'lines', jsonb_build_array(jsonb_build_object(
        'product_id', v_prod, 'unit_id', v_piece,
        'qty_entered', 1, 'unit_price', 20))));
  exception when others then
    if sqlerrm like 'PARTY_REQUIRED%' then v_caught := true; else raise; end if;
  end;
  if not v_caught then
    raise exception 'FAILED: an unpaid sale was accepted with nobody owing it';
  end if;
  raise notice 'ok  anonymous credit sale refused';

  -- =====================================================================
  -- 7. CREDIT SALE + PAYMENT ALLOCATION
  --    Sell 10 @ 20 = 200 on credit, pay 120 → due 80.
  -- =====================================================================
  v_res := post_sale(v_shop, jsonb_build_object(
    'business_date', current_date, 'party_id', v_party, 'cash_paid', 0,
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'unit_id', v_piece,
      'qty_entered', 10, 'unit_price', 20))));

  select receivable into v_due from v_party_due where party_id = v_party;
  perform assert_eq(v_due, 200, 'customer due after credit sale');

  v_res2 := record_payment(v_shop, jsonb_build_object(
    'business_date', current_date, 'party_id', v_party,
    'direction', 'in', 'amount', 120));

  perform assert_eq((v_res2->>'allocated')::numeric,   120, 'payment allocated to the bill');
  perform assert_eq((v_res2->>'unallocated')::numeric,   0, 'nothing left over');

  select receivable into v_due from v_party_due where party_id = v_party;
  perform assert_eq(v_due, 80, 'customer due after partial payment');

  -- =====================================================================
  -- 8. OVERPAYMENT — paying 500 against an 80 balance leaves 420 as advance,
  --    and must never push the bill negative.
  -- =====================================================================
  v_res2 := record_payment(v_shop, jsonb_build_object(
    'business_date', current_date, 'party_id', v_party,
    'direction', 'in', 'amount', 500));

  perform assert_eq((v_res2->>'allocated')::numeric,    80, 'only the outstanding 80 is allocated');
  perform assert_eq((v_res2->>'unallocated')::numeric, 420, 'the rest is held as advance');

  select receivable into v_due from v_party_due where party_id = v_party;
  perform assert_eq(v_due, 0, 'customer due cleared, not negative');

  -- =====================================================================
  -- 9. IDEMPOTENCY — the same key twice must produce ONE sale
  -- =====================================================================
  v_res := post_sale(v_shop, jsonb_build_object(
    'idempotency_key', 'smoke-test-key-0001',
    'business_date', current_date, 'cash_paid', 40,
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'unit_id', v_piece,
      'qty_entered', 2, 'unit_price', 20))));

  v_res2 := post_sale(v_shop, jsonb_build_object(
    'idempotency_key', 'smoke-test-key-0001',
    'business_date', current_date, 'cash_paid', 40,
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'unit_id', v_piece,
      'qty_entered', 2, 'unit_price', 20))));

  if (v_res->>'sale_id') <> (v_res2->>'sale_id') then
    raise exception 'FAILED: the same idempotency key created two different sales';
  end if;
  raise notice 'ok  duplicate submission returned the original sale';

  -- =====================================================================
  -- 10. CLOSED MONTH MUST REJECT WRITES
  -- =====================================================================
  insert into accounting_periods (shop_id, period_month, status, closed_at, closed_by)
  values (v_shop, date_trunc('month', current_date)::date, 'closed', now(), null);

  v_caught := false;
  begin
    perform post_sale(v_shop, jsonb_build_object(
      'business_date', current_date, 'cash_paid', 20,
      'lines', jsonb_build_array(jsonb_build_object(
        'product_id', v_prod, 'unit_id', v_piece,
        'qty_entered', 1, 'unit_price', 20))));
  exception when others then
    if sqlerrm like 'PERIOD_CLOSED%' then v_caught := true; else raise; end if;
  end;
  if not v_caught then
    raise exception 'FAILED: a sale was posted into a closed month';
  end if;
  raise notice 'ok  closed month refused the write';

  delete from accounting_periods where shop_id = v_shop;

  -- =====================================================================
  -- 11. LEDGER AND LOTS MUST AGREE  (this should always be empty)
  -- =====================================================================
  select count(*) into v_count from v_stock_reconciliation where shop_id = v_shop;
  if v_count <> 0 then
    raise exception 'FAILED: stock ledger and FIFO lots disagree on % product(s)', v_count;
  end if;
  raise notice 'ok  ledger and lots reconcile';

  -- =====================================================================
  -- 12. CASH BALANCE IS EXPLAINED BY THE LEDGER
  --     in : 150 + 2000 + 300 + 120 + 500 + 40 = 3110
  --     out: 1000 + 600                        = 1600
  --     net: 1510
  -- =====================================================================
  select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)
    into v_cash from cash_ledger where shop_id = v_shop;
  perform assert_eq(v_cash, 1510, 'cash ledger net movement');

  -- =====================================================================
  -- 13. HISTORICAL SNAPSHOT — renaming the product must NOT alter past lines
  -- =====================================================================
  update products set name = 'Renamed Fan' where id = v_prod;

  select count(*) into v_count from sale_lines
   where shop_id = v_shop and product_name = 'Test Fan';
  if v_count = 0 then
    raise exception 'FAILED: renaming the product changed historical invoice lines';
  end if;
  raise notice 'ok  % past line(s) kept the original product name', v_count;

  -- =====================================================================
  -- 14. POSTED DOCUMENTS CANNOT BE DELETED
  -- =====================================================================
  v_caught := false;
  begin
    delete from sales where shop_id = v_shop;
  exception when others then
    if sqlerrm like 'DELETE_FORBIDDEN%' then v_caught := true; else raise; end if;
  end;
  if not v_caught then
    raise exception 'FAILED: a posted sale was deleted';
  end if;
  raise notice 'ok  deleting a posted sale refused';

  raise notice '';
  raise notice '=====================================';
  raise notice '        SMOKE TEST PASSED';
  raise notice '=====================================';
end $test$;

-- Supabase's SQL editor does not display RAISE NOTICE output, so a clean run
-- shows only "Success. No rows returned". This makes the result visible:
-- reaching it at all means every assertion above passed, because any failure
-- raises an exception and aborts the batch.
select 'SMOKE TEST PASSED' as result,
       28                  as assertions_checked,
       'nothing persisted - transaction rolled back' as note;

-- Nothing above is kept.
rollback;
