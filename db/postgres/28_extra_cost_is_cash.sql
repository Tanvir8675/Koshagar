-- =========================================================================
-- KoshAgar ERP — 28_extra_cost_is_cash.sql
--
-- Your rule, stated plainly: extra cost on a purchase is CARRYING AND LABOUR.
-- It is paid at the gate, out of the drawer, and the supplier is never owed it.
--
-- post_purchase had it folded into the bill total:
--
--     v_net := gross - discount + extra          -- and the payable was net - cash
--
-- so 300 taka of freight on a part-paid purchase became 300 taka the supplier
-- was owed. That is wrong twice: the supplier's balance is overstated, and the
-- cash that actually left the counter is understated.
--
-- After this:
--   * the supplier is owed  (gross - discount) - cash_paid   -- goods only
--   * the drawer loses      cash_paid + extra                -- goods plus freight
--   * landed cost still carries each line's share of the extra, so stock value
--     and COGS are unchanged - the goods really did cost that much to get here
--
-- This matches financial.js line 152, which subtracts extra cost as cash out
-- unconditionally and never puts it on the supplier's account.
-- =========================================================================

create or replace function post_purchase(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key        text  := p_payload->>'idempotency_key';
  v_hit        jsonb;
  v_date       date  := (p_payload->>'business_date')::date;
  v_at         timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_party      uuid  := nullif(p_payload->>'party_id', '')::uuid;
  v_discount   numeric(18,2) := coalesce((p_payload->>'bill_discount')::numeric, 0);
  v_extra      numeric(18,2) := coalesce((p_payload->>'extra_cost')::numeric, 0);
  v_cash_paid  numeric(18,2) := coalesce((p_payload->>'cash_paid')::numeric, 0);
  v_account    uuid  := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_id         uuid; v_no text; v_line jsonb; v_i int := 0;
  v_product    uuid; v_unit uuid; v_factor numeric(18,6);
  v_qty_base   numeric(18,3); v_line_total numeric(18,2); v_line_id uuid;
  v_gross      numeric(18,2) := 0;
  v_goods      numeric(18,2);          -- what the supplier is owed for, before cash
  v_landed     numeric(18,4);
  v_owed       numeric(18,2);
  v_result     jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);
  perform assert_party_in_shop(p_shop, v_party);

  if jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)) = 0 then
    raise exception 'EMPTY_DOCUMENT: a purchase must have at least one line.';
  end if;
  if v_extra < 0 then
    raise exception 'INVALID_AMOUNT: extra cost cannot be negative.';
  end if;

  v_no := next_document_no(p_shop, 'purchase', v_date);

  insert into purchases (shop_id, bill_no, party_id, occurred_at, business_date,
                         bill_discount, extra_cost, note, created_by)
  values (p_shop, v_no, v_party, v_at, v_date, v_discount, v_extra,
          coalesce(p_payload->>'note', ''), auth.uid())
  returning id into v_id;

  -- Pass 1: the lines, and the gross they add up to.
  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_i := v_i + 1;
    v_product := (v_line->>'product_id')::uuid;
    v_unit    := (v_line->>'unit_id')::uuid;
    v_factor  := resolve_conversion(p_shop, v_product, v_unit);
    v_qty_base := round((v_line->>'qty_entered')::numeric * v_factor, 3);

    insert into purchase_lines (shop_id, purchase_id, line_no, product_id, unit_id,
                                product_name, unit_name, entry_factor,
                                qty_entered, qty_base, unit_price, line_discount,
                                landed_unit_cost)
    select p_shop, v_id, v_i, v_product, v_unit, p.name, u.name, v_factor,
           (v_line->>'qty_entered')::numeric, v_qty_base,
           (v_line->>'unit_price')::numeric,
           coalesce((v_line->>'line_discount')::numeric, 0), 0
    from products p, units u
    where p.id = v_product and p.shop_id = p_shop
      and u.id = v_unit    and u.shop_id = p_shop
    returning id, line_total into v_line_id, v_line_total;

    if v_line_id is null then
      raise exception 'PRODUCT_NOT_FOUND: a line refers to a product or unit that is not in this shop.';
    end if;
    v_gross := v_gross + v_line_total;
  end loop;

  -- The goods. Freight is deliberately NOT in here.
  v_goods := v_gross - v_discount;

  -- Pass 2: landed cost keeps its share of the freight, because the goods did
  -- cost that much to get onto the shelf even though the supplier is not owed it.
  for v_line_id, v_line_total, v_qty_base in
    select id, line_total, qty_base from purchase_lines
    where purchase_id = v_id order by line_no
  loop
    v_landed := case when v_qty_base > 0 and v_gross > 0
      then round(((v_line_total
                   - round(v_discount * v_line_total / v_gross, 2)
                   + round(v_extra    * v_line_total / v_gross, 2)) / v_qty_base), 4)
      else 0 end;

    update purchase_lines set landed_unit_cost = v_landed where id = v_line_id;

    insert into stock_lots (shop_id, product_id, source_table, source_id,
                            received_at, business_date, qty_received, qty_remaining, unit_cost)
    select p_shop, pl.product_id, 'purchase_lines', pl.id,
           v_at, v_date, pl.qty_base, pl.qty_base, v_landed
    from purchase_lines pl where pl.id = v_line_id;

    insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                     occurred_at, business_date, source_table, source_id, created_by)
    select p_shop, pl.product_id, 'purchase', pl.qty_base,
           v_at, v_date, 'purchase_lines', pl.id, auth.uid()
    from purchase_lines pl where pl.id = v_line_id;
  end loop;

  -- Cash is capped against the GOODS. Paying more than the goods are worth is
  -- the overpayment you ruled out. Freight is separate and always leaves.
  if v_cash_paid > v_goods + 0.001 then
    raise exception 'CASH_EXCEEDS_TOTAL: paid % against goods of %.', v_cash_paid, v_goods;
  end if;

  if v_cash_paid + v_extra > 0 then
    if v_account is null then v_account := default_cash_account(p_shop); end if;
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    values (p_shop, v_account, 'out', v_cash_paid + v_extra, v_at, v_date,
            'purchases', v_id,
            case when v_extra > 0
                 then 'Purchase ' || v_no || ' (incl. ' || v_extra || ' carrying)'
                 else 'Purchase ' || v_no end,
            auth.uid());
  end if;

  -- What is still owed: goods only.
  v_owed := round(v_goods - v_cash_paid, 2);
  if v_owed > 0.001 then
    if v_party is null then
      raise exception 'PARTY_REQUIRED: an unpaid purchase must name the supplier it is owed to.';
    end if;
    insert into party_bills (shop_id, party_id, direction, source_table, source_id,
                             occurred_at, business_date, amount, note, created_by)
    values (p_shop, v_party, 'payable', 'purchases', v_id, v_at, v_date, v_owed,
            'Purchase ' || v_no, auth.uid());
  end if;

  perform write_audit(p_shop, 'purchase_posted', 'purchases', v_id, null,
                      jsonb_build_object('bill_no', v_no, 'goods', v_goods,
                                         'extra_cost', v_extra,
                                         'cash_paid', v_cash_paid, 'owed', v_owed));

  v_result := jsonb_build_object('ok', true, 'purchase_id', v_id, 'bill_no', v_no,
                                 'goods', v_goods, 'extra_cost', v_extra,
                                 'cash_out', v_cash_paid + v_extra, 'owed', v_owed);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_purchase', v_result) on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

grant execute on function post_purchase(uuid, jsonb) to authenticated;

select 'extra cost now leaves the drawer and never joins the supplier balance' as note;
