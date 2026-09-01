-- 01_tenancy.sql — shops, membership, and the isolation rules everything else leans on.
--
-- Run order: 01_tenancy → 02_core → 03_views → 04_functions
--
-- Model: ONE shop_id per shop, MANY users. This is not branches. Signing up
-- creates an empty shop; signing in from any device reaches the same shop; no
-- account can read another's rows. Isolation is enforced by the database, so a
-- bug in the frontend cannot leak or cross-write data.

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Shops
-- ---------------------------------------------------------------------------
create table shops (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null default 'KoshAgar' check (length(trim(name)) > 0),
  address    text        not null default '',
  phone      text        not null default '',
  currency   char(3)     not null default 'BDT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table shop_members (
  shop_id   uuid not null references shops(id) on delete restrict,
  user_id   uuid not null references auth.users(id) on delete restrict,
  role      text not null check (role in ('owner', 'staff', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);

create index on shop_members (user_id);

-- ---------------------------------------------------------------------------
-- Helpers used by every RLS policy
--
-- STABLE + security definer so the policy can read shop_members without
-- recursing back through shop_members' own policy.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- updated_at is set by the DATABASE, never by the client.
--
-- This is the specific defect that cost months of data: the old app compared a
-- client-supplied timestamp against the cloud's, and a device with a stale copy
-- and a fresher clock won. A client can no longer influence this value at all.
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Signup: every new user gets their own empty shop, seeded and ready.
-- ---------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  insert into shops (name) values ('KoshAgar') returning id into v_shop;
  insert into shop_members (shop_id, user_id, role) values (v_shop, new.id, 'owner');

  insert into units (shop_id, name) values
    (v_shop, 'PIECE'), (v_shop, 'PCS'), (v_shop, 'KG'),
    (v_shop, 'FEET'),  (v_shop, 'BOX'), (v_shop, 'CARTON');

  insert into cash_accounts (shop_id, name, kind) values (v_shop, 'Main Counter', 'cash');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

alter table shops        enable row level security;
alter table shop_members enable row level security;

create policy shops_read on shops
  for select using (id in (select current_shop_ids()));

create policy shops_write on shops
  for update using (has_shop_role(id, 'owner'))
  with check (has_shop_role(id, 'owner'));

create policy members_read on shop_members
  for select using (shop_id in (select current_shop_ids()));

create policy members_manage on shop_members
  for all using (has_shop_role(shop_id, 'owner'))
  with check (has_shop_role(shop_id, 'owner'));
