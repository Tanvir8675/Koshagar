-- =========================================================================
-- KoshAgar ERP — 29_edit_documents.sql
--
-- WHY THIS EXISTS
-- The app's edit button had nowhere to go. runEngineCommand() refuses any
-- command without a server function, so "Save Changes" on a sale, purchase or
-- return answered "not available yet in the online version" - correctly, but
-- uselessly: a wrong quantity typed this morning could not be corrected at all.
--
-- WHAT AN EDIT IS, IN A LEDGER
-- Not an UPDATE. A posted document has already moved stock, cash and someone's
-- balance; rewriting its row would leave every one of those effects behind and
-- silently disagree with the books. An edit is therefore what a correction is
-- on paper: reverse the document, post the corrected one, leave both halves
-- visible. Stock, cash, the party's due and profit all follow from the rows
-- those two documents write, so all of them move together or none of them do.
--
-- The two halves have to happen together or not at all - a reversal that
-- succeeds while the repost fails would DELETE the shopkeeper's sale. A single
-- function call is a single transaction, which is the whole reason this lives
-- in the database rather than in two calls from write-shop.js.
--
-- WHAT IT REFUSES, AND WHY
--   * a bill a return has been filed against - the return points at the lines
--     about to be reversed, and would be left hanging
--   * a bill a payment has been allocated to - the money was applied to a bill
--     that is about to stop existing
--   * a purchase whose goods have been sold (from reverse_purchase)
--   * a sale return whose restored goods have been sold on again
-- In each case the honest instruction is on the message: undo the later
-- document first, or post a return instead.
--
-- The corrected document gets a NEW number. It is a new document; the old one
-- keeps its number and its reversal, so the sequence still explains itself.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 0. A column 28_extra_cost_is_cash.sql assumed and 03_operations.sql never
--    created. post_purchase writes purchase_lines.unit_id; without the column
--    every purchase fails. Harmless if it is already there.
-- -------------------------------------------------------------------------
alter table purchase_lines add column if not exists unit_id uuid references units(id);
alter table sale_lines     add column if not exists unit_id uuid references units(id);

-- -------------------------------------------------------------------------
-- 1. REVERSE A RETURN
--
-- The missing branch. reverse_document() knew about sales, purchases, payments,
-- the three cash documents and adjustments - never returns, so a mistyped
-- return could not be undone by any route at all.
--
-- A sale return CREATED a lot (the goods came back on the shelf); undoing it
-- takes that lot away, and refuses if the goods have since been sold, rather
-- than driving the shelf negative.
--
-- A purchase return CONSUMED lots (the goods went back to the supplier);
-- undoing it puts each quantity back into the exact lot it left, which keeps
-- FIFO position - and therefore the cost of every later sale - intact.
-- -------------------------------------------------------------------------
create or replace function reverse_return(p_shop uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_date date; v_status text; v_no text; v_kind text;
  v_cash numeric(18,2); v_sold numeric(18,3); r record;
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
      raise exception
        'RETURN_STOCK_SOLD: % of the returned goods have already been sold, so this return cannot be undone.',
        v_sold;
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

-- -------------------------------------------------------------------------
-- 2. The dispatcher, now complete.
-- -------------------------------------------------------------------------
create or replace function reverse_document(
  p_shop uuid, p_type text, p_id uuid, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = public as $fn$
begin
  case p_type
    when 'sale'             then return reverse_sale(p_shop, p_id, p_reason);
    when 'purchase'         then return reverse_purchase(p_shop, p_id, p_reason);
    when 'return'           then return reverse_return(p_shop, p_id, p_reason);
    when 'payment'          then return reverse_payment(p_shop, p_id, p_reason);
    when 'expense'          then return reverse_expense(p_shop, p_id, p_reason);
    when 'cash_withdrawal'  then return reverse_cash_withdrawal(p_shop, p_id, p_reason);
    when 'capital_movement' then return reverse_capital_movement(p_shop, p_id, p_reason);
    when 'adjustment'       then return reverse_adjustment(p_shop, p_id, p_reason);
    else raise exception 'INVALID_TYPE: cannot reverse a document of type "%".', p_type;
  end case;
end $fn$;

-- -------------------------------------------------------------------------
-- 3. EDIT = REVERSE + REPOST, in one transaction.
--
-- Covers sales, purchases, returns, expenses, cash withdrawals and stock
-- adjustments - every screen in the app that offers an edit button.
--
-- p_payload is a complete posting payload for the corrected document - the same
-- shape post_sale/post_purchase/post_return already take, lines and all. The
-- caller sends the WHOLE document, not a patch: a bill's total is its lines, so
-- a payload with one line missing means a bill with one line fewer, said out
-- loud rather than by accident.
-- -------------------------------------------------------------------------
create or replace function edit_document(
  p_shop uuid, p_type text, p_id uuid, p_payload jsonb, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_key    text := p_payload->>'idempotency_key';
  v_hit    jsonb;
  v_table  text;
  v_reason text := coalesce(nullif(p_reason, ''), 'Corrected in the app');
  v_result jsonb;
begin
  if p_type not in ('sale', 'purchase', 'return',
                    'expense', 'cash_withdrawal', 'adjustment', 'payment') then
    raise exception 'INVALID_TYPE: cannot edit a document of type "%".', p_type;
  end if;

  -- A retry of the same user action returns what the first attempt posted,
  -- rather than reversing a second document. The key is recorded by the
  -- post_* function below; this only reads it.
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  v_table := case p_type when 'sale'            then 'sales'
                         when 'purchase'        then 'purchases'
                         when 'return'          then 'returns'
                         when 'expense'         then 'expenses'
                         when 'cash_withdrawal' then 'cash_withdrawals'
                         when 'payment'         then 'payments'
                         else 'adjustments' end;

  -- A return points at the lines that are about to be reversed.
  if p_type in ('sale', 'purchase') then
    if exists (
      select 1 from returns r
      where r.shop_id = p_shop and r.status = 'posted'
        and (case when p_type = 'sale' then r.original_sale_id
                  else r.original_purchase_id end) = p_id
    ) then
      raise exception
        'HAS_RETURNS: a return has already been filed against this bill. Undo the return first, then edit the bill.';
    end if;
  end if;

  -- Money already applied to the bill this edit would void.
  if exists (
    select 1
    from payment_allocations a
    join party_bills b on b.id = a.bill_id
    join payments   pm on pm.id = a.payment_id
    where b.shop_id = p_shop and b.source_table = v_table and b.source_id = p_id
      and pm.status = 'posted'
  ) then
    raise exception
      'HAS_PAYMENTS: a payment has already been settled against this bill. Undo the payment first, then edit the bill.';
  end if;

  case p_type
    when 'sale' then
      perform reverse_sale(p_shop, p_id, v_reason);
      v_result := post_sale(p_shop, p_payload);
    when 'purchase' then
      perform reverse_purchase(p_shop, p_id, v_reason);
      v_result := post_purchase(p_shop, p_payload);
    when 'return' then
      perform reverse_return(p_shop, p_id, v_reason);
      v_result := post_return(p_shop, p_payload);
    when 'expense' then
      perform reverse_expense(p_shop, p_id, v_reason);
      v_result := post_expense(p_shop, p_payload);
    when 'cash_withdrawal' then
      perform reverse_cash_withdrawal(p_shop, p_id, v_reason);
      v_result := post_cash_withdrawal(p_shop, p_payload);
    when 'payment' then
      -- The corrected amount is re-allocated from scratch, oldest bill first,
      -- exactly as a payment taken today would be. Anything above what is owed
      -- is still refused by record_payment, so an edit cannot slip past the
      -- overpayment rule that a straight UPDATE would have gone round.
      perform reverse_payment(p_shop, p_id, v_reason);
      v_result := record_payment(p_shop, p_payload);
    else
      perform reverse_adjustment(p_shop, p_id, v_reason);
      v_result := post_adjustment(p_shop, p_payload);
  end case;

  perform write_audit(p_shop, 'document_edited', v_table, p_id, null,
                      jsonb_build_object('type', p_type, 'reason', v_reason,
                                         'replacement', v_result));

  return v_result || jsonb_build_object('replaced_id', p_id, 'edited', true);
end $fn$;

comment on function edit_document is
  'Corrects a posted document by reversing it and posting the corrected one in the same transaction. Handles sale, purchase, return, expense, cash_withdrawal and adjustment. Both halves stay visible; the correction carries a new document number.';

revoke all on function reverse_return(uuid, uuid, text) from public, anon;
grant execute on function reverse_document(uuid, text, uuid, text) to authenticated;
grant execute on function edit_document(uuid, text, uuid, jsonb, text) to authenticated;

select 'returns can be reversed, and sales, purchases and returns can be edited' as note;
