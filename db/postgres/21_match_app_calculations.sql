-- =========================================================================
-- KoshAgar ERP — 21_match_app_calculations.sql
--
-- Aligns the views with calc/financial.js, read line by line rather than
-- inferred from the table shapes.
--
-- WHAT MATCHED ALREADY
--   netRevenue        gross sales - sale returns          v_monthly_trading
--   COGS              saleCostTotal uses the stored exact
--                     costTotal, which is cogs_amount     sale_lines
--   customer due      max(0, total - paid - payments)     v_party_due filters
--                     per credit, never negative          balance > 0
--   supplier due      same shape                          same
--   cash anchor       getOpeningAnchorDate - everything
--                     before it is already in the opening
--                     figure                              cash_balance_as_of
--   opening purchases excluded from purchase totals       they are adjustments
--
-- WHAT DID NOT
--   PROFIT. financial.js line 136:
--     profit = netRevenue - netCost - adjustmentLossTotal
--   Damage, theft and correction write-offs reduce profit. v_monthly_trading
--   stopped at revenue - COGS, so every month's profit was overstated by
--   whatever was written off in it. Fixed below.
-- =========================================================================

create or replace view v_adjustment_losses as
select shop_id,
       date_trunc('month', business_date)::date as month,
       -- The app prefers the stored total and falls back to cost x qty. Here
       -- the amount is always recorded, so no fallback is needed.
       sum(round(qty_base * unit_cost, 2)) as loss
from adjustments
where status = 'posted'
  and kind in ('damage', 'theft', 'correction_out')
group by 1, 2;

comment on view v_adjustment_losses is
  'Stock written off. Reduces profit, matching adjustmentLossTotal in calc/financial.js - opening and correction_in are stock coming IN and are not losses.';

drop view if exists v_monthly_trading;
create view v_monthly_trading as
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
  select shop_id, month from sales_m
  union select shop_id, month from returns_m
  union select shop_id, month from purchases_m
  union select shop_id, month from expenses_m
  union select shop_id, month from v_adjustment_losses
)
select sp.shop_id,
       sp.month,
       coalesce(s.revenue, 0)                                  as gross_revenue,
       coalesce(r.sale_returns, 0)                             as sale_returns,
       coalesce(s.revenue, 0) - coalesce(r.sale_returns, 0)    as net_revenue,
       coalesce(s.cogs, 0) - coalesce(r.sale_return_cost, 0)   as cogs,
       coalesce(a.loss, 0)                                     as adjustment_loss,
       -- financial.js line 136, exactly.
       (coalesce(s.revenue, 0) - coalesce(r.sale_returns, 0))
         - (coalesce(s.cogs, 0) - coalesce(r.sale_return_cost, 0))
         - coalesce(a.loss, 0)                                 as gross_profit,
       coalesce(e.expenses, 0)                                 as expenses,
       (coalesce(s.revenue, 0) - coalesce(r.sale_returns, 0))
         - (coalesce(s.cogs, 0) - coalesce(r.sale_return_cost, 0))
         - coalesce(a.loss, 0) - coalesce(e.expenses, 0)       as net_profit,
       coalesce(p.purchases, 0) - coalesce(r.purchase_returns, 0) as net_purchases,
       coalesce(s.sale_count, 0)                               as sale_count
from spine sp
left join sales_m             s on s.shop_id = sp.shop_id and s.month = sp.month
left join returns_m           r on r.shop_id = sp.shop_id and r.month = sp.month
left join purchases_m         p on p.shop_id = sp.shop_id and p.month = sp.month
left join expenses_m          e on e.shop_id = sp.shop_id and e.month = sp.month
left join v_adjustment_losses a on a.shop_id = sp.shop_id and a.month = sp.month;

alter view v_monthly_trading   set (security_invoker = true);
alter view v_adjustment_losses set (security_invoker = true);
grant select on v_monthly_trading, v_adjustment_losses to authenticated, service_role;

select 'profit now matches financial.js line 136' as note;
