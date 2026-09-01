-- =========================================================================
-- KoshAgar ERP — 11_cash_adjustments.sql
--
-- Cash over and short: the drawer holds more or less than the ledger says it
-- should. Every till in every shop has this eventually.
--
-- WHY THIS EXISTS
-- The August import found ten withdrawals the drawer could not cover - roughly
-- BDT 11,250. The withdrawals are real (the owner confirmed the money left), so
-- the missing half is cash income that was never written down. That money has
-- to be recorded somewhere, and the two dishonest options are:
--
--   * quietly raise the opening balance - hides a real gap inside a figure
--     that is supposed to be a counted fact;
--   * book it as owner capital - claims the owner put money in when they did not.
--
-- So it gets its own document type, named for what it is. Each adjustment
-- states its reason and is visible in the cash ledger like any other movement,
-- which means "why is the cash this amount?" still has a complete answer.
-- =========================================================================

create table cash_adjustments (
  id               uuid          primary key default gen_random_uuid(),
  shop_id          uuid          not null references shops(id) on delete restrict,
  legacy_id        text,
  cash_account_id  uuid          not null references cash_accounts(id) on delete restrict,
  direction        text          not null check (direction in ('in', 'out')),
  reason           text          not null check (length(trim(reason)) > 0),
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

create index on cash_adjustments (shop_id, business_date) where status = 'posted';

comment on table cash_adjustments is
  'Cash over/short. A reason is mandatory - an unexplained adjustment is exactly the thing this table exists to prevent.';

-- The ledger must accept the new source.
alter table cash_ledger drop constraint if exists cash_ledger_source_table_check;
alter table cash_ledger
  add constraint cash_ledger_source_table_check
  check (source_table in ('sales', 'purchases', 'returns', 'payments',
                          'expenses', 'capital_movements', 'cash_withdrawals',
                          'cash_adjustments'));

create trigger cash_adjustments_touch before update on cash_adjustments
  for each row execute function touch_updated_at();
create trigger cash_adjustments_no_delete before delete on cash_adjustments
  for each row execute function forbid_delete_posted();

alter table cash_adjustments enable row level security;
create policy cash_adjustments_read on cash_adjustments for select
  using (shop_id in (select current_shop_ids()));

create or replace function post_cash_adjustment(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key     text := p_payload->>'idempotency_key';
  v_hit     jsonb;
  v_date    date := (p_payload->>'business_date')::date;
  v_at      timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_dir     text := coalesce(p_payload->>'direction', 'in');
  v_amount  numeric(18,2) := (p_payload->>'amount')::numeric;
  v_reason  text := coalesce(p_payload->>'reason', '');
  v_account uuid := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_id      uuid;
  v_result  jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);

  if v_amount is null or v_amount <= 0 then
    raise exception 'INVALID_AMOUNT: an adjustment must be greater than zero.';
  end if;
  if length(trim(v_reason)) = 0 then
    raise exception 'REASON_REQUIRED: a cash adjustment must say why the drawer differs.';
  end if;
  if v_dir not in ('in', 'out') then
    raise exception 'INVALID_DIRECTION: adjustment direction must be "in" or "out".';
  end if;
  if v_account is null then v_account := default_cash_account(p_shop); end if;

  insert into cash_adjustments (shop_id, cash_account_id, direction, reason, amount,
                                occurred_at, business_date, created_by)
  values (p_shop, v_account, v_dir, v_reason, v_amount, v_at, v_date, auth.uid())
  returning id into v_id;

  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, v_dir, v_amount, v_at, v_date,
          'cash_adjustments', v_id, v_reason, auth.uid());

  perform write_audit(p_shop, 'cash_adjusted', 'cash_adjustments', v_id, null,
                      jsonb_build_object('direction', v_dir, 'amount', v_amount,
                                         'reason', v_reason));

  v_result := jsonb_build_object('ok', true, 'adjustment_id', v_id, 'amount', v_amount);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_cash_adjustment', v_result)
    on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

grant execute on function post_cash_adjustment(uuid, jsonb) to authenticated;
grant all on cash_adjustments to service_role;
grant select on cash_adjustments to authenticated;
