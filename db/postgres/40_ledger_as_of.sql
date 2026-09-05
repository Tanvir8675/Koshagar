-- =========================================================================
-- KoshAgar ERP — 40_ledger_as_of.sql
--
-- THE LEDGER CARD, ANSWERED BY THE DATABASE
--
-- 39_cash_summary.sql moved the drawer. This moves the rest of the Ledger tab:
-- stock value, what customers owe, what the shop owes, and the business worth
-- built from those three plus cash.
--
-- WHY NOT JUST USE THE VIEWS THAT EXIST
-- v_stock_value, v_due_totals and v_business_worth answer "right now". The
-- Ledger asks "as of the selected date" - the whole point of choosing a month
-- is seeing where the shop stood at its end, not where it stands today. A view
-- of current balances cannot answer that, so these functions rebuild the
-- position from the documents up to a date, exactly as the app does in the
-- browser today.
--
-- WHAT "AS OF A DATE" MEANS FOR STOCK
-- Stock is valued the way it is bought: FIFO, lot by lot, at what that lot
-- actually cost. A lot counts once it has arrived; the quantity taken out of it
-- counts once the document that took it has happened. So the value on a date is
--
--   for each lot received on or before D:
--     (what arrived  -  what was taken out on or before D)  x  that lot's cost
--
-- floored at zero per lot, because a lot cannot hold less than nothing.
--
-- REVERSED DOCUMENTS DISAPPEAR ENTIRELY, ON EVERY DATE
-- This is the part worth being careful about. Reversing a sale does not delete
-- the stock_lot_consumption rows; it puts the quantity back on the lot and
-- writes an inventory movement dated to the ORIGINAL document's day, not the
-- day of the reversal (07_returns_reversals.sql). So from every date's point of
-- view the document's effect on stock is nil - which is why the rule here is to
-- exclude a reversed document outright rather than to net it out on the day it
-- was reversed. The app does the same: load-shop.js never loads reversed
-- documents into the book at all.
--
-- DUES ARE THE SAME QUESTION IN A DIFFERENT TABLE
-- A bill raised on or before D, less the payments allocated to it on or before
-- D. Only open bills, and only the part still owing - the same rule as
-- v_bill_balances, with a date on both halves.
--
-- Advances (money taken against no bill) are deliberately left out, because
-- v_due_totals leaves them out too, and this has to answer the same question
-- the app is asking or the comparison means nothing.
-- =========================================================================

-- -------------------------------------------------------------------------
-- STOCK VALUE ON A DATE
-- -------------------------------------------------------------------------
create or replace function stock_value_on(p_shop uuid, p_date date)
returns numeric language sql stable set search_path = public as $$
  with lot as (
    select l.id, l.qty_received, l.unit_cost
      from stock_lots l
      -- Where the lot came from, and whether that document still stands.
      left join purchase_lines pl on l.source_table = 'purchase_lines' and pl.id = l.source_id
      left join purchases      pu on pu.id = pl.purchase_id
      left join return_lines   rl on l.source_table = 'return_lines'   and rl.id = l.source_id
      left join returns        r  on r.id = rl.return_id
      left join adjustments    ad on l.source_table = 'adjustments'    and ad.id = l.source_id
     where l.shop_id = p_shop
       and l.business_date <= p_date
       and coalesce(pu.status, r.status, ad.status, 'posted') <> 'reversed'
  ),
  used as (
    select c.lot_id, sum(c.qty) as qty
      from stock_lot_consumption c
      join lot on lot.id = c.lot_id
      -- The date a quantity left the lot is the date of the document that took
      -- it, not the row's created_at: a sale entered today for yesterday
      -- belongs to yesterday's stock.
      left join sale_lines   sl on c.consumer_table = 'sale_lines'   and sl.id = c.consumer_id
      left join sales        s  on s.id = sl.sale_id
      left join return_lines rl on c.consumer_table = 'return_lines' and rl.id = c.consumer_id
      left join returns      r  on r.id = rl.return_id
      left join adjustments  ad on c.consumer_table = 'adjustments'  and ad.id = c.consumer_id
     where c.shop_id = p_shop
       and coalesce(s.business_date, r.business_date, ad.business_date) <= p_date
       and coalesce(s.status, r.status, ad.status, 'posted') <> 'reversed'
     group by c.lot_id
  )
  select round(coalesce(sum(
           greatest(lot.qty_received - coalesce(used.qty, 0), 0) * lot.unit_cost
         ), 0), 2)
    from lot
    left join used on used.lot_id = lot.id;
$$;

comment on function stock_value_on is
  'What the stock on hand was worth at the end of a given day, valued lot by lot at what each lot cost.';

-- -------------------------------------------------------------------------
-- WHAT WAS OWED, IN BOTH DIRECTIONS, ON A DATE
-- -------------------------------------------------------------------------
create or replace function dues_on(p_shop uuid, p_date date)
returns table (receivable numeric, payable numeric)
language sql stable set search_path = public as $$
  with bal as (
    select b.direction,
           b.amount - coalesce((
             select sum(al.amount)
               from payment_allocations al
               join payments p on p.id = al.payment_id
              where al.bill_id = b.id
                and p.status = 'posted'
                and p.business_date <= p_date
           ), 0) as balance
      from party_bills b
     where b.shop_id = p_shop
       and b.status = 'open'
       and b.business_date <= p_date
  )
  -- Only bills still owing. A bill overpaid by an allocation does not turn into
  -- money owed the other way; that is what the advance is for, and v_party_due
  -- draws the same line.
  select round(coalesce(sum(balance) filter (where direction = 'receivable' and balance > 0), 0), 2),
         round(coalesce(sum(balance) filter (where direction = 'payable'    and balance > 0), 0), 2)
    from bal;
$$;

comment on function dues_on is
  'Receivable and payable as they stood at the end of a given day: bills raised by then, less what had been paid against them by then.';

-- -------------------------------------------------------------------------
-- THE WHOLE LEDGER CARD IN ONE CALL
--
-- Cash comes from opening_cash_on() plus that day's movements - the same
-- closing figure cash_summary() reports, so the two cards can never quote
-- different cash.
-- -------------------------------------------------------------------------
create or replace function business_snapshot(p_shop uuid, p_date date)
returns table (
  cash_in_hand   numeric,
  stock_value    numeric,
  receivable     numeric,
  payable        numeric,
  business_worth numeric
) language sql stable set search_path = public as $$
  with c as (
    select round(opening_cash_on(p_shop, p_date)
           + coalesce((select sum(case when direction = 'in' then amount else -amount end)
                         from cash_ledger
                        where shop_id = p_shop and business_date = p_date), 0), 2) as cash
  ),
  s as (select stock_value_on(p_shop, p_date) as stock),
  d as (select * from dues_on(p_shop, p_date))
  select c.cash, s.stock, d.receivable, d.payable,
         round(c.cash + s.stock + d.receivable - d.payable, 2)
    from c, s, d;
$$;

comment on function business_snapshot is
  'Where the business stood at the end of a day: cash, stock, owed to you, owed by you, and the worth those four add up to.';

grant execute on function stock_value_on(uuid, date)     to authenticated;
grant execute on function dues_on(uuid, date)            to authenticated;
grant execute on function business_snapshot(uuid, date)  to authenticated;

select 'stock_value_on(), dues_on() and business_snapshot() are ready' as note;
