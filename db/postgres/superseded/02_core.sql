-- 02_core.sql — the business tables.
--
-- Ported from the FLAT transaction model the app actually runs on
-- (data.transactions in calc/financial.js, modules/inventory.js). The parallel
-- "ERP" tables in the old SQLite schema — sales, sale_items, purchases,
-- purchase_items, customer_credits, inventory_movements, stock_levels — are
-- written but never read by any screen, so they are deliberately NOT ported.
-- One representation, no reconciliation between two.
--
-- Conventions used throughout:
--   * money  — bigint paisa. No floats anywhere. Formatted for display only.
--   * qty    — numeric(14,3). Fractional units (KG, FEET) are real.
--   * ids    — uuid. legacy_id keeps the old counter value so historical bill
--              numbers on printed receipts stay searchable.
--   * delete — soft. deleted_at is set; rows are never removed.
--   * audit  — created_by on everything that records a business action.

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
create table units (
  id      uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete restrict,
  name    text not null check (name = upper(trim(name)) and length(name) > 0),
  unique (shop_id, name)
);

create table cash_accounts (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops(id) on delete restrict,
  name       text not null check (length(trim(name)) > 0),
  kind       text not null default 'cash' check (kind in ('cash','bank','mobile_money','owner')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, name)
);

create table products (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete restrict,
  legacy_id   text,
  name        text not null check (length(trim(name)) > 0),
  unit        text not null default '',
  category    text not null default '',
  attrs       jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (shop_id, legacy_id)
);

create index on products (shop_id) where deleted_at is null;
create index on products (shop_id, lower(name));

-- Party identity is the phone number, exactly as the old schema had it:
-- the same phone anywhere is the same party.
create table parties (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops(id) on delete restrict,
  phone      text not null check (phone ~ '^01[3-9][0-9]{8}$'),
  name       text not null check (length(trim(name)) > 0),
  kind       text not null check (kind in ('customer','supplier','both')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, phone)
);

-- ---------------------------------------------------------------------------
-- Bills — the header a multi-line entry hangs off. Single-line entries have no
-- bill and reference null.
-- ---------------------------------------------------------------------------
create table bills (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references shops(id) on delete restrict,
  legacy_bill_no    text,
  kind              text not null check (kind in ('sale','purchase')),
  occurred_at       timestamptz not null,
  local_date        date not null,
  party_id          uuid references parties(id),
  discount_paisa    bigint not null default 0 check (discount_paisa >= 0),
  extra_cost_paisa  bigint not null default 0 check (extra_cost_paisa >= 0),
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (shop_id, legacy_bill_no)
);

create index on bills (shop_id, local_date) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Transactions — the single line-item ledger everything is derived from.
-- Stock, FIFO cost, revenue, profit and every report read from here.
-- ---------------------------------------------------------------------------
create table transactions (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references shops(id) on delete restrict,
  legacy_id        text,
  bill_id          uuid references bills(id),
  kind             text not null check (kind in
                     ('sale','purchase','return','adjustment','capital-in','capital-out')),
  return_kind      text check (return_kind in ('sale-return','purchase-return')),
  adjustment_kind  text,
  occurred_at      timestamptz not null,
  local_date       date not null,

  product_id       uuid not null references products(id) on delete restrict,
  qty              numeric(14,3) not null check (qty > 0),
  price_paisa      bigint not null check (price_paisa >= 0),
  cost_paisa       bigint not null default 0 check (cost_paisa >= 0),
  total_paisa      bigint not null check (total_paisa >= 0),
  cash_paid_paisa  bigint check (cash_paid_paisa is null or cash_paid_paisa >= 0),

  -- Unit conversion kept first-class, as in the old schema: qty/price/total are
  -- in the product's BASE unit; these record what was actually typed.
  entry_unit       text not null default '',
  entry_qty        numeric(14,3),
  entry_factor     numeric(14,6) not null default 1 check (entry_factor > 0),
  base_unit        text not null default '',

  is_opening       boolean not null default false,
  linked_tx_id     uuid references transactions(id),
  return_group_id  uuid,
  attrs            jsonb not null default '{}'::jsonb,

  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  unique (shop_id, legacy_id),
  constraint cash_paid_within_total
    check (cash_paid_paisa is null or cash_paid_paisa <= total_paisa),
  constraint return_kind_only_on_returns
    check ((kind = 'return') = (return_kind is not null))
);

create index on transactions (shop_id, product_id) where deleted_at is null;
create index on transactions (shop_id, local_date)  where deleted_at is null;
create index on transactions (shop_id, kind, local_date) where deleted_at is null;
create index on transactions (bill_id) where bill_id is not null;

-- ---------------------------------------------------------------------------
-- Customer credit (money owed to the shop)
-- ---------------------------------------------------------------------------
create table credits (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops(id) on delete restrict,
  legacy_id       text,
  bill_id         uuid references bills(id),
  party_id        uuid references parties(id),
  customer_name   text not null check (length(trim(customer_name)) > 0),
  customer_phone  text not null default '',
  occurred_at     timestamptz not null,
  local_date      date not null,
  total_paisa     bigint not null check (total_paisa > 0),
  initial_paid_paisa bigint not null default 0 check (initial_paid_paisa >= 0),
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (shop_id, legacy_id),
  constraint initial_paid_within_total check (initial_paid_paisa <= total_paisa)
);

create table payments (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops(id) on delete restrict,
  legacy_id     text,
  credit_id     uuid not null references credits(id) on delete restrict,
  occurred_at   timestamptz not null,
  local_date    date not null,
  amount_paisa  bigint not null check (amount_paisa > 0),
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (shop_id, legacy_id)
);

create index on payments (credit_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Supplier credit (money the shop owes)
-- ---------------------------------------------------------------------------
create table supplier_credits (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops(id) on delete restrict,
  legacy_id       text,
  bill_id         uuid references bills(id),
  party_id        uuid references parties(id),
  supplier_name   text not null check (length(trim(supplier_name)) > 0),
  supplier_phone  text not null default '',
  occurred_at     timestamptz not null,
  local_date      date not null,
  total_paisa     bigint not null check (total_paisa > 0),
  initial_paid_paisa bigint not null default 0 check (initial_paid_paisa >= 0),
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (shop_id, legacy_id),
  constraint sup_initial_paid_within_total check (initial_paid_paisa <= total_paisa)
);

create table supplier_payments (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references shops(id) on delete restrict,
  legacy_id          text,
  supplier_credit_id uuid not null references supplier_credits(id) on delete restrict,
  occurred_at        timestamptz not null,
  local_date         date not null,
  amount_paisa       bigint not null check (amount_paisa > 0),
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (shop_id, legacy_id)
);

create index on supplier_payments (supplier_credit_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Cash movements not tied to a product line
-- ---------------------------------------------------------------------------
create table extra_expenses (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops(id) on delete restrict,
  legacy_id    text,
  occurred_at  timestamptz not null,
  local_date   date not null,
  note         text not null default '',
  amount_paisa bigint not null check (amount_paisa > 0),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (shop_id, legacy_id)
);

create table cash_withdrawals (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops(id) on delete restrict,
  legacy_id    text,
  occurred_at  timestamptz not null,
  local_date   date not null,
  note         text not null default '',
  amount_paisa bigint not null check (amount_paisa > 0),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (shop_id, legacy_id)
);

create table opening_cash (
  shop_id      uuid not null references shops(id) on delete restrict,
  local_date   date not null,
  amount_paisa bigint not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (shop_id, local_date)
);

-- ---------------------------------------------------------------------------
-- Audit trail — append only. No update or delete policy is granted below.
-- ---------------------------------------------------------------------------
create table audit_trail (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  action      text not null check (length(trim(action)) > 0),
  details     jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id)
);

create index on audit_trail (shop_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'shops','cash_accounts','products','parties','bills','transactions',
    'credits','payments','supplier_credits','supplier_payments',
    'extra_expenses','cash_withdrawals','opening_cash'
  ] loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function touch_updated_at()',
      t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security — every business table, same rule.
--
-- Reads: any member of the shop. Writes: owner or staff (viewers are read-only,
-- enforced here rather than by a frontend check anyone could bypass).
-- audit_trail gets insert + select only, so history cannot be rewritten.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'units','cash_accounts','products','parties','bills','transactions',
    'credits','payments','supplier_credits','supplier_payments',
    'extra_expenses','cash_withdrawals','opening_cash'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format($f$
      create policy %I_read on %I for select
        using (shop_id in (select current_shop_ids()))
    $f$, t, t);
    execute format($f$
      create policy %I_write on %I for all
        using      (has_shop_role(shop_id, 'owner', 'staff'))
        with check (has_shop_role(shop_id, 'owner', 'staff'))
    $f$, t, t);
  end loop;
end $$;

alter table audit_trail enable row level security;
create policy audit_read on audit_trail for select
  using (shop_id in (select current_shop_ids()));
create policy audit_append on audit_trail for insert
  with check (has_shop_role(shop_id, 'owner', 'staff'));
