-- =========================================================================
-- inspect_due_mismatch.sql — why the app and the server disagree
--
-- Database Health Check reported, for shop 922a15a7:
--
--     DIFF Supplier due    App 150      / Server 5,300   (off by -5,150)
--     DIFF Cash in hand    App 7,680    / Server 7,480   (off by 200)
--
-- The app shows ONE payable bill for "Test" with 150 outstanding. The server
-- says 5,300 is owed. 5,300 = 150 + 5,150, and 5,150 is exactly what that bill
-- owed before the 5,000 payment - so the most likely story is a SECOND open
-- bill the app is not showing, not a wrong figure on either side.
--
-- These four queries say which it is. Run them in the Supabase SQL Editor and
-- read them in order; each one narrows the last.
-- =========================================================================

\set shop '922a15a7-9abd-4ae7-868f-b684e696b519'

-- -------------------------------------------------------------------------
-- 1. EVERY open bill and what is still owed on it.
--
-- This is the exact figure v_due_totals adds up, one row per bill. If two rows
-- point at the same source_id, the same purchase raised the debt twice - and
-- the second one is the 5,150.
-- -------------------------------------------------------------------------
select p.name              as party,
       b.direction,
       b.source_table,
       b.source_id,
       b.business_date,
       b.amount            as raised,
       bb.allocated        as paid_by_payments,
       bb.balance          as still_owed,
       b.status
from v_bill_balances bb
join party_bills b on b.id = bb.bill_id
join parties     p on p.id = b.party_id
where bb.shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519'
order by b.business_date, b.created_at;

-- -------------------------------------------------------------------------
-- 2. Is the source document still posted?
--
-- A reversed purchase must take its payable with it (reverse_purchase sets the
-- bill to 'reversed'). A row here where the purchase says 'reversed' but the
-- bill says 'open' is a leak, and it would explain the whole 5,150.
-- -------------------------------------------------------------------------
select b.id as bill_id, b.amount, b.status as bill_status,
       pu.bill_no, pu.status as purchase_status
from party_bills b
left join purchases pu on pu.id = b.source_id and b.source_table = 'purchases'
where b.shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519'
order by b.created_at;

-- -------------------------------------------------------------------------
-- 3. Every payment and where it landed.
--
-- A payment whose allocation is missing settles nothing on the server, even
-- though the app shows it under the bill. Note that a REVERSED payment keeps
-- its allocation rows - the balance views ignore them, so a reversed payment
-- here with allocations is expected, not a fault.
-- -------------------------------------------------------------------------
select pm.payment_no, pm.direction, pm.status, pm.amount as payment_amount,
       pm.business_date, a.bill_id, a.amount as allocated_to_that_bill
from payments pm
left join payment_allocations a on a.payment_id = pm.id
where pm.shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519'
order by pm.occurred_at, a.id;

-- -------------------------------------------------------------------------
-- 4. The 200 of cash. Every row that moved the drawer, newest last.
--
-- shop_cash() adds these to the opening balance. Compare the total against the
-- app's 7,680: an extra or missing 200 will be one identifiable row, and its
-- source_table names which entry produced it.
-- -------------------------------------------------------------------------
select business_date, direction, amount, source_table, source_id, note
from cash_ledger
where shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519'
order by occurred_at, id;

select * from shop_cash('922a15a7-9abd-4ae7-868f-b684e696b519');

-- =========================================================================
-- 5. THE PURCHASE ITSELF — added after reading queries 1-4.
--
-- What they showed:
--   * one open payable bill, raised 10,300.00, 5,000 allocated, 5,300 owed
--   * one payment, posted, allocated correctly - so payments are NOT the fault
--   * cash: 32,000 in, 24,520 out, 7,480 in hand (opening 0)
--
-- The app's Credit screen shows the same bill as total 12,350 with 7,200 paid
-- at the counter, which means it believes 5,150 was raised - exactly half of
-- 10,300. A bill is raised as (goods - cash paid), and goods is the sum of
-- line_total, which the database GENERATES as qty_base x unit_price. So if the
-- app sent a unit_price that was already multiplied by the unit conversion
-- factor, every converted line is stored factor times too big, and so is the
-- debt. These rows say whether that is what happened.
--
-- Read entry_factor first. Where it is 1, qty_base = qty_entered and nothing
-- can have scaled. Where it is not 1, check whether
--     line_total = qty_base x unit_price
-- is the money you actually meant to record for that line.
-- =========================================================================
select pu.bill_no, pu.business_date, pu.status,
       pu.bill_discount, pu.extra_cost,
       l.line_no, l.product_name, l.unit_name,
       l.entry_factor, l.qty_entered, l.qty_base,
       l.unit_price, l.line_discount, l.line_total,
       l.landed_unit_cost
from purchases pu
join purchase_lines l on l.purchase_id = pu.id
where pu.shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519'
order by pu.business_date, pu.bill_no, l.line_no;

-- The same for sales, since the bill screen posts both through one code path.
select s.invoice_no, s.business_date, s.status, s.bill_discount,
       l.line_no, l.product_name, l.unit_name,
       l.entry_factor, l.qty_entered, l.qty_base,
       l.unit_price, l.line_discount, l.line_total
from sales s
join sale_lines l on l.sale_id = s.id
where s.shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519'
order by s.business_date, s.invoice_no, l.line_no;
