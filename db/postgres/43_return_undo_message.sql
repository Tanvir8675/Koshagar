-- =========================================================================
-- KoshAgar ERP — 43_return_undo_message.sql
--
-- SAYING WHICH SALE IS IN THE WAY
--
-- Undoing a sale return takes goods back off the shelf, and 29_edit_documents
-- refuses when some of those goods have since been sold. That refusal is right:
-- the stock cannot be un-returned once it has left again, and forcing it would
-- drive the shelf negative and leave a later sale costed against a lot the books
-- say never existed.
--
-- What was wrong was the wording. The shopkeeper was told:
--
--   1.000 of the returned goods have already been sold, so this return
--   cannot be undone.
--
-- Two things a person needs are missing from that: WHICH sale is in the way,
-- and WHAT to do about it. Without them the message reads as "the app will not
-- let you", which is where a shopkeeper stops and rings someone.
--
-- The answer is in the database already. stock_lot_consumption records which
-- document took each quantity out of which lot, so the sale that consumed the
-- returned lot can be named - and the way out follows from it: undo that sale
-- first, then this return. Later documents come off the top, like a stack.
--
-- Only the message changes. The rule, and everything else the function does,
-- is exactly as it was.
-- =========================================================================

create or replace function reverse_return(p_shop uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_date date; v_status text; v_no text; v_kind text;
  v_cash numeric(18,2); v_sold numeric(18,3); r record;
  v_blockers text;
begin
  select business_date, status, return_no, kind
    into v_date, v_status, v_no, v_kind
    from returns where id = p_id and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such return in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: return % has already been reversed.', v_no;
  end if;

  perform assert_period_writable(p_shop, v_date);

  if v_kind = 'sale_return' then
    select coalesce(sum(sl.qty_received - sl.qty_remaining), 0) into v_sold
    from stock_lots sl
    join return_lines rl on rl.id = sl.source_id and sl.source_table = 'return_lines'
    where rl.return_id = p_id;

    if v_sold > 0.0001 then
      -- Which documents took the returned goods back out. Named, and dated, so
      -- the shopkeeper can find them without searching.
      --
      -- Nearly always one sale; listed in case a return was split across
      -- several, and capped at three so a long list does not bury the
      -- instruction that follows it.
      select string_agg(x.label, ', ' order by x.occurred_at desc)
        into v_blockers
      from (
        select distinct s.invoice_no || ' (' || to_char(s.business_date, 'DD-MM-YYYY') || ')' as label,
               s.occurred_at
        from stock_lot_consumption c
        join stock_lots   sl on sl.id = c.lot_id
                            and sl.source_table = 'return_lines'
        join return_lines rl on rl.id = sl.source_id and rl.return_id = p_id
        join sale_lines   snl on snl.id = c.consumer_id and c.consumer_table = 'sale_lines'
        join sales        s   on s.id = snl.sale_id and s.status = 'posted'
        limit 3
      ) x;

      raise exception
        'RETURN_STOCK_SOLD: % of these returned goods have been sold again on %. Undo that sale first, then this return.',
        trim(to_char(v_sold, 'FM999999990.###')),
        coalesce(v_blockers, 'a later sale');
    end if;

    for r in
      select sl.id as lot_id, sl.product_id, sl.qty_remaining
      from stock_lots sl
      join return_lines rl on rl.id = sl.source_id and sl.source_table = 'return_lines'
      where rl.return_id = p_id
    loop
      update stock_lots set qty_remaining = 0 where id = r.lot_id;
      insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                       occurred_at, business_date, source_table, source_id, created_by)
      values (p_shop, r.product_id, 'reversal', -r.qty_remaining, now(), v_date,
              'return_lines', r.lot_id, auth.uid());
    end loop;
  else
    -- Put every consumed quantity back into the lot it came from.
    for r in
      select c.lot_id, c.qty, c.consumer_id, rl.product_id
      from stock_lot_consumption c
      join return_lines rl on rl.id = c.consumer_id
      where c.consumer_table = 'return_lines' and rl.return_id = p_id
    loop
      update stock_lots set qty_remaining = qty_remaining + r.qty where id = r.lot_id;
      insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                       occurred_at, business_date, source_table, source_id, created_by)
      values (p_shop, r.product_id, 'reversal', r.qty, now(), v_date,
              'return_lines', r.consumer_id, auth.uid());
    end loop;
  end if;

  -- Undo the refund, whichever way it went.
  select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)
    into v_cash from cash_ledger where source_table = 'returns' and source_id = p_id;

  if v_cash <> 0 then
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    select p_shop, cash_account_id,
           case when v_cash > 0 then 'out' else 'in' end,
           abs(v_cash), now(), v_date, 'returns', p_id,
           'Reversal of ' || v_no, auth.uid()
    from cash_ledger where source_table = 'returns' and source_id = p_id limit 1;
  end if;

  -- Void the credit note it raised.
  update party_bills set status = 'reversed'
   where source_table = 'returns' and source_id = p_id;

  update returns set status = 'reversed' where id = p_id;

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'return', p_id, p_id, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'return_reversed', 'returns', p_id, null,
                      jsonb_build_object('return_no', v_no, 'kind', v_kind, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'return_id', p_id, 'return_no', v_no,
                            'status', 'reversed');
end $fn$;

select 'reverse_return() now names the sale that blocks the undo' as note;
