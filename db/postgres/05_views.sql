-- =========================================================================
-- KoshAgar ERP — 05_views.sql
--
-- The source-of-truth map, made executable.
--
-- Every business value the app displays is defined exactly once, here, and
-- derived from the transactional tables. Nothing below is stored. If a report
-- and a dashboard ever disagree it is because one of them stopped reading
-- these views - not because two copies of the truth drifted apart.
--
-- The single exception remains sale_lines.cogs_amount, frozen at posting so
-- that a backdated purchase cannot rewrite reported profit.
-- =========================================================================

-- =========================================================================
-- STOCK — from the ledger, and only from the ledger
-- =========================================================================
create or replace view v_stock_on_hand as
select shop_id,
       product_id,
       sum(qty_delta) as qty
from inventory_movements
group by shop_id, product_id;

comment on view v_stock_on_hand is
  'Authoritative current stock. Answering "why is this 42?" means selecting the movements for that product and reading the reasons.';

-- Stock value comes from the lots still on hand, at the cost they were
-- received at - never at today's purchase price, which would silently
-- revalue inventory every time a supplier changed their prices.
create or replace view v_stock_value as
select shop_id,
       product_id,
       sum(qty_remaining)             as qty_in_lots,
       sum(round(qty_remaining * unit_cost, 2)) as value
from stock_lots
where qty_remaining > 0
group by shop_id, product_id;

-- Convenience view for the stock screen.
create or replace view v_product_stock as
select p.shop_id,
       p.id                              as product_id,
       p.name                            as product_name,
       p.category,
       u.name                            as base_unit,
       p.is_active,
       coalesce(s.qty, 0)                as qty,
       coalesce(v.value, 0)              as stock_value,
       case when coalesce(s.qty, 0) > 0
            then round(coalesce(v.value, 0) / s.qty, 4) end as avg_unit_cost
from products p
join units u          on u.id = p.base_unit_id
left join v_stock_on_hand s on s.product_id = p.id
left join v_stock_value  v  on v.product_id = p.id;

-- Self-audit. The ledger and the lots are maintained together inside one
-- transaction, so these two must agree; a non-empty result means something
-- wrote to one without the other and needs investigating.
create or replace view v_stock_reconciliation as
select coalesce(s.shop_id, v.shop_id)       as shop_id,
       coalesce(s.product_id, v.product_id) as product_id,
       coalesce(s.qty, 0)                   as ledger_qty,
       coalesce(v.qty_in_lots, 0)           as lot_qty,
       coalesce(s.qty, 0) - coalesce(v.qty_in_lots, 0) as difference
from v_stock_on_hand s
full outer join v_stock_value v
  on v.shop_id = s.shop_id and v.product_id = s.product_id
where abs(coalesce(s.qty, 0) - coalesce(v.qty_in_lots, 0)) > 0.001;

comment on view v_stock_reconciliation is
  'Should always be empty. Worth checking after any import or migration.';

-- =========================================================================
-- SALES AND PROFIT
-- =========================================================================
create or replace view v_sale_totals as
select s.id            as sale_id,
       s.shop_id,
       s.business_date,
       s.party_id,
       s.invoice_no,
       s.status,
       coalesce(sum(l.line_total), 0)                      as gross_total,
       s.bill_discount,
       coalesce(sum(l.line_total), 0) - s.bill_discount    as net_total,
       coalesce(sum(l.cogs_amount), 0)                     as cogs
from sales s
left join sale_lines l on l.sale_id = s.id
group by s.id, s.shop_id, s.business_date, s.party_id,
         s.invoice_no, s.status, s.bill_discount;

create or replace view v_purchase_totals as
select p.id            as purchase_id,
       p.shop_id,
       p.business_date,
       p.party_id,
       p.bill_no,
       p.status,
       coalesce(sum(l.line_total), 0)                                       as gross_total,
       p.bill_discount,
       p.extra_cost,
       coalesce(sum(l.line_total), 0) - p.bill_discount + p.extra_cost      as net_total
from purchases p
left join purchase_lines l on l.purchase_id = p.id
group by p.id, p.shop_id, p.business_date, p.party_id,
         p.bill_no, p.status, p.bill_discount, p.extra_cost;

-- Returns netted off, so revenue and cost both reflect goods that came back.
create or replace view v_return_totals as
select r.id            as return_id,
       r.shop_id,
       r.kind,
       r.business_date,
       r.status,
       coalesce(sum(rl.line_total), 0)  as return_total,
       coalesce(sum(rl.cost_amount), 0) as return_cost
from returns r
left join return_lines rl on rl.return_id = r.id
group by r.id, r.shop_id, r.kind, r.business_date, r.status;

-- Monthly trading summary. Gross profit uses the COGS frozen on each sale
-- line, so last month's figure is the same today as it was last month.
create or replace view v_monthly_trading as
with sales_m as (
  select shop_id, date_trunc('month', business_date)::date as month,
         sum(net_total) as revenue, sum(cogs) as cogs, count(*) as sale_count
  from v_sale_totals where status = 'posted' group by 1, 2
),
returns_m as (
  select shop_id, date_trunc('month', business_date)::date as month,
         sum(return_total) filter (where kind = 'sale_return')     as sale_returns,
         sum(return_cost)  filter (where kind = 'sale_return')     as sale_return_cost,
         sum(return_total) filter (where kind = 'purchase_return') as purchase_returns
  from v_return_totals where status = 'posted' group by 1, 2
),
purchases_m as (
  select shop_id, date_trunc('month', business_date)::date as month,
         sum(net_total) as purchases
  from v_purchase_totals where status = 'posted' group by 1, 2
),
expenses_m as (
  select shop_id, date_trunc('month', business_date)::date as month,
         sum(amount) as expenses
  from expenses where status = 'posted' group by 1, 2
),
spine as (
  -- every (shop, month) that has any activity at all, exactly once
  select shop_id, month from sales_m
  union select shop_id, month from returns_m
  union select shop_id, month from purchases_m
  union select shop_id, month from expenses_m
)
select sp.shop_id,
       sp.month,
       coalesce(s.revenue, 0)                                  as gross_revenue,
       coalesce(r.sale_returns, 0)                             as sale_returns,
       coalesce(s.revenue, 0) - coalesce(r.sale_returns, 0)    as net_revenue,
       coalesce(s.cogs, 0) - coalesce(r.sale_return_cost, 0)   as cogs,
       (coalesce(s.revenue, 0) - coalesce(r.sale_returns, 0))
         - (coalesce(s.cogs, 0) - coalesce(r.sale_return_cost, 0)) as gross_profit,
       coalesce(e.expenses, 0)                                 as expenses,
       (coalesce(s.revenue, 0) - coalesce(r.sale_returns, 0))
         - (coalesce(s.cogs, 0) - coalesce(r.sale_return_cost, 0))
         - coalesce(e.expenses, 0)                             as net_profit,
       coalesce(p.purchases, 0) - coalesce(r.purchase_returns, 0) as net_purchases,
       coalesce(s.sale_count, 0)                               as sale_count
from spine sp
left join sales_m     s on s.shop_id = sp.shop_id and s.month = sp.month
left join returns_m   r on r.shop_id = sp.shop_id and r.month = sp.month
left join purchases_m p on p.shop_id = sp.shop_id and p.month = sp.month
left join expenses_m  e on e.shop_id = sp.shop_id and e.month = sp.month;

-- =========================================================================
-- RECEIVABLES AND PAYABLES
-- =========================================================================
create or replace view v_bill_balances as
select b.id            as bill_id,
       b.shop_id,
       b.party_id,
       b.direction,
       b.business_date,
       b.amount,
       coalesce(a.allocated, 0)            as allocated,
       b.amount - coalesce(a.allocated, 0) as balance
from party_bills b
left join (
  select al.bill_id, sum(al.amount) as allocated
  from payment_allocations al
  join payments p on p.id = al.payment_id and p.status = 'posted'
  group by al.bill_id
) a on a.bill_id = b.id
where b.status = 'open';

create or replace view v_party_due as
with bill_agg as (
  -- one row per party: bills aggregated first, so joining advances below
  -- cannot multiply these sums
  select party_id,
         sum(balance) filter (where direction = 'receivable') as receivable,
         sum(balance) filter (where direction = 'payable')    as payable
  from v_bill_balances
  where balance > 0
  group by party_id
),
advance_agg as (
  -- one row per party: unallocated money summed per payment, then per party
  select party_id, sum(unallocated) as advance
  from (
    select p.id, p.party_id,
           p.amount - coalesce(sum(a.amount), 0) as unallocated
    from payments p
    left join payment_allocations a on a.payment_id = p.id
    where p.status = 'posted'
    group by p.id, p.party_id, p.amount
  ) per_payment
  where unallocated > 0
  group by party_id
)
select pt.shop_id,
       pt.id    as party_id,
       pt.name,
       pt.phone,
       pt.kind,
       coalesce(b.receivable, 0) as receivable,
       coalesce(b.payable, 0)    as payable,
       coalesce(v.advance, 0)    as advance
from parties pt
left join bill_agg    b on b.party_id = pt.id
left join advance_agg v on v.party_id = pt.id;

comment on view v_party_due is
  'receivable = what the customer owes you, payable = what you owe the supplier, advance = money received against no bill yet.';

create or replace view v_due_totals as
select shop_id,
       sum(receivable) as total_receivable,
       sum(payable)    as total_payable
from v_party_due
group by shop_id;

-- =========================================================================
-- CASH
-- =========================================================================
create or replace view v_cash_daily as
select shop_id,
       cash_account_id,
       business_date,
       sum(amount) filter (where direction = 'in')  as cash_in,
       sum(amount) filter (where direction = 'out') as cash_out,
       coalesce(sum(amount) filter (where direction = 'in'), 0)
         - coalesce(sum(amount) filter (where direction = 'out'), 0) as net_movement
from cash_ledger
group by shop_id, cash_account_id, business_date;

-- Balance at the end of a given day: start from the most recent explicit
-- opening figure on or before that day, then apply every movement since.
-- Written as a function because it takes a date; the view below covers "now".
create or replace function cash_balance_as_of(
  p_shop uuid, p_account uuid, p_date date
) returns numeric language sql stable set search_path = public as $$
  with anchor as (
    select business_date, amount
    from opening_cash
    where shop_id = p_shop and cash_account_id = p_account and business_date <= p_date
    order by business_date desc
    limit 1
  )
  select coalesce((select amount from anchor), 0)
       + coalesce((
           select sum(case when direction = 'in' then amount else -amount end)
           from cash_ledger
           where shop_id = p_shop
             and cash_account_id = p_account
             and business_date >= coalesce((select business_date from anchor), '0001-01-01'::date)
             and business_date <= p_date
         ), 0);
$$;

comment on function cash_balance_as_of is
  'Anchors on the last opening figure you entered, so a manually counted drawer becomes the new starting point rather than being overridden by history.';

create or replace view v_cash_balance as
select a.shop_id,
       a.id   as cash_account_id,
       a.name as account_name,
       cash_balance_as_of(a.shop_id, a.id, current_date) as balance
from cash_accounts a
where a.is_active;

-- =========================================================================
-- BUSINESS WORTH
--
-- The figure your reports already show: cash + stock + what you are owed,
-- less what you owe. Every input is one of the views above, so it cannot
-- disagree with the screens those views feed.
-- =========================================================================
create or replace view v_business_worth as
select s.id as shop_id,
       coalesce((select sum(balance) from v_cash_balance c where c.shop_id = s.id), 0)      as cash,
       coalesce((select sum(value)   from v_stock_value v where v.shop_id = s.id), 0)       as stock_value,
       coalesce((select total_receivable from v_due_totals d where d.shop_id = s.id), 0)    as receivable,
       coalesce((select total_payable    from v_due_totals d where d.shop_id = s.id), 0)    as payable,
       coalesce((select sum(balance) from v_cash_balance c where c.shop_id = s.id), 0)
       + coalesce((select sum(value) from v_stock_value v where v.shop_id = s.id), 0)
       + coalesce((select total_receivable from v_due_totals d where d.shop_id = s.id), 0)
       - coalesce((select total_payable    from v_due_totals d where d.shop_id = s.id), 0)  as business_worth
from shops s;

-- =========================================================================
-- FIFO EXPLAINABILITY
--
-- Point at a sale line and see exactly which lots produced its cost. This is
-- what makes the frozen cogs_amount auditable rather than merely asserted.
-- =========================================================================
create or replace view v_sale_line_costing as
select sl.id             as sale_line_id,
       sl.shop_id,
       sl.sale_id,
       sl.product_name,
       sl.qty_base,
       sl.cogs_amount,
       c.lot_id,
       lot.business_date as lot_received_on,
       c.qty             as qty_from_lot,
       c.unit_cost,
       c.amount
from sale_lines sl
left join stock_lot_consumption c
       on c.consumer_table = 'sale_lines' and c.consumer_id = sl.id
left join stock_lots lot on lot.id = c.lot_id;
