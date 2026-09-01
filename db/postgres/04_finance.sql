-- =========================================================================
-- KoshAgar ERP — 04_finance.sql
--
-- What is owed, what was paid, which payment settled what, and where the cash
-- actually went.
--
-- THE MODEL YOU CHOSE: balance-based payment with recorded allocation.
-- Three things that are genuinely different get three tables:
--
--   party_bills          the obligation - one row per credit sale or purchase
--   payments             the money event - cash actually received or handed over
--   payment_allocations  which payment settled which bill, and by how much
--
-- The old schema had credits.paid holding an initial payment while the payments
-- table held the rest, making due "total - paid - sum(payments)". One column
-- named `paid` that did not mean "amount paid" was a standing invitation to a
-- wrong due figure. Here a payment exists in exactly one place, and due has
-- exactly one formula.
--
-- Nothing in this file stores a balance. Due and cash balance are derived in
-- 05_views.sql from these rows.
-- =========================================================================

-- =========================================================================
-- PARTY BILLS — the obligation
-- =========================================================================
create table party_bills (
  id             uuid          primary key default gen_random_uuid(),
  shop_id        uuid          not null references shops(id) on delete restrict,
  legacy_id      text,
  party_id       uuid          not null references parties(id) on delete restrict,
  direction      text          not null check (direction in ('receivable', 'payable')),

  -- What created the obligation. A credit sale, a credit purchase, or an
  -- opening balance carried in from the old system.
  source_table   text          not null check (source_table in
                   ('sales', 'purchases', 'returns', 'opening')),
  source_id      uuid,

  occurred_at    timestamptz   not null,
  business_date  date          not null,
  amount         numeric(18,2) not null check (amount > 0),
  status         text          not null default 'open'
                   check (status in ('open', 'reversed')),
  note           text          not null default '',
  created_by     uuid          references auth.users(id),
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now(),
  unique (shop_id, legacy_id),
  constraint bill_has_source check (source_table = 'opening' or source_id is not null)
);

create index on party_bills (shop_id, party_id) where status = 'open';
create index on party_bills (shop_id, business_date);
create index on party_bills (source_table, source_id);

comment on column party_bills.amount is
  'The credit portion only - what remained unpaid at the moment the bill was raised. Cash taken at the counter is a cash_ledger row, not part of this.';

comment on column party_bills.direction is
  'receivable = the customer owes you. payable = you owe the supplier. One table because the arithmetic is identical and only the sign of the relationship differs.';

-- =========================================================================
-- PAYMENTS — the money event
-- =========================================================================
create table payments (
  id               uuid          primary key default gen_random_uuid(),
  shop_id          uuid          not null references shops(id) on delete restrict,
  legacy_id        text,
  payment_no       text          not null,
  party_id         uuid          not null references parties(id) on delete restrict,
  direction        text          not null check (direction in ('in', 'out')),
  cash_account_id  uuid          not null references cash_accounts(id) on delete restrict,
  method           text          not null default 'cash'
                     check (method in ('cash', 'bank', 'mobile_money')),
  occurred_at      timestamptz   not null,
  business_date    date          not null,
  amount           numeric(18,2) not null check (amount > 0),
  status           text          not null default 'posted'
                     check (status in ('posted', 'reversed')),
  note             text          not null default '',
  created_by       uuid          references auth.users(id),
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  unique (shop_id, payment_no),
  unique (shop_id, legacy_id)
);

create index on payments (shop_id, party_id) where status = 'posted';
create index on payments (shop_id, business_date);

comment on column payments.direction is
  '"in" = money received from a customer, settling receivables. "out" = money paid to a supplier, settling payables.';

-- =========================================================================
-- PAYMENT ALLOCATIONS — which payment settled which bill
--
-- Written oldest-bill-first by record_payment() in 06_functions.sql, inside
-- the payment's own transaction. Because allocations are rows rather than a
-- computed guess, they can later be adjusted without touching the payment.
--
-- A payment may be only partly allocated: the unallocated remainder is an
-- advance sitting against the party's balance.
-- =========================================================================
create table payment_allocations (
  id           uuid          primary key default gen_random_uuid(),
  shop_id      uuid          not null references shops(id) on delete restrict,
  payment_id   uuid          not null references payments(id) on delete restrict,
  bill_id      uuid          not null references party_bills(id) on delete restrict,
  amount       numeric(18,2) not null check (amount > 0),
  created_by   uuid          references auth.users(id),
  created_at   timestamptz   not null default now(),
  unique (payment_id, bill_id)
);

create index on payment_allocations (bill_id);
create index on payment_allocations (payment_id);

-- How much of a bill is still outstanding.
create or replace function bill_balance(p_bill uuid)
returns numeric language sql stable set search_path = public as $$
  select b.amount - coalesce((
           select sum(a.amount)
           from payment_allocations a
           join payments p on p.id = a.payment_id and p.status = 'posted'
           where a.bill_id = b.id), 0)
  from party_bills b
  where b.id = p_bill and b.status = 'open';
$$;

-- How much of a payment has not yet been applied to any bill.
create or replace function payment_unallocated(p_payment uuid)
returns numeric language sql stable set search_path = public as $$
  select p.amount - coalesce((
           select sum(a.amount) from payment_allocations a where a.payment_id = p.id), 0)
  from payments p
  where p.id = p_payment and p.status = 'posted';
$$;

-- =========================================================================
-- Allocation guards
--
-- Two rules, both enforced by the database:
--   1. No bill may be over-settled.
--   2. No payment may allocate more than it is worth.
--
-- These replace tr_payments_no_overpay_ins / tr_spayments_no_overpay_upd from
-- the SQLite schema, and are stronger: they recompute the full picture on every
-- change rather than only on insert, and they cover reversal too.
-- =========================================================================
create or replace function check_allocation_valid()
returns trigger language plpgsql set search_path = public as $$
declare
  v_bill_amount    numeric(18,2);
  v_bill_allocated numeric(18,2);
  v_pay_amount     numeric(18,2);
  v_pay_allocated  numeric(18,2);
  v_bill_dir       text;
  v_pay_dir        text;
begin
  select amount, direction into v_bill_amount, v_bill_dir
    from party_bills where id = new.bill_id and status = 'open';
  if not found then
    raise exception 'BILL_NOT_OPEN: the bill this payment points at is missing or reversed.';
  end if;

  select amount, direction into v_pay_amount, v_pay_dir
    from payments where id = new.payment_id and status = 'posted';
  if not found then
    raise exception 'PAYMENT_NOT_POSTED: the payment is missing or reversed.';
  end if;

  -- Money in settles receivables; money out settles payables. Crossing them
  -- would let a supplier payment reduce a customer's due.
  if (v_pay_dir = 'in'  and v_bill_dir <> 'receivable')
  or (v_pay_dir = 'out' and v_bill_dir <> 'payable') then
    raise exception
      'DIRECTION_MISMATCH: a payment "%" cannot settle a "%" bill.', v_pay_dir, v_bill_dir;
  end if;

  select coalesce(sum(a.amount), 0) into v_bill_allocated
  from payment_allocations a
  join payments p on p.id = a.payment_id and p.status = 'posted'
  where a.bill_id = new.bill_id and a.id is distinct from new.id;

  if v_bill_allocated + new.amount > v_bill_amount + 0.001 then
    raise exception
      'OVERPAYMENT: bill total is %, already settled %, cannot apply a further %.',
      v_bill_amount, v_bill_allocated, new.amount;
  end if;

  select coalesce(sum(a.amount), 0) into v_pay_allocated
  from payment_allocations a
  where a.payment_id = new.payment_id and a.id is distinct from new.id;

  if v_pay_allocated + new.amount > v_pay_amount + 0.001 then
    raise exception
      'OVER_ALLOCATION: payment is %, already applied %, cannot apply a further %.',
      v_pay_amount, v_pay_allocated, new.amount;
  end if;

  return new;
end $$;

create trigger payment_allocations_valid
  before insert or update on payment_allocations
  for each row execute function check_allocation_valid();

-- =========================================================================
-- CASH LEDGER
--
-- Every movement of money, whatever caused it. This is the authoritative
-- answer to "why is the cash in the drawer this amount?" - not a stored
-- balance that something updates.
--
-- A cash ledger, not double-entry: your decision, and it matches how the shop
-- is actually run.
-- =========================================================================
create table cash_ledger (
  id               bigserial     primary key,
  shop_id          uuid          not null references shops(id) on delete restrict,
  cash_account_id  uuid          not null references cash_accounts(id) on delete restrict,
  direction        text          not null check (direction in ('in', 'out')),
  amount           numeric(18,2) not null check (amount > 0),
  occurred_at      timestamptz   not null,
  business_date    date          not null,

  -- Why the money moved. Every row points at the document that caused it.
  source_table     text          not null check (source_table in
                     ('sales', 'purchases', 'returns', 'payments',
                      'expenses', 'capital_movements', 'cash_withdrawals')),
  source_id        uuid          not null,
  note             text          not null default '',
  created_by       uuid          references auth.users(id),
  created_at       timestamptz   not null default now()
);

create index on cash_ledger (shop_id, cash_account_id, business_date);
create index on cash_ledger (shop_id, business_date);
create index on cash_ledger (source_table, source_id);

comment on table cash_ledger is
  'Append only. Money cannot appear or vanish without a row here naming the document responsible.';

-- =========================================================================
-- EXPENSES, CAPITAL AND WITHDRAWALS
--
-- Kept as three tables rather than one, because your reports treat them as
-- three different things: an expense reduces profit, capital does not, and a
-- withdrawal is the owner taking money out rather than a cost of trading.
-- Collapsing them would make the profit calculation ambiguous.
-- =========================================================================
create table expenses (
  id               uuid          primary key default gen_random_uuid(),
  shop_id          uuid          not null references shops(id) on delete restrict,
  legacy_id        text,
  cash_account_id  uuid          not null references cash_accounts(id) on delete restrict,
  category         text          not null default '',
  note             text          not null default '',
  amount           numeric(18,2) not null check (amount > 0),
  occurred_at      timestamptz   not null,
  business_date    date          not null,
  status           text          not null default 'posted'
                     check (status in ('posted', 'reversed')),
  created_by       uuid          references auth.users(id),
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  unique (shop_id, legacy_id)
);

create index on expenses (shop_id, business_date) where status = 'posted';

create table capital_movements (
  id               uuid          primary key default gen_random_uuid(),
  shop_id          uuid          not null references shops(id) on delete restrict,
  legacy_id        text,
  cash_account_id  uuid          not null references cash_accounts(id) on delete restrict,
  kind             text          not null check (kind in ('in', 'out')),
  note             text          not null default '',
  amount           numeric(18,2) not null check (amount > 0),
  occurred_at      timestamptz   not null,
  business_date    date          not null,
  status           text          not null default 'posted'
                     check (status in ('posted', 'reversed')),
  created_by       uuid          references auth.users(id),
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  unique (shop_id, legacy_id)
);

create index on capital_movements (shop_id, business_date) where status = 'posted';

comment on table capital_movements is
  'Owner money in or out of the business. In the old schema this rode on a fake product called __CAPITAL__ inside the transactions table, so it had to be filtered out of every stock loop and product query. It is a financial event and now lives with the financial events.';

create table cash_withdrawals (
  id               uuid          primary key default gen_random_uuid(),
  shop_id          uuid          not null references shops(id) on delete restrict,
  legacy_id        text,
  cash_account_id  uuid          not null references cash_accounts(id) on delete restrict,
  reason           text          not null default '',
  amount           numeric(18,2) not null check (amount > 0),
  occurred_at      timestamptz   not null,
  business_date    date          not null,
  status           text          not null default 'posted'
                     check (status in ('posted', 'reversed')),
  created_by       uuid          references auth.users(id),
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  unique (shop_id, legacy_id)
);

create index on cash_withdrawals (shop_id, business_date) where status = 'posted';

-- =========================================================================
-- updated_at triggers
-- =========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'party_bills', 'payments', 'expenses', 'capital_movements', 'cash_withdrawals'
  ] loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function touch_updated_at()',
      t, t);
  end loop;
end $$;

-- =========================================================================
-- NO DELETES — same rule as the operational documents
-- =========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'party_bills', 'payments', 'payment_allocations', 'cash_ledger',
    'expenses', 'capital_movements', 'cash_withdrawals'
  ] loop
    execute format(
      'create trigger %I_no_delete before delete on %I for each row execute function forbid_delete_posted()',
      t, t);
  end loop;
end $$;
