-- =========================================================================
-- KoshAgar ERP - 46_expense_cash_guard.sql
--
-- AN EXPENSE CANNOT SPEND MONEY THE DRAWER DOES NOT HAVE
--
-- 45 gave post_purchase the overdraw check that post_cash_withdrawal has had
-- since 08_cash_documents.sql. This gives post_expense the same one, for the
-- same reason: the browser asked the question, the database did not, and a rule
-- that lives only on a screen is absent from every other way the same row can
-- be written.
--
-- Only the check is added; nothing else in the function changes.
--
-- STILL UNGUARDED, AND WHY THEY ARE LEFT FOR A DECISION
-- Three other paths take cash out of the drawer without asking whether it is
-- there: a payment to a supplier (record_payment, direction out), an owner's
-- capital withdrawal, and a cash refund on a return. The same guard fits all
-- three - but it would also refuse a REVERSAL. Undoing a sale puts its cash
-- back out of the drawer, and if that money has since been spent the undo would
-- be blocked, leaving a wrong document that cannot be corrected. That trade is
-- a decision about how the shop should work, not a technical detail, so it is
-- named here rather than settled quietly.
-- =========================================================================

create or replace function post_expense(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key     text := p_payload->>'idempotency_key';
  v_hit     jsonb;
  v_date    date := (p_payload->>'business_date')::date;
  v_at      timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
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

  if v_amount is null or v_amount <= 0 then
    raise exception 'INVALID_AMOUNT: an expense must be greater than zero.';
  end if;
  if v_account is null then v_account := default_cash_account(p_shop); end if;

  -- THE SAME RULE A WITHDRAWAL HAS ALWAYS HAD.
  --
  -- post_cash_withdrawal refuses to overdraw; an expense takes money out of the
  -- same drawer and did not. So tea money could be recorded on a day the drawer
  -- was empty, and the books carried a negative balance nobody had entered.
  --
  -- Checked as of the expense's own business date, so a backdated expense is
  -- judged against the drawer as it stood that day.
  if v_amount > cash_balance_as_of(p_shop, v_account, v_date) + 0.001 then
    raise exception
      'INSUFFICIENT_CASH: the drawer holds % on %, so % cannot be spent. Record where the money came from first.',
      round(cash_balance_as_of(p_shop, v_account, v_date), 2), v_date, v_amount;
  end if;

  insert into expenses (shop_id, cash_account_id, category, note, amount,
                        occurred_at, business_date, created_by)
  values (p_shop, v_account, coalesce(p_payload->>'category', ''),
          coalesce(p_payload->>'note', ''), v_amount, v_at, v_date, auth.uid())
  returning id into v_id;

  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, 'out', v_amount, v_at, v_date, 'expenses', v_id,
          coalesce(p_payload->>'note', 'Expense'), auth.uid());

  perform write_audit(p_shop, 'expense_posted', 'expenses', v_id, null,
                      jsonb_build_object('amount', v_amount));

  v_result := jsonb_build_object('ok', true, 'expense_id', v_id, 'amount', v_amount);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_expense', v_result) on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

select 'post_expense() now refuses to overdraw the drawer' as note;
