-- =========================================================================
-- KoshAgar ERP — 31_return_party.sql
--
-- WHY
-- Database Health Check reported the supplier owed 5,300 while the app showed
-- 150. Both were reading their own books correctly; the books disagreed.
--
-- A purchase return of 5,150 had been posted against PUR-2026-000002. The app
-- nets a return off the bill it came from, so it showed 12,350 owed less the
-- payments - 150 left. The database had the return, the returned stock and the
-- consumed lots, but NO credit note against the supplier, so the payable stayed
-- at its full 10,300 less the 5,000 paid.
--
-- The reason is one clause in post_return:
--
--     if v_total - v_refund > 0.001 and v_party is not null then
--         insert into party_bills ...                     -- the credit note
--
-- The return screen has no customer or supplier field, because a return is
-- filed against a bill that already names them - so the app sent party_id null,
-- and that guard quietly skipped the credit. Nothing failed. The money simply
-- was not recorded, and only a reconciliation months later would have found it.
--
-- WHAT CHANGES
--   1. The party is INHERITED from the original sale or purchase when the
--      caller does not name one. That is where it was always available.
--   2. A credit that still cannot be attached to anybody is now an ERROR, not a
--      skipped row. An anonymous cash sale must be refunded in cash.
--
-- Nothing else in the function is touched: the FIFO lot handling from
-- 22_purchase_return_cost.sql is carried over exactly as it was.
--
-- EXISTING DATA IS NOT REPAIRED HERE.
-- The return already posted has no credit note and this migration does not
-- invent one - inserting money by hand into party_bills is exactly the kind of
-- write this schema exists to prevent. Reverse that return in the app and enter
-- it again; it will then post correctly through the function below.
-- =========================================================================

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

  if v_kind not in ('sale_return', 'purchase_return') then
    raise exception 'INVALID_KIND: return kind must be sale_return or purchase_return.';
  end if;

  -- THE PARTY IS INHERITED, NOT REQUIRED OF THE CALLER.
  --
  -- A return screen has no customer or supplier field - it does not need one,
  -- because a return is filed against a bill that already names them. So the
  -- app sent no party, this function accepted it, and the credit note below was
  -- skipped by its `v_party is not null` guard without a word. The goods came
  -- back, the stock moved, and the supplier stayed owed the full amount.
  --
  -- Whoever the original bill belongs to is who the credit belongs to.
  if v_party is null then
    if v_kind = 'sale_return' then
      select s.party_id into v_party from sales s
       where s.id = coalesce(v_orig_s,
              (select sl.sale_id from sale_lines sl
                where sl.id = ((p_payload->'lines'->0->>'original_line_id')::uuid)))
         and s.shop_id = p_shop;
    else
      select pu.party_id into v_party from purchases pu
       where pu.id = coalesce(v_orig_p,
              (select pl.purchase_id from purchase_lines pl
                where pl.id = ((p_payload->'lines'->0->>'original_line_id')::uuid)))
         and pu.shop_id = p_shop;
    end if;
  end if;

  perform assert_party_in_shop(p_shop, v_party);

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

  -- Goods came back and cash did not go out for all of them: someone is owed
  -- the difference. If there is still no party after inheriting one, the
  -- original bill was an anonymous cash sale - and then a credit that cannot be
  -- attached to anybody is a refusal, not a row to skip. Saying so is the whole
  -- point: the old behaviour lost 5,150 of supplier credit without an error.
  if v_total - v_refund > 0.001 then
    if v_party is null then
      raise exception
        'PARTY_REQUIRED: this return is worth % more than the cash refunded, and the original bill names nobody to credit it to. Refund the full amount in cash instead.',
        round(v_total - v_refund, 2);
    end if;
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

grant execute on function post_return(uuid, jsonb) to authenticated;

select 'a return now credits the party its bill names, or refuses' as note;
