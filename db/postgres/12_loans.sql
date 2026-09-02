-- =========================================================================
-- KoshAgar ERP — 12_loans.sql
--
-- Money borrowed to fund the shop, and its repayment.
--
-- WHY THIS WAS MISSING
-- The alignment audit found 56 references to loans in the app and no table for
-- them in the new schema. In the old system a loan was a `capital-in`
-- transaction carrying loanName / loanPhone / loanDueDate, with repayments in a
-- separate loan_payments table. That conflated two different things: capital is
-- the owner's own money and is never repaid; a loan is somebody else's money
-- and is a liability with a name and a due date attached.
--
-- HOW IT WORKS HERE
-- Borrowing raises a payable, exactly like an unpaid supplier bill, so
-- repayments run through record_payment() and the allocation machinery that is
-- already proven. Nothing new had to be invented for the repayment side.
--
--   borrow   -> loans row + cash IN  + party_bills payable
--   repay    -> record_payment(direction 'out') allocates against that payable
--   balance  -> v_party_due, same as any other payable
-- =========================================================================

-- A due date is useful on any obligation, not just loans - a credit sale can
-- have terms too. Nullable, so nothing existing has to change.
alter table party_bills add column if not exists due_date date;

comment on column party_bills.due_date is
  'When the money is expected. Null means no agreed date, which is the norm for an ordinary counter credit.';

create table loans (
  id                  uuid          primary key default gen_random_uuid(),
  shop_id             uuid          not null references shops(id) on delete restrict,
  legacy_id           text,

  -- The lender. A party when they are identifiable; the name is snapshotted
  -- regardless, so the loan still reads correctly if the party is edited later.
  party_id            uuid          references parties(id) on delete restrict,
  lender_name         text          not null check (length(trim(lender_name)) > 0),
  lender_phone        text,

  principal           numeric(18,2) not null check (principal > 0),
  purpose             text          not null default '',
  -- What the money was borrowed for, when it funded a specific purchase.
  related_purchase_id uuid          references purchases(id) on delete restrict,

  occurred_at         timestamptz   not null,
  business_date       date          not null,
  due_date            date,
  status              text          not null default 'posted'
                        check (status in ('posted', 'reversed')),
  created_by          uuid          references auth.users(id),
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),
  unique (shop_id, legacy_id)
);

create index on loans (shop_id, business_date) where status = 'posted';
create index on loans (party_id) where party_id is not null;

comment on table loans is
  'A liability, not capital. The repayment balance lives in party_bills so it uses the same allocation logic as supplier credit.';

-- cash_ledger must accept the new source.
alter table cash_ledger drop constraint if exists cash_ledger_source_table_check;
alter table cash_ledger
  add constraint cash_ledger_source_table_check
  check (source_table in ('sales', 'purchases', 'returns', 'payments',
                          'expenses', 'capital_movements', 'cash_withdrawals',
                          'cash_adjustments', 'loans'));

alter table party_bills drop constraint if exists party_bills_source_table_check;
alter table party_bills
  add constraint party_bills_source_table_check
  check (source_table in ('sales', 'purchases', 'returns', 'loans', 'opening'));

create trigger loans_touch before update on loans
  for each row execute function touch_updated_at();
create trigger loans_no_delete before delete on loans
  for each row execute function forbid_delete_posted();

alter table loans enable row level security;
create policy loans_read on loans for select
  using (shop_id in (select current_shop_ids()));

-- =========================================================================
-- TAKE A LOAN
-- =========================================================================
create or replace function post_loan(p_shop uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key      text := p_payload->>'idempotency_key';
  v_hit      jsonb;
  v_date     date := (p_payload->>'business_date')::date;
  v_at       timestamptz := coalesce((p_payload->>'occurred_at')::timestamptz, now());
  v_party    uuid := nullif(p_payload->>'party_id', '')::uuid;
  v_name     text := coalesce(p_payload->>'lender_name', '');
  v_phone    text := nullif(p_payload->>'lender_phone', '');
  v_amount   numeric(18,2) := (p_payload->>'principal')::numeric;
  v_due      date := nullif(p_payload->>'due_date', '')::date;
  v_purchase uuid := nullif(p_payload->>'related_purchase_id', '')::uuid;
  v_account  uuid := nullif(p_payload->>'cash_account_id', '')::uuid;
  v_id       uuid;
  v_result   jsonb;
begin
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  perform assert_period_writable(p_shop, v_date);
  perform assert_party_in_shop(p_shop, v_party);

  if v_amount is null or v_amount <= 0 then
    raise exception 'INVALID_AMOUNT: a loan must be greater than zero.';
  end if;
  if length(trim(v_name)) = 0 then
    raise exception 'LENDER_REQUIRED: a loan must name who lent the money.';
  end if;
  if v_account is null then v_account := default_cash_account(p_shop); end if;

  insert into loans (shop_id, party_id, lender_name, lender_phone, principal,
                     purpose, related_purchase_id, occurred_at, business_date,
                     due_date, created_by)
  values (p_shop, v_party, trim(v_name), v_phone, v_amount,
          coalesce(p_payload->>'purpose', ''), v_purchase, v_at, v_date,
          v_due, auth.uid())
  returning id into v_id;

  -- The money arrives.
  insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                           business_date, source_table, source_id, note, created_by)
  values (p_shop, v_account, 'in', v_amount, v_at, v_date, 'loans', v_id,
          'Loan from ' || trim(v_name), auth.uid());

  -- And it is owed. Without a party the debt cannot be tracked to anyone, so
  -- the loan is still recorded but no payable is raised - the app should be
  -- creating a legacy party for the lender instead.
  if v_party is not null then
    insert into party_bills (shop_id, party_id, direction, source_table, source_id,
                             occurred_at, business_date, due_date, amount, note, created_by)
    values (p_shop, v_party, 'payable', 'loans', v_id, v_at, v_date, v_due,
            v_amount, 'Loan from ' || trim(v_name), auth.uid());
  end if;

  perform write_audit(p_shop, 'loan_taken', 'loans', v_id, null,
                      jsonb_build_object('lender', trim(v_name), 'principal', v_amount,
                                         'due_date', v_due));

  v_result := jsonb_build_object('ok', true, 'loan_id', v_id, 'principal', v_amount);
  if v_key is not null then
    insert into idempotency_keys (shop_id, key, operation, result)
    values (p_shop, v_key, 'post_loan', v_result) on conflict (shop_id, key) do nothing;
  end if;
  return v_result;
end $$;

-- =========================================================================
-- OUTSTANDING LOANS
-- Repayments are ordinary payments, so the balance comes from the same place
-- every other balance does.
-- =========================================================================
create or replace view v_loan_balances as
select l.id            as loan_id,
       l.shop_id,
       l.lender_name,
       l.lender_phone,
       l.party_id,
       l.principal,
       l.business_date as taken_on,
       l.due_date,
       coalesce(b.balance, 0)                         as outstanding,
       l.principal - coalesce(b.balance, 0)           as repaid,
       (l.due_date is not null and l.due_date < current_date
        and coalesce(b.balance, 0) > 0)               as overdue
from loans l
-- v_bill_balances is keyed by bill, so reach it through the payable the loan
-- raised. There is no source_bill_id column - the link lives on party_bills.
left join party_bills pb
       on pb.source_table = 'loans' and pb.source_id = l.id and pb.status = 'open'
left join v_bill_balances b on b.bill_id = pb.id
where l.status = 'posted';

grant execute on function post_loan(uuid, jsonb) to authenticated;
grant all    on loans to service_role;
grant select on loans to authenticated;
