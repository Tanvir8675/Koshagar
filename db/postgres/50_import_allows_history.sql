-- =========================================================================
-- KoshAgar ERP - 50_import_allows_history.sql
--
-- THE NEW GUARDS WOULD HAVE BLOCKED AN IMPORT OF THE REAL BOOKS
--
-- 23_import_historical_cash.sql settled this argument once already, for
-- withdrawals: the old app let the drawer go negative, so the actual history
-- contains days where more cash went out than the books say was in. The rule
-- is right for a new entry and wrong for replaying what already happened, and
-- bending the history to fit the rule is backwards - the history is the fact.
-- The answer was an explicit allow_negative flag that ONLY service_role may
-- use.
--
-- 45, 46, 47 and 49 then added the same overdraw check to purchases, expenses,
-- payments out, capital withdrawal and cash refunds - and did NOT carry the
-- flag across. So the importer, which replays every document through these
-- very functions, would now stop at the first historical day the drawer dipped
-- below zero. Not a reset: it simply could not finish.
--
-- This migration gives all five the same escape 23 gave the sixth. Nothing
-- else in any of them changes.
--
-- For an ordinary signed-in user nothing changes at all: is_service_role() is
-- false, so the flag evaluates to false however the payload is written, and
-- the refusal stands exactly as it did yesterday.
--
-- The importer must SET the flag (tools/import-to-supabase.mjs). Without it,
-- the guards apply to the import too - which is the correct default: silence
-- is a refusal, not a bypass.
-- =========================================================================

-- ---------------------------------------------------------------------
-- post_purchase
-- ---------------------------------------------------------------------
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
  -- Honoured only for service_role, exactly as in 23_import_historical_cash.sql.
  -- An ordinary signed-in user can pass this flag all day and it is ignored.
  v_allow_neg boolean := coalesce((p_payload->>'allow_negative')::boolean, false)
                         and is_service_role();
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

  -- THE DRAWER CANNOT PAY WHAT IT DOES NOT HOLD.
  --
  -- A withdrawal has been refused for overdrawing since 08_cash_documents; a
  -- purchase paid in cash never was. So the only thing standing between the
  -- books and a negative drawer was a dialog in the browser - and a guard that
  -- lives only on the screen is not a guard: it is absent from an edit, from a
  -- retry, from an import, and from anything written by a future screen.
  --
  -- Freight is included because it leaves the drawer at the same moment
  -- (28_extra_cost_is_cash). The balance is taken as of the document's own
  -- business date, exactly as the withdrawal check does, so a backdated
  -- purchase is judged against the drawer as it stood that day.
  --
  -- The funding flow is unaffected: it posts the loan or the investment first,
  -- so by the time the purchase arrives the money is already in.
  if v_cash_paid + v_extra > 0 then
    if v_account is null then v_account := default_cash_account(p_shop); end if;
    if not v_allow_neg
       and v_cash_paid + v_extra > cash_balance_as_of(p_shop, v_account, v_date) + 0.001 then
      raise exception
        'INSUFFICIENT_CASH: the drawer holds % on %, so % cannot be paid out. Record where the extra money is coming from first.',
        round(cash_balance_as_of(p_shop, v_account, v_date), 2), v_date,
        round(v_cash_paid + v_extra, 2);
    end if;
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

-- ---------------------------------------------------------------------
-- post_expense
-- ---------------------------------------------------------------------
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
  -- Honoured only for service_role, exactly as in 23_import_historical_cash.sql.
  -- An ordinary signed-in user can pass this flag all day and it is ignored.
  v_allow_neg boolean := coalesce((p_payload->>'allow_negative')::boolean, false)
                         and is_service_role();
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
  if not v_allow_neg
     and v_amount > cash_balance_as_of(p_shop, v_account, v_date) + 0.001 then
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

-- ---------------------------------------------------------------------
-- record_payment
-- ---------------------------------------------------------------------
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
  -- Honoured only for service_role, exactly as in 23_import_historical_cash.sql.
  -- An ordinary signed-in user can pass this flag all day and it is ignored.
  v_allow_neg boolean := coalesce((p_payload->>'allow_negative')::boolean, false)
                         and is_service_role();
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
     and not v_allow_neg
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

-- ---------------------------------------------------------------------
-- post_capital_movement
-- ---------------------------------------------------------------------
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
  -- Honoured only for service_role, exactly as in 23_import_historical_cash.sql.
  -- An ordinary signed-in user can pass this flag all day and it is ignored.
  v_allow_neg boolean := coalesce((p_payload->>'allow_negative')::boolean, false)
                         and is_service_role();
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
     and not v_allow_neg
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
-- post_return
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
  -- Honoured only for service_role, exactly as in 23_import_historical_cash.sql.
  -- An ordinary signed-in user can pass this flag all day and it is ignored.
  v_allow_neg boolean := coalesce((p_payload->>'allow_negative')::boolean, false)
                         and is_service_role();
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
    if not v_allow_neg
       and v_refund > cash_balance_as_of(p_shop, v_account, v_date) + 0.001 then
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

grant execute on function post_purchase(uuid, jsonb) to authenticated;
grant execute on function post_expense(uuid, jsonb) to authenticated;
grant execute on function record_payment(uuid, jsonb) to authenticated;
grant execute on function post_capital_movement(uuid, jsonb) to authenticated;
grant execute on function post_return(uuid, jsonb) to authenticated;

select 'the importer can replay history again; the guards stand for every real user' as note;
