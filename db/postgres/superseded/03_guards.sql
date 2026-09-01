-- 03_guards.sql — the integrity rules that must survive the move.
--
-- Ported one-for-one from the live triggers in db/sqlite.js. These are the rules
-- that were actually protecting the data, so each one is named after the trigger
-- it replaces. The parallel "ERP" triggers (tr_erp_*) are NOT ported: they fire
-- on inventory_movements / customer_credits_erp, tables nothing reads.
--
-- Two of these are stronger here than in SQLite:
--   * the overpay guards also cover soft-delete and un-delete, not just insert
--     and update of the amount;
--   * the delete guards work on soft deletes. ON DELETE RESTRICT alone would
--     never fire, because this schema never hard-deletes anything.

-- ---------------------------------------------------------------------------
-- Customer payments may not exceed the credit  (tr_payments_no_overpay_ins/_upd)
-- ---------------------------------------------------------------------------
create or replace function check_customer_payment_not_overpaid()
returns trigger language plpgsql as $$
declare
  v_credit_id uuid := coalesce(new.credit_id, old.credit_id);
  v_total     bigint;
  v_initial   bigint;
  v_paid      bigint;
begin
  select total_paisa, initial_paid_paisa into v_total, v_initial
    from credits where id = v_credit_id and deleted_at is null;
  if not found then
    raise exception 'CREDIT_NOT_FOUND: payment refers to a missing or deleted credit';
  end if;

  select coalesce(sum(amount_paisa), 0) into v_paid
    from payments
   where credit_id = v_credit_id
     and deleted_at is null
     and id is distinct from coalesce(new.id, old.id);

  if new.deleted_at is null then
    v_paid := v_paid + new.amount_paisa;
  end if;

  if v_initial + v_paid > v_total then
    raise exception
      'PAYMENT_EXCEEDS_DUE: paid % would exceed the credit total of %',
      (v_initial + v_paid) / 100.0, v_total / 100.0;
  end if;
  return new;
end $$;

create trigger payments_no_overpay
  before insert or update on payments
  for each row execute function check_customer_payment_not_overpaid();

-- ---------------------------------------------------------------------------
-- Supplier payments may not exceed the credit (tr_spayments_no_overpay_ins/_upd)
-- ---------------------------------------------------------------------------
create or replace function check_supplier_payment_not_overpaid()
returns trigger language plpgsql as $$
declare
  v_credit_id uuid := coalesce(new.supplier_credit_id, old.supplier_credit_id);
  v_total     bigint;
  v_initial   bigint;
  v_paid      bigint;
begin
  select total_paisa, initial_paid_paisa into v_total, v_initial
    from supplier_credits where id = v_credit_id and deleted_at is null;
  if not found then
    raise exception 'SUPPLIER_CREDIT_NOT_FOUND: payment refers to a missing or deleted credit';
  end if;

  select coalesce(sum(amount_paisa), 0) into v_paid
    from supplier_payments
   where supplier_credit_id = v_credit_id
     and deleted_at is null
     and id is distinct from coalesce(new.id, old.id);

  if new.deleted_at is null then
    v_paid := v_paid + new.amount_paisa;
  end if;

  if v_initial + v_paid > v_total then
    raise exception
      'SUPPLIER_PAYMENT_EXCEEDS_DUE: paid % would exceed the credit total of %',
      (v_initial + v_paid) / 100.0, v_total / 100.0;
  end if;
  return new;
end $$;

create trigger supplier_payments_no_overpay
  before insert or update on supplier_payments
  for each row execute function check_supplier_payment_not_overpaid();

-- ---------------------------------------------------------------------------
-- Soft-delete protection  (tr_products_no_delete_with_tx,
--                          tr_credits_no_delete_with_payments,
--                          tr_supplier_credits_no_delete_with_payments)
--
-- ON DELETE RESTRICT is still declared in 02_core.sql and still guards a true
-- hard delete. These cover the case the app will actually hit.
-- ---------------------------------------------------------------------------
create or replace function check_product_has_no_transactions()
returns trigger language plpgsql as $$
begin
  if old.deleted_at is null and new.deleted_at is not null
     and exists (select 1 from transactions
                  where product_id = new.id and deleted_at is null) then
    raise exception
      'PRODUCT_IN_USE: "%" has transactions and cannot be deleted. Delete or return those first.',
      new.name;
  end if;
  return new;
end $$;

create trigger products_no_delete_with_tx
  before update on products
  for each row execute function check_product_has_no_transactions();

create or replace function check_credit_has_no_payments()
returns trigger language plpgsql as $$
begin
  if old.deleted_at is null and new.deleted_at is not null
     and exists (select 1 from payments
                  where credit_id = new.id and deleted_at is null) then
    raise exception 'CREDIT_HAS_PAYMENTS: remove the payments against this credit first.';
  end if;
  return new;
end $$;

create trigger credits_no_delete_with_payments
  before update on credits
  for each row execute function check_credit_has_no_payments();

create or replace function check_supplier_credit_has_no_payments()
returns trigger language plpgsql as $$
begin
  if old.deleted_at is null and new.deleted_at is not null
     and exists (select 1 from supplier_payments
                  where supplier_credit_id = new.id and deleted_at is null) then
    raise exception 'SUPPLIER_CREDIT_HAS_PAYMENTS: remove the payments against this credit first.';
  end if;
  return new;
end $$;

create trigger supplier_credits_no_delete_with_payments
  before update on supplier_credits
  for each row execute function check_supplier_credit_has_no_payments();

-- ---------------------------------------------------------------------------
-- Negative stock
--
-- This is the rule that blocked the bad restore. In the old app it lived in
-- JavaScript (collectCriticalMismatches in index.html) and so was only as strong
-- as the code path that happened to call it. Here it is a database function, and
-- the write RPCs in 04_functions.sql call it inside the same transaction as the
-- insert — so a sale cannot commit against stock that isn't there, no matter
-- which client sent it or how many devices are selling at once.
-- ---------------------------------------------------------------------------
create or replace function stock_on_hand(p_product uuid, p_asof timestamptz default null)
returns numeric language sql stable as $$
  select coalesce(sum(
    case
      when kind = 'purchase' then qty
      when kind = 'sale'     then -qty
      when kind = 'adjustment' then -qty
      when kind = 'return' and return_kind = 'sale-return'     then qty
      when kind = 'return' and return_kind = 'purchase-return' then -qty
      else 0
    end), 0)
  from transactions
  where product_id = p_product
    and deleted_at is null
    and (p_asof is null or occurred_at <= p_asof);
$$;

create or replace function assert_stock_not_negative(p_product uuid)
returns void language plpgsql as $$
declare v_qty numeric; v_name text;
begin
  v_qty := stock_on_hand(p_product);
  if v_qty < -0.0001 then
    select name into v_name from products where id = p_product;
    raise exception
      'NEGATIVE_STOCK: "%" would go to % in stock. Some of it may already be sold — use a Return instead of a Delete, or fix the related sale first.',
      coalesce(v_name, p_product::text), v_qty;
  end if;
end $$;
