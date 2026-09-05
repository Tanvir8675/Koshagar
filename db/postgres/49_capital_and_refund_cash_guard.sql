-- =========================================================================
-- KoshAgar ERP - 49_capital_and_refund_cash_guard.sql
--
-- THE LAST TWO WAYS CASH COULD LEAVE A DRAWER THAT WAS ALREADY EMPTY
--
-- post_cash_withdrawal() has always refused to overdraw. 45, 46 and 47 gave the
-- same refusal to purchases, expenses and supplier payments. Two paths were
-- still open:
--
--   * post_capital_movement(kind = 'out')  - the owner taking money out
--   * post_return(refund_cash > 0)         - a customer handed money back
--
-- Both are closed here, by the same rule and with the same wording: the
-- balance is read with cash_balance_as_of() on the document's own business
-- date, so a backdated entry is judged against the drawer as it stood then.
--
-- ON REVERSALS - THE WORRY DOES NOT APPLY
--
-- The concern with guarding cash-out is that undoing a wrong document could
-- itself be refused, leaving a mistake permanently in the books. It cannot
-- happen here. Every reverse_* function writes its mirror row STRAIGHT INTO
-- cash_ledger and never calls the posting function - reverse_expense and
-- reverse_capital_movement (24_reverse_cash_documents.sql), reverse_payment
-- (07) and reverse_return all do this. None of them passes through the checks
-- added in 45-49, so a correction is always possible even when the money has
-- since been spent. That is the right split: entering NEW money that is not
-- there is an error, while undoing an entry is a correction of the record.
--
-- Nothing else in either function changes. Both are reproduced whole from
-- 08_cash_documents.sql and 31_return_party.sql with the guard inserted, since
-- Postgres replaces a function entire.
-- =========================================================================

create or replace function post_capital_movement(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key     text := p_payload->>'idempotency_key';
  v_hit     jsonb;
  v_date    date := (p_payload->>'business_date')::date;
  v_at      timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_kind    text := p_payload->>'kind';           -- 'in' or 'out'
  v_amount  numeric(18,2) := (p_payload->>'amount')::numeric;
  v_account uuid := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_id      uuid;
  v_result  jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);

  if v_kind not in ('in', 'out') then
    raise exception 'INVALID_KIND: capital movement must be "in" (money into the business) or "out".';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'INVALID_AMOUNT: a capital movement must be greater than zero.';
  end if;
  if v_account is null then v_account := default_cash_account(p_shop); end if;

  -- THE DRAWER CANNOT PAY OUT WHAT IT DOES NOT HOLD.
  --
  -- Taking capital out is spending shop cash on the owner. Nothing checked the
  -- balance, so a withdrawal larger than the drawer was accepted and the books
  -- carried a negative balance nobody had entered - the same hole that 45 and
  -- 46 closed for purchases and expenses.
  --
  -- Only 'out' is checked. Putting capital IN adds cash and can never overdraw.
  --
  -- Checked as of the movement's own business date, so a backdated withdrawal
  -- is judged against the drawer as it stood that day.
  if v_kind = 'out'
     and v_amount > cash_balance_as_of(p_shop, v_account, v_date) + 0.001 then
    raise exception
      'INSUFFICIENT_CASH: the drawer holds % on %, so % cannot be withdrawn. Record where the money came from first.',
      round(cash_balance_as_of(p_shop, v_account, v_date), 2), v_date, v_amount;
  end if;

  insert into capital_movements (shop_id, cash_account_id, kind, note, amount,
                                 occurred_at, business_date, created_by)
  values (p_shop, v_account, v_kind, coalesce(p_payload->>'note', ''),
          v_amount, v_at, v_date, auth.uid())
  returning id into v_id;

  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, v_kind, v_amount, v_at, v_date,
          'capital_movements', v_id,
          coalesce(p_payload->>'note', 'Capital ' || v_kind), auth.uid());

  perform write_audit(p_shop, 'capital_posted', 'capital_movements', v_id, null,
                      jsonb_build_object('kind', v_kind, 'amount', v_amount));

  v_result := jsonb_build_object('ok', true, 'capital_id', v_id,
                                 'kind', v_kind, 'amount', v_amount);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_capital_movement', v_result) on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

-- ---------------------------------------------------------------------
-- post_return - the refund leg
-- ---------------------------------------------------------------------
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

  -- A REFUND IS CASH LEAVING THE DRAWER, AND IT WAS UNGUARDED.
  --
  -- When a customer brings goods back and is handed money, that money must be
  -- in the drawer. It was never checked, so a refund larger than the balance
  -- went through and left the cash figure negative.
  --
  -- Only a sale_return refunds outward. On a purchase_return the shop RECEIVES
  -- the money back from its supplier, which adds cash and cannot overdraw - so
  -- that direction is left alone.
  --
  -- Checked before anything is written, and as of the return's own business
  -- date, so a backdated refund is judged against that day's drawer.
  if v_kind = 'sale_return' and v_refund > 0 then
    if v_account is null then v_account := default_cash_account(p_shop); end if;
    if v_refund > cash_balance_as_of(p_shop, v_account, v_date) + 0.001 then
      raise exception
        'INSUFFICIENT_CASH: the drawer holds % on %, so % cannot be refunded. Refund less in cash and leave the rest as credit to the customer.',
        round(cash_balance_as_of(p_shop, v_account, v_date), 2), v_date, v_refund;
    end if;
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

grant execute on function post_capital_movement(uuid, jsonb) to authenticated;
grant execute on function post_return(uuid, jsonb) to authenticated;

select 'capital withdrawal and cash refunds can no longer overdraw the drawer' as note;
