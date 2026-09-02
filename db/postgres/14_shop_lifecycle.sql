-- =========================================================================
-- KoshAgar ERP — 14_shop_lifecycle.sql
--
-- THE REPAIR WORKFLOW
--
-- When the books go wrong, the owner's established way of fixing it is:
--
--   export  ->  import on localhost  ->  a developer corrects the data
--           ->  export the corrected copy  ->  load it back online
--
-- The old system finished that by wiping everything and importing the fix. This
-- does the same job without the wipe: the corrected data goes into a NEW shop
-- and the app switches to it, while the wrong data is archived rather than
-- destroyed.
--
-- That difference is not pedantry. It means:
--   * if the "fix" turns out to be wrong, the original is still there;
--   * the two can be compared side by side to see what actually changed;
--   * a mistake during repair cannot cost the shop its history.
--
-- The corrected data also has to pass every rule on the way in - it is replayed
-- through post_sale and the rest, not inserted raw. A repair that would produce
-- negative stock or an overpaid bill is refused at the door, which is precisely
-- the class of problem that made the books wrong to begin with.
-- =========================================================================

alter table shops add column if not exists is_archived  boolean not null default false;
alter table shops add column if not exists archived_at  timestamptz;
alter table shops add column if not exists archive_note text not null default '';

comment on column shops.is_archived is
  'An archived shop is hidden from the shop switcher but stays fully readable. Superseded books are archived, never deleted.';

-- =========================================================================
-- ARCHIVE / RESTORE A SHOP
-- =========================================================================
create or replace function archive_shop(p_shop uuid, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_remaining int;
begin
  if not has_shop_role(p_shop, 'owner') then
    raise exception 'NOT_OWNER: only the owner can archive a shop.';
  end if;

  -- Refuse to leave the user with nowhere to work.
  select count(*) into v_remaining
  from shop_members m join shops s on s.id = m.shop_id
  where m.user_id = auth.uid() and not s.is_archived and s.id <> p_shop;

  if v_remaining = 0 then
    raise exception
      'LAST_SHOP: this is your only active shop. Create or restore another one before archiving this.';
  end if;

  update shops
     set is_archived = true, archived_at = now(),
         archive_note = coalesce(nullif(trim(p_note), ''), 'Superseded')
   where id = p_shop;

  perform write_audit(p_shop, 'shop_archived', 'shops', p_shop, null,
                      jsonb_build_object('note', p_note));

  return jsonb_build_object('ok', true, 'shop_id', p_shop, 'archived', true);
end $$;

create or replace function unarchive_shop(p_shop uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not has_shop_role(p_shop, 'owner') then
    raise exception 'NOT_OWNER: only the owner can restore a shop.';
  end if;

  update shops set is_archived = false, archived_at = null where id = p_shop;
  perform write_audit(p_shop, 'shop_unarchived', 'shops', p_shop, null, null);
  return jsonb_build_object('ok', true, 'shop_id', p_shop, 'archived', false);
end $$;

-- =========================================================================
-- WHAT THE SHOP SWITCHER READS
--
-- Enough for the owner to tell two copies apart at a glance - which is the
-- whole difficulty after a repair, when there are two sets of books that look
-- almost identical.
-- =========================================================================
create or replace view v_my_shops as
select s.id                as shop_id,
       s.name,
       s.is_archived,
       s.archived_at,
       s.archive_note,
       s.created_at,
       m.role,
       (select count(*) from sales     x where x.shop_id = s.id) as sale_count,
       (select count(*) from purchases x where x.shop_id = s.id) as purchase_count,
       (select max(business_date) from sales x where x.shop_id = s.id) as last_sale_on,
       coalesce((select sum(round(qty_remaining * unit_cost, 2))
                   from stock_lots x where x.shop_id = s.id and x.qty_remaining > 0), 0) as stock_value
from shops s
join shop_members m on m.shop_id = s.id and m.user_id = auth.uid();

alter view v_my_shops set (security_invoker = true);

-- =========================================================================
-- REPLACE ONE SHOP WITH ANOTHER
--
-- The last step of the repair: the corrected shop becomes the working one and
-- the old is archived, in a single transaction so the owner can never end up
-- with both live or neither.
--
-- Called AFTER the corrected file has been imported into p_new_shop and its
-- checksums verified - not before. Nothing here validates the import; that is
-- the import's job, and it should be done before anything is switched.
-- =========================================================================
create or replace function replace_shop(p_old_shop uuid, p_new_shop uuid, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not has_shop_role(p_old_shop, 'owner') or not has_shop_role(p_new_shop, 'owner') then
    raise exception 'NOT_OWNER: both shops must belong to you.';
  end if;
  if p_old_shop = p_new_shop then
    raise exception 'SAME_SHOP: the replacement must be a different shop.';
  end if;
  if shop_is_empty(p_new_shop) then
    raise exception
      'REPLACEMENT_IS_EMPTY: the new shop has no sales, purchases or payments. Import the corrected data before switching to it.';
  end if;

  update shops
     set is_archived = true, archived_at = now(),
         archive_note = coalesce(nullif(trim(p_note), ''), 'Replaced by corrected data')
   where id = p_old_shop;

  update shops set is_archived = false, archived_at = null where id = p_new_shop;

  perform write_audit(p_old_shop, 'shop_replaced', 'shops', p_old_shop,
                      jsonb_build_object('status', 'active'),
                      jsonb_build_object('status', 'archived', 'replaced_by', p_new_shop));
  perform write_audit(p_new_shop, 'shop_activated', 'shops', p_new_shop, null,
                      jsonb_build_object('replaces', p_old_shop, 'note', p_note));

  return jsonb_build_object('ok', true, 'archived', p_old_shop, 'active', p_new_shop);
end $$;

grant execute on function archive_shop(uuid, text)   to authenticated;
grant execute on function unarchive_shop(uuid)       to authenticated;
grant execute on function replace_shop(uuid, uuid, text) to authenticated;
