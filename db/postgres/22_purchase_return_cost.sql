-- =========================================================================
-- KoshAgar ERP — 22_purchase_return_cost.sql
--
-- Found by reading index.html getReturnCost() at line 10102:
--
--   sale-return      -> orig.cost     the cost the original sale consumed
--   purchase-return  -> orig.price    the price that purchase was bought at
--
-- My post_return got the first right and the second wrong. It called
-- consume_fifo(), which takes stock from the OLDEST open lot - and the oldest
-- lot is usually not the one being sent back. Return goods from a 120-taka
-- purchase while an older 100-taka lot is still open, and FIFO removes the
-- 100-taka stock, leaving the 120-taka goods on the shelf. The quantity ends up
-- right and the stock VALUE wrong, and every later sale inherits the error.
--
-- Goods going back to a supplier are specific goods. They leave from the lot
-- that purchase created.
-- =========================================================================

create or replace function consume_specific_lot(
  p_shop uuid, p_purchase_line uuid, p_product uuid, p_qty numeric,
  p_consumer_table text, p_consumer_id uuid
) returns numeric language plpgsql set search_path = public as $$
declare
  v_left numeric(18,3) := p_qty;
  v_cost numeric(18,2) := 0;
  v_take numeric(18,3);
  r      record;
begin
  -- The lot this purchase line created, first.
  for r in
    select id, qty_remaining, unit_cost
    from stock_lots
    where shop_id = p_shop and product_id = p_product
      and source_table = 'purchase_lines' and source_id = p_purchase_line
      and qty_remaining > 0
    for update
  loop
    exit when v_left <= 0.0001;
    v_take := least(r.qty_remaining, v_left);
    update stock_lots set qty_remaining = qty_remaining - v_take where id = r.id;
    insert into stock_lot_consumption (shop_id, lot_id, consumer_table, consumer_id, qty, unit_cost)
    values (p_shop, r.id, p_consumer_table, p_consumer_id, v_take, r.unit_cost);
    v_cost := v_cost + round(v_take * r.unit_cost, 2);
    v_left := v_left - v_take;
  end loop;

  -- Whatever that lot can no longer cover has already been sold, so it falls
  -- back to FIFO. Rare, and better than refusing a return the shop has
  -- physically made.
  if v_left > 0.0001 then
    v_cost := v_cost + consume_fifo(p_shop, p_product, v_left, p_consumer_table, p_consumer_id);
  end if;

  return v_cost;
end $$;

comment on function consume_specific_lot is
  'Removes stock from the lot a named purchase line created, falling back to FIFO for any shortfall. Used by purchase returns, where the goods going back are specific goods.';

-- Re-point post_return at it. Only the purchase-return branch changes.
create or replace function post_return(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key text := p_payload->>'idempotency_key'; v_hit jsonb;
  v_kind text := p_payload->>'kind';
  v_date date := (p_payload->>'business_date')::date;
  v_at timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_party uuid := nullif(p_payload->>'party_id', '')::uuid;
  v_orig_s uuid := nullif(p_payload->>'original_sale_id', '')::uuid;
  v_orig_p uuid := nullif(p_payload->>'original_purchase_id', '')::uuid;
  v_refund numeric(18,2) := coalesce((p_payload->>'refund_cash')::numeric, 0);
  v_account uuid := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_id uuid; v_no text; v_line jsonb; v_i int := 0;
  v_orig_ln uuid; v_qty numeric(18,3); v_price numeric(18,4);
  v_line_id uuid; v_product uuid; v_unit_cost numeric(18,4);
  v_cost numeric(18,2); v_total numeric(18,2) := 0; v_totcost numeric(18,2) := 0;
  v_result jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);
  perform assert_party_in_shop(p_shop, v_party);

  if v_kind not in ('sale_return', 'purchase_return') then
    raise exception 'INVALID_KIND: return kind must be sale_return or purchase_return.';
  end if;
  if jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)) = 0 then
    raise exception 'EMPTY_DOCUMENT: a return must have at least one line.';
  end if;

  v_no := next_document_no(p_shop,
            case when v_kind = 'sale_return' then 'sale_return' else 'purchase_return' end, v_date);

  insert into returns (shop_id, return_no, kind, party_id, original_sale_id,
                       original_purchase_id, occurred_at, business_date, note, created_by)
  values (p_shop, v_no, v_kind, v_party, v_orig_s, v_orig_p, v_at, v_date,
          coalesce(p_payload->>'note', ''), auth.uid())
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_i := v_i + 1;
    v_orig_ln := (v_line->>'original_line_id')::uuid;
    v_qty := (v_line->>'qty_base')::numeric;
    v_price := (v_line->>'unit_price')::numeric;

    if v_kind = 'sale_return' then
      select sl.product_id,
             case when sl.qty_base > 0 then sl.cogs_amount / sl.qty_base else 0 end
        into v_product, v_unit_cost
      from sale_lines sl where sl.id = v_orig_ln and sl.shop_id = p_shop;
      if v_product is null then
        raise exception 'ORIGINAL_LINE_NOT_FOUND: a sale return must reference the sale line it reverses.';
      end if;
      v_cost := round(v_qty * v_unit_cost, 2);

      insert into return_lines (shop_id, return_id, line_no, product_id,
                                original_sale_line_id, product_name, unit_name,
                                qty_base, unit_price, cost_amount)
      select p_shop, v_id, v_i, sl.product_id, sl.id, sl.product_name, sl.unit_name,
             v_qty, v_price, v_cost
      from sale_lines sl where sl.id = v_orig_ln
      returning id into v_line_id;

      insert into stock_lots (shop_id, product_id, source_table, source_id,
                              received_at, business_date, qty_received, qty_remaining, unit_cost)
      values (p_shop, v_product, 'return_lines', v_line_id, v_at, v_date, v_qty, v_qty, v_unit_cost);

      insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                       occurred_at, business_date, source_table, source_id, created_by)
      values (p_shop, v_product, 'sale_return', v_qty, v_at, v_date, 'return_lines', v_line_id, auth.uid());
    else
      select pl.product_id into v_product
      from purchase_lines pl where pl.id = v_orig_ln and pl.shop_id = p_shop;
      if v_product is null then
        raise exception 'ORIGINAL_LINE_NOT_FOUND: a purchase return must reference the purchase line it reverses.';
      end if;

      insert into return_lines (shop_id, return_id, line_no, product_id,
                                original_purchase_line_id, product_name, unit_name,
                                qty_base, unit_price, cost_amount)
      select p_shop, v_id, v_i, pl.product_id, pl.id, pl.product_name, pl.unit_name,
             v_qty, v_price, 0
      from purchase_lines pl where pl.id = v_orig_ln
      returning id into v_line_id;

      -- CHANGED: from the lot that purchase created, not the oldest open lot.
      v_cost := consume_specific_lot(p_shop, v_orig_ln, v_product, v_qty, 'return_lines', v_line_id);
      update return_lines set cost_amount = v_cost where id = v_line_id;

      insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                       occurred_at, business_date, source_table, source_id, created_by)
      values (p_shop, v_product, 'purchase_return', -v_qty, v_at, v_date, 'return_lines', v_line_id, auth.uid());
    end if;

    v_total := v_total + round(v_qty * v_price, 2);
    v_totcost := v_totcost + v_cost;
  end loop;

  if v_refund > 0 then
    if v_account is null then v_account := default_cash_account(p_shop); end if;
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    values (p_shop, v_account, case when v_kind = 'sale_return' then 'out' else 'in' end,
            v_refund, v_at, v_date, 'returns', v_id, 'Return ' || v_no, auth.uid());
  end if;

  if v_total - v_refund > 0.001 and v_party is not null then
    insert into party_bills (shop_id, party_id, direction, source_table, source_id,
                             occurred_at, business_date, amount, note, created_by)
    values (p_shop, v_party,
            case when v_kind = 'sale_return' then 'payable' else 'receivable' end,
            'returns', v_id, v_at, v_date, v_total - v_refund,
            'Credit for return ' || v_no, auth.uid());
  end if;

  perform write_audit(p_shop, 'return_posted', 'returns', v_id, null,
                      jsonb_build_object('return_no', v_no, 'kind', v_kind,
                                         'total', v_total, 'cost', v_totcost));

  v_result := jsonb_build_object('ok', true, 'return_id', v_id, 'return_no', v_no,
                                 'total', v_total, 'cost', v_totcost);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_return', v_result) on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

revoke all on function consume_specific_lot(uuid, uuid, uuid, numeric, text, uuid)
  from public, anon, authenticated;
grant execute on function post_return(uuid, jsonb) to authenticated;

select 'purchase returns now leave from the lot that purchase created' as note;
