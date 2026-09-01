-- =========================================================================
-- KoshAgar ERP — 07_returns_reversals.sql
--
-- Two different things that are often confused:
--
--   A RETURN is a real event. Goods physically came back, or went back to the
--   supplier. The original sale stays true - it happened - and the return is a
--   new document that partly undoes its effect.
--
--   A REVERSAL is a correction. The original document should not have existed
--   in that form. It stays in the books marked 'reversed', with a compensating
--   document linked to it, because your decision was that nothing posted is
--   ever deleted.
--
-- THE COSTING RULE THAT MATTERS
-- A sale return restores stock at the cost the original sale CONSUMED, not at
-- today's cost. Otherwise returning goods after a price rise would manufacture
-- profit out of nothing: sold at a cost of 10, returned at a cost of 12, and
-- the books gain 2 for free.
-- =========================================================================

-- =========================================================================
-- POST RETURN
--
-- payload:
--   { idempotency_key, business_date, occurred_at, kind, party_id,
--     original_sale_id | original_purchase_id, refund_cash, cash_account_id,
--     lines: [ { original_line_id, qty_base, unit_price } ] }
-- =========================================================================
create or replace function post_return(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key      text := p_payload->>'idempotency_key';
  v_hit      jsonb;
  v_kind     text := p_payload->>'kind';
  v_date     date := (p_payload->>'business_date')::date;
  v_at       timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_party    uuid := nullif(p_payload->>'party_id', '')::uuid;
  v_orig_s   uuid := nullif(p_payload->>'original_sale_id', '')::uuid;
  v_orig_p   uuid := nullif(p_payload->>'original_purchase_id', '')::uuid;
  v_refund   numeric(18,2) := coalesce((p_payload->>'refund_cash')::numeric, 0);
  v_account  uuid := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_id       uuid;
  v_no       text;
  v_line     jsonb;
  v_i        int := 0;
  v_orig_ln  uuid;
  v_qty      numeric(18,3);
  v_price    numeric(18,4);
  v_line_id  uuid;
  v_product  uuid;
  v_unit_cost numeric(18,4);
  v_cost     numeric(18,2);
  v_total    numeric(18,2) := 0;
  v_totcost  numeric(18,2) := 0;
  v_result   jsonb;
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
            case when v_kind = 'sale_return' then 'sale_return' else 'purchase_return' end,
            v_date);

  insert into returns (shop_id, return_no, kind, party_id,
                       original_sale_id, original_purchase_id,
                       occurred_at, business_date, note, created_by)
  values (p_shop, v_no, v_kind, v_party, v_orig_s, v_orig_p, v_at, v_date,
          coalesce(p_payload->>'note', ''), auth.uid())
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_i := v_i + 1;
    v_orig_ln := (v_line->>'original_line_id')::uuid;
    v_qty     := (v_line->>'qty_base')::numeric;
    v_price   := (v_line->>'unit_price')::numeric;

    if v_kind = 'sale_return' then
      -- Cost comes from what the original sale actually consumed. Requiring the
      -- original line is what makes that possible; a return with no original
      -- has no defensible cost.
      select sl.product_id,
             case when sl.qty_base > 0 then sl.cogs_amount / sl.qty_base else 0 end
        into v_product, v_unit_cost
      from sale_lines sl
      where sl.id = v_orig_ln and sl.shop_id = p_shop;

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

      -- Goods are back on the shelf: a new lot at the cost they left at.
      insert into stock_lots (shop_id, product_id, source_table, source_id,
                              received_at, business_date, qty_received, qty_remaining, unit_cost)
      values (p_shop, v_product, 'return_lines', v_line_id,
              v_at, v_date, v_qty, v_qty, v_unit_cost);

      insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                       occurred_at, business_date, source_table, source_id, created_by)
      values (p_shop, v_product, 'sale_return', v_qty, v_at, v_date,
              'return_lines', v_line_id, auth.uid());

    else
      -- Purchase return: goods go back to the supplier, so stock leaves at its
      -- own FIFO cost, exactly as a sale would.
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

      v_cost := consume_fifo(p_shop, v_product, v_qty, 'return_lines', v_line_id);
      update return_lines set cost_amount = v_cost where id = v_line_id;

      insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                       occurred_at, business_date, source_table, source_id, created_by)
      values (p_shop, v_product, 'purchase_return', -v_qty, v_at, v_date,
              'return_lines', v_line_id, auth.uid());
    end if;

    v_total   := v_total + round(v_qty * v_price, 2);
    v_totcost := v_totcost + v_cost;
  end loop;

  -- Money. A refund moves cash; anything not refunded reduces what is owed.
  if v_refund > 0 then
    if v_account is null then v_account := default_cash_account(p_shop); end if;
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    values (p_shop, v_account,
            case when v_kind = 'sale_return' then 'out' else 'in' end,
            v_refund, v_at, v_date, 'returns', v_id, 'Return ' || v_no, auth.uid());
  end if;

  if v_total - v_refund > 0.001 and v_party is not null then
    -- Reduce the party's balance by raising an opposite-direction bill. The
    -- allocation machinery then nets it off against what they owe.
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
    values (p_shop, v_key, 'post_return', v_result)
    on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

-- =========================================================================
-- REVERSE A SALE
--
-- A true undo. Stock goes back into the exact lots it came out of, which keeps
-- FIFO position intact - creating a fresh lot instead would put the goods at
-- the back of the queue and quietly change the cost of later sales.
-- =========================================================================
create or replace function reverse_sale(p_shop uuid, p_sale uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_date date; v_status text; v_no text; c record; v_cash numeric(18,2);
begin
  select business_date, status, invoice_no into v_date, v_status, v_no
    from sales where id = p_sale and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such sale in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: sale % has already been reversed.', v_no;
  end if;

  perform assert_period_writable(p_shop, v_date);

  -- Put every consumed quantity back into the lot it came from.
  for c in
    select c.lot_id, c.qty, c.consumer_id, sl.product_id
    from stock_lot_consumption c
    join sale_lines sl on sl.id = c.consumer_id
    where c.consumer_table = 'sale_lines' and sl.sale_id = p_sale
  loop
    update stock_lots set qty_remaining = qty_remaining + c.qty where id = c.lot_id;

    insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                     occurred_at, business_date, source_table, source_id, created_by)
    values (p_shop, c.product_id, 'reversal', c.qty, now(), v_date,
            'sale_lines', c.consumer_id, auth.uid());
  end loop;

  -- Undo the cash that came in.
  select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)
    into v_cash from cash_ledger where source_table = 'sales' and source_id = p_sale;

  if v_cash <> 0 then
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    select p_shop, cash_account_id,
           case when v_cash > 0 then 'out' else 'in' end,
           abs(v_cash), now(), v_date, 'sales', p_sale,
           'Reversal of ' || v_no, auth.uid()
    from cash_ledger where source_table = 'sales' and source_id = p_sale limit 1;
  end if;

  -- Void the receivable it raised. Allocations against it are refused from here
  -- on, because every balance calculation filters on status = 'open'.
  update party_bills set status = 'reversed'
   where source_table = 'sales' and source_id = p_sale;

  update sales set status = 'reversed' where id = p_sale;

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'sale', p_sale, p_sale, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'sale_reversed', 'sales', p_sale, null,
                      jsonb_build_object('invoice_no', v_no, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'sale_id', p_sale, 'invoice_no', v_no,
                            'status', 'reversed');
end $$;

-- =========================================================================
-- REVERSE A PURCHASE
--
-- Only possible while the goods are untouched. Once any of them has been sold,
-- reversing would have to claw stock back out of a completed sale - so the
-- correct action is a purchase return, and this refuses with that advice.
-- =========================================================================
create or replace function reverse_purchase(p_shop uuid, p_purchase uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_date date; v_status text; v_no text; v_sold numeric; v_cash numeric(18,2); l record;
begin
  select business_date, status, bill_no into v_date, v_status, v_no
    from purchases where id = p_purchase and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such purchase in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: purchase % has already been reversed.', v_no;
  end if;

  perform assert_period_writable(p_shop, v_date);

  select coalesce(sum(sl.qty_received - sl.qty_remaining), 0) into v_sold
  from stock_lots sl
  join purchase_lines pl on pl.id = sl.source_id and sl.source_table = 'purchase_lines'
  where pl.purchase_id = p_purchase;

  if v_sold > 0.0001 then
    raise exception
      'PURCHASE_PARTLY_SOLD: % of these goods have already been sold. Post a purchase return instead of reversing the bill.',
      v_sold;
  end if;

  for l in
    select sl.id as lot_id, sl.product_id, sl.qty_remaining
    from stock_lots sl
    join purchase_lines pl on pl.id = sl.source_id and sl.source_table = 'purchase_lines'
    where pl.purchase_id = p_purchase
  loop
    update stock_lots set qty_remaining = 0 where id = l.lot_id;

    insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                     occurred_at, business_date, source_table, source_id, created_by)
    values (p_shop, l.product_id, 'reversal', -l.qty_remaining, now(), v_date,
            'purchase_lines', l.lot_id, auth.uid());
  end loop;

  select coalesce(sum(case when direction = 'out' then amount else -amount end), 0)
    into v_cash from cash_ledger where source_table = 'purchases' and source_id = p_purchase;

  if v_cash <> 0 then
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    select p_shop, cash_account_id,
           case when v_cash > 0 then 'in' else 'out' end,
           abs(v_cash), now(), v_date, 'purchases', p_purchase,
           'Reversal of ' || v_no, auth.uid()
    from cash_ledger where source_table = 'purchases' and source_id = p_purchase limit 1;
  end if;

  update party_bills set status = 'reversed'
   where source_table = 'purchases' and source_id = p_purchase;

  update purchases set status = 'reversed' where id = p_purchase;

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'purchase', p_purchase, p_purchase, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'purchase_reversed', 'purchases', p_purchase, null,
                      jsonb_build_object('bill_no', v_no, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'purchase_id', p_purchase, 'bill_no', v_no,
                            'status', 'reversed');
end $$;

-- =========================================================================
-- REVERSE A PAYMENT
--
-- Marking it reversed is enough to undo its effect on every balance: both
-- bill_balance() and v_bill_balances only count allocations whose payment is
-- still 'posted'. The allocation rows stay as a record of what was settled.
-- =========================================================================
create or replace function reverse_payment(p_shop uuid, p_payment uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_date date; v_status text; v_no text; v_amount numeric(18,2);
        v_dir text; v_account uuid;
begin
  select business_date, status, payment_no, amount, direction, cash_account_id
    into v_date, v_status, v_no, v_amount, v_dir, v_account
    from payments where id = p_payment and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such payment in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: payment % has already been reversed.', v_no;
  end if;

  perform assert_period_writable(p_shop, v_date);

  update payments set status = 'reversed' where id = p_payment;

  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account,
          case when v_dir = 'in' then 'out' else 'in' end,
          v_amount, now(), v_date, 'payments', p_payment,
          'Reversal of ' || v_no, auth.uid());

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'payment', p_payment, p_payment, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'payment_reversed', 'payments', p_payment, null,
                      jsonb_build_object('payment_no', v_no, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'payment_id', p_payment, 'payment_no', v_no,
                            'status', 'reversed');
end $$;

-- =========================================================================
-- DISPATCHER — one entry point for the app
-- =========================================================================
create or replace function reverse_document(
  p_shop uuid, p_type text, p_id uuid, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  case p_type
    when 'sale'     then return reverse_sale(p_shop, p_id, p_reason);
    when 'purchase' then return reverse_purchase(p_shop, p_id, p_reason);
    when 'payment'  then return reverse_payment(p_shop, p_id, p_reason);
    else raise exception 'INVALID_TYPE: cannot reverse a document of type "%".', p_type;
  end case;
end $$;
