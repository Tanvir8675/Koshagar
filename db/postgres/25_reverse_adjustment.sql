-- =========================================================================
-- KoshAgar ERP — 25_reverse_adjustment.sql
--
-- document_reversals already ALLOWED 'adjustment', but reverse_document had no
-- branch for it, so the app's "delete adjustment" button had nowhere to go.
-- Writing damage off is easy to get wrong in a hurry - the wrong product, the
-- wrong quantity - so undoing it has to be possible.
--
-- Reversing an adjustment means putting the stock back. Quantity returns as a
-- movement; it does NOT restore the original FIFO lots, because those were
-- consumed and their cost is already settled. The stock comes back at the cost
-- recorded on the adjustment, which is the honest answer.
-- =========================================================================

create or replace function reverse_adjustment(p_shop uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_date date; v_status text; v_kind text; v_product uuid;
  v_qty numeric(18,3); v_cost numeric(18,4);
begin
  select business_date, status, kind, product_id, qty_base, unit_cost
    into v_date, v_status, v_kind, v_product, v_qty, v_cost
    from adjustments where id = p_id and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such adjustment in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: that adjustment has already been reversed.';
  end if;

  perform assert_period_writable(p_shop, v_date);
  update adjustments set status = 'reversed' where id = p_id;

  if v_kind in ('opening', 'correction_in') then
    -- It ADDED stock, so undoing it takes that stock away. Refuse if the goods
    -- have since been sold, rather than driving the shelf negative.
    if coalesce((select qty from v_stock_on_hand
                  where shop_id = p_shop and product_id = v_product), 0) < v_qty then
      raise exception
        'INSUFFICIENT_STOCK: that stock has already been sold, so the adjustment cannot be undone.';
    end if;
    perform consume_fifo(p_shop, v_product, v_qty, 'adjustments', p_id);
    insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                     occurred_at, business_date, source_table, source_id, created_by)
    values (p_shop, v_product, 'adjustment', -v_qty, now(), v_date, 'adjustments', p_id, auth.uid());
  else
    -- It REMOVED stock, so undoing it puts the stock back at the cost recorded
    -- on the adjustment.
    insert into stock_lots (shop_id, product_id, source_table, source_id,
                            received_at, business_date, qty_received, qty_remaining, unit_cost)
    values (p_shop, v_product, 'adjustments', p_id, now(), v_date, v_qty, v_qty, coalesce(v_cost, 0));
    insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                     occurred_at, business_date, source_table, source_id, created_by)
    values (p_shop, v_product, 'adjustment', v_qty, now(), v_date, 'adjustments', p_id, auth.uid());
  end if;

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'adjustment', p_id, p_id, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'adjustment_reversed', 'adjustments', p_id, null,
                      jsonb_build_object('qty', v_qty, 'kind', v_kind, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'adjustment_id', p_id, 'status', 'reversed');
end $$;

create or replace function reverse_document(
  p_shop uuid, p_type text, p_id uuid, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  case p_type
    when 'sale'             then return reverse_sale(p_shop, p_id, p_reason);
    when 'purchase'         then return reverse_purchase(p_shop, p_id, p_reason);
    when 'payment'          then return reverse_payment(p_shop, p_id, p_reason);
    when 'expense'          then return reverse_expense(p_shop, p_id, p_reason);
    when 'cash_withdrawal'  then return reverse_cash_withdrawal(p_shop, p_id, p_reason);
    when 'capital_movement' then return reverse_capital_movement(p_shop, p_id, p_reason);
    when 'adjustment'       then return reverse_adjustment(p_shop, p_id, p_reason);
    else raise exception 'INVALID_TYPE: cannot reverse a document of type "%".', p_type;
  end case;
end $$;

revoke all on function reverse_adjustment(uuid, uuid, text) from public, anon;
grant execute on function reverse_document(uuid, text, uuid, text) to authenticated;

select 'adjustments can now be reversed' as note;
