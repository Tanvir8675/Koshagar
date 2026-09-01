-- =========================================================================
-- KoshAgar ERP — 03_operations.sql
--
-- Sales, purchases, returns, adjustments, and the inventory ledger that
-- explains every one of them.
--
-- THE CENTRAL RULE OF THIS FILE
-- No table here holds a "current stock" number. Stock is the sum of
-- inventory_movements, and inventory_movements is the only way stock changes.
-- There is therefore no column anyone can write to make stock wrong, and
-- "why is this product's stock 42?" is answered by reading rows.
--
-- SNAPSHOTS
-- Every line copies the product name, unit name and conversion factor as they
-- were at the moment of the transaction. Renaming a product tomorrow cannot
-- alter an invoice issued today - the defect that made old invoices mutable
-- in the previous system.
-- =========================================================================

-- =========================================================================
-- DOCUMENT LIFECYCLE
--
-- Your decision: free editing on the day of entry, reversal-only afterwards.
-- Nothing posted is ever deleted.
--
--   posted   - live, counts in every report
--   reversed - superseded by a reversal document; both remain visible
--
-- There is no 'draft': the existing app posts immediately and you did not ask
-- for a confirmation step, so adding one would invent a workflow.
-- =========================================================================
create table document_reversals (
  id             uuid        primary key default gen_random_uuid(),
  shop_id        uuid        not null references shops(id) on delete restrict,
  original_type  text        not null check (original_type in
                   ('sale', 'purchase', 'return', 'adjustment', 'payment')),
  original_id    uuid        not null,
  reversal_id    uuid        not null,
  reason         text        not null default '',
  created_by     uuid        references auth.users(id),
  created_at     timestamptz not null default now(),
  unique (original_type, original_id)
);

comment on table document_reversals is
  'One reversal per document - the unique constraint stops a document being reversed twice, which would double-count the correction.';

-- =========================================================================
-- SALES
-- =========================================================================
create table sales (
  id             uuid          primary key default gen_random_uuid(),
  shop_id        uuid          not null references shops(id) on delete restrict,
  legacy_id      text,
  invoice_no     text          not null,
  legacy_no      text,
  party_id       uuid          references parties(id) on delete restrict,
  occurred_at    timestamptz   not null,
  business_date  date          not null,
  bill_discount  numeric(18,2) not null default 0 check (bill_discount >= 0),
  status         text          not null default 'posted'
                   check (status in ('posted', 'reversed')),
  note           text          not null default '',
  created_by     uuid          references auth.users(id),
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now(),
  unique (shop_id, invoice_no),
  unique (shop_id, legacy_id)
);

create index on sales (shop_id, business_date) where status = 'posted';
create index on sales (party_id) where party_id is not null;

comment on column sales.legacy_no is
  'The bill number this sale carried in the old system (1200000093). Customers hold receipts printed with it, so it stays searchable alongside the new INV-2026-000001 series.';

comment on column sales.party_id is
  'Null for an anonymous cash sale - your decision. A credit sale requires a party, enforced in post_sale().';

create table sale_lines (
  id               uuid          primary key default gen_random_uuid(),
  shop_id          uuid          not null references shops(id) on delete restrict,
  sale_id          uuid          not null references sales(id) on delete restrict,
  line_no          int           not null check (line_no > 0),
  product_id       uuid          not null references products(id) on delete restrict,

  -- Historical snapshot. Not redundancy for its own sake: the invoice must
  -- show what was sold, under the name and unit used at the time.
  product_name     text          not null,
  unit_name        text          not null,
  entry_factor     numeric(18,6) not null check (entry_factor > 0),

  qty_entered      numeric(18,3) not null check (qty_entered > 0),
  qty_base         numeric(18,3) not null check (qty_base > 0),
  unit_price       numeric(18,4) not null check (unit_price >= 0),
  line_discount    numeric(18,2) not null default 0 check (line_discount >= 0),
  line_total       numeric(18,2) not null
                     generated always as
                     (round(qty_base * unit_price, 2) - line_discount) stored,

  -- Frozen at posting by consuming FIFO lots. Never updated.
  cogs_amount      numeric(18,2) not null default 0 check (cogs_amount >= 0),

  created_at       timestamptz   not null default now(),
  unique (sale_id, line_no),
  constraint line_total_not_negative check (round(qty_base * unit_price, 2) >= line_discount),
  constraint qty_matches_conversion
    check (abs(qty_base - qty_entered * entry_factor) < 0.001)
);

create index on sale_lines (sale_id);
create index on sale_lines (shop_id, product_id);

comment on column sale_lines.line_total is
  'GENERATED. The database computes it from quantity and price; a client cannot supply a total that disagrees with its own components.';

comment on column sale_lines.cogs_amount is
  'The only stored calculated value in the schema. Frozen so that a backdated purchase cannot rewrite profit already reported - your decision. stock_lot_consumption explains how it was reached.';

-- =========================================================================
-- PURCHASES
--
-- extra_cost is apportioned across lines into landed_unit_cost, and the landed
-- cost is what becomes the FIFO lot cost. This is carried over from the
-- existing system, which already computed a landed cost.
-- =========================================================================
create table purchases (
  id             uuid          primary key default gen_random_uuid(),
  shop_id        uuid          not null references shops(id) on delete restrict,
  legacy_id      text,
  bill_no        text          not null,
  legacy_no      text,
  party_id       uuid          references parties(id) on delete restrict,
  occurred_at    timestamptz   not null,
  business_date  date          not null,
  bill_discount  numeric(18,2) not null default 0 check (bill_discount >= 0),
  extra_cost     numeric(18,2) not null default 0 check (extra_cost >= 0),
  status         text          not null default 'posted'
                   check (status in ('posted', 'reversed')),
  note           text          not null default '',
  created_by     uuid          references auth.users(id),
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now(),
  unique (shop_id, bill_no),
  unique (shop_id, legacy_id)
);

create index on purchases (shop_id, business_date) where status = 'posted';
create index on purchases (party_id) where party_id is not null;

create table purchase_lines (
  id                uuid          primary key default gen_random_uuid(),
  shop_id           uuid          not null references shops(id) on delete restrict,
  purchase_id       uuid          not null references purchases(id) on delete restrict,
  line_no           int           not null check (line_no > 0),
  product_id        uuid          not null references products(id) on delete restrict,

  product_name      text          not null,
  unit_name         text          not null,
  entry_factor      numeric(18,6) not null check (entry_factor > 0),

  qty_entered       numeric(18,3) not null check (qty_entered > 0),
  qty_base          numeric(18,3) not null check (qty_base > 0),
  unit_price        numeric(18,4) not null check (unit_price >= 0),
  line_discount     numeric(18,2) not null default 0 check (line_discount >= 0),
  line_total        numeric(18,2) not null
                      generated always as
                      (round(qty_base * unit_price, 2) - line_discount) stored,

  -- unit_price net of discount, plus this line's share of extra_cost.
  -- This is the cost the FIFO lot is created at.
  landed_unit_cost  numeric(18,4) not null check (landed_unit_cost >= 0),

  created_at        timestamptz   not null default now(),
  unique (purchase_id, line_no),
  constraint p_line_total_not_negative check (round(qty_base * unit_price, 2) >= line_discount),
  constraint p_qty_matches_conversion
    check (abs(qty_base - qty_entered * entry_factor) < 0.001)
);

create index on purchase_lines (purchase_id);
create index on purchase_lines (shop_id, product_id);

-- =========================================================================
-- RETURNS
--
-- A return references the line it reverses and may not exceed its quantity -
-- the rule the existing system already enforced ("Linked return qty overflow").
-- A sale return restores stock at the cost originally consumed, not at today's
-- cost, so returning goods cannot manufacture profit.
-- =========================================================================
create table returns (
  id                uuid        primary key default gen_random_uuid(),
  shop_id           uuid        not null references shops(id) on delete restrict,
  legacy_id         text,
  return_no         text        not null,
  kind              text        not null check (kind in ('sale_return', 'purchase_return')),
  party_id          uuid        references parties(id) on delete restrict,
  original_sale_id     uuid     references sales(id) on delete restrict,
  original_purchase_id uuid     references purchases(id) on delete restrict,
  occurred_at       timestamptz not null,
  business_date     date        not null,
  status            text        not null default 'posted'
                      check (status in ('posted', 'reversed')),
  note              text        not null default '',
  created_by        uuid        references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (shop_id, return_no),
  unique (shop_id, legacy_id),
  constraint return_points_at_matching_document check (
    (kind = 'sale_return'     and original_sale_id     is not null and original_purchase_id is null) or
    (kind = 'purchase_return' and original_purchase_id is not null and original_sale_id     is null)
  )
);

create index on returns (shop_id, business_date) where status = 'posted';

create table return_lines (
  id                    uuid          primary key default gen_random_uuid(),
  shop_id               uuid          not null references shops(id) on delete restrict,
  return_id             uuid          not null references returns(id) on delete restrict,
  line_no               int           not null check (line_no > 0),
  product_id            uuid          not null references products(id) on delete restrict,
  original_sale_line_id     uuid      references sale_lines(id) on delete restrict,
  original_purchase_line_id uuid      references purchase_lines(id) on delete restrict,

  product_name          text          not null,
  unit_name             text          not null,
  qty_base              numeric(18,3) not null check (qty_base > 0),
  unit_price            numeric(18,4) not null check (unit_price >= 0),
  line_total            numeric(18,2) not null
                          generated always as (round(qty_base * unit_price, 2)) stored,

  -- For a sale return: the cost that comes back into stock, taken from what
  -- the original sale consumed. For a purchase return: the lot cost removed.
  cost_amount           numeric(18,2) not null default 0 check (cost_amount >= 0),

  created_at            timestamptz   not null default now(),
  unique (return_id, line_no)
);

create index on return_lines (return_id);
create index on return_lines (original_sale_line_id) where original_sale_line_id is not null;
create index on return_lines (original_purchase_line_id) where original_purchase_line_id is not null;

-- A return can never exceed what was originally transacted, counting every
-- other return already made against the same line.
create or replace function check_return_within_original()
returns trigger language plpgsql set search_path = public as $$
declare
  v_original numeric(18,3);
  v_returned numeric(18,3);
  v_line     uuid := coalesce(new.original_sale_line_id, new.original_purchase_line_id);
begin
  if v_line is null then
    return new;   -- a return with no original line is allowed (goodwill, opening correction)
  end if;

  if new.original_sale_line_id is not null then
    select qty_base into v_original from sale_lines where id = new.original_sale_line_id;
  else
    select qty_base into v_original from purchase_lines where id = new.original_purchase_line_id;
  end if;

  select coalesce(sum(rl.qty_base), 0) into v_returned
  from return_lines rl
  join returns r on r.id = rl.return_id and r.status = 'posted'
  where coalesce(rl.original_sale_line_id, rl.original_purchase_line_id) = v_line
    and rl.id <> new.id;

  if v_returned + new.qty_base > v_original + 0.001 then
    raise exception
      'RETURN_EXCEEDS_ORIGINAL: % already returned of % sold; cannot return a further %.',
      v_returned, v_original, new.qty_base;
  end if;
  return new;
end $$;

create trigger return_lines_within_original
  before insert or update on return_lines
  for each row execute function check_return_within_original();

-- =========================================================================
-- ADJUSTMENTS — opening stock, damage, theft, corrections
--
-- Single-line, matching how the existing app records them.
-- =========================================================================
create table adjustments (
  id             uuid          primary key default gen_random_uuid(),
  shop_id        uuid          not null references shops(id) on delete restrict,
  legacy_id      text,
  adjustment_no  text          not null,
  kind           text          not null check (kind in
                   ('opening', 'damage', 'theft', 'correction_in', 'correction_out')),
  product_id     uuid          not null references products(id) on delete restrict,
  product_name   text          not null,
  unit_name      text          not null,
  qty_base       numeric(18,3) not null check (qty_base > 0),
  unit_cost      numeric(18,4) not null default 0 check (unit_cost >= 0),
  occurred_at    timestamptz   not null,
  business_date  date          not null,
  status         text          not null default 'posted'
                   check (status in ('posted', 'reversed')),
  note           text          not null default '',
  created_by     uuid          references auth.users(id),
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now(),
  unique (shop_id, adjustment_no),
  unique (shop_id, legacy_id)
);

create index on adjustments (shop_id, business_date) where status = 'posted';

comment on column adjustments.unit_cost is
  'Only meaningful for inbound kinds (opening, correction_in), where it becomes the FIFO lot cost. Outbound kinds consume lots at their own cost and ignore this.';

-- =========================================================================
-- INVENTORY LEDGER
--
-- The single authoritative record of stock. One row per stock change, always
-- with a reason and a source document. Nothing else may alter stock.
-- =========================================================================
create table inventory_movements (
  id             bigserial     primary key,
  shop_id        uuid          not null references shops(id) on delete restrict,
  product_id     uuid          not null references products(id) on delete restrict,
  movement_type  text          not null check (movement_type in
                   ('opening', 'purchase', 'sale', 'sale_return', 'purchase_return',
                    'damage', 'theft', 'correction_in', 'correction_out', 'reversal')),
  qty_delta      numeric(18,3) not null check (qty_delta <> 0),
  occurred_at    timestamptz   not null,
  business_date  date          not null,
  source_table   text          not null check (source_table in
                   ('sale_lines', 'purchase_lines', 'return_lines', 'adjustments')),
  source_id      uuid          not null,
  created_by     uuid          references auth.users(id),
  created_at     timestamptz   not null default now()
);

create index on inventory_movements (shop_id, product_id);
create index on inventory_movements (shop_id, business_date);
create index on inventory_movements (source_table, source_id);

comment on table inventory_movements is
  'Append only. Correcting stock means posting a compensating movement, never editing or deleting one - otherwise the ledger stops explaining the balance.';

-- =========================================================================
-- FIFO LOTS
--
-- Goods arrive in lots at a known cost; sales consume them oldest-first.
-- qty_remaining is maintained by the posting functions in 06_functions.sql,
-- always inside the same transaction as the movement that changed it.
-- =========================================================================
create table stock_lots (
  id             uuid          primary key default gen_random_uuid(),
  shop_id        uuid          not null references shops(id) on delete restrict,
  product_id     uuid          not null references products(id) on delete restrict,
  source_table   text          not null check (source_table in
                   ('purchase_lines', 'return_lines', 'adjustments')),
  source_id      uuid          not null,
  received_at    timestamptz   not null,
  business_date  date          not null,
  -- Monotonic arrival sequence. FIFO cannot tie-break on id: uuids are random,
  -- so two lots sharing a timestamp (two purchases in one transaction, or two
  -- entries with the same occurred_at) would be consumed in arbitrary order.
  lot_seq        bigserial     not null,
  qty_received   numeric(18,3) not null check (qty_received > 0),
  qty_remaining  numeric(18,3) not null check (qty_remaining >= 0),
  unit_cost      numeric(18,4) not null check (unit_cost >= 0),
  created_at     timestamptz   not null default now(),
  constraint remaining_within_received check (qty_remaining <= qty_received + 0.001)
);

-- The FIFO read path: open lots for one product, oldest first. A partial index
-- because consumption never looks at exhausted lots.
-- FIFO order is: the day the goods arrived, then when the entry was made,
-- then arrival sequence. business_date leads because a purchase backdated to
-- last week must be consumed BEFORE one entered yesterday for yesterday -
-- ordering by the typing instant would put the backdated lot last and cost
-- later sales from the wrong lot.
create index stock_lots_open_fifo
  on stock_lots (shop_id, product_id, business_date, received_at, lot_seq)
  where qty_remaining > 0;

create index on stock_lots (source_table, source_id);

comment on column stock_lots.received_at is
  'Ordering key for FIFO. A backdated purchase creates a lot dated in the past, so it is consumed by FUTURE sales - it does not disturb sales already costed, per your decision to freeze settled COGS.';

-- =========================================================================
-- LOT CONSUMPTION
--
-- Which sale took how much from which lot, at what cost. This is what makes
-- the frozen cogs_amount explainable rather than merely asserted: you can
-- point at any sale and see the exact lots behind its cost.
-- =========================================================================
create table stock_lot_consumption (
  id              bigserial     primary key,
  shop_id         uuid          not null references shops(id) on delete restrict,
  lot_id          uuid          not null references stock_lots(id) on delete restrict,
  consumer_table  text          not null check (consumer_table in
                    ('sale_lines', 'return_lines', 'adjustments')),
  consumer_id     uuid          not null,
  qty             numeric(18,3) not null check (qty > 0),
  unit_cost       numeric(18,4) not null check (unit_cost >= 0),
  amount          numeric(18,2) not null
                    generated always as (round(qty * unit_cost, 2)) stored,
  created_at      timestamptz   not null default now()
);

create index on stock_lot_consumption (consumer_table, consumer_id);
create index on stock_lot_consumption (lot_id);

-- =========================================================================
-- updated_at triggers
-- =========================================================================
do $$
declare t text;
begin
  foreach t in array array['sales', 'purchases', 'returns', 'adjustments'] loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function touch_updated_at()',
      t, t);
  end loop;
end $$;

-- =========================================================================
-- NO DELETES ON POSTED DOCUMENTS
--
-- Belt and braces alongside the RLS policies in 07_rls.sql: even a direct
-- database connection cannot remove a posted document. Delete-by-date, the
-- feature that destroyed history in the old system, has no equivalent here.
-- =========================================================================
create or replace function forbid_delete_posted()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception
    'DELETE_FORBIDDEN: % is a posted document and cannot be deleted. Post a reversal instead.',
    tg_table_name;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'sales', 'sale_lines', 'purchases', 'purchase_lines',
    'returns', 'return_lines', 'adjustments',
    'inventory_movements', 'stock_lots', 'stock_lot_consumption'
  ] loop
    execute format(
      'create trigger %I_no_delete before delete on %I for each row execute function forbid_delete_posted()',
      t, t);
  end loop;
end $$;
