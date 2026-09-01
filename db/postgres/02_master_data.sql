-- =========================================================================
-- KoshAgar ERP — 02_master_data.sql
--
-- Things that exist independently of any transaction: products, units and the
-- conversions between them, parties, and the cash account.
--
-- Master data is DEACTIVATED, never deleted, so historical documents keep
-- resolving. Transaction lines additionally snapshot what they need (name,
-- unit, price), so a rename or a price change cannot reach back and alter an
-- invoice that has already been issued.
-- =========================================================================

-- =========================================================================
-- UNITS
-- =========================================================================
create table units (
  id          uuid        primary key default gen_random_uuid(),
  shop_id     uuid        not null references shops(id) on delete restrict,
  name        text        not null check (name = upper(trim(name)) and length(name) > 0),
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (shop_id, name)
);

comment on table units is
  'PIECE, KG, FEET, BOX. Uppercase is enforced so "Box" and "BOX" cannot become two units.';

-- =========================================================================
-- PRODUCTS
--
-- base_unit_id is the unit stock is HELD in. Everything - stock, FIFO lots,
-- movements - is denominated in the base unit. Buying or selling in another
-- unit goes through product_units.
-- =========================================================================
create table products (
  id            uuid        primary key default gen_random_uuid(),
  shop_id       uuid        not null references shops(id) on delete restrict,
  legacy_id     text,
  name          text        not null check (length(trim(name)) > 0),
  category      text        not null default '',
  base_unit_id  uuid        not null references units(id) on delete restrict,
  is_active     boolean     not null default true,
  created_by    uuid        references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (shop_id, legacy_id)
);

create index on products (shop_id) where is_active;
create index on products (shop_id, lower(name));

comment on column products.legacy_id is
  'The old identifier (P-001). Kept so historical receipts and searches still resolve after the migration; never used as a key.';

comment on column products.is_active is
  'Products are retired, not deleted. A product with movements can never be removed without destroying the history that explains current stock.';

-- =========================================================================
-- PRODUCT UNITS — conversions as master data
--
-- Your decision: a conversion belongs to the product, not to the line. The old
-- schema recorded entry_factor per transaction, so the same product could be
-- 1 CARTON = 12 today and = 10 tomorrow with nothing objecting - a typo that
-- silently distorted both stock and cost.
--
-- factor = how many BASE units one of this unit contains.
--   base unit itself:  factor 1
--   1 CARTON = 12 PIECE:  factor 12
-- =========================================================================
create table product_units (
  id           uuid          primary key default gen_random_uuid(),
  shop_id      uuid          not null references shops(id) on delete restrict,
  product_id   uuid          not null references products(id) on delete restrict,
  unit_id      uuid          not null references units(id) on delete restrict,
  factor       numeric(18,6) not null check (factor > 0),
  is_purchase_default boolean not null default false,
  is_sale_default     boolean not null default false,
  created_at   timestamptz   not null default now(),
  updated_at   timestamptz   not null default now(),
  unique (product_id, unit_id)
);

create index on product_units (product_id);

-- At most one default purchase unit and one default sale unit per product.
create unique index product_units_one_purchase_default
  on product_units (product_id) where is_purchase_default;
create unique index product_units_one_sale_default
  on product_units (product_id) where is_sale_default;

comment on table product_units is
  'Every transaction line must reference a row here, so an undefined conversion cannot be invented at entry time.';

-- Every product must be sellable in its own base unit at factor 1.
create or replace function ensure_base_unit_conversion()
returns trigger language plpgsql set search_path = public as $$
begin
  insert into product_units (shop_id, product_id, unit_id, factor,
                             is_purchase_default, is_sale_default)
  values (new.shop_id, new.id, new.base_unit_id, 1, true, true)
  on conflict (product_id, unit_id) do nothing;
  return new;
end $$;

create trigger products_seed_base_unit
  after insert on products
  for each row execute function ensure_base_unit_conversion();

-- The base unit's own conversion must stay at exactly 1, or stock arithmetic
-- silently shifts under every existing movement.
create or replace function protect_base_unit_factor()
returns trigger language plpgsql set search_path = public as $$
declare v_base uuid;
begin
  select base_unit_id into v_base from products where id = new.product_id;
  if new.unit_id = v_base and new.factor <> 1 then
    raise exception
      'BASE_UNIT_FACTOR: the base unit conversion must be 1, not %. Change the product base unit instead.',
      new.factor;
  end if;
  return new;
end $$;

create trigger product_units_protect_base
  before insert or update on product_units
  for each row execute function protect_base_unit_factor();

-- =========================================================================
-- PARTIES — customers and suppliers
--
-- Identity is the phone number, carried over from the existing system: the
-- same phone anywhere is the same party. Anonymous cash sales create no party
-- at all (your decision); a credit sale requires one, because a debt with
-- nobody attached cannot be collected.
-- =========================================================================
create table parties (
  id          uuid        primary key default gen_random_uuid(),
  shop_id     uuid        not null references shops(id) on delete restrict,
  legacy_id   text,
  -- Phone is the identity when present. It is optional ONLY for parties
  -- carried in from the old system, where it was often never recorded; every
  -- party created from now on must have one. See is_legacy below.
  phone       text        check (phone is null or phone ~ '^01[3-9][0-9]{8}$'),
  name        text        not null check (length(trim(name)) > 0),
  kind        text        not null check (kind in ('customer', 'supplier', 'both')),
  is_legacy   boolean     not null default false,
  address     text        not null default '',
  is_active   boolean     not null default true,
  created_by  uuid        references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (shop_id, phone),
  unique (shop_id, legacy_id),
  constraint parties_phone_required_for_new check (phone is not null or is_legacy)
);

-- Legacy parties have no phone to identify them, so the name must be unique
-- instead - otherwise two "Sojol" rows would split one person's balance.
create unique index parties_legacy_name_unique
  on parties (shop_id, lower(trim(name))) where phone is null;

create index on parties (shop_id) where is_active;
create index on parties (shop_id, name);

comment on column parties.kind is
  'A party who both buys and sells is one row marked "both", not two rows - otherwise their receivable and payable drift apart.';

-- =========================================================================
-- CASH ACCOUNTS
--
-- One drawer for now, because the shop is run by one person. The table exists
-- so that adding a second till later is a row, not a schema change.
-- =========================================================================
create table cash_accounts (
  id          uuid        primary key default gen_random_uuid(),
  shop_id     uuid        not null references shops(id) on delete restrict,
  name        text        not null check (length(trim(name)) > 0),
  kind        text        not null default 'cash'
                check (kind in ('cash', 'bank', 'mobile_money')),
  is_active   boolean     not null default true,
  is_default  boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (shop_id, name)
);

create unique index cash_accounts_one_default
  on cash_accounts (shop_id) where is_default;

-- =========================================================================
-- OPENING CASH — the drawer's starting balance for a trading day
-- =========================================================================
create table opening_cash (
  shop_id         uuid          not null references shops(id) on delete restrict,
  cash_account_id uuid          not null references cash_accounts(id) on delete restrict,
  business_date   date          not null,
  amount          numeric(18,2) not null check (amount >= 0),
  created_by      uuid          references auth.users(id),
  updated_at      timestamptz   not null default now(),
  primary key (shop_id, cash_account_id, business_date)
);

-- =========================================================================
-- updated_at triggers
-- =========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'units', 'products', 'product_units', 'parties', 'cash_accounts', 'opening_cash'
  ] loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function touch_updated_at()',
      t, t);
  end loop;
end $$;

-- =========================================================================
-- SEEDING A NEW SHOP
--
-- Called by handle_new_user() in 01_foundation.sql. A brand new account gets
-- working units and a cash drawer, so the first sale does not require setup.
-- =========================================================================
create or replace function seed_new_shop(p_shop uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into units (shop_id, name)
  select p_shop, u
  from unnest(array['PIECE','PCS','KG','FEET','BOX','CARTON','BOTTLE','METER']) as u
  on conflict (shop_id, name) do nothing;

  insert into cash_accounts (shop_id, name, kind, is_default)
  values (p_shop, 'Main Counter', 'cash', true)
  on conflict (shop_id, name) do nothing;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
