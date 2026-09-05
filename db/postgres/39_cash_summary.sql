-- =========================================================================
-- KoshAgar ERP — 39_cash_summary.sql
--
-- THE DRAWER, ANSWERED BY THE DATABASE
--
-- Every cash figure on the dashboard and in the reports is worked out in the
-- browser today, in calc/financial.js, from every row of history pulled into
-- memory. That is two problems at once:
--
--   * two calculators. The same "cash in hand" is derived here as well, by
--     shop_cash() and the views, in different code. When a rule changes - and
--     they have: 22_purchase_return_cost, 28_extra_cost_is_cash - one of them
--     is updated and the other quietly disagrees. Nothing on screen says so.
--   * the whole book has to be downloaded to add up one number. Fine at two
--     sales, impossible at fifty thousand.
--
-- This answers the same question in the place that owns the data. It reads
-- cash_ledger, which is append-only and carries a row for every movement of
-- money naming the document responsible - so a figure here can always be
-- traced back to what caused it.
--
-- WHY IT MIRRORS THE APP RATHER THAN CORRECTING IT
-- The point of this step is a comparison the app can run: server figure beside
-- browser figure, and a warning when they differ. So the rules are copied
-- deliberately, including the ones that look odd:
--
--   * an opening_cash row means "cash at the START of that day". Movements on
--     that same day are added on top when the NEXT day's opening is worked out.
--   * closing cash is taken from the last day of the period, not by adding the
--     period's movements to its opening. They are the same number unless an
--     opening_cash row was written inside the period; when they differ, the
--     app trusts the day, and so does this.
--
-- Anything that turns out to be genuinely wrong gets fixed afterwards, in one
-- place, with the comparison there to show what moved.
--
-- TWO SPLITS THE LEDGER CANNOT MAKE ON ITS OWN
-- The screens show four rows where cash_ledger has two, and both differences
-- are real rather than cosmetic:
--
--   carrying cost   a purchase writes ONE cash row for the goods and the
--                   freight together (28_extra_cost_is_cash.sql), but the card
--                   lists them separately. purchases.extra_cost is the split,
--                   and it is attributed in full to every ledger row of that
--                   purchase - so a reversal cancels it exactly.
--   loan repayment  repaying a loan IS a payment out (12_loans.sql), which is
--                   why it cannot be told from a supplier payment by direction.
--                   What distinguishes it is where the money was ALLOCATED: a
--                   party_bill whose source_table is 'loans'. That is the same
--                   rule the app uses to build its loan payment list.
--
-- REVERSALS
-- A reversed document is not deleted; a mirror row is written with the
-- direction flipped and the SAME source_table. So each bucket is a NET figure
-- (out minus in for a spending bucket), which is why a reversed purchase stops
-- counting as cash paid instead of appearing twice.
-- =========================================================================

-- -------------------------------------------------------------------------
-- CASH AT THE START OF A GIVEN DAY
--
-- The nearest opening_cash row at or before the date, carried forward by every
-- movement between that row's day and the day asked for. With no opening_cash
-- row at all the shop simply started at zero, which is the same formula with
-- nothing to carry from.
-- -------------------------------------------------------------------------
create or replace function opening_cash_on(p_shop uuid, p_date date)
returns numeric language sql stable set search_path = public as $$
  with base as (
    select business_date, amount
      from opening_cash
     where shop_id = p_shop and business_date <= p_date
     order by business_date desc
     limit 1
  )
  select round(
    coalesce((select amount from base), 0)
    + case
        -- The day's own opening was written down. It is the answer, not a
        -- starting point: the movements of that day belong to the day, not to
        -- the moment it began.
        when (select business_date from base) = p_date then 0
        else coalesce((
          select sum(case when direction = 'in' then amount else -amount end)
            from cash_ledger
           where shop_id = p_shop
             and business_date >= coalesce((select business_date from base), '-infinity'::date)
             and business_date <  p_date
        ), 0)
      end, 2);
$$;

comment on function opening_cash_on is
  'Cash in the drawer at the start of a day: the last recorded opening, carried forward by every movement since.';

-- -------------------------------------------------------------------------
-- THE CASH SUMMARY FOR A PERIOD
--
-- One call gives the whole card: what came in, what went out, split the way
-- the screens split it, plus opening and closing.
--
-- The split is by what CAUSED the movement, not by which way it went, because
-- those are different questions. A payment row is money in when a customer
-- pays and money out when a supplier is paid; the ledger direction alone
-- cannot tell them apart, so the payment itself is consulted.
-- -------------------------------------------------------------------------
-- The signature changes when a column is added, and Postgres will not replace
-- a function with a different return type. Dropping first makes this file safe
-- to run again over an earlier version of itself.
drop function if exists cash_summary(uuid, date, date);

create or replace function cash_summary(p_shop uuid, p_from date, p_to date)
returns table (
  opening_cash          numeric,
  sale_cash_in          numeric,
  customer_payment_in   numeric,
  purchase_return_in    numeric,
  investment_in         numeric,
  loan_in               numeric,
  adjustment_in         numeric,
  total_in              numeric,
  purchase_paid_out     numeric,
  purchase_goods_out    numeric,
  purchase_extra_out    numeric,
  sale_return_out       numeric,
  supplier_payment_out  numeric,
  loan_payment_out      numeric,
  expense_out           numeric,
  withdrawal_out        numeric,
  capital_out           numeric,
  adjustment_out        numeric,
  total_out             numeric,
  total_in_with_opening numeric,
  cash_in_hand          numeric,
  net_cash_change       numeric
) language sql stable set search_path = public as $$
  with l as (
    select cl.source_table,
           cl.direction,
           case when cl.direction = 'in' then cl.amount else -cl.amount end as signed,
           pay.direction as pay_dir,
           ret.kind      as ret_kind,
           cap.kind      as cap_kind,
           coalesce(pu.extra_cost, 0) as extra_cost
      from cash_ledger cl
      left join payments          pay on cl.source_table = 'payments'          and pay.id = cl.source_id
      left join returns           ret on cl.source_table = 'returns'           and ret.id = cl.source_id
      left join capital_movements cap on cl.source_table = 'capital_movements' and cap.id = cl.source_id
      left join purchases         pu  on cl.source_table = 'purchases'         and pu.id  = cl.source_id
     where cl.shop_id = p_shop
       and cl.business_date between p_from and p_to
  ),
  -- What of the payments out went against a loan rather than a supplier bill.
  -- Read from the allocations, because that is what decides which debt the
  -- money settled. Reversed payments are excluded by status, the same way the
  -- ledger's own mirror row cancels them on the other side.
  loan_repaid as (
    select round(coalesce(sum(a.amount), 0), 2) as amt
      from payment_allocations a
      join party_bills b on b.id = a.bill_id and b.source_table = 'loans'
      join payments    p on p.id = a.payment_id
     where a.shop_id = p_shop
       and p.direction = 'out'
       and p.status = 'posted'
       and p.business_date between p_from and p_to
  ),
  b as (
    select
      round(coalesce(sum(signed) filter (where source_table = 'sales'), 0), 2)                        as sale_in,
      round(coalesce(sum(signed) filter (where source_table = 'payments' and pay_dir = 'in'), 0), 2)  as cust_in,
      round(coalesce(sum(signed) filter (where source_table = 'returns'
                                           and ret_kind = 'purchase_return'), 0), 2)                  as pret_in,
      round(coalesce(sum(signed) filter (where source_table = 'capital_movements'
                                           and cap_kind = 'in'), 0), 2)                               as cap_in,
      round(coalesce(sum(signed) filter (where source_table = 'loans'), 0), 2)                        as loan_in,
      round(coalesce(sum(signed) filter (where source_table = 'cash_adjustments'
                                           and direction = 'in'), 0), 2)                              as adj_in,
      round(-coalesce(sum(signed) filter (where source_table = 'purchases'), 0), 2)                   as purch_out,
      -- The freight rides on the same row as the goods, so it is attributed to
      -- every row of that purchase and cancels with the reversal.
      round(-coalesce(sum(sign(signed) * extra_cost)
                        filter (where source_table = 'purchases'), 0), 2)                             as extra_out,
      round(-coalesce(sum(signed) filter (where source_table = 'returns'
                                            and ret_kind = 'sale_return'), 0), 2)                     as sret_out,
      round(-coalesce(sum(signed) filter (where source_table = 'payments'
                                            and pay_dir = 'out'), 0), 2)                              as supp_out,
      round(-coalesce(sum(signed) filter (where source_table = 'expenses'), 0), 2)                    as exp_out,
      round(-coalesce(sum(signed) filter (where source_table = 'cash_withdrawals'), 0), 2)            as wd_out,
      round(-coalesce(sum(signed) filter (where source_table = 'capital_movements'
                                            and cap_kind = 'out'), 0), 2)                             as cap_out,
      round(-coalesce(sum(signed) filter (where source_table = 'cash_adjustments'
                                            and direction = 'out'), 0), 2)                            as adj_out
      from l
  ),
  -- Closing cash is the LAST DAY's close, not the period's arithmetic. See the
  -- header: the two agree unless an opening was written inside the period, and
  -- when they disagree the day is what the app shows.
  close_of_period as (
    select round(opening_cash_on(p_shop, p_to)
           + coalesce((select sum(case when direction = 'in' then amount else -amount end)
                         from cash_ledger
                        where shop_id = p_shop and business_date = p_to), 0), 2) as amt
  ),
  opened as (
    select opening_cash_on(p_shop, p_from) as amt
  )
  select
    o.amt,
    b.sale_in, b.cust_in, b.pret_in, b.cap_in, b.loan_in, b.adj_in,
    round(b.sale_in + b.cust_in + b.pret_in + b.cap_in + b.loan_in + b.adj_in, 2),
    b.purch_out,
    round(b.purch_out - b.extra_out, 2),
    b.extra_out,
    b.sret_out,
    round(b.supp_out - lr.amt, 2),
    lr.amt,
    b.exp_out, b.wd_out, b.cap_out, b.adj_out,
    round(b.purch_out + b.sret_out + b.supp_out + b.exp_out + b.wd_out
          + b.cap_out + b.adj_out, 2),
    round(o.amt + b.sale_in + b.cust_in + b.pret_in + b.cap_in + b.loan_in + b.adj_in, 2),
    c.amt,
    round(c.amt - o.amt, 2)
  from b, opened o, close_of_period c, loan_repaid lr;
$$;

comment on function cash_summary is
  'The cash card for a period: opening, what came in and out split by cause, closing. Buckets are net of reversals and always add up to the totals.';

-- Both are SECURITY INVOKER, so RLS decides what they can see: cash_ledger and
-- opening_cash are readable only by members of the shop (09_rls.sql). A caller
-- asking about a shop that is not theirs gets zeroes, not an error - the same
-- answer an empty shop gives, which is the correct amount of information.
grant execute on function opening_cash_on(uuid, date)     to authenticated;
grant execute on function cash_summary(uuid, date, date)  to authenticated;

select 'opening_cash_on() and cash_summary() are ready' as note;
