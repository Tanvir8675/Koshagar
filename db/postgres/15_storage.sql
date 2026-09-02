-- =========================================================================
-- KoshAgar ERP — 15_storage.sql
--
-- Seeing how much room the data takes, and reclaiming it when an archived copy
-- is genuinely no longer wanted.
--
-- THE NUMBERS, MEASURED NOT GUESSED
-- One shop with six months of real trading (592 sales, 329 purchases, 1,557
-- transaction lines) comes to about 9,000 rows, roughly 3 MB with indexes. So
-- a year is 6-7 MB, and Supabase's 500 MB free tier holds something like 70
-- shop-years. Archiving a superseded copy after a data repair costs about 3 MB.
--
-- Storage is therefore not the reason to delete anything - but the owner should
-- still be able to, and this is the only sanctioned way.
--
-- WHY PURGING IS DELIBERATELY AWKWARD
-- Every other table in this schema refuses deletion, because the September 2026
-- data loss came from history being destroyed. Purging is the single exception,
-- and it is narrow: a whole shop, already archived, never the last one, and only
-- after the owner confirms they hold an exported file. It cannot remove a single
-- sale, which is what made delete-by-date dangerous.
-- =========================================================================

-- =========================================================================
-- WHAT IS USING THE SPACE
-- =========================================================================
create or replace view v_storage_usage as
select s.id          as shop_id,
       s.name,
       s.is_archived,
       (select count(*) from sales                 x where x.shop_id = s.id)
     + (select count(*) from sale_lines            x where x.shop_id = s.id)
     + (select count(*) from purchases             x where x.shop_id = s.id)
     + (select count(*) from purchase_lines        x where x.shop_id = s.id)
     + (select count(*) from inventory_movements   x where x.shop_id = s.id)
     + (select count(*) from stock_lots            x where x.shop_id = s.id)
     + (select count(*) from stock_lot_consumption x where x.shop_id = s.id)
     + (select count(*) from cash_ledger           x where x.shop_id = s.id)
     + (select count(*) from payments              x where x.shop_id = s.id)
     + (select count(*) from audit_log             x where x.shop_id = s.id)
       as row_count,
       -- ~350 bytes per row including index entries, from the measured shop.
       round((
         (select count(*) from sales                 x where x.shop_id = s.id)
       + (select count(*) from sale_lines            x where x.shop_id = s.id)
       + (select count(*) from purchases             x where x.shop_id = s.id)
       + (select count(*) from purchase_lines        x where x.shop_id = s.id)
       + (select count(*) from inventory_movements   x where x.shop_id = s.id)
       + (select count(*) from stock_lots            x where x.shop_id = s.id)
       + (select count(*) from stock_lot_consumption x where x.shop_id = s.id)
       + (select count(*) from cash_ledger           x where x.shop_id = s.id)
       + (select count(*) from payments              x where x.shop_id = s.id)
       + (select count(*) from audit_log             x where x.shop_id = s.id)
       ) * 350.0 / 1048576, 2) as approx_mb
from shops s
join shop_members m on m.shop_id = s.id and m.user_id = auth.uid();

alter view v_storage_usage set (security_invoker = true);

-- =========================================================================
-- THE ONE DOOR THROUGH THE NO-DELETE RULE
--
-- forbid_delete_posted() blocks every delete. Rather than dropping that guard,
-- purge_archived_shop() opens it for the length of its own transaction only,
-- via a setting no client can reach.
-- =========================================================================
create or replace function forbid_delete_posted()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('koshagar.purge_active', true), 'off') = 'on' then
    return old;   -- inside purge_archived_shop(), and nowhere else
  end if;
  raise exception
    'DELETE_FORBIDDEN: % is a posted document and cannot be deleted. Post a reversal instead.',
    tg_table_name;
end $$;

-- =========================================================================
-- PURGE AN ARCHIVED SHOP
--
-- p_confirm_export must be the exact phrase, so this cannot happen by a stray
-- click or a mistyped id.
-- =========================================================================
create or replace function purge_archived_shop(p_shop uuid, p_confirm_export text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text; v_archived boolean; v_rows int; v_active int;
begin
  if not has_shop_role(p_shop, 'owner') then
    raise exception 'NOT_OWNER: only the owner can purge a shop.';
  end if;

  select name, is_archived into v_name, v_archived from shops where id = p_shop;
  if v_name is null then
    raise exception 'SHOP_NOT_FOUND: no such shop.';
  end if;
  if not v_archived then
    raise exception
      'NOT_ARCHIVED: "%" is still in use. Archive it first - purging is only for superseded books.', v_name;
  end if;

  select count(*) into v_active
  from shop_members m join shops s on s.id = m.shop_id
  where m.user_id = auth.uid() and not s.is_archived;
  if v_active = 0 then
    raise exception 'LAST_SHOP: you would be left with no active shop.';
  end if;

  if coalesce(p_confirm_export, '') <> 'I HAVE EXPORTED THIS SHOP' then
    raise exception
      'EXPORT_NOT_CONFIRMED: export this shop first, then pass the exact phrase "I HAVE EXPORTED THIS SHOP". Once purged it cannot be recovered from here.';
  end if;

  select row_count into v_rows from v_storage_usage where shop_id = p_shop;

  -- The audit entry is written BEFORE the rows go, and deliberately against a
  -- different shop's log - an audit row inside the shop being purged would be
  -- deleted along with everything else, leaving no trace that this happened.
  insert into audit_log (shop_id, actor, action, entity_table, entity_id, old_value, note)
  select m.shop_id, auth.uid(), 'shop_purged', 'shops', p_shop,
         jsonb_build_object('name', v_name, 'rows', v_rows),
         'Purged archived shop after export'
  from shop_members m join shops s on s.id = m.shop_id
  where m.user_id = auth.uid() and not s.is_archived
  limit 1;

  perform set_config('koshagar.purge_active', 'on', true);   -- true = this transaction only

  -- Children before parents.
  delete from stock_lot_consumption where shop_id = p_shop;
  delete from payment_allocations    where shop_id = p_shop;
  delete from inventory_movements    where shop_id = p_shop;
  delete from cash_ledger            where shop_id = p_shop;
  delete from return_lines           where shop_id = p_shop;
  delete from returns                where shop_id = p_shop;
  delete from sale_lines             where shop_id = p_shop;
  delete from sales                  where shop_id = p_shop;
  delete from purchase_lines         where shop_id = p_shop;
  delete from purchases              where shop_id = p_shop;
  delete from stock_lots             where shop_id = p_shop;
  delete from adjustments            where shop_id = p_shop;
  delete from payments               where shop_id = p_shop;
  delete from party_bills            where shop_id = p_shop;
  delete from loans                  where shop_id = p_shop;
  delete from expenses               where shop_id = p_shop;
  delete from capital_movements      where shop_id = p_shop;
  delete from cash_withdrawals       where shop_id = p_shop;
  delete from cash_adjustments       where shop_id = p_shop;
  delete from opening_cash           where shop_id = p_shop;
  delete from document_reversals     where shop_id = p_shop;
  delete from product_units          where shop_id = p_shop;
  delete from products               where shop_id = p_shop;
  delete from parties                where shop_id = p_shop;
  delete from cash_accounts          where shop_id = p_shop;
  delete from units                  where shop_id = p_shop;
  delete from accounting_periods     where shop_id = p_shop;
  delete from document_sequences     where shop_id = p_shop;
  delete from idempotency_keys       where shop_id = p_shop;
  delete from audit_log              where shop_id = p_shop;
  delete from shop_members           where shop_id = p_shop;
  delete from shops                  where id = p_shop;

  perform set_config('koshagar.purge_active', 'off', true);

  return jsonb_build_object('ok', true, 'purged', v_name, 'rows_removed', v_rows);
end $$;

grant execute on function purge_archived_shop(uuid, text) to authenticated;
