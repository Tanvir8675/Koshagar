-- =========================================================================
-- KoshAgar ERP — 42_product_sales.sql
--
-- WHAT EACH PRODUCT SOLD, EARNED AND COST
--
-- The last of the numbers the browser derives for itself: the per-product and
-- per-category breakdowns, the fast/slow lists and the profitability table.
-- All of them are built from one small map - quantity, revenue and cost per
-- product for a period - so that map is what this returns. How it is sorted,
-- badged and grouped into categories stays in the app, because that is
-- presentation and it belongs where the screen is.
--
-- THE COST COLUMN IS THE REASON THIS BELONGS HERE
-- Same as 41: cost is the FIFO cost the sale actually consumed, which the
-- database worked out at posting time and stored on the line. The browser
-- re-derives it by replaying the shop's whole trading history.
--
-- THE BILL DISCOUNT IS SHARED OUT
-- A discount given on the whole bill belongs to the products on that bill -
-- otherwise the breakdown adds up to more than the revenue above it, and a
-- product looks more profitable than it was. It is split in proportion to what
-- each line contributed to the bill, and calc/financial.js splits it the same
-- way, by the same formula, so the two agree line for line.
--
-- Rounding is left where it falls rather than forced to reconcile: both sides
-- round each share the same way, so they always match each other. The cost is
-- that the shares can add up to a paisa less than the discount on a multi-line
-- bill. Preferring "the two calculators agree" over "the parts add to the whole
-- to the last paisa" is deliberate while there are still two calculators.
--
-- RETURNS COME OFF
-- A returned item subtracts its quantity, its revenue and the cost that came
-- back into stock - so a product returned in full reads as never sold rather
-- than as sold and separately refunded.
-- =========================================================================

create or replace function product_sales_summary(p_shop uuid, p_from date, p_to date)
returns table (
  product_id uuid,
  qty        numeric,
  revenue    numeric,
  cost       numeric
) language sql stable set search_path = public as $$
  with bill as (
    select s.id,
           s.bill_discount,
           (select coalesce(sum(l.line_total), 0) from sale_lines l where l.sale_id = s.id) as line_sum
      from sales s
     where s.shop_id = p_shop
       and s.status = 'posted'
       and s.business_date between p_from and p_to
  ),
  sold as (
    select sl.product_id,
           sum(sl.qty_base) as qty,
           sum(sl.line_total
               - case when b.line_sum > 0 and b.bill_discount > 0
                      then round(b.bill_discount * sl.line_total / b.line_sum, 2)
                      else 0 end) as revenue,
           sum(sl.cogs_amount) as cost
      from sale_lines sl
      join bill b on b.id = sl.sale_id
     group by sl.product_id
  ),
  returned as (
    select rl.product_id,
           sum(rl.qty_base)   as qty,
           sum(rl.line_total) as revenue,
           sum(rl.cost_amount) as cost
      from return_lines rl
      join returns r on r.id = rl.return_id
     where r.shop_id = p_shop
       and r.kind = 'sale_return'
       and r.status = 'posted'
       and r.business_date between p_from and p_to
     group by rl.product_id
  )
  -- A full outer join, because a product can be returned in a period it was not
  -- sold in - the sale was last month and the customer brought it back this one.
  -- Dropping those rows would quietly hide a refund.
  select coalesce(s.product_id, x.product_id),
         round(coalesce(s.qty, 0)     - coalesce(x.qty, 0), 3),
         round(coalesce(s.revenue, 0) - coalesce(x.revenue, 0), 2),
         round(coalesce(s.cost, 0)    - coalesce(x.cost, 0), 2)
    from sold s
    full outer join returned x on x.product_id = s.product_id;
$$;

comment on function product_sales_summary is
  'Per product for a period: quantity sold net of returns, revenue after its share of any bill discount, and the FIFO cost those sales consumed.';

grant execute on function product_sales_summary(uuid, date, date) to authenticated;

select 'product_sales_summary() is ready' as note;
