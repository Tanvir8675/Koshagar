-- =========================================================================
-- KoshAgar ERP — 27_unit_kinds.sql
--
-- Two problems, both found by trying to buy 100 PCS in a fresh shop.
--
-- 1. THE APP OFFERS UNITS THE SHOP DOES NOT HAVE.
--    seed_new_shop created 8 units; the entry screen lists 10. DOZ, GAUGE and
--    COIL were in the dropdown and in no shop, so choosing one failed at save
--    time with "Unit is not set up in this shop" - after the whole bill had
--    been typed in. Offering a choice that cannot work is worse than not
--    offering it.
--
-- 2. NOTHING RECORDED WHICH UNITS ARE CONTAINERS.
--    You said it plainly: BOX, CARTON, BOTTLE and COIL are containers; the rest
--    are base units. That distinction decides whether a conversion is required
--    ("1 BOX = how many PCS?") and the database had no idea - only the browser
--    did, in isContainerUnit(). A rule that lives only in the client is a rule
--    that stops applying the moment anything else writes.
-- =========================================================================

alter table units add column if not exists is_container boolean not null default false;

comment on column units.is_container is
  'A container is bought or sold as a package (BOX, CARTON, BOTTLE, COIL) and needs a conversion to the product base unit. Base units (PCS, KG, METER, FEET, DOZ, GAUGE, PIECE) stand on their own.';

-- Backfill: every shop gets the full set, and the containers get marked.
do $$
declare
  v_shop uuid;
  v_base      text[] := array['PCS','PIECE','KG','METER','FEET','DOZ','GAUGE'];
  v_container text[] := array['BOX','CARTON','BOTTLE','COIL'];
begin
  for v_shop in select id from shops loop
    insert into units (shop_id, name, is_container)
    select v_shop, u, false from unnest(v_base) as u
    on conflict (shop_id, name) do nothing;

    insert into units (shop_id, name, is_container)
    select v_shop, u, true from unnest(v_container) as u
    on conflict (shop_id, name) do nothing;
  end loop;

  -- Existing rows predate the column, so set the flag on what is already there.
  update units set is_container = true
   where name in ('BOX', 'CARTON', 'BOTTLE', 'COIL') and is_container = false;
  update units set is_container = false
   where name not in ('BOX', 'CARTON', 'BOTTLE', 'COIL') and is_container = true;
end $$;

-- And fix the seed so new shops start with the same set.
create or replace function seed_new_shop(p_shop uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into units (shop_id, name, is_container)
  select p_shop, u, false
  from unnest(array['PCS','PIECE','KG','METER','FEET','DOZ','GAUGE']) as u
  on conflict (shop_id, name) do nothing;

  insert into units (shop_id, name, is_container)
  select p_shop, u, true
  from unnest(array['BOX','CARTON','BOTTLE','COIL']) as u
  on conflict (shop_id, name) do nothing;

  insert into cash_accounts (shop_id, name, kind, is_default)
  values (p_shop, 'Main Counter', 'cash', true)
  on conflict do nothing;
end $$;

-- Creating a product and forgetting its base conversion leaves a product the
-- database cannot price - it exists, and every line against it is refused. The
-- two belong in one transaction, so no caller can do half of it.
create or replace function create_product(
  p_shop uuid, p_name text, p_unit_id uuid, p_category text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_container boolean;
begin
  -- has_shop_role is VARIADIC, so the role is passed as a plain argument.
  -- is_service_role() lets the importer and tooling through, matching 20.
  if not (is_service_role() or has_shop_role(p_shop, 'owner')) then
    raise exception 'NOT_A_MEMBER: you do not have access to this shop.';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'INVALID_NAME: a product needs a name.';
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
  values (p_shop, trim(p_name), p_unit_id, nullif(trim(coalesce(p_category, '')), ''), true, auth.uid())
  returning id into v_id;

  -- The base unit converts to itself. Without this row resolve_conversion has
  -- nothing to find and refuses the product's very first purchase.
  insert into product_units (shop_id, product_id, unit_id, factor,
                             is_purchase_default, is_sale_default)
  values (p_shop, v_id, p_unit_id, 1, true, true);

  perform write_audit(p_shop, 'product_created', 'products', v_id, null,
                      jsonb_build_object('name', trim(p_name)));

  return jsonb_build_object('ok', true, 'product_id', v_id, 'name', trim(p_name));
end $$;

grant execute on function create_product(uuid, text, uuid, text) to authenticated;
revoke all on function create_product(uuid, text, uuid, text) from public, anon;

select 'units completed and marked; create_product() is atomic' as note;
