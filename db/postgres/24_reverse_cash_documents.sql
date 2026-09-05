-- =========================================================================
-- KoshAgar ERP — 24_reverse_cash_documents.sql
--
-- reverse_document() covered sales, purchases and payments only. But the app
-- has deleteExtraExpense, deleteCashWithdrawal and an undo for capital, and
-- those had nowhere to go: forbid_delete_posted refuses a hard delete (rightly),
-- and no reversal existed. A shopkeeper who typed 5000 instead of 500 was stuck.
--
-- Same shape as the existing reversals: the original is marked reversed and
-- KEPT, and an opposite cash row is written beside it. Both halves stay visible.
-- That is what "no silent delete" costs and what makes a wrong number
-- explainable a year later instead of just gone.
-- =========================================================================

-- document_reversals.original_type has a CHECK that only knows the document
-- kinds that existed when it was written. Widen it first, or every function
-- below fails on its audit row rather than on the work it actually did.
alter table document_reversals drop constraint if exists document_reversals_original_type_check;
alter table document_reversals add constraint document_reversals_original_type_check
  check (original_type in ('sale', 'purchase', 'return', 'adjustment', 'payment',
                           'expense', 'cash_withdrawal', 'capital_movement'));

create or replace function reverse_expense(p_shop uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_date date; v_status text; v_amount numeric(18,2); v_account uuid; v_note text;
begin
  select business_date, status, amount, cash_account_id, note
    into v_date, v_status, v_amount, v_account, v_note
    from expenses where id = p_id and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such expense in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: that expense has already been reversed.';
  end if;

  perform assert_period_writable(p_shop, v_date);
  update expenses set status = 'reversed' where id = p_id;

  -- An expense took cash out, so the reversal puts it back.
  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, 'in', v_amount, now(), v_date, 'expenses', p_id,
          'Reversal of expense: ' || coalesce(v_note, ''), auth.uid());

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'expense', p_id, p_id, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'expense_reversed', 'expenses', p_id, null,
                      jsonb_build_object('amount', v_amount, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'expense_id', p_id, 'status', 'reversed');
end $$;

create or replace function reverse_cash_withdrawal(p_shop uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_date date; v_status text; v_amount numeric(18,2); v_account uuid; v_reason text;
begin
  select business_date, status, amount, cash_account_id, reason
    into v_date, v_status, v_amount, v_account, v_reason
    from cash_withdrawals where id = p_id and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such withdrawal in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: that withdrawal has already been reversed.';
  end if;

  perform assert_period_writable(p_shop, v_date);
  update cash_withdrawals set status = 'reversed' where id = p_id;

  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, 'in', v_amount, now(), v_date, 'cash_withdrawals', p_id,
          'Reversal of withdrawal: ' || coalesce(v_reason, ''), auth.uid());

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'cash_withdrawal', p_id, p_id, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'withdrawal_reversed', 'cash_withdrawals', p_id, null,
                      jsonb_build_object('amount', v_amount, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'withdrawal_id', p_id, 'status', 'reversed');
end $$;

create or replace function reverse_capital_movement(p_shop uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_date date; v_status text; v_amount numeric(18,2); v_account uuid; v_dir text;
begin
  -- the column is `kind` here ('in' / 'out'), not `direction` as on payments
  select business_date, status, amount, cash_account_id, kind
    into v_date, v_status, v_amount, v_account, v_dir
    from capital_movements where id = p_id and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such capital movement in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: that capital entry has already been reversed.';
  end if;

  perform assert_period_writable(p_shop, v_date);
  update capital_movements set status = 'reversed' where id = p_id;

  -- Money in reverses as money out, and the other way round.
  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, case when v_dir = 'in' then 'out' else 'in' end,
          v_amount, now(), v_date, 'capital_movements', p_id,
          'Reversal of capital ' || v_dir, auth.uid());

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'capital_movement', p_id, p_id, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'capital_reversed', 'capital_movements', p_id, null,
                      jsonb_build_object('amount', v_amount, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'capital_id', p_id, 'status', 'reversed');
end $$;

-- Widen the dispatcher to know about them.
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
    else raise exception 'INVALID_TYPE: cannot reverse a document of type "%".', p_type;
  end case;
end $$;

revoke all on function reverse_expense(uuid, uuid, text)          from public, anon;
revoke all on function reverse_cash_withdrawal(uuid, uuid, text)  from public, anon;
revoke all on function reverse_capital_movement(uuid, uuid, text) from public, anon;
grant execute on function reverse_document(uuid, text, uuid, text) to authenticated;

select 'expenses, withdrawals and capital can now be reversed' as note;
