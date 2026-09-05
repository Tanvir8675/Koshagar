-- =========================================================================
-- KoshAgar ERP - 37_export_the_reasons.sql
--
-- The export carried every figure and none of the reasons.
--
--   document_reversals - why a document was undone
--   document_edits     - what a correction changed, in words: "Price: 85 -> 90",
--                        printed beside the corrected entry by the app
--
-- A restored copy without them still adds up. It just cannot say why the day's
-- takings moved, which is exactly the question a backup gets asked months later.
-- Both are now in the file, and 36_restore_shop_data.sql puts them back.
--
-- STILL format_version 2, deliberately.
-- The change is additive in both directions: a file written before today simply
-- has no such key, and the restore reads a missing table as an empty list. A
-- version number is for saying "this cannot be read", and that is not the case
-- here - bumping it would refuse the file the shopkeeper downloaded yesterday.
-- =========================================================================

create or replace function export_shop_data(p_shop uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
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

    -- Why things were changed. document_reversals holds the reason a document
    -- was undone; document_edits holds the plain-language note of what a
    -- correction altered ("Price: 85 -> 90"), which the entry screens print
    -- beside the corrected row. Without these a restored copy still has the
    -- right numbers and no account of how it arrived at them.
    'document_reversals', coalesce((select jsonb_agg(to_jsonb(x)) from document_reversals x where x.shop_id = p_shop), '[]'::jsonb),
    'document_edits',     coalesce((select jsonb_agg(to_jsonb(x)) from document_edits x where x.shop_id = p_shop), '[]'::jsonb),

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
  'Full shop backup as one JSON document: every row, plus the reversal reasons and correction notes that explain them, plus checksums so a restore can be verified rather than assumed. VOLATILE because it records every export in audit_log.';

grant execute on function export_shop_data(uuid) to authenticated;

select 'the export now carries the reasons, not only the figures' as note;
