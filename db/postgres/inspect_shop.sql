-- =========================================================================
-- inspect_shop.sql — checking what the app actually wrote
--
-- The long version of this file has been replaced by three database functions
-- (see 26_inspect_helpers.sql). Run 26 once, then paste any of these into the
-- Supabase SQL Editor. Change the id to look at a different shop - that is the
-- only thing to edit.
--
--   922a15a7-9abd-4ae7-868f-b684e696b519   shop 2, the test one
--   70d5fb96-9577-43b8-8a92-d453c4fc2474   your real books
-- =========================================================================

-- -------------------------------------------------------------------------
-- START HERE: which shops exist, and what is in them
-- -------------------------------------------------------------------------
-- Run this first. It gives you the id to paste into everything below, and the
-- document counts tell you which shop is which without having to remember.
select s.id,
       s.name,
       s.created_at::date as created,
       (select count(*) from sales     x where x.shop_id = s.id) as sales,
       (select count(*) from purchases x where x.shop_id = s.id) as purchases,
       (select count(*) from products  x where x.shop_id = s.id) as products
from shops s
where s.is_archived = false
order by s.created_at;

-- Every document the shop has posted, newest first.
-- If something you entered in the app is not here, it never reached Postgres.
select * from shop_documents('922a15a7-9abd-4ae7-868f-b684e696b519');

-- How many rows in each table (an empty shop is obviously empty).
-- select * from shop_counts('922a15a7-9abd-4ae7-868f-b684e696b519');

-- Opening cash, money in, money out, and what the drawer should hold.
-- select * from shop_cash('922a15a7-9abd-4ae7-868f-b684e696b519');

-- Stock on hand.
-- select p.name, v.qty
--   from v_stock_on_hand v join products p on p.id = v.product_id
--  where v.shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519' and v.qty <> 0
--  order by p.name;

-- Who owes what.
-- select name, kind, receivable, payable from v_party_due
--  where shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519'
--    and (receivable > 0 or payable > 0);

-- The audit trail — every posting function writes here.
-- select occurred_at, action, entity_table, new_value from audit_log
--  where shop_id = '922a15a7-9abd-4ae7-868f-b684e696b519'
--  order by occurred_at desc limit 30;
