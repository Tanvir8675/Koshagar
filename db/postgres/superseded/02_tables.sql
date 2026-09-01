-- 02_tables.sql — faithful port of the live SQLite schema, keyed by UUID.
--
-- Source of truth: the schema read out of the running database (shop.sqlite) —
-- 29 tables, exactly as the app has been using them. Table names, column names,
-- column order, defaults and every CHECK constraint are preserved so the app's
-- queries and the calc/report code keep behaving identically. The ERP tables are
-- ported in full, not dropped.
--
-- TYPE MAPPING (mechanical, no semantic change):
--   TEXT             -> text
--   REAL             -> double precision
--   INTEGER (paisa)  -> bigint
--   INTEGER (0/1)    -> smallint with the same CHECK
--   TEXT (ISO date)  -> text            (the app stores ISO strings; kept as-is)
--   TEXT (json)      -> text            (validated by kosh_json_ok, as before)
--   GLOB             -> ~ regex         (same pattern)
--
-- TWO STRUCTURAL CHANGES, both required by going online:
--
-- 1. UUID keys. SQLite used app-generated ids from local counters ('P-001',
--    '1100000477'). Those are unique only within one browser: two devices both
--    produce P-280 for different products. Keys are now uuid with a server-side
--    default, so an id can never collide no matter how many devices are writing.
--    The old value is kept in legacy_id — printed receipts and bill numbers stay
--    searchable, and the import maps foreign keys through it.
--
-- 2. shop_id. The flat tables carried no shop_id because the database lived in
--    one browser and was implicitly one shop. With separate accounts that scope
--    must be explicit, or every account would share one dataset.
--
-- Because UUIDs are globally unique, primary keys stay SINGLE-column exactly as
-- SQLite had them, and every foreign key stays single-column too.

create extension if not exists pgcrypto;

-- ===========================================================================
-- Core / tenancy
-- ===========================================================================
create table shops (
  id            uuid primary key default gen_random_uuid(),
  name          text not null default 'KoshAgar',
  address       text not null default '',
  phone         text not null default '',
  currency_code text not null default 'BDT',
  created_at    text not null,
  updated_at    text not null
);

-- Membership is what makes "a new id gets its own empty app" work.
create table shop_members (
  shop_id   uuid not null references shops(id) on delete restrict on update cascade,
  user_id   uuid not null references auth.users(id) on delete restrict,
  role      text not null check (role in ('owner','staff','viewer')),
  joined_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);
create index on shop_members (user_id);

-- meta was a single global key/value store; it becomes per-shop.
create table meta (
  shop_id uuid not null references shops(id) on delete cascade on update cascade,
  key     text not null,
  value   text not null,
  primary key (shop_id, key)
);

-- ===========================================================================
-- Flat model — what every screen, report and calculation actually reads
-- ===========================================================================
create table products (
  id        uuid primary key default gen_random_uuid(),
  shop_id   uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id text,
  name      text not null check (length(trim(coalesce(name, ''))) > 0),
  unit      text not null default '',
  category  text not null default '',
  json      text not null default '{}',
  unique (shop_id, legacy_id)
);

create table parties (
  id      uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade on update cascade,
  phone   text not null check (phone ~ '^01[3-9][0-9]{8}$'),
  name    text not null check (length(trim(coalesce(name, ''))) > 0),
  type    text not null check (type in ('customer','supplier','both')),
  json    text not null default '{}',
  unique (shop_id, phone)
);

create table transactions (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id        text,
  type             text not null check (type in
                     ('sale','purchase','return','adjustment','capital-in','capital-out')),
  date             text not null,
  local_date       text not null default '',
  "productId"      uuid not null references products(id)
                     on delete restrict on update cascade,
  qty              double precision not null check (qty > 0),
  price            double precision not null check (price >= 0),
  cost             double precision not null default 0 check (cost >= 0),
  total            double precision not null check (total >= 0),
  "cashPaid"       double precision check ("cashPaid" is null or "cashPaid" >= 0),
  "returnType"     text,
  "linkedTxId"     uuid references transactions(id)
                     on delete set null on update cascade deferrable initially deferred,
  opening          smallint not null default 0 check (opening in (0,1)),
  "adjustmentType" text,
  -- Unit conversion stays first-class: qty/price/total are in the product's BASE
  -- unit; these record what was actually entered. entry_factor = base units per
  -- 1 entered unit (1 for simple products / sales in the base unit).
  entry_unit       text not null default '',
  entry_qty        double precision,
  entry_factor     double precision not null default 1 check (entry_factor > 0),
  base_unit        text not null default '',
  json             text not null default '{}',
  unique (shop_id, legacy_id),
  check ("cashPaid" is null or "cashPaid" <= total + 0.01)
);

create table credits (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id       text,
  date            text not null,
  local_date      text not null default '',
  "customerName"  text not null check (length(trim(coalesce("customerName", ''))) > 0),
  "customerPhone" text not null default '',
  total           double precision not null check (total > 0),
  paid            double precision not null default 0 check (paid >= 0),
  party_id        uuid references parties(id)
                    on delete set null on update cascade deferrable initially deferred,
  json            text not null default '{}',
  unique (shop_id, legacy_id),
  check (paid <= total + 0.01)
);

create table payments (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id  text,
  "creditId" uuid not null references credits(id) on delete restrict on update cascade,
  date       text not null,
  local_date text not null default '',
  amount     double precision not null check (amount > 0),
  json       text not null default '{}',
  unique (shop_id, legacy_id)
);

create table supplier_credits (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id       text,
  date            text not null,
  local_date      text not null default '',
  "supplierName"  text not null default '',
  "supplierPhone" text not null default '',
  total           double precision not null check (total > 0),
  paid            double precision not null default 0 check (paid >= 0),
  party_id        uuid references parties(id)
                    on delete set null on update cascade deferrable initially deferred,
  json            text not null default '{}',
  unique (shop_id, legacy_id),
  check (paid <= total + 0.01)
);

create table supplier_payments (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id  text,
  "scId"     uuid not null references supplier_credits(id) on delete restrict on update cascade,
  date       text not null,
  local_date text not null default '',
  amount     double precision not null check (amount > 0),
  json       text not null default '{}',
  unique (shop_id, legacy_id)
);

create table loan_payments (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id  text,
  "loanTxId" uuid not null references transactions(id) on delete restrict on update cascade,
  date       text not null,
  local_date text not null default '',
  amount     double precision not null check (amount > 0),
  note       text not null default '',
  json       text not null default '{}',
  unique (shop_id, legacy_id)
);

create table extra_expenses (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id  text,
  date       text not null,
  local_date text not null default '',
  amount     double precision not null check (amount > 0),
  note       text not null default '',
  json       text not null default '{}',
  unique (shop_id, legacy_id)
);

create table cash_withdrawals (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id  text,
  date       text not null,
  local_date text not null default '',
  amount     double precision not null check (amount > 0),
  reason     text not null default '',
  json       text not null default '{}',
  unique (shop_id, legacy_id)
);

-- opening_cash and units were keyed by their natural value in SQLite, not by a
-- generated id. That stays true — a uuid here would add nothing.
create table opening_cash (
  shop_id uuid not null references shops(id) on delete cascade on update cascade,
  date    text not null,
  amount  double precision not null check (amount >= 0),
  primary key (shop_id, date)
);

create table units (
  shop_id uuid not null references shops(id) on delete cascade on update cascade,
  name    text not null check (length(trim(coalesce(name, ''))) > 0),
  primary key (shop_id, name)
);

create table audit_trail (
  id        uuid primary key default gen_random_uuid(),
  shop_id   uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id text,
  json      text not null default '{}',
  unique (shop_id, legacy_id)
);

-- ===========================================================================
-- ERP model — ported in full, unchanged apart from the key type
-- ===========================================================================
create table customers (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id         text,
  name              text not null check (length(trim(name)) > 0),
  phone             text not null default '',
  address           text not null default '',
  opening_due_paisa bigint not null default 0 check (opening_due_paisa >= 0),
  active            smallint not null default 1 check (active in (0,1)),
  created_at        text not null,
  updated_at        text not null,
  unique (shop_id, phone),
  unique (shop_id, legacy_id)
);

create table suppliers (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id         text,
  name              text not null check (length(trim(name)) > 0),
  phone             text not null default '',
  address           text not null default '',
  opening_due_paisa bigint not null default 0 check (opening_due_paisa >= 0),
  active            smallint not null default 1 check (active in (0,1)),
  created_at        text not null,
  updated_at        text not null,
  unique (shop_id, phone),
  unique (shop_id, legacy_id)
);

create table sales (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id       text,
  invoice_no      text not null,
  customer_id     uuid references customers(id) on delete set null on update cascade,
  sale_date       text not null,
  gross_paisa     bigint not null default 0 check (gross_paisa >= 0),
  discount_paisa  bigint not null default 0 check (discount_paisa >= 0),
  net_paisa       bigint not null check (net_paisa >= 0),
  cash_paid_paisa bigint not null default 0 check (cash_paid_paisa >= 0),
  status          text not null default 'posted' check (status in ('draft','posted','void','returned')),
  notes           text not null default '',
  source_ref      text not null default '',
  created_at      text not null,
  updated_at      text not null,
  unique (shop_id, invoice_no),
  unique (shop_id, legacy_id),
  check (discount_paisa <= gross_paisa),
  check (net_paisa = gross_paisa - discount_paisa),
  check (cash_paid_paisa <= net_paisa)
);

create table sale_items (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id        text,
  sale_id          uuid not null references sales(id) on delete cascade on update cascade,
  product_id       uuid not null references products(id) on delete restrict on update cascade,
  unit_name        text not null default '',
  qty_milli        bigint not null check (qty_milli > 0),
  unit_price_paisa bigint not null check (unit_price_paisa >= 0),
  discount_paisa   bigint not null default 0 check (discount_paisa >= 0),
  line_total_paisa bigint not null check (line_total_paisa >= 0),
  cogs_unit_paisa  bigint not null default 0 check (cogs_unit_paisa >= 0),
  created_at       text not null,
  unique (shop_id, legacy_id),
  check (line_total_paisa = ((qty_milli * unit_price_paisa) / 1000) - discount_paisa)
);

create table purchases (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id        text,
  bill_no          text not null,
  supplier_id      uuid references suppliers(id) on delete set null on update cascade,
  purchase_date    text not null,
  gross_paisa      bigint not null default 0 check (gross_paisa >= 0),
  discount_paisa   bigint not null default 0 check (discount_paisa >= 0),
  extra_cost_paisa bigint not null default 0 check (extra_cost_paisa >= 0),
  net_paisa        bigint not null check (net_paisa >= 0),
  cash_paid_paisa  bigint not null default 0 check (cash_paid_paisa >= 0),
  status           text not null default 'posted' check (status in ('draft','posted','void','returned')),
  notes            text not null default '',
  source_ref       text not null default '',
  created_at       text not null,
  updated_at       text not null,
  unique (shop_id, bill_no),
  unique (shop_id, legacy_id),
  check (discount_paisa <= gross_paisa),
  check (net_paisa = gross_paisa - discount_paisa),
  check (cash_paid_paisa <= net_paisa)
);

create table purchase_items (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id         text,
  purchase_id       uuid not null references purchases(id) on delete cascade on update cascade,
  product_id        uuid not null references products(id) on delete restrict on update cascade,
  unit_name         text not null default '',
  qty_milli         bigint not null check (qty_milli > 0),
  list_unit_paisa   bigint not null default 0 check (list_unit_paisa >= 0),
  net_unit_paisa    bigint not null check (net_unit_paisa >= 0),
  landed_unit_paisa bigint not null check (landed_unit_paisa >= 0),
  discount_paisa    bigint not null default 0 check (discount_paisa >= 0),
  line_total_paisa  bigint not null check (line_total_paisa >= 0),
  created_at        text not null,
  unique (shop_id, legacy_id)
);

create table customer_credits (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id          text,
  customer_id        uuid not null references customers(id) on delete restrict on update cascade,
  sale_id            uuid references sales(id) on delete set null on update cascade,
  credit_date        text not null,
  total_paisa        bigint not null check (total_paisa > 0),
  initial_paid_paisa bigint not null default 0 check (initial_paid_paisa >= 0),
  status             text not null default 'open' check (status in ('open','closed','void')),
  created_at         text not null,
  unique (shop_id, legacy_id),
  check (initial_paid_paisa <= total_paisa)
);

create table customer_payments (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id    text,
  credit_id    uuid not null references customer_credits(id) on delete restrict on update cascade,
  payment_date text not null,
  amount_paisa bigint not null check (amount_paisa <> 0),
  method       text not null default 'cash',
  note         text not null default '',
  created_at   text not null,
  unique (shop_id, legacy_id)
);

create table supplier_credits_erp (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id          text,
  supplier_id        uuid not null references suppliers(id) on delete restrict on update cascade,
  purchase_id        uuid references purchases(id) on delete set null on update cascade,
  credit_date        text not null,
  total_paisa        bigint not null check (total_paisa > 0),
  initial_paid_paisa bigint not null default 0 check (initial_paid_paisa >= 0),
  status             text not null default 'open' check (status in ('open','closed','void')),
  created_at         text not null,
  unique (shop_id, legacy_id),
  check (initial_paid_paisa <= total_paisa)
);

create table supplier_payments_erp (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id    text,
  credit_id    uuid not null references supplier_credits_erp(id) on delete restrict on update cascade,
  payment_date text not null,
  amount_paisa bigint not null check (amount_paisa <> 0),
  method       text not null default 'cash',
  note         text not null default '',
  created_at   text not null,
  unique (shop_id, legacy_id)
);

create table inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id       text,
  product_id      uuid not null references products(id) on delete restrict on update cascade,
  movement_date   text not null,
  movement_type   text not null check (movement_type in
                    ('opening','purchase','sale','sale_return','purchase_return',
                     'adjustment_in','adjustment_out','damage','transfer_in','transfer_out')),
  source_table    text not null default '',
  source_id       text not null default '',
  qty_delta_milli bigint not null check (qty_delta_milli <> 0),
  unit_cost_paisa bigint not null default 0 check (unit_cost_paisa >= 0),
  created_at      text not null,
  unique (shop_id, legacy_id)
);

create table stock_levels (
  shop_id     uuid not null references shops(id) on delete cascade on update cascade,
  product_id  uuid not null references products(id) on delete cascade on update cascade,
  qty_milli   bigint not null default 0,
  value_paisa bigint not null default 0 check (value_paisa >= 0),
  updated_at  text not null,
  primary key (shop_id, product_id)
);

create table cash_accounts (
  id                    uuid primary key default gen_random_uuid(),
  shop_id               uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id             text,
  name                  text not null,
  type                  text not null default 'cash' check (type in ('cash','bank','mobile_money','owner')),
  opening_balance_paisa bigint not null default 0,
  active                smallint not null default 1 check (active in (0,1)),
  created_at            text not null,
  updated_at            text not null,
  unique (shop_id, name),
  unique (shop_id, legacy_id)
);

create table cash_ledger (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops(id) on delete cascade on update cascade,
  legacy_id    text,
  account_id   uuid references cash_accounts(id) on delete set null on update cascade,
  entry_date   text not null,
  direction    text not null check (direction in ('in','out')),
  amount_paisa bigint not null check (amount_paisa > 0),
  source_table text not null default '',
  source_id    text not null default '',
  note         text not null default '',
  created_at   text not null,
  unique (shop_id, legacy_id)
);
