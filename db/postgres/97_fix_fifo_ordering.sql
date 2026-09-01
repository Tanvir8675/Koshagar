-- =========================================================================
-- KoshAgar ERP — 97_fix_fifo_ordering.sql
--
-- Run ONCE against a database that already has 01–06 loaded.
-- Found by the smoke test: FIFO consumed the NEWER lot first.
--
-- TWO BUGS, both in how lots were ordered.
--
-- 1. The tie-break was the primary key.
--      order by received_at, id
--    Ids are random uuids. Two lots sharing a received_at - two purchases
--    posted in one transaction, or two entries carrying the same occurred_at -
--    were therefore consumed in arbitrary order. The smoke test bought 100 @ 10
--    then 50 @ 12 in the same transaction, so both lots got the same
--    transaction timestamp, and the 12 lot was consumed first: 50x12 + 50x10 =
--    1100 instead of 90x10 + 10x12 = 1020.
--
--    Fixed with lot_seq, a monotonic sequence that always reflects arrival
--    order, even inside a single transaction.
--
-- 2. Ordering ignored the trading day.
--    received_at is when the entry was typed. A purchase backdated to last week
--    is typed today, so ordering by received_at put it LAST - and later sales
--    took cost from the wrong lot. business_date now leads the ordering, which
--    is the day the goods actually arrived.
--
-- Neither bug can be seen by reading the schema; both produce plausible numbers.
-- =========================================================================

-- 1. Monotonic arrival sequence. Existing rows are numbered in insertion order.
alter table stock_lots add column if not exists lot_seq bigserial;

-- 2. Index the order FIFO actually reads in.
drop index if exists stock_lots_open_fifo;

create index stock_lots_open_fifo
  on stock_lots (shop_id, product_id, business_date, received_at, lot_seq)
  where qty_remaining > 0;

-- 3. Consume in that order.
create or replace function consume_fifo(
  p_shop           uuid,
  p_product        uuid,
  p_qty            numeric,
  p_consumer_table text,
  p_consumer_id    uuid
) returns numeric language plpgsql set search_path = public as $$
declare
  v_left  numeric(18,3) := p_qty;
  v_cost  numeric(18,2) := 0;
  v_take  numeric(18,3);
  v_name  text;
  r       record;
begin
  for r in
    select id, qty_remaining, unit_cost
    from stock_lots
    where shop_id = p_shop and product_id = p_product and qty_remaining > 0
    order by business_date, received_at, lot_seq
    for update
  loop
    exit when v_left <= 0.0001;

    v_take := least(r.qty_remaining, v_left);

    update stock_lots
       set qty_remaining = qty_remaining - v_take
     where id = r.id;

    insert into stock_lot_consumption
      (shop_id, lot_id, consumer_table, consumer_id, qty, unit_cost)
    values (p_shop, r.id, p_consumer_table, p_consumer_id, v_take, r.unit_cost);

    v_cost := v_cost + round(v_take * r.unit_cost, 2);
    v_left := v_left - v_take;
  end loop;

  if v_left > 0.0001 then
    select name into v_name from products where id = p_product;
    raise exception
      'INSUFFICIENT_STOCK: "%" is short by %. Enter the missing purchase or opening stock first.',
      coalesce(v_name, p_product::text), v_left;
  end if;

  return v_cost;
end $$;

-- Confirm the ordering columns are in place.
select column_name, data_type
from information_schema.columns
where table_name = 'stock_lots'
  and column_name in ('business_date', 'received_at', 'lot_seq')
order by column_name;
