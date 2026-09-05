-- =========================================================================
-- KoshAgar ERP - 34_create_product_conflict.sql
--
-- Adding any product failed with:
--   duplicate key value violates unique constraint "product_units_product_id_unit_id_key"
--
-- Two things insert the base-unit conversion, and only one of them expects the
-- other to exist.
--
--   02_master_data.sql  ensure_base_unit_conversion() runs AFTER INSERT on
--                       products and writes the (product, base unit, factor 1)
--                       row - with `on conflict do nothing`, so it is safe to
--                       run twice.
--
--   27_unit_kinds.sql   create_product() writes the same row itself, with no
--                       conflict clause. By the time it runs, the trigger has
--                       already inserted it, so the insert collides with itself.
--
-- Both are right to want that row: the trigger guarantees it for every product
-- however it was created (the import inserts directly), and create_product()
-- states the requirement where a reader of that function can see it. Only the
-- collision is wrong.
--
-- So create_product() now says `on conflict do nothing` too. It is then correct
-- whether the trigger exists or not, which is what an insert of a row that
-- MUST exist should look like anyway.
-- =========================================================================

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
  --
  -- products_seed_base_unit has almost certainly written it already - this
  -- states the requirement rather than assuming a trigger somebody may later
  -- move, and says `do nothing` so the two cannot collide.
  insert into product_units (shop_id, product_id, unit_id, factor,
                             is_purchase_default, is_sale_default)
  values (p_shop, v_id, p_unit_id, 1, true, true)
  on conflict (product_id, unit_id) do nothing;

  perform write_audit(p_shop, 'product_created', 'products', v_id, null,
                      jsonb_build_object('name', trim(p_name)));

  return jsonb_build_object('ok', true, 'product_id', v_id, 'name', trim(p_name));
end $$;

grant execute on function create_product(uuid, text, uuid, text) to authenticated;

select 'products can be added again' as note;
