-- =========================================================================
-- KoshAgar ERP - 36_restore_shop_data.sql
--
-- Putting an exported file back into the database, from the app.
--
-- WHAT A RESTORE IS HERE
-- export_shop_data() writes a snapshot: the actual rows, not a summary. So a
-- restore is a row-for-row copy of that snapshot into an empty set of books -
-- not a replay through post_sale and the rest.
--
-- That distinction matters. Replaying recomputes FIFO from scratch, and a
-- backdated sale or an edited bill can then consume different lots than it
-- originally did: the restored books would be internally consistent but would
-- not match the file, and the COGS on a two-year-old sale would quietly change.
-- A backup that comes back different is not a backup. The stock lots and their
-- consumption are in the export precisely so the copy can reproduce the
-- original's costs rather than recalculate them.
--
-- IDS ARE ALL NEW
-- The original books usually still exist - the repair workflow in
-- 14_shop_lifecycle.sql depends on comparing the two side by side - so copying
-- the rows under their old primary keys would collide with them. Every id is
-- therefore reissued, and every reference to it is rewritten.
--
-- The rewrite rule is one line: any uuid ANYWHERE in a restored row that names
-- a row being restored becomes that row's new id. Because ids are uuids and
-- unique across the whole database, this covers foreign keys and the
-- source_table / source_id pairs alike, without a list of columns to keep in
-- step with the schema. A uuid that is not one of ours - created_by, actor -
-- is left exactly as it is.
--
-- WHAT IT REFUSES
--   * a shop that already has documents in it (nothing here deletes, so a
--     second restore would double the books rather than replace them);
--   * a shop you do not own;
--   * a file that is not a format_version 2 export.
--
-- It runs as one statement, so it either lands completely or not at all.
-- =========================================================================

create or replace function restore_shop_data(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  -- Parents before children. stock_lot_consumption points at stock_lots, which
  -- point at purchase_lines, and so on down the list.
  v_tables text[] := array[
    'units', 'products', 'product_units', 'parties', 'cash_accounts',
    'opening_cash',
    'sales', 'sale_lines', 'purchases', 'purchase_lines',
    'returns', 'return_lines', 'adjustments',
    'stock_lots', 'stock_lot_consumption', 'inventory_movements',
    'party_bills', 'payments', 'payment_allocations', 'cash_ledger',
    'expenses', 'capital_movements', 'cash_withdrawals', 'cash_adjustments',
    'loans',
    -- Last of the documents: these two only point BACK at rows already
    -- restored, so their references resolve however the list above is ordered.
    'document_reversals', 'document_edits',
    'accounting_periods', 'audit_log'
  ];
  v_table   text;
  v_rows    jsonb;
  v_cols    text;
  v_count   int;
  v_total   int := 0;
  v_report  jsonb := '{}'::jsonb;
begin
  if not has_shop_role(p_shop, 'owner') then
    raise exception 'NOT_OWNER: only the owner can restore into a set of books.';
  end if;
  if coalesce(p_payload->>'format_version', '') <> '2' then
    raise exception
      'WRONG_FILE: this is not a KoshAgar backup file. Choose the .json file the app exported.';
  end if;
  -- shop_is_empty() asks about sales, purchases and payments. A restore also
  -- REPLACES the master data, so anything already pointing at a product would
  -- block that with a foreign key error halfway through - opening stock, for
  -- instance, which is an adjustment and leaves a lot behind. Checked here
  -- rather than widening shop_is_empty(), which other screens rely on.
  if not shop_is_empty(p_shop)
     or exists (select 1 from adjustments        where shop_id = p_shop)
     or exists (select 1 from stock_lots         where shop_id = p_shop)
     or exists (select 1 from returns            where shop_id = p_shop)
     or exists (select 1 from expenses           where shop_id = p_shop)
     or exists (select 1 from cash_withdrawals   where shop_id = p_shop)
     or exists (select 1 from capital_movements  where shop_id = p_shop)
     or exists (select 1 from loans              where shop_id = p_shop) then
    raise exception
      'SHOP_NOT_EMPTY: these books already have entries in them. A restore fills an EMPTY set of books - reset first, then restore into the fresh ones.';
  end if;

  -- ---------------------------------------------------------------------
  -- 1. New id for every row in the file.
  -- ---------------------------------------------------------------------
  -- Qualified pg_temp throughout: this function fixes search_path to public
  -- (as every security definer function here does), so an unqualified temp
  -- table would not be found by its own queries.
  create temporary table _restore_map (
    old_id uuid primary key,
    new_id uuid not null default gen_random_uuid()
  ) on commit drop;

  foreach v_table in array v_tables loop
    if v_table = 'audit_log' then continue; end if;   -- its key is a bigint
    v_rows := coalesce(p_payload->v_table, '[]'::jsonb);
    insert into pg_temp._restore_map (old_id)
    select distinct (e->>'id')::uuid
      from jsonb_array_elements(v_rows) e
     where e ? 'id' and (e->>'id') is not null
    on conflict (old_id) do nothing;
  end loop;

  -- ---------------------------------------------------------------------
  -- 2. Clear what seed_new_shop() put in the empty shop.
  --
  -- A new shop is created with default units and a cash drawer. The file has
  -- its own, and units are unique per (shop, name), so the seeded PCS would
  -- collide with the restored PCS - and the restored products point at the
  -- file's unit ids, not the seeded ones. The shop is empty, so nothing refers
  -- to these yet. None of these tables carry the no-delete trigger; the
  -- document tables that do are untouched here.
  -- ---------------------------------------------------------------------
  delete from product_units      where shop_id = p_shop;
  delete from products           where shop_id = p_shop;
  delete from units              where shop_id = p_shop;
  delete from cash_accounts      where shop_id = p_shop;
  delete from parties            where shop_id = p_shop;
  delete from opening_cash       where shop_id = p_shop;
  delete from accounting_periods where shop_id = p_shop;
  delete from document_sequences where shop_id = p_shop;

  -- ---------------------------------------------------------------------
  -- 3. Copy the rows.
  --
  -- The column list comes from the catalogue and skips generated columns:
  -- line_total is computed by the database from qty and price, and cannot be
  -- written to. Everything else is inserted exactly as exported.
  -- ---------------------------------------------------------------------
  foreach v_table in array v_tables loop
    v_rows := coalesce(p_payload->v_table, '[]'::jsonb);
    if jsonb_array_length(v_rows) = 0 then continue; end if;

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into v_cols
      from information_schema.columns
     where table_schema = 'public'
       and table_name = v_table
       and is_generated = 'NEVER'
       -- audit_log.id is a bigserial shared with every other shop's history,
       -- so the copy takes a fresh one rather than the number it had.
       and not (v_table = 'audit_log' and column_name = 'id');

    -- Rewrite every row: this shop's id, new ids, references followed through.
    execute format($sql$
      insert into %I (%s)
      select %s
      from jsonb_populate_recordset(null::%I, (
        select coalesce(jsonb_agg(
          (select jsonb_object_agg(k,
             case
               when k = 'shop_id' then to_jsonb($2::text)
               when jsonb_typeof(v) = 'string' and m.new_id is not null
                 then to_jsonb(m.new_id::text)
               else v
             end)
           from jsonb_each(e) kv(k, v)
           left join pg_temp._restore_map m
             on jsonb_typeof(v) = 'string' and m.old_id::text = (v #>> '{}'))
        ), '[]'::jsonb)
        from jsonb_array_elements($1) e
      ))
    $sql$, v_table, v_cols, v_cols, v_table)
    using v_rows, p_shop::text;

    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
    v_report := v_report || jsonb_build_object(v_table, v_count);
  end loop;

  -- ---------------------------------------------------------------------
  -- 4. Restart document numbering above what was restored.
  --
  -- document_sequences is not in the export - it is machinery, not history -
  -- so without this the next sale would be numbered INV-2026-000001 again and
  -- collide with the one that came back from the file.
  -- ---------------------------------------------------------------------
  insert into document_sequences (shop_id, doc_type, year, prefix, last_value)
  select p_shop, d.doc_type, d.yr, d.prefix, max(d.seq)
  from (
    select 'sale' as doc_type, 'INV' as prefix,
           extract(year from business_date)::int as yr,
           coalesce(nullif(regexp_replace(invoice_no, '^.*-', ''), '')::bigint, 0) as seq
      from sales where shop_id = p_shop and invoice_no ~ '-[0-9]+$'
    union all
    select 'purchase', 'PUR', extract(year from business_date)::int,
           coalesce(nullif(regexp_replace(bill_no, '^.*-', ''), '')::bigint, 0)
      from purchases where shop_id = p_shop and bill_no ~ '-[0-9]+$'
    union all
    select case when kind = 'sale_return' then 'sale_return' else 'purchase_return' end,
           case when kind = 'sale_return' then 'SRT' else 'PRT' end,
           extract(year from business_date)::int,
           coalesce(nullif(regexp_replace(return_no, '^.*-', ''), '')::bigint, 0)
      from returns where shop_id = p_shop and return_no ~ '-[0-9]+$'
    union all
    select 'payment', 'PAY', extract(year from business_date)::int,
           coalesce(nullif(regexp_replace(payment_no, '^.*-', ''), '')::bigint, 0)
      from payments where shop_id = p_shop and payment_no ~ '-[0-9]+$'
    union all
    select 'adjustment', 'ADJ', extract(year from business_date)::int,
           coalesce(nullif(regexp_replace(adjustment_no, '^.*-', ''), '')::bigint, 0)
      from adjustments where shop_id = p_shop and adjustment_no ~ '-[0-9]+$'
  ) d
  group by d.doc_type, d.yr, d.prefix
  on conflict (shop_id, doc_type, year)
  do update set last_value = greatest(document_sequences.last_value, excluded.last_value);

  -- The shop's own name, address and phone are in the file too. They are on the
  -- invoice, so a restored set of books that calls itself something else is
  -- wrong in a way the shopkeeper notices immediately.
  update shops
     set name    = coalesce(nullif(trim(p_payload->'shop'->>'name'), ''), name),
         address = coalesce(p_payload->'shop'->>'address', address),
         phone   = coalesce(p_payload->'shop'->>'phone', phone)
   where id = p_shop;

  perform write_audit(p_shop, 'data_restored', 'shops', p_shop, null,
                      jsonb_build_object('rows', v_total,
                                         'from_export', p_payload->>'exported_at',
                                         'tables', v_report));

  return jsonb_build_object('ok', true, 'shop_id', p_shop, 'rows_restored', v_total,
                            'tables', v_report,
                            'checksums', p_payload->'checksums');
end $fn$;

grant execute on function restore_shop_data(uuid, jsonb) to authenticated;

comment on function restore_shop_data is
  'Copies an export_shop_data() snapshot into an empty shop, reissuing every id so the original books can still exist beside it. Refuses a non-empty shop, a shop you do not own, and anything that is not a format_version 2 export.';

select 'a backup file can be restored from the app' as note;
