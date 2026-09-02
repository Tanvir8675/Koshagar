-- =========================================================================
-- KoshAgar ERP — 13_backup.sql
--
-- A downloadable copy of everything in one shop.
--
-- WHY THIS MATTERS MORE THAN USUAL
-- In September 2026 this shop nearly lost six months of records because the
-- only copies lived inside two browsers that disagreed with each other. The
-- data now lives on a server, which removes that failure mode - but a hosted
-- database is still one account, one provider and one billing status away from
-- being unreachable. A file you hold yourself is the only backup that does not
-- depend on somebody else staying online.
--
-- WHAT RESET MEANS NOW
-- Reset used to be destructive because the database lived in the browser and
-- could genuinely become corrupt. It cannot any more: the browser holds no
-- authoritative data. So "reset" is a CLIENT operation - clear the caches, drop
-- the service worker, reload, and read the server again. It touches nothing
-- here, which is why there is no reset function in this file. Wiping server
-- data is a different act and should never share a button with clearing a cache.
-- =========================================================================

create or replace function export_shop_data(p_shop uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  -- Membership check: security definer bypasses RLS, so the caller's right to
  -- this shop has to be proven explicitly.
  if not exists (select 1 from shop_members
                  where shop_id = p_shop and user_id = auth.uid()) then
    raise exception 'NOT_A_MEMBER: you do not have access to this shop.';
  end if;

  select jsonb_build_object(
    'format_version', 2,
    'exported_at',    now(),
    'shop',           (select to_jsonb(s) from shops s where s.id = p_shop),

    -- Master data
    'units',          coalesce((select jsonb_agg(to_jsonb(u)) from units u where u.shop_id = p_shop), '[]'::jsonb),
    'products',       coalesce((select jsonb_agg(to_jsonb(p)) from products p where p.shop_id = p_shop), '[]'::jsonb),
    'product_units',  coalesce((select jsonb_agg(to_jsonb(pu)) from product_units pu where pu.shop_id = p_shop), '[]'::jsonb),
    'parties',        coalesce((select jsonb_agg(to_jsonb(pt)) from parties pt where pt.shop_id = p_shop), '[]'::jsonb),
    'cash_accounts',  coalesce((select jsonb_agg(to_jsonb(ca)) from cash_accounts ca where ca.shop_id = p_shop), '[]'::jsonb),

    -- Trading documents
    'sales',          coalesce((select jsonb_agg(to_jsonb(x)) from sales x where x.shop_id = p_shop), '[]'::jsonb),
    'sale_lines',     coalesce((select jsonb_agg(to_jsonb(x)) from sale_lines x where x.shop_id = p_shop), '[]'::jsonb),
    'purchases',      coalesce((select jsonb_agg(to_jsonb(x)) from purchases x where x.shop_id = p_shop), '[]'::jsonb),
    'purchase_lines', coalesce((select jsonb_agg(to_jsonb(x)) from purchase_lines x where x.shop_id = p_shop), '[]'::jsonb),
    'returns',        coalesce((select jsonb_agg(to_jsonb(x)) from returns x where x.shop_id = p_shop), '[]'::jsonb),
    'return_lines',   coalesce((select jsonb_agg(to_jsonb(x)) from return_lines x where x.shop_id = p_shop), '[]'::jsonb),
    'adjustments',    coalesce((select jsonb_agg(to_jsonb(x)) from adjustments x where x.shop_id = p_shop), '[]'::jsonb),

    -- Inventory. The lots and their consumption are included so a restored copy
    -- can explain its own COGS, not merely state it.
    'inventory_movements',   coalesce((select jsonb_agg(to_jsonb(x)) from inventory_movements x where x.shop_id = p_shop), '[]'::jsonb),
    'stock_lots',            coalesce((select jsonb_agg(to_jsonb(x)) from stock_lots x where x.shop_id = p_shop), '[]'::jsonb),
    'stock_lot_consumption', coalesce((select jsonb_agg(to_jsonb(x)) from stock_lot_consumption x where x.shop_id = p_shop), '[]'::jsonb),

    -- Money
    'party_bills',         coalesce((select jsonb_agg(to_jsonb(x)) from party_bills x where x.shop_id = p_shop), '[]'::jsonb),
    'payments',            coalesce((select jsonb_agg(to_jsonb(x)) from payments x where x.shop_id = p_shop), '[]'::jsonb),
    'payment_allocations', coalesce((select jsonb_agg(to_jsonb(x)) from payment_allocations x where x.shop_id = p_shop), '[]'::jsonb),
    'cash_ledger',         coalesce((select jsonb_agg(to_jsonb(x)) from cash_ledger x where x.shop_id = p_shop), '[]'::jsonb),
    'expenses',            coalesce((select jsonb_agg(to_jsonb(x)) from expenses x where x.shop_id = p_shop), '[]'::jsonb),
    'capital_movements',   coalesce((select jsonb_agg(to_jsonb(x)) from capital_movements x where x.shop_id = p_shop), '[]'::jsonb),
    'cash_withdrawals',    coalesce((select jsonb_agg(to_jsonb(x)) from cash_withdrawals x where x.shop_id = p_shop), '[]'::jsonb),
    'cash_adjustments',    coalesce((select jsonb_agg(to_jsonb(x)) from cash_adjustments x where x.shop_id = p_shop), '[]'::jsonb),
    'opening_cash',        coalesce((select jsonb_agg(to_jsonb(x)) from opening_cash x where x.shop_id = p_shop), '[]'::jsonb),
    'loans',               coalesce((select jsonb_agg(to_jsonb(x)) from loans x where x.shop_id = p_shop), '[]'::jsonb),

    -- Control
    'accounting_periods', coalesce((select jsonb_agg(to_jsonb(x)) from accounting_periods x where x.shop_id = p_shop), '[]'::jsonb),
    'audit_log',          coalesce((select jsonb_agg(to_jsonb(x)) from audit_log x where x.shop_id = p_shop), '[]'::jsonb),

    -- Figures the file can be checked against without replaying anything.
    -- If a restore does not reproduce these, something was lost in transit.
    'checksums', jsonb_build_object(
      'sales',        (select count(*) from sales where shop_id = p_shop),
      'sale_lines',   (select count(*) from sale_lines where shop_id = p_shop),
      'purchases',    (select count(*) from purchases where shop_id = p_shop),
      'payments',     (select count(*) from payments where shop_id = p_shop),
      'products',     (select count(*) from products where shop_id = p_shop),
      'stock_value',  (select coalesce(sum(round(qty_remaining * unit_cost, 2)), 0)
                         from stock_lots where shop_id = p_shop and qty_remaining > 0),
      'receivable',   (select coalesce(sum(balance), 0) from v_bill_balances
                         where shop_id = p_shop and direction = 'receivable' and balance > 0),
      'payable',      (select coalesce(sum(balance), 0) from v_bill_balances
                         where shop_id = p_shop and direction = 'payable' and balance > 0)
    )
  ) into v_out;

  perform write_audit(p_shop, 'data_exported', 'shops', p_shop, null,
                      v_out->'checksums');

  return v_out;
end $$;

comment on function export_shop_data is
  'Full shop backup as one JSON document, with checksums so a restore can be verified rather than assumed. The audit_log records every export.';

grant execute on function export_shop_data(uuid) to authenticated;

-- =========================================================================
-- IS THIS SHOP EMPTY?
--
-- A restore replays documents through the posting functions, which means
-- importing into a shop that already has data would DUPLICATE it rather than
-- replace it - nothing here can be deleted to make room. So a restore must
-- target an empty shop, and the app checks with this before offering the option.
-- =========================================================================
create or replace function shop_is_empty(p_shop uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from sales     where shop_id = p_shop)
     and not exists (select 1 from purchases where shop_id = p_shop)
     and not exists (select 1 from payments  where shop_id = p_shop);
$$;

grant execute on function shop_is_empty(uuid) to authenticated;

-- =========================================================================
-- START A FRESH SHOP
--
-- The "reset the phone" case: keep everything that happened, but begin again
-- with a clean set of books. The old shop is left untouched and still readable,
-- so nothing is destroyed - which is the whole point of doing it this way
-- rather than deleting rows.
-- =========================================================================
create or replace function create_additional_shop(p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN: a shop can only be created by a signed-in user.';
  end if;

  insert into shops (name) values (coalesce(nullif(trim(p_name), ''), 'KoshAgar'))
  returning id into v_shop;

  insert into shop_members (shop_id, user_id, role) values (v_shop, auth.uid(), 'owner');
  perform seed_new_shop(v_shop);

  perform write_audit(v_shop, 'shop_created', 'shops', v_shop, null,
                      jsonb_build_object('name', p_name));

  return jsonb_build_object('ok', true, 'shop_id', v_shop);
end $$;

grant execute on function create_additional_shop(text) to authenticated;
