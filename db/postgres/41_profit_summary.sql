-- =========================================================================
-- KoshAgar ERP — 41_profit_summary.sql
--
-- REVENUE, COST AND PROFIT, ANSWERED BY THE DATABASE
--
-- The last of the figures the browser still works out for itself. 39 moved the
-- cash, 40 moved the position; this moves what the shop actually earned.
--
-- The cost side is the reason this belongs here more than anything else did.
-- Profit needs what each sale actually cost, which is a FIFO question - which
-- lots the goods came out of, at what price. The database already answered it
-- when the sale was posted and wrote the answer down (sale_lines.cogs_amount,
-- from stock_lot_consumption). The browser has been re-deriving that answer by
-- replaying every purchase and sale from the beginning of the shop's history,
-- in order, on every render. Two FIFO engines is one too many, and the one
-- that is not the database is the one that can be wrong without anyone knowing.
--
-- STOCK ADJUSTMENTS HAVE A DIRECTION — CORRECTED, IN BOTH PLACES AT ONCE
-- The first version of this file mirrored the app's rule, which added up every
-- adjustment except an opening balance and called the lot a loss - with no
-- sign. But the kinds are not alike (10_adjustments.sql): damage, theft and
-- correction_out CONSUME lots, while correction_in CREATES one, exactly as an
-- opening balance does. Counting stock that arrived as stock that was lost made
-- a shop poorer on paper for finding goods it already owned.
--
-- So the loss is now the outbound kinds less the inbound one:
--
--   loss = damage + theft + correction_out - correction_in
--
-- Netting rather than merely ignoring correction_in, because the two
-- corrections are one instrument: a stock count that comes out low is a cost
-- and one that comes out high is not a cost, and treating only the first would
-- report a business that can lose from counting but never gain from it.
--
-- 'opening' stays out of it entirely: that is stock the shop already had, not
-- stock it found.
--
-- calc/financial.js is changed in the same commit and by the same rule, because
-- correcting one calculator alone only makes the two disagree.
--
-- THE BILL DISCOUNT — CORRECTED, IN BOTH PLACES AT ONCE
-- The first version of this file mirrored a real error instead: revenue was the
-- sum of the LINE totals, and a discount given on the whole bill
-- (sales.bill_discount) reduced neither revenue nor profit. The cash and the
-- customer's balance were right; only what the shop appeared to have EARNED was
-- overstated, by exactly the discount. Give 100 off a 1,000 bill and the books
-- reported 1,000 of revenue against money that was never going to arrive.
--
-- A discount on a sale reduces revenue - it is not an expense, and it is not
-- nothing. So it is subtracted here, and in calc/financial.js in the same
-- change, because fixing one calculator alone would only make the two disagree.
--
-- It is returned as its own column rather than folded into the gross, so the
-- screens can show the subtraction instead of quietly reporting a smaller
-- number than the bills add up to.
-- =========================================================================

-- The signature gains bill_discount, and Postgres will not replace a function
-- with a different return type.
drop function if exists profit_summary(uuid, date, date);

create or replace function profit_summary(p_shop uuid, p_from date, p_to date)
returns table (
  gross_revenue        numeric,
  bill_discount        numeric,
  sale_return_revenue  numeric,
  net_revenue          numeric,
  gross_cost           numeric,
  sale_return_cost     numeric,
  net_cost             numeric,
  adjustment_loss      numeric,
  profit               numeric,
  margin_pct           numeric
) language sql stable set search_path = public as $$
  with rev as (
    select round(coalesce(sum(sl.line_total), 0), 2) as amt,
           round(coalesce(sum(sl.cogs_amount), 0), 2) as cost
      from sale_lines sl
      join sales s on s.id = sl.sale_id
     where s.shop_id = p_shop
       and s.status = 'posted'
       and s.business_date between p_from and p_to
  ),
  -- Once per BILL, not per line. It lives on the sale header, so summing it
  -- through the line join would multiply it by the number of items.
  disc as (
    select round(coalesce(sum(s.bill_discount), 0), 2) as amt
      from sales s
     where s.shop_id = p_shop
       and s.status = 'posted'
       and s.business_date between p_from and p_to
  ),
  ret as (
    -- Sale returns only. A purchase return is money and stock going back to a
    -- supplier; it has nothing to do with what was earned.
    select round(coalesce(sum(rl.line_total), 0), 2)  as amt,
           round(coalesce(sum(rl.cost_amount), 0), 2) as cost
      from return_lines rl
      join returns r on r.id = rl.return_id
     where r.shop_id = p_shop
       and r.kind = 'sale_return'
       and r.status = 'posted'
       and r.business_date between p_from and p_to
  ),
  adj as (
    -- Signed by direction: goods that left cost the shop, goods that arrived
    -- did not. 'opening' is excluded because an opening balance is stock the
    -- shop already had, not stock it found.
    select round(coalesce(sum(
             case when a.kind = 'correction_in' then -1 else 1 end
             * round(a.qty_base * a.unit_cost, 2)
           ), 0), 2) as amt
      from adjustments a
     where a.shop_id = p_shop
       and a.status = 'posted'
       and a.kind in ('damage', 'theft', 'correction_out', 'correction_in')
       and a.business_date between p_from and p_to
  )
  -- net revenue = what the bills came to, less what was discounted off them,
  -- less what came back.
  select rev.amt,
         disc.amt,
         ret.amt,
         round(rev.amt - disc.amt - ret.amt, 2),
         rev.cost,
         ret.cost,
         round(rev.cost - ret.cost, 2),
         adj.amt,
         round((rev.amt - disc.amt - ret.amt) - (rev.cost - ret.cost) - adj.amt, 2),
         case when rev.amt - disc.amt - ret.amt > 0
              then round(((rev.amt - disc.amt - ret.amt) - (rev.cost - ret.cost) - adj.amt)
                         / (rev.amt - disc.amt - ret.amt) * 100, 1)
              else 0 end
    from rev, disc, ret, adj;
$$;

comment on function profit_summary is
  'What the shop earned in a period: bills less discounts and returns, less the FIFO cost those sales consumed, less stock lost to damage and corrections.';

grant execute on function profit_summary(uuid, date, date) to authenticated;

select 'profit_summary() is ready' as note;
