-- =========================================================================
-- KoshAgar ERP — 06_functions.sql
--
-- The write paths. The application never inserts into these tables directly;
-- it calls one of these functions, and each one is a single ACID transaction.
-- Either the whole sale lands - header, lines, FIFO consumption, stock ledger,
-- credit and cash - or none of it does.
--
-- Every function here:
--   * refuses to write into a closed month
--   * returns the same result for a repeated idempotency key instead of
--     writing twice
--   * recomputes money from quantity and price rather than trusting the client
--   * writes an audit row
--   * raises a named exception the app can turn into a specific message
--
-- Exceptions are prefixed so the frontend can match on them:
--   INSUFFICIENT_STOCK, UNIT_NOT_DEFINED, PERIOD_CLOSED, PARTY_REQUIRED,
--   OVERPAYMENT, CASH_EXCEEDS_TOTAL, EMPTY_DOCUMENT
-- =========================================================================

-- =========================================================================
-- FIFO CONSUMPTION
--
-- Locks the product's open lots oldest-first and consumes them. The lock is
-- what makes concurrent selling safe: a second seller reaching the same
-- product waits for the first to commit, then sees the reduced quantities.
--
-- Your decision - block the sale when lots fall short - is the raise below.
-- =========================================================================
create or replace function consume_fifo(
  p_shop           uuid,
  p_product        uuid,
  p_qty            numeric,
  p_consumer_table text,
  p_consumer_id    uuid
) returns numeric language plpgsql set search_path = public as $$
declare
  v_left  numeric(18,3) := p_qty;
  v_cost  numeric(18,2) := 0;
  v_take  numeric(18,3);
  v_name  text;
  r       record;
begin
  for r in
    select id, qty_remaining, unit_cost
    from stock_lots
    where shop_id = p_shop and product_id = p_product and qty_remaining > 0
    order by business_date, received_at, lot_seq
    for update
  loop
    exit when v_left <= 0.0001;

    v_take := least(r.qty_remaining, v_left);

    update stock_lots
       set qty_remaining = qty_remaining - v_take
     where id = r.id;

    insert into stock_lot_consumption
      (shop_id, lot_id, consumer_table, consumer_id, qty, unit_cost)
    values (p_shop, r.id, p_consumer_table, p_consumer_id, v_take, r.unit_cost);

    v_cost := v_cost + round(v_take * r.unit_cost, 2);
    v_left := v_left - v_take;
  end loop;

  if v_left > 0.0001 then
    select name into v_name from products where id = p_product;
    raise exception
      'INSUFFICIENT_STOCK: "%" is short by %. Enter the missing purchase or opening stock first.',
      coalesce(v_name, p_product::text), v_left;
  end if;

  return v_cost;
end $$;

comment on function consume_fifo is
  'Returns the cost consumed. Called inside the posting transaction, so a sale that cannot be costed cannot be committed either.';


-- =========================================================================
-- TENANT GUARDS
--
-- The posting functions run as security definer so they can maintain lots and
-- ledgers the caller may not write directly. That also means RLS does not
-- protect them, so every id arriving from the client is re-checked against the
-- shop it claims to belong to.
-- =========================================================================
create or replace function assert_party_in_shop(p_shop uuid, p_party uuid)
returns void language plpgsql stable set search_path = public as $$
begin
  if p_party is null then return; end if;
  if not exists (select 1 from parties where id = p_party and shop_id = p_shop) then
    raise exception 'PARTY_NOT_FOUND: that customer or supplier does not belong to this shop.';
  end if;
end $$;

create or replace function default_cash_account(p_shop uuid)
returns uuid language plpgsql stable set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from cash_accounts
   where shop_id = p_shop and is_default and is_active;
  if v_id is null then
    raise exception 'NO_CASH_ACCOUNT: this shop has no default cash account. Create one before recording money.';
  end if;
  return v_id;
end $$;

-- =========================================================================
-- CONVERSION LOOKUP
--
-- Conversions are master data (your decision), so an undefined one is an error
-- rather than something invented at entry time.
-- =========================================================================
create or replace function resolve_conversion(p_shop uuid, p_product uuid, p_unit uuid)
returns numeric language plpgsql stable set search_path = public as $$
declare v_factor numeric(18,6); v_pname text; v_uname text;
begin
  -- shop_id is checked here as well as on the product: these functions are
  -- security definer and therefore bypass RLS, so the tenant boundary has to be
  -- re-asserted explicitly on every lookup.
  select pu.factor into v_factor
    from product_units pu
    join products p on p.id = pu.product_id and p.shop_id = p_shop
    join units    u on u.id = pu.unit_id    and u.shop_id = p_shop
   where pu.product_id = p_product and pu.unit_id = p_unit;

  if v_factor is null then
    select p.name, u.name into v_pname, v_uname
      from products p, units u
     where p.id = p_product and u.id = p_unit
       and p.shop_id = p_shop and u.shop_id = p_shop;
    raise exception
      'UNIT_NOT_DEFINED: "%" has no conversion defined for unit "%". Add it to the product first.',
      coalesce(v_pname, '?'), coalesce(v_uname, '?');
  end if;
  return v_factor;
end $$;

-- =========================================================================
-- IDEMPOTENCY
--
-- Returns the stored result if this key has been seen, else null. The caller
-- records the result at the end. Protects against a double-clicked Save, a
-- retried request, and an app that crashes mid-write.
-- =========================================================================
create or replace function idempotent_hit(p_shop uuid, p_key text)
returns jsonb language sql stable set search_path = public as $$
  select result from idempotency_keys where shop_id = p_shop and key = p_key;
$$;

-- =========================================================================
-- POST PURCHASE
--
-- Creates the bill, the stock lots at landed cost, the ledger movements, and
-- either a cash payment or a payable.
--
-- extra_cost is apportioned across lines in proportion to line value, which is
-- how the existing app already computed landedUnitCost.
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
  v_id         uuid;
  v_no         text;
  v_line       jsonb;
  v_i          int := 0;
  v_factor     numeric(18,6);
  v_qty_base   numeric(18,3);
  v_line_id    uuid;
  v_gross      numeric(18,2) := 0;
  v_net        numeric(18,2);
  v_line_total numeric(18,2);
  v_landed     numeric(18,4);
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

  v_no := next_document_no(p_shop, 'purchase', v_date);

  insert into purchases (shop_id, bill_no, party_id, occurred_at, business_date,
                         bill_discount, extra_cost, note, created_by)
  values (p_shop, v_no, v_party, v_at, v_date, v_discount, v_extra,
          coalesce(p_payload->>'note', ''), auth.uid())
  returning id into v_id;

  -- Pass 1: insert lines, accumulate gross so extra_cost can be apportioned.
  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_i := v_i + 1;
    v_factor := resolve_conversion(p_shop, (v_line->>'product_id')::uuid, (v_line->>'unit_id')::uuid);
    v_qty_base := round((v_line->>'qty_entered')::numeric * v_factor, 3);

    insert into purchase_lines (
      shop_id, purchase_id, line_no, product_id,
      product_name, unit_name, entry_factor,
      qty_entered, qty_base, unit_price, line_discount, landed_unit_cost)
    select p_shop, v_id, v_i, p.id,
           p.name, u.name, v_factor,
           (v_line->>'qty_entered')::numeric, v_qty_base,
           (v_line->>'unit_price')::numeric,
           coalesce((v_line->>'line_discount')::numeric, 0),
           0                                   -- provisional; set in pass 2
    from products p
    join units u on u.id = (v_line->>'unit_id')::uuid and u.shop_id = p_shop
    where p.id = (v_line->>'product_id')::uuid and p.shop_id = p_shop
    returning id, line_total into v_line_id, v_line_total;

    if v_line_id is null then
      raise exception 'PRODUCT_NOT_FOUND: line % refers to a product or unit that does not exist.', v_i;
    end if;

    v_gross := v_gross + v_line_total;
  end loop;

  v_net := v_gross - v_discount + v_extra;

  -- Pass 2: landed cost per line, then the lot and the ledger movement.
  for v_line_id, v_line_total, v_qty_base in
    select id, line_total, qty_base from purchase_lines
    where purchase_id = v_id order by line_no
  loop
    -- share of (bill discount and extra cost) proportional to line value
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

  if v_cash_paid > v_net + 0.001 then
    raise exception 'CASH_EXCEEDS_TOTAL: paid % against a bill of %.', v_cash_paid, v_net;
  end if;

  if v_cash_paid > 0 then
    if v_account is null then v_account := default_cash_account(p_shop); end if;
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    values (p_shop, v_account, 'out', v_cash_paid, v_at, v_date, 'purchases', v_id,
            'Purchase ' || v_no, auth.uid());
  end if;

  if v_net - v_cash_paid > 0.001 then
    if v_party is null then
      raise exception 'PARTY_REQUIRED: a credit purchase needs a supplier - an unpaid balance must belong to someone.';
    end if;
    insert into party_bills (shop_id, party_id, direction, source_table, source_id,
                             occurred_at, business_date, amount, note, created_by)
    values (p_shop, v_party, 'payable', 'purchases', v_id, v_at, v_date,
            v_net - v_cash_paid, 'Purchase ' || v_no, auth.uid());
  end if;

  perform write_audit(p_shop, 'purchase_posted', 'purchases', v_id, null,
                      jsonb_build_object('bill_no', v_no, 'net_total', v_net));

  v_result := jsonb_build_object('ok', true, 'purchase_id', v_id,
                                 'bill_no', v_no, 'net_total', v_net);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_purchase', v_result)
    on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

-- =========================================================================
-- POST SALE
--
-- The critical path. Stock is validated by consuming it, so validation and
-- effect cannot disagree, and the cost is frozen onto the line as it happens.
-- =========================================================================
create or replace function post_sale(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key        text  := p_payload->>'idempotency_key';
  v_hit        jsonb;
  v_date       date  := (p_payload->>'business_date')::date;
  v_at         timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_party      uuid  := nullif(p_payload->>'party_id', '')::uuid;
  v_discount   numeric(18,2) := coalesce((p_payload->>'bill_discount')::numeric, 0);
  v_cash_paid  numeric(18,2) := coalesce((p_payload->>'cash_paid')::numeric, 0);
  v_account    uuid  := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_id         uuid;
  v_no         text;
  v_line       jsonb;
  v_i          int := 0;
  v_factor     numeric(18,6);
  v_qty_base   numeric(18,3);
  v_line_id    uuid;
  v_product    uuid;
  v_cogs       numeric(18,2);
  v_gross      numeric(18,2) := 0;
  v_total_cogs numeric(18,2) := 0;
  v_line_total numeric(18,2);
  v_net        numeric(18,2);
  v_result     jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);
  perform assert_party_in_shop(p_shop, v_party);

  if jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)) = 0 then
    raise exception 'EMPTY_DOCUMENT: a sale must have at least one line.';
  end if;

  v_no := next_document_no(p_shop, 'sale', v_date);

  insert into sales (shop_id, invoice_no, party_id, occurred_at, business_date,
                     bill_discount, note, created_by)
  values (p_shop, v_no, v_party, v_at, v_date, v_discount,
          coalesce(p_payload->>'note', ''), auth.uid())
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_i := v_i + 1;
    v_product := (v_line->>'product_id')::uuid;
    v_factor := resolve_conversion(p_shop, v_product, (v_line->>'unit_id')::uuid);
    v_qty_base := round((v_line->>'qty_entered')::numeric * v_factor, 3);

    insert into sale_lines (
      shop_id, sale_id, line_no, product_id,
      product_name, unit_name, entry_factor,
      qty_entered, qty_base, unit_price, line_discount)
    select p_shop, v_id, v_i, p.id, p.name, u.name, v_factor,
           (v_line->>'qty_entered')::numeric, v_qty_base,
           (v_line->>'unit_price')::numeric,
           coalesce((v_line->>'line_discount')::numeric, 0)
    from products p
    join units u on u.id = (v_line->>'unit_id')::uuid and u.shop_id = p_shop
    where p.id = v_product and p.shop_id = p_shop
    returning id, line_total into v_line_id, v_line_total;

    if v_line_id is null then
      raise exception 'PRODUCT_NOT_FOUND: line % refers to a product or unit that does not exist.', v_i;
    end if;

    -- Consume stock. Raises INSUFFICIENT_STOCK and aborts the whole sale if
    -- the lots do not cover the quantity.
    v_cogs := consume_fifo(p_shop, v_product, v_qty_base, 'sale_lines', v_line_id);

    update sale_lines set cogs_amount = v_cogs where id = v_line_id;

    insert into inventory_movements (shop_id, product_id, movement_type, qty_delta,
                                     occurred_at, business_date, source_table, source_id, created_by)
    values (p_shop, v_product, 'sale', -v_qty_base, v_at, v_date,
            'sale_lines', v_line_id, auth.uid());

    v_gross := v_gross + v_line_total;
    v_total_cogs := v_total_cogs + v_cogs;
  end loop;

  v_net := v_gross - v_discount;

  if v_cash_paid > v_net + 0.001 then
    raise exception 'CASH_EXCEEDS_TOTAL: received % against a bill of %.', v_cash_paid, v_net;
  end if;

  if v_cash_paid > 0 then
    if v_account is null then v_account := default_cash_account(p_shop); end if;
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    values (p_shop, v_account, 'in', v_cash_paid, v_at, v_date, 'sales', v_id,
            'Sale ' || v_no, auth.uid());
  end if;

  -- An unpaid balance must belong to someone. This is the rule that keeps
  -- anonymous walk-in sales cash-only, per your decision.
  if v_net - v_cash_paid > 0.001 then
    if v_party is null then
      raise exception 'PARTY_REQUIRED: a credit sale needs a customer with a phone number - an unpaid balance must belong to someone.';
    end if;
    insert into party_bills (shop_id, party_id, direction, source_table, source_id,
                             occurred_at, business_date, amount, note, created_by)
    values (p_shop, v_party, 'receivable', 'sales', v_id, v_at, v_date,
            v_net - v_cash_paid, 'Sale ' || v_no, auth.uid());
  end if;

  perform write_audit(p_shop, 'sale_posted', 'sales', v_id, null,
                      jsonb_build_object('invoice_no', v_no, 'net_total', v_net,
                                         'cogs', v_total_cogs));

  v_result := jsonb_build_object('ok', true, 'sale_id', v_id, 'invoice_no', v_no,
                                 'net_total', v_net, 'cogs', v_total_cogs,
                                 'gross_profit', v_net - v_total_cogs);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_sale', v_result)
    on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

-- =========================================================================
-- RECORD PAYMENT
--
-- Balance-based with oldest-first allocation - your decision. The allocation
-- is written as rows, so it can be adjusted later without touching the payment,
-- and "which payment settled which invoice" is always answerable.
--
-- A payment larger than the outstanding bills is allowed: the remainder stays
-- unallocated and shows as an advance.
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
