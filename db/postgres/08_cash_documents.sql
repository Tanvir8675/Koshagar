-- =========================================================================
-- KoshAgar ERP — 08_cash_documents.sql
--
-- Posting functions for the three money documents that are not sales,
-- purchases or payments: expenses, owner capital, and cash withdrawals.
--
-- Each one exists for the same reason as post_sale: the document and its
-- cash_ledger row must be written together or not at all. A shop expense that
-- was recorded but never reached the cash ledger would leave the drawer
-- unexplained - and "why is the cash this amount?" is the question the ledger
-- exists to answer.
--
-- Kept as three separate documents rather than one generic "cash entry",
-- because your reports treat them differently: an expense reduces profit,
-- capital does not, and a withdrawal is the owner taking money out rather than
-- a cost of trading.
-- =========================================================================

-- =========================================================================
-- EXPENSE — a cost of trading. Reduces profit.
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

-- =========================================================================
-- CAPITAL MOVEMENT — owner money in or out. NOT a cost, so it never touches
-- profit. In the old schema this rode on a fake product called __CAPITAL__
-- inside the transactions table.
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

-- =========================================================================
-- CASH WITHDRAWAL — money taken out of the drawer. Refuses to overdraw,
-- because a drawer cannot hold less than nothing and a negative cash balance
-- is always a data error rather than a real event.
-- =========================================================================
create or replace function post_cash_withdrawal(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key     text := p_payload->>'idempotency_key';
  v_hit     jsonb;
  v_date    date := (p_payload->>'business_date')::date;
  v_at      timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_amount  numeric(18,2) := (p_payload->>'amount')::numeric;
  v_account uuid := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_balance numeric(18,2);
  v_id      uuid;
  v_result  jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);

  if v_amount is null or v_amount <= 0 then
    raise exception 'INVALID_AMOUNT: a withdrawal must be greater than zero.';
  end if;
  if v_account is null then v_account := default_cash_account(p_shop); end if;

  v_balance := cash_balance_as_of(p_shop, v_account, v_date);
  if v_amount > v_balance + 0.001 then
    raise exception
      'INSUFFICIENT_CASH: the drawer holds % on %, so % cannot be withdrawn.',
      v_balance, v_date, v_amount;
  end if;

  insert into cash_withdrawals (shop_id, cash_account_id, reason, amount,
                                occurred_at, business_date, created_by)
  values (p_shop, v_account, coalesce(p_payload->>'reason', ''), v_amount,
          v_at, v_date, auth.uid())
  returning id into v_id;

  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, 'out', v_amount, v_at, v_date, 'cash_withdrawals', v_id,
          coalesce(p_payload->>'reason', 'Withdrawal'), auth.uid());

  perform write_audit(p_shop, 'withdrawal_posted', 'cash_withdrawals', v_id, null,
                      jsonb_build_object('amount', v_amount));

  v_result := jsonb_build_object('ok', true, 'withdrawal_id', v_id, 'amount', v_amount);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_cash_withdrawal', v_result) on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

-- =========================================================================
-- SET THE OPENING CASH FOR A DAY
--
-- The anchor cash_balance_as_of() counts forward from. Recording a counted
-- drawer makes that count the new starting point, rather than letting history
-- override what you physically have in your hand.
-- =========================================================================
create or replace function set_opening_cash(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_date    date := (p_payload->>'business_date')::date;
  v_amount  numeric(18,2) := (p_payload->>'amount')::numeric;
  v_account uuid := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_old     numeric(18,2);
begin
  perform assert_period_writable(p_shop, v_date);

  if v_amount is null or v_amount < 0 then
    raise exception 'INVALID_AMOUNT: opening cash cannot be negative.';
  end if;
  if v_account is null then v_account := default_cash_account(p_shop); end if;

  select amount into v_old from opening_cash
   where shop_id = p_shop and cash_account_id = v_account and business_date = v_date;

  insert into opening_cash (shop_id, cash_account_id, business_date, amount, created_by)
  values (p_shop, v_account, v_date, v_amount, auth.uid())
  on conflict (shop_id, cash_account_id, business_date)
  do update set amount = excluded.amount, updated_at = now();

  perform write_audit(p_shop, 'opening_cash_set', 'opening_cash', null,
                      jsonb_build_object('amount', v_old),
                      jsonb_build_object('amount', v_amount, 'date', v_date));

  return jsonb_build_object('ok', true, 'business_date', v_date, 'amount', v_amount);
end $$;
