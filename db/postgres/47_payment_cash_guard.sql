-- =========================================================================
-- KoshAgar ERP - 47_payment_cash_guard.sql
--
-- PAYING A SUPPLIER OR A LENDER CANNOT OVERDRAW THE DRAWER EITHER
--
-- 45 and 46 gave post_purchase and post_expense the overdraw check that
-- post_cash_withdrawal has always had. record_payment was the last ordinary way
-- to spend money the shop does not have: paying a supplier bill, or repaying a
-- loan, from an empty drawer.
--
-- It showed itself the way these always do - one screen refused it and another
-- allowed it. That difference is the tell that a rule is living in a screen.
--
-- THE REVERSAL QUESTION, NOW SETTLED
-- 46 left this open because a blanket guard would also refuse an undo. It turns
-- out not to: reverse_payment() writes its cash row directly to cash_ledger
-- rather than calling record_payment(), so guarding this function leaves every
-- correction possible. A mistake can always be taken back; only new spending is
-- checked.
--
-- Only the check is added; nothing else in the function changes.
--
-- STILL UNGUARDED: an owner's capital withdrawal and a cash refund on a return.
-- Both are money out. Left alone for now because a refund is often the second
-- half of a correction, and that is the case 46 warned about.
-- =========================================================================

create or replace function record_payment(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key       text := p_payload->>'idempotency_key';
  v_hit       jsonb;
  v_date      date := (p_payload->>'business_date')::date;
  v_at        timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_party     uuid := (p_payload->>'party_id')::uuid;
  v_direction text := p_payload->>'direction';          -- 'in' or 'out'
  v_amount    numeric(18,2) := (p_payload->>'amount')::numeric;
  v_account   uuid := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_method    text := coalesce(p_payload->>'method', 'cash');
  v_id        uuid;
  v_no        text;
  v_left      numeric(18,2);
  v_apply     numeric(18,2);
  v_allocated numeric(18,2) := 0;
  b           record;
  v_result    jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);
  perform assert_party_in_shop(p_shop, v_party);

  if v_amount is null or v_amount <= 0 then
    raise exception 'INVALID_AMOUNT: a payment must be greater than zero.';
  end if;

  if v_direction not in ('in', 'out') then
    raise exception 'INVALID_DIRECTION: payment direction must be "in" (from a customer) or "out" (to a supplier).';
  end if;

  if v_account is null then v_account := default_cash_account(p_shop); end if;

  -- PAYING SOMEONE STILL TAKES THE MONEY OUT OF THE DRAWER.
  --
  -- Paying a supplier or repaying a lender is cash leaving, exactly like a
  -- withdrawal or an expense, and it was the last ordinary way to spend money
  -- the shop did not have. One screen happened to check first and another did
  -- not, which is the shape of every bug this rule exists to end: the guard was
  -- in a screen instead of in the books.
  --
  -- Only direction 'out'. Money coming IN from a customer needs no drawer.
  --
  -- A REVERSAL IS NOT AFFECTED, and that is deliberate. Undoing a payment
  -- writes its cash row straight to cash_ledger (reverse_payment, in
  -- 07_returns_reversals.sql) rather than coming through here - so a mistake can
  -- always be undone, even when the money has since been spent. Refusing that
  -- would leave a wrong document in the books with no way to correct it, which
  -- is worse than a drawer that dips for as long as the correction takes.
  if v_direction = 'out'
     and v_amount > cash_balance_as_of(p_shop, v_account, v_date) + 0.001 then
    raise exception
      'INSUFFICIENT_CASH: the drawer holds % on %, so % cannot be paid out. Record where the money came from first.',
      round(cash_balance_as_of(p_shop, v_account, v_date), 2), v_date, v_amount;
  end if;

  v_no := next_document_no(p_shop, 'payment', v_date);

  insert into payments (shop_id, payment_no, party_id, direction, cash_account_id,
                        method, occurred_at, business_date, amount, note, created_by)
  values (p_shop, v_no, v_party, v_direction, v_account, v_method, v_at, v_date,
          v_amount, coalesce(p_payload->>'note', ''), auth.uid())
  returning id into v_id;

  -- Allocate oldest bill first. FOR UPDATE so two payments against the same
  -- party cannot both allocate against the same remaining balance.
  v_left := v_amount;
  for b in
    select pb.id, pb.amount
    from party_bills pb
    where pb.shop_id = p_shop
      and pb.party_id = v_party
      and pb.status = 'open'
      and pb.direction = case when v_direction = 'in' then 'receivable' else 'payable' end
    order by pb.business_date, pb.occurred_at, pb.id
    for update
  loop
    exit when v_left <= 0.001;
    v_apply := least(v_left, bill_balance(b.id));
    if v_apply > 0.001 then
      insert into payment_allocations (shop_id, payment_id, bill_id, amount, created_by)
      values (p_shop, v_id, b.id, v_apply, auth.uid());
      v_left := v_left - v_apply;
      v_allocated := v_allocated + v_apply;
    end if;
  end loop;

  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, v_direction, v_amount, v_at, v_date, 'payments', v_id,
          'Payment ' || v_no, auth.uid());

  perform write_audit(p_shop, 'payment_recorded', 'payments', v_id, null,
                      jsonb_build_object('payment_no', v_no, 'amount', v_amount,
                                         'allocated', v_allocated, 'advance', v_left));

  v_result := jsonb_build_object('ok', true, 'payment_id', v_id, 'payment_no', v_no,
                                 'amount', v_amount, 'allocated', v_allocated,
                                 'unallocated', v_left);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'record_payment', v_result)
    on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

select 'record_payment() now refuses to overdraw the drawer' as note;
