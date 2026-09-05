-- =========================================================================
-- KoshAgar ERP — 26_inspect_helpers.sql
--
-- Turns inspect_shop.sql into three functions, so checking what the app wrote
-- is one short line instead of a file full of repeated ids:
--
--   select * from shop_documents('922a15a7-9abd-4ae7-868f-b684e696b519');
--   select * from shop_counts('922a15a7-9abd-4ae7-868f-b684e696b519');
--   select * from shop_cash('922a15a7-9abd-4ae7-868f-b684e696b519');
--
-- Switching shops means changing one id in one place.
--
-- These are SECURITY INVOKER (the default), so they see exactly what the caller
-- is allowed to see. In the SQL Editor that is everything; from the app it is
-- the caller's own shops and nothing else.
-- =========================================================================

-- Every document the shop has posted, whatever kind, newest first.
create or replace function shop_documents(p_shop uuid)
returns table (
  occurred_at   timestamptz,
  business_date date,
  kind          text,
  reference     text,
  party         text,
  amount        numeric,
  status        text
) language sql stable set search_path = public as $$
  select * from (
    select s.occurred_at, s.business_date, 'sale'::text, s.invoice_no,
           coalesce(p.name, '(cash)'),
           (select coalesce(sum(line_total), 0) from sale_lines l where l.sale_id = s.id)
             - s.bill_discount,
           s.status
      from sales s left join parties p on p.id = s.party_id
     where s.shop_id = p_shop
    union all
    select pu.occurred_at, pu.business_date, 'purchase', pu.bill_no,
           coalesce(p.name, '(cash)'),
           (select coalesce(sum(line_total), 0) from purchase_lines l where l.purchase_id = pu.id)
             - pu.bill_discount + pu.extra_cost,
           pu.status
      from purchases pu left join parties p on p.id = pu.party_id
     where pu.shop_id = p_shop
    union all
    select r.occurred_at, r.business_date, r.kind, r.return_no,
           coalesce(p.name, '(cash)'),
           (select coalesce(sum(qty_base * unit_price), 0) from return_lines l where l.return_id = r.id),
           r.status
      from returns r left join parties p on p.id = r.party_id
     where r.shop_id = p_shop
    union all
    select pay.occurred_at, pay.business_date,
           case when pay.direction = 'in' then 'payment received' else 'payment made' end,
           pay.payment_no, coalesce(p.name, '?'), pay.amount, pay.status
      from payments pay left join parties p on p.id = pay.party_id
     where pay.shop_id = p_shop
    union all
    select e.occurred_at, e.business_date, 'expense', '',
           coalesce(nullif(e.note, ''), '-'), -e.amount, e.status
      from expenses e where e.shop_id = p_shop
    union all
    select w.occurred_at, w.business_date, 'withdrawal', '',
           coalesce(nullif(w.reason, ''), '-'), -w.amount, w.status
      from cash_withdrawals w where w.shop_id = p_shop
    union all
    select c.occurred_at, c.business_date, 'capital ' || c.kind, '',
           coalesce(nullif(c.note, ''), '-'),
           case when c.kind = 'in' then c.amount else -c.amount end, c.status
      from capital_movements c where c.shop_id = p_shop
    union all
    select a.occurred_at, a.business_date, 'adjustment (' || a.kind || ')', a.adjustment_no,
           a.product_name, -(a.qty_base * a.unit_cost), a.status
      from adjustments a where a.shop_id = p_shop
  ) d
  order by occurred_at desc;
$$;

comment on function shop_documents is
  'Every posted document in one list, newest first. If something entered in the app is not here, it never reached the database.';

-- Row counts per table, so an empty shop is obviously empty.
create or replace function shop_counts(p_shop uuid)
returns table (table_name text, rows bigint)
language sql stable set search_path = public as $$
  select * from (
    select 'products'::text,          count(*) from products          where shop_id = p_shop
    union all select 'parties',            count(*) from parties             where shop_id = p_shop
    union all select 'sales',              count(*) from sales               where shop_id = p_shop
    union all select 'sale_lines',         count(*) from sale_lines          where shop_id = p_shop
    union all select 'purchases',          count(*) from purchases           where shop_id = p_shop
    union all select 'purchase_lines',     count(*) from purchase_lines      where shop_id = p_shop
    union all select 'returns',            count(*) from returns             where shop_id = p_shop
    union all select 'adjustments',        count(*) from adjustments         where shop_id = p_shop
    union all select 'party_bills',        count(*) from party_bills         where shop_id = p_shop
    union all select 'payments',           count(*) from payments            where shop_id = p_shop
    union all select 'expenses',           count(*) from expenses            where shop_id = p_shop
    union all select 'cash_withdrawals',   count(*) from cash_withdrawals    where shop_id = p_shop
    union all select 'capital_movements',  count(*) from capital_movements   where shop_id = p_shop
    union all select 'cash_ledger',        count(*) from cash_ledger         where shop_id = p_shop
    union all select 'stock_lots',         count(*) from stock_lots          where shop_id = p_shop
    union all select 'inventory_movements',count(*) from inventory_movements where shop_id = p_shop
  ) c
  order by 1;
$$;

-- The drawer: opening cash plus every movement since.
create or replace function shop_cash(p_shop uuid)
returns table (
  opening_cash  numeric,
  cash_in       numeric,
  cash_out      numeric,
  cash_in_hand  numeric
) language sql stable set search_path = public as $$
  select o.amt,
         coalesce(sum(l.amount) filter (where l.direction = 'in'), 0),
         coalesce(sum(l.amount) filter (where l.direction = 'out'), 0),
         o.amt + coalesce(sum(l.amount) filter (where l.direction = 'in'), 0)
               - coalesce(sum(l.amount) filter (where l.direction = 'out'), 0)
    from (select coalesce((select amount from opening_cash
                            where shop_id = p_shop order by business_date limit 1), 0) as amt) o
    left join cash_ledger l on l.shop_id = p_shop
   group by o.amt;
$$;

grant execute on function shop_documents(uuid) to authenticated;
grant execute on function shop_counts(uuid)    to authenticated;
grant execute on function shop_cash(uuid)      to authenticated;

select 'shop_documents(), shop_counts() and shop_cash() are ready' as note;
