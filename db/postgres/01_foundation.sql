-- =========================================================================
-- KoshAgar ERP — 01_foundation.sql
--
-- Tenancy, period control, document numbering, duplicate prevention, audit,
-- and the shared helpers every later file depends on.
--
-- Run order: 01_foundation → 02_master_data → 03_operations → 04_finance
--            → 05_views → 06_functions → 07_rls
--
-- Engine: PostgreSQL 15+ (Supabase). Authentication lives in auth.users;
-- everything below is business data.
--
-- CONVENTIONS USED THROUGHOUT
--   money      numeric(18,2)   -- never float. Totals, payments, balances.
--   unit cost  numeric(18,4)   -- extra precision so landed-cost apportionment
--                                 does not round before it reaches a total.
--   quantity   numeric(18,3)   -- fractional units are real (KG, FEET).
--   time       timestamptz     -- the instant something happened.
--   business   date            -- the trading day it belongs to. A sale at
--     _date                       01:00 belongs to the previous day's takings,
--                                 so this is set explicitly, never derived.
--   naming     snake_case throughout, singular column names, plural tables.
-- =========================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- =========================================================================
-- SHOPS AND MEMBERSHIP
--
-- One shop_id per shop, many users. Signing up creates an empty shop; no
-- account can reach another's rows. Roles are owner and viewer only — the
-- shop is run by one person. Adding staff later means adding rows here and
-- a permissions table, without restructuring anything.
-- =========================================================================
create table shops (
  id             uuid primary key default gen_random_uuid(),
  name           text        not null default 'KoshAgar'
                   check (length(trim(name)) > 0),
  address        text        not null default '',
  phone          text        not null default '',
  currency_code  char(3)     not null default 'BDT',
  timezone       text        not null default 'Asia/Dhaka',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on column shops.timezone is
  'Determines which trading day a timestamp falls into. The shop is in Dhaka; storing it makes the business_date rule explicit rather than assumed.';

create table shop_members (
  shop_id    uuid        not null references shops(id) on delete restrict,
  user_id    uuid        not null references auth.users(id) on delete restrict,
  role       text        not null check (role in ('owner', 'viewer')),
  joined_at  timestamptz not null default now(),
  primary key (shop_id, user_id)
);

create index on shop_members (user_id);

comment on table shop_members is
  'Access is a user-to-shop link, not one-login-one-shop. A second person can be given their own login into the same shop without sharing a password.';

-- =========================================================================
-- ACCOUNTING PERIODS
--
-- Month closing, enforced by the database rather than by a UI check.
-- A closed period rejects new entries and edits; unlocking is explicit,
-- recorded, and reversible.
-- =========================================================================
create table accounting_periods (
  id           uuid        primary key default gen_random_uuid(),
  shop_id      uuid        not null references shops(id) on delete restrict,
  period_month date        not null,          -- always the 1st of the month
  status       text        not null default 'open'
                 check (status in ('open', 'closed', 'unlocked')),
  closed_at    timestamptz,
  closed_by    uuid        references auth.users(id),
  unlocked_at  timestamptz,
  unlocked_by  uuid        references auth.users(id),
  unlock_note  text        not null default '',
  unique (shop_id, period_month),
  constraint period_month_is_first_of_month
    check (period_month = date_trunc('month', period_month)::date),
  -- A closed period must record WHEN it was closed. It cannot require WHO:
  -- closed_by references auth.users, and a migration, an import or a scheduled
  -- job has no auth.uid() - so demanding it would make closing historical
  -- months during the data import impossible. A null closer means "closed by
  -- the system", which the audit_log entry alongside it explains.
  constraint closed_period_has_closed_at
    check (status <> 'closed' or closed_at is not null)
);

comment on table accounting_periods is
  'A month with no row here is open. "unlocked" is a closed month temporarily reopened - the audit trail keeps both the close and the unlock.';

-- Returns true when the given business date may be written to.
create or replace function period_is_writable(p_shop uuid, p_date date)
returns boolean language sql stable set search_path = public as $$
  select coalesce(
    (select status <> 'closed'
       from accounting_periods
      where shop_id = p_shop
        and period_month = date_trunc('month', p_date)::date),
    true);   -- no row = never closed = open
$$;

create or replace function assert_period_writable(p_shop uuid, p_date date)
returns void language plpgsql stable set search_path = public as $$
begin
  if not period_is_writable(p_shop, p_date) then
    raise exception
      'PERIOD_CLOSED: % is in a closed month. Unlock the month first, or post the correction into the current month.',
      to_char(p_date, 'FMMonth YYYY');
  end if;
end $$;

-- =========================================================================
-- DOCUMENT NUMBERING
--
-- Internal identity (uuid) is separate from the number a customer sees.
-- Existing history keeps its old numbers via legacy_no; new documents are
-- issued from here in the year-prefixed format chosen for the cutover.
--
-- Concurrency: next_document_no() locks its row for the duration of the
-- calling transaction, so two simultaneous sales cannot take the same number.
-- =========================================================================
create table document_sequences (
  shop_id    uuid    not null references shops(id) on delete restrict,
  doc_type   text    not null check (doc_type in
               ('sale', 'purchase', 'sale_return', 'purchase_return',
                'payment', 'adjustment')),
  year       int     not null check (year between 2000 and 2999),
  prefix     text    not null,
  last_value bigint  not null default 0 check (last_value >= 0),
  padding    int     not null default 6 check (padding between 1 and 12),
  primary key (shop_id, doc_type, year)
);

create or replace function next_document_no(p_shop uuid, p_type text, p_date date)
returns text language plpgsql set search_path = public as $$
declare
  v_year   int := extract(year from p_date);
  v_prefix text;
  v_next   bigint;
  v_pad    int;
begin
  -- Seed the row for a new year on first use, then take the lock.
  insert into document_sequences (shop_id, doc_type, year, prefix)
  values (p_shop, p_type, v_year,
          case p_type
            when 'sale'            then 'INV'
            when 'purchase'        then 'PUR'
            when 'sale_return'     then 'SRT'
            when 'purchase_return' then 'PRT'
            when 'payment'         then 'PAY'
            else 'ADJ'
          end)
  on conflict (shop_id, doc_type, year) do nothing;

  update document_sequences
     set last_value = last_value + 1
   where shop_id = p_shop and doc_type = p_type and year = v_year
  returning last_value, prefix, padding into v_next, v_prefix, v_pad;

  return format('%s-%s-%s', v_prefix, v_year, lpad(v_next::text, v_pad, '0'));
end $$;

comment on function next_document_no is
  'Returns INV-2026-000001 and increments under a row lock. Called inside the document transaction, so a rolled-back sale does not consume a number that is then missing from the books.';

-- =========================================================================
-- IDEMPOTENCY
--
-- A double-clicked Save, a retried request after a dropped connection, or an
-- app that crashes mid-write must not produce two sales. The client sends a
-- key it generates once per user action; a repeat returns the first result
-- instead of writing again.
-- =========================================================================
create table idempotency_keys (
  shop_id      uuid        not null references shops(id) on delete restrict,
  key          text        not null check (length(key) between 8 and 128),
  operation    text        not null,
  result       jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  primary key (shop_id, key)
);

create index on idempotency_keys (created_at);

comment on table idempotency_keys is
  'Rows older than a few days can be pruned; the protection only needs to cover the window in which a retry is plausible.';

-- =========================================================================
-- AUDIT LOG
--
-- Deliberately separate from the business tables, append-only, and never
-- truncated. The old system kept its audit trail inside the same dataset it
-- audited and capped it at 4,000 rows - so the event that overwrote the data
-- also overwrote its own history.
-- =========================================================================
create table audit_log (
  id           bigserial   primary key,
  shop_id      uuid        not null references shops(id) on delete restrict,
  occurred_at  timestamptz not null default now(),
  actor        uuid        references auth.users(id),
  action       text        not null check (length(trim(action)) > 0),
  entity_table text        not null default '',
  entity_id    uuid,
  old_value    jsonb,
  new_value    jsonb,
  note         text        not null default ''
);

create index on audit_log (shop_id, occurred_at desc);
create index on audit_log (shop_id, entity_table, entity_id);

comment on table audit_log is
  'Append only. No update or delete policy is granted in 07_rls.sql, so history cannot be rewritten through the API.';

-- =========================================================================
-- SHARED HELPERS
-- =========================================================================

-- updated_at is set by the database, never accepted from a client.
-- This is the defect that caused the September data loss: the old app compared
-- a client-supplied timestamp against the cloud's, and a stale device with a
-- fast clock won.
create or replace function touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- The shops a caller may see. STABLE + security definer so RLS policies can
-- read shop_members without recursing through its own policy.
create or replace function current_shop_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select shop_id from shop_members where user_id = auth.uid();
$$;

create or replace function has_shop_role(p_shop uuid, variadic p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from shop_members
     where shop_id = p_shop and user_id = auth.uid() and role = any(p_roles)
  );
$$;

create or replace function write_audit(
  p_shop uuid, p_action text, p_table text default '',
  p_entity uuid default null, p_old jsonb default null,
  p_new jsonb default null, p_note text default ''
) returns void language sql set search_path = public as $$
  insert into audit_log (shop_id, actor, action, entity_table, entity_id, old_value, new_value, note)
  values (p_shop, auth.uid(), p_action, p_table, p_entity, p_old, p_new, p_note);
$$;

create trigger shops_touch before update on shops
  for each row execute function touch_updated_at();

-- =========================================================================
-- SIGNUP — every new account gets its own empty shop.
-- Seeding lives in 02_master_data.sql, which creates the tables it needs.
-- =========================================================================
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  insert into shops (name) values ('KoshAgar') returning id into v_shop;
  insert into shop_members (shop_id, user_id, role) values (v_shop, new.id, 'owner');
  perform seed_new_shop(v_shop);
  return new;
end $$;

-- Trigger is created in 02_master_data.sql, once seed_new_shop() exists.
