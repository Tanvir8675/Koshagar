-- =========================================================================
-- KoshAgar ERP — 44_reverse_sale_alias.sql
--
-- A NAME USED TWICE, AND A SALE THAT COULD NOT BE UNDONE
--
-- Undoing a sale failed with:
--
--   record "c" is not assigned yet
--
-- The loop that puts consumed stock back declares its record as `c`, and the
-- query inside it aliases stock_lot_consumption as `c` too:
--
--   for c in
--     select c.lot_id, c.qty, ...
--     from stock_lot_consumption c
--
-- plpgsql substitutes its own variables into a query before the planner sees
-- it, and a plpgsql variable wins over a table alias of the same name. So
-- `c.lot_id` was read as "the lot_id field of the record c" - a record that has
-- nothing in it until the loop has produced its first row. The loop could never
-- start, and the error names the symptom rather than the collision.
--
-- Nothing else in the function changes. The alias is renamed to `slc`, which no
-- variable shares.
--
-- WHY IT SURFACED ONLY NOW
-- Reversing a sale that consumed no stock never enters the loop's query, and
-- the earlier reversals in testing were of returns - reverse_return() writes the
-- same query but names its loop record `r`, so it never collided. The first
-- undo of an ordinary sale was the first time this line ran at all.
--
-- reverse_purchase() and reverse_return() were checked for the same pattern:
-- their loop records are `l` and `r`, and neither is used as an alias.
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
    select slc.lot_id, slc.qty, slc.consumer_id, sl.product_id
    from stock_lot_consumption slc
    join sale_lines sl on sl.id = slc.consumer_id
    where slc.consumer_table = 'sale_lines' and sl.sale_id = p_sale
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

select 'reverse_sale() no longer collides its loop record with a table alias' as note;
