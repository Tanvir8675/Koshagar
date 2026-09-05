-- =========================================================================
-- verify_app_writes.sql - see for yourself that the app is writing to
-- Postgres, and that the figures on screen come from these rows.
--
-- Paste one block at a time into the Supabase SQL Editor. Nothing has to be
-- filled in: every block below names your shop directly.
--
--     71d95264-4f4a-487f-9257-2425d1c370ca
--
-- Run block 1 first to confirm that is still the shop the app has open. A reset
-- opens a NEW set of books with a new id, so after one of those, replace the id
-- everywhere below with the one block 1 shows as ACTIVE.
--
-- NOTE ON auth.uid(): the SQL Editor connects as the database owner, not as
-- your signed-in user, so auth.uid() is null here and the RLS policies do not
-- apply. That is why these queries name the shop explicitly rather than asking
-- "which shops are mine" - in this window, all of them are.
--
-- WHAT THIS CAN AND CANNOT SHOW
-- The app WRITES here and READS here - blocks 1 to 5 prove both.
--
-- The calculating is split, and block 6 is where you see the split:
--   * the database works out and STORES cost of goods sold, each line's total,
--     landed cost, the stock lots and the cash ledger. The app only reads them.
--   * the app works out the day's totals - revenue, profit, cash in hand,
--     who owes what - from those rows, in the browser.
--   * the database ALSO knows those totals, in the views block 6 runs.
--
-- So block 6 is the real test: if those numbers match your dashboard, the two
-- calculations agree. If they do not, one of them is wrong - and that is
-- exactly what Settings > Database Health Check exists to tell you.
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1. WHICH BOOKS AM I LOOKING AT
--
-- The row marked active is the one every block below uses.
-- -------------------------------------------------------------------------
select s.id,
       s.name,
       case when s.is_archived then 'archived (read only)' else 'ACTIVE' end as status,
       s.created_at,
       (select count(*) from products  x where x.shop_id = s.id) as products,
       (select count(*) from sales     x where x.shop_id = s.id) as sales,
       (select count(*) from purchases x where x.shop_id = s.id) as purchases
from shops s
order by s.is_archived, s.created_at desc;


-- -------------------------------------------------------------------------
-- 2. THE PRODUCTS YOU ADDED
--
-- If a product you added in Product Setup is here, the app wrote it here.
-- -------------------------------------------------------------------------
select p.name, u.name as unit, p.category, p.is_active, p.created_at
from products p
join units u on u.id = p.base_unit_id
where p.shop_id = '71d95264-4f4a-487f-9257-2425d1c370ca'
order by p.created_at;


-- -------------------------------------------------------------------------
-- 3. WHAT YOU BOUGHT AND SOLD
--
-- line_total is a GENERATED column - the database computes qty x price minus
-- the discount itself and will not accept a value for it, so that number
-- cannot have come from the app.
--
-- cogs on a sale line is the FIFO cost the sale actually consumed, worked out
-- by post_sale at the moment it was posted. The app reads it and never
-- recalculates it, which is why the profit on an old sale never moves.
-- -------------------------------------------------------------------------
select 'PURCHASE' as kind, pu.bill_no as doc_no, pu.business_date,
       l.product_name, l.qty_base, l.unit_price, l.line_total,
       l.landed_unit_cost as cost_with_freight, null::numeric as cogs
from purchases pu
join purchase_lines l on l.purchase_id = pu.id
where pu.shop_id = '71d95264-4f4a-487f-9257-2425d1c370ca'
  and pu.status = 'posted'
union all
select 'SALE', s.invoice_no, s.business_date,
       l.product_name, l.qty_base, l.unit_price, l.line_total,
       null, l.cogs_amount
from sales s
join sale_lines l on l.sale_id = s.id
where s.shop_id = '71d95264-4f4a-487f-9257-2425d1c370ca'
  and s.status = 'posted'
order by business_date, doc_no;


-- -------------------------------------------------------------------------
-- 4. EVERY TAKA THAT MOVED
--
-- The app does not write this table. Each posting function writes its own cash
-- row inside the same transaction as the document, so the drawer and the books
-- cannot disagree about whether something happened.
-- -------------------------------------------------------------------------
select business_date, direction, amount, source_table, note
from cash_ledger
where shop_id = '71d95264-4f4a-487f-9257-2425d1c370ca'
order by occurred_at;


-- -------------------------------------------------------------------------
-- 5. WHO OWES WHAT
--
-- `raised` is what was owed when the bill was made, `paid_by_payments` is what
-- has been settled since, `still_owed` is the difference. Compare still_owed
-- with the Credit page.
-- -------------------------------------------------------------------------
select pt.name as party,
       b.direction,          -- receivable = they owe you, payable = you owe them
       b.source_table,
       b.business_date,
       b.amount     as raised,
       bb.allocated as paid_by_payments,
       bb.balance   as still_owed
from v_bill_balances bb
join party_bills b  on b.id = bb.bill_id
join parties     pt on pt.id = b.party_id
where bb.shop_id = '71d95264-4f4a-487f-9257-2425d1c370ca'
order by b.business_date;


-- -------------------------------------------------------------------------
-- 6. THE DATABASE'S OWN TOTALS - compare these with the app
--
-- Every figure here is worked out by Postgres from the rows above. Open the
-- app beside this and read them off the screens named in the last column.
--
-- If a line does not match, the app and the database disagree, and
-- Settings > Database Health Check will name the same gap.
-- -------------------------------------------------------------------------
with shop as (
  select '71d95264-4f4a-487f-9257-2425d1c370ca'::uuid as id
)
select 'Cash in hand' as figure,
       (select cash_in_hand from shop_cash((select id from shop)))                              as database_says,
       'Dashboard, "Cash in Hand (Expected)"'                                                   as where_on_screen
union all
select 'Stock value',
       (select coalesce(sum(stock_value), 0) from v_product_stock where shop_id = (select id from shop)),
       'Reports > Ledger, "Stock Value"'
union all
select 'Customers owe you',
       (select coalesce(total_receivable, 0) from v_due_totals where shop_id = (select id from shop)),
       'Credit page, "Total Customer Due"'
union all
select 'You owe suppliers',
       (select coalesce(total_payable, 0) from v_due_totals where shop_id = (select id from shop)),
       'Credit page, "Total Supplier Due" (loans are counted here too)'
union all
select 'Business worth',
       (select cash + stock_value + receivable - payable from v_business_worth where shop_id = (select id from shop)),
       'Reports > Ledger, "Business Worth"';


-- -------------------------------------------------------------------------
-- 7. PROFIT, THE DATABASE'S ANSWER
--
-- Revenue less the FIFO cost each sale actually consumed, by month. The same
-- arithmetic the Reports page does in the browser, done here instead.
-- -------------------------------------------------------------------------
select to_char(month, 'YYYY-MM') as month,
       net_revenue, cogs, gross_profit
from v_monthly_trading
where shop_id = '71d95264-4f4a-487f-9257-2425d1c370ca'
order by month;


-- -------------------------------------------------------------------------
-- 8. THE TRAIL
--
-- Every posting function writes here, and nothing can update or delete a row -
-- no policy allows it. This is the database's record of what the app did,
-- rather than the browser's claim about it.
-- -------------------------------------------------------------------------
select occurred_at, action, entity_table, new_value
from audit_log
where shop_id = '71d95264-4f4a-487f-9257-2425d1c370ca'
order by occurred_at desc
limit 40;
