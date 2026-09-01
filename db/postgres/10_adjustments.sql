-- =========================================================================
-- KoshAgar ERP — 10_adjustments.sql
--
-- Stock changes with no counterparty: opening stock, damage, theft, and
-- corrections. Money does not move, so nothing here touches the cash ledger -
-- but stock does, so everything here goes through the inventory ledger.
--
-- Inbound kinds (opening, correction_in) create a FIFO lot at the cost you
-- give. Outbound kinds (damage, theft, correction_out) consume lots at their
-- own cost, exactly as a sale does - so writing off damaged goods removes the
-- cost they actually carried, not an estimate.
-- =========================================================================
create or replace function post_adjustment(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key     text := p_payload->>'idempotency_key';
  v_hit     jsonb;
  v_kind    text := p_payload->>'kind';
  v_date    date := (p_payload->>'business_date')::date;
  v_at      timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_product uuid := (p_payload->>'product_id')::uuid;
  v_unit    uuid := nullif(p_payload->>'unit_id', '')::uuid;
  v_qty_in  numeric(18,3) := (p_payload->>'qty_entered')::numeric;
  v_cost    numeric(18,4) := coalesce((p_payload->>'unit_cost')::numeric, 0);
  v_factor  numeric(18,6);
  v_qty     numeric(18,3);
  v_id      uuid;
  v_no      text;
  v_pname   text;
  v_uname   text;
  v_consumed numeric(18,2);
  v_result  jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);

  if v_kind not in ('opening', 'damage', 'theft', 'correction_in', 'correction_out') then
    raise exception 'INVALID_KIND: "%" is not an adjustment kind.', v_kind;
  end if;
  if v_qty_in is null or v_qty_in <= 0 then
    raise exception 'INVALID_QUANTITY: an adjustment must be greater than zero.';
  end if;

  select p.name, p.base_unit_id into v_pname, v_unit
  from products p where p.id = v_product and p.shop_id = p_shop;
  if v_pname is null then
    raise exception 'PRODUCT_NOT_FOUND: that product does not belong to this shop.';
  end if;

  if nullif(p_payload->>'unit_id', '') is not null then
    v_unit := (p_payload->>'unit_id')::uuid;
  end if;

  v_factor := resolve_conversion(p_shop, v_product, v_unit);
  v_qty    := round(v_qty_in * v_factor, 3);
  select name into v_uname from units where id = v_unit;

  v_no := next_document_no(p_shop, 'adjustment', v_date);

  insert into adjustments (shop_id, adjustment_no, kind, product_id, product_name,
                           unit_name, qty_base, unit_cost, occurred_at, business_date,
                           note, created_by)
  values (p_shop, v_no, v_kind, v_product, v_pname, coalesce(v_uname, ''), v_qty,
          v_cost, v_at, v_date, coalesce(p_payload->>'note', ''), auth.uid())
  returning id into v_id;

  if v_kind in ('opening', 'correction_in') then
    insert into stock_lots (shop_id, product_id, source_table, source_id,
                            received_at, business_date, qty_received, qty_remaining, unit_cost)
    values (p_shop, v_product, 'adjustments', v_id, v_at, v_date, v_qty, v_qty, v_cost);

    insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                     occurred_at, business_date, source_table, source_id, created_by)
    values (p_shop, v_product, v_kind, v_qty, v_at, v_date, 'adjustments', v_id, auth.uid());
  else
    -- Damage and theft remove goods at the cost those goods actually carried.
    v_consumed := consume_fifo(p_shop, v_product, v_qty, 'adjustments', v_id);
    update adjustments
       set unit_cost = case when v_qty > 0 then round(v_consumed / v_qty, 4) else 0 end
     where id = v_id;

    insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                     occurred_at, business_date, source_table, source_id, created_by)
    values (p_shop, v_product, v_kind, -v_qty, v_at, v_date, 'adjustments', v_id, auth.uid());
  end if;

  perform write_audit(p_shop, 'adjustment_posted', 'adjustments', v_id, null,
                      jsonb_build_object('kind', v_kind, 'qty', v_qty, 'product', v_pname));

  v_result := jsonb_build_object('ok', true, 'adjustment_id', v_id,
                                 'adjustment_no', v_no, 'qty_base', v_qty);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_adjustment', v_result) on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

grant execute on function post_adjustment(uuid, jsonb) to authenticated;
