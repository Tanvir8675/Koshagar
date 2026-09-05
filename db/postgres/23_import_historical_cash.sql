-- =========================================================================
-- KoshAgar ERP — 23_import_historical_cash.sql
--
-- The insufficient-cash rule is right for new entries and wrong for replaying
-- history. The old app let the drawer go negative, so some real withdrawals in
-- the existing books are larger than the recorded cash on that day.
--
-- Faced with that, the importer had been INVENTING a "cash adjustment" to top
-- the drawer up so the withdrawal would pass - 13,264.54 taka of income that
-- never happened, which is why cash came out at 40,247.70 instead of 25,341.14.
--
-- Bending the history to fit a new rule is backwards. The history is the fact.
-- So: an explicit allow_negative flag that ONLY service_role may use. The
-- importer sets it, records what the books actually say, and the guard stays
-- fully in force for every real user typing a withdrawal into the app.
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
  -- Honoured only for service_role. An ordinary signed-in user can pass this
  -- flag all day and it will be ignored.
  v_allow_neg boolean := coalesce((p_payload->>'allow_negative')::boolean, false)
                         and is_service_role();
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

  if not v_allow_neg then
    v_balance := cash_balance_as_of(p_shop, v_account, v_date);
    if v_amount > v_balance + 0.001 then
      raise exception
        'INSUFFICIENT_CASH: the drawer holds % on %, so % cannot be withdrawn.',
        v_balance, v_date, v_amount;
    end if;
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
                      jsonb_build_object('amount', v_amount, 'historical', v_allow_neg));

  v_result := jsonb_build_object('ok', true, 'withdrawal_id', v_id, 'amount', v_amount);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_cash_withdrawal', v_result) on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

grant execute on function post_cash_withdrawal(uuid, jsonb) to authenticated;

select 'historical withdrawals may now run the drawer negative; the guard still holds for app users' as note;
