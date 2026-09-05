-- =========================================================================
-- KoshAgar ERP - 38_product_name_unique.sql
--
-- Three taps on "Add Product" made three products called "test".
--
-- The app does check for a duplicate name before it saves - but it checks the
-- copy of the product list it is holding, and all three taps read that copy
-- before the first save came back. A check in the browser cannot see a write
-- that is still in flight. Only the database can, because only the database
-- sees them arrive one after another.
--
-- Two things here:
--   1. the duplicates already created are deactivated - but ONLY the ones that
--      have never been bought, sold or counted, so a real product is never
--      hidden by this;
--   2. a unique index makes a second product of the same name impossible, and
--      create_product() says so in words before the index has to.
--
-- Case- and space-insensitive: "Test", "test " and "test" are one name to a
-- shopkeeper, so they are one name here.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Stand down the accidental copies.
--
-- The oldest of each set is kept - it is the one the shopkeeper meant to make -
-- and anything with history attached is left completely alone.
-- -------------------------------------------------------------------------
with ranked as (
  select p.id, p.shop_id, p.name,
         row_number() over (partition by p.shop_id, lower(trim(p.name))
                            order by p.created_at, p.id) as seq
  from products p
  where p.is_active
),
untouched as (
  select r.id
  from ranked r
  where r.seq > 1
    and not exists (select 1 from sale_lines     x where x.product_id = r.id)
    and not exists (select 1 from purchase_lines x where x.product_id = r.id)
    and not exists (select 1 from return_lines   x where x.product_id = r.id)
    and not exists (select 1 from adjustments    x where x.product_id = r.id)
    and not exists (select 1 from stock_lots     x where x.product_id = r.id)
)
update products set is_active = false
where id in (select id from untouched);

-- -------------------------------------------------------------------------
-- 2. Make it impossible.
--
-- Only among ACTIVE products: a name freed up by deactivating an old product
-- can be used again, which is what deactivating is for.
--
-- If this index fails to create, two ACTIVE products of the same name still
-- have history on both and a person has to decide which is which - that is not
-- something a migration should guess at.
-- -------------------------------------------------------------------------
create unique index if not exists products_active_name_unique
  on products (shop_id, lower(trim(name))) where is_active;

comment on index products_active_name_unique is
  'One active product per name per shop. The app checks too, but three fast taps all read the list before the first write landed - only the database sees them arrive in order.';

-- -------------------------------------------------------------------------
-- 3. And say it in words, before the index has to.
-- -------------------------------------------------------------------------
create or replace function create_product(
  p_shop uuid, p_name text, p_unit_id uuid, p_category text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_container boolean; v_name text;
begin
  if not (is_service_role() or has_shop_role(p_shop, 'owner')) then
    raise exception 'NOT_A_MEMBER: you do not have access to this shop.';
  end if;

  v_name := trim(coalesce(p_name, ''));
  if length(v_name) = 0 then
    raise exception 'INVALID_NAME: a product needs a name.';
  end if;

  if exists (select 1 from products
              where shop_id = p_shop and is_active
                and lower(trim(name)) = lower(v_name)) then
    raise exception
      'PRODUCT_EXISTS: "%" is already in your product list. Edit that one, or give this a different name.',
      v_name;
  end if;

  select is_container into v_container
    from units where id = p_unit_id and shop_id = p_shop;
  if v_container is null then
    raise exception 'UNIT_NOT_FOUND: that unit does not exist in this shop.';
  end if;
  if v_container then
    raise exception
      'BASE_UNIT_REQUIRED: a container unit cannot be a product base unit. Pick PCS, KG, METER, FEET, DOZ, GAUGE or PIECE, then add the container as a conversion.';
  end if;

  insert into products (shop_id, name, base_unit_id, category, is_active, created_by)
  values (p_shop, v_name, p_unit_id, nullif(trim(coalesce(p_category, '')), ''), true, auth.uid())
  returning id into v_id;

  -- The base unit converts to itself. products_seed_base_unit has almost
  -- certainly written it already (02_master_data.sql); this states the
  -- requirement where a reader of this function can see it, and says
  -- `do nothing` so the two cannot collide.
  insert into product_units (shop_id, product_id, unit_id, factor,
                             is_purchase_default, is_sale_default)
  values (p_shop, v_id, p_unit_id, 1, true, true)
  on conflict (product_id, unit_id) do nothing;

  perform write_audit(p_shop, 'product_created', 'products', v_id, null,
                      jsonb_build_object('name', v_name));

  return jsonb_build_object('ok', true, 'product_id', v_id, 'name', v_name);
end $$;

grant execute on function create_product(uuid, text, uuid, text) to authenticated;

select 'one active product per name, enforced where it can actually be enforced' as note;
