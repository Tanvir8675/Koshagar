-- =========================================================================
-- KoshAgar ERP - 32_archive_and_loan_reversal.sql
--
-- Two gaps found by auditing which app actions still had no server behind
-- them. Both are small, and both were quietly doing nothing until now.
--
-- 1. ARCHIVING A SETTLED BILL
--    The Credit screens offer "archive" on a fully-paid bill: it leaves the
--    active list but the history stays, so a disagreement months later can
--    still be checked. That flag was written to the browser's copy of the data
--    and nowhere else, so it survived exactly until the next reload.
--
--    Archiving is NOT deletion and NOT reversal. The bill happened, it was
--    paid, and it stays - archived only means "stop showing me this among the
--    things I still have to chase".
--
-- 2. UNDOING A LOAN
--    reverse_document() handled every document type except loans, so undoing
--    one raised INVALID_TYPE. Now it reverses like everything else: the cash
--    that arrived goes back out, the payable is voided, both halves stay.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Archive
-- -------------------------------------------------------------------------
alter table party_bills
  add column if not exists archived_at    timestamptz,
  add column if not exists archive_reason text not null default '';

comment on column party_bills.archived_at is
  'Set when a SETTLED bill is filed away from the active due list. The bill and every payment against it stay exactly as they were - this only hides it from the screens that ask who still owes money.';

create index if not exists party_bills_active_idx
  on party_bills (shop_id, party_id) where status = 'open' and archived_at is null;

create or replace function archive_party_bill(p_shop uuid, p_bill uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_balance numeric(18,2); v_archived timestamptz; v_found boolean := false;
begin
  select true, bb.balance, b.archived_at
    into v_found, v_balance, v_archived
    from party_bills b
    left join v_bill_balances bb on bb.bill_id = b.id
   where b.id = p_bill and b.shop_id = p_shop;

  if not coalesce(v_found, false) then
    raise exception 'DOCUMENT_NOT_FOUND: no such bill in this shop.';
  end if;
  if v_archived is not null then
    raise exception 'ALREADY_ARCHIVED: this bill is already archived.';
  end if;

  -- Only a settled bill may be filed away. Archiving one that is still owed
  -- would hide a debt, which is the opposite of what this is for.
  if coalesce(v_balance, 0) > 0.001 then
    raise exception
      'BILL_NOT_SETTLED: % is still owed on this bill, so it cannot be archived yet.',
      round(v_balance, 2);
  end if;

  update party_bills
     set archived_at = now(),
         archive_reason = coalesce(nullif(trim(p_reason), ''), 'Archived in the app')
   where id = p_bill;

  perform write_audit(p_shop, 'bill_archived', 'party_bills', p_bill, null,
                      jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true, 'bill_id', p_bill, 'archived', true);
end $fn$;

create or replace function unarchive_party_bill(p_shop uuid, p_bill uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
begin
  update party_bills
     set archived_at = null, archive_reason = ''
   where id = p_bill and shop_id = p_shop and archived_at is not null;
  if not found then
    raise exception 'DOCUMENT_NOT_FOUND: no archived bill with that id in this shop.';
  end if;
  perform write_audit(p_shop, 'bill_unarchived', 'party_bills', p_bill, null, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'bill_id', p_bill, 'archived', false);
end $fn$;

grant execute on function archive_party_bill(uuid, uuid, text) to authenticated;
grant execute on function unarchive_party_bill(uuid, uuid)     to authenticated;

-- v_bill_balances and v_party_due are deliberately NOT filtered on archived_at.
-- An archived bill is settled, so it already contributes zero to what anyone is
-- owed; filtering it would make the totals depend on a display decision.

-- -------------------------------------------------------------------------
-- 2. Reversing a loan
-- -------------------------------------------------------------------------
create or replace function reverse_loan(p_shop uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_date date; v_status text; v_name text; v_amount numeric(18,2);
  v_repaid numeric(18,2); v_cash numeric(18,2);
begin
  select business_date, status, lender_name, principal
    into v_date, v_status, v_name, v_amount
    from loans where id = p_id and shop_id = p_shop;
  if v_date is null then
    raise exception 'DOCUMENT_NOT_FOUND: no such loan in this shop.';
  end if;
  if v_status = 'reversed' then
    raise exception 'ALREADY_REVERSED: this loan has already been undone.';
  end if;

  perform assert_period_writable(p_shop, v_date);

  -- Money already repaid against it. Undoing the loan would leave those
  -- payments allocated to a debt that no longer exists, so it is refused the
  -- same way a bill refuses to be edited out from under its payments.
  select coalesce(sum(a.amount), 0) into v_repaid
    from payment_allocations a
    join party_bills b on b.id = a.bill_id
    join payments   pm on pm.id = a.payment_id
   where b.shop_id = p_shop and b.source_table = 'loans' and b.source_id = p_id
     and pm.status = 'posted';
  if v_repaid > 0.001 then
    raise exception
      'HAS_PAYMENTS: % has already been repaid against this loan. Undo the repayment first.',
      round(v_repaid, 2);
  end if;

  -- The cash that arrived goes back out.
  select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)
    into v_cash from cash_ledger where source_table = 'loans' and source_id = p_id;

  if v_cash <> 0 then
    insert into cash_ledger (shop_id, cash_account_id, direction, amount, occurred_at,
                             business_date, source_table, source_id, note, created_by)
    select p_shop, cash_account_id,
           case when v_cash > 0 then 'out' else 'in' end,
           abs(v_cash), now(), v_date, 'loans', p_id,
           'Reversal of loan from ' || v_name, auth.uid()
    from cash_ledger where source_table = 'loans' and source_id = p_id limit 1;
  end if;

  update party_bills set status = 'reversed'
   where source_table = 'loans' and source_id = p_id;

  update loans set status = 'reversed' where id = p_id;

  insert into document_reversals (shop_id, original_type, original_id, reversal_id,
                                  reason, created_by)
  values (p_shop, 'loan', p_id, p_id, coalesce(p_reason, ''), auth.uid());

  perform write_audit(p_shop, 'loan_reversed', 'loans', p_id, null,
                      jsonb_build_object('lender', v_name, 'principal', v_amount,
                                         'reason', p_reason));

  return jsonb_build_object('ok', true, 'loan_id', p_id, 'status', 'reversed');
end $fn$;

grant execute on function reverse_loan(uuid, uuid, text) to authenticated;

-- The dispatcher learns the new type.
create or replace function reverse_document(
  p_shop uuid, p_type text, p_id uuid, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = public as $fn$
begin
  case p_type
    when 'sale'             then return reverse_sale(p_shop, p_id, p_reason);
    when 'purchase'         then return reverse_purchase(p_shop, p_id, p_reason);
    when 'return'           then return reverse_return(p_shop, p_id, p_reason);
    when 'payment'          then return reverse_payment(p_shop, p_id, p_reason);
    when 'expense'          then return reverse_expense(p_shop, p_id, p_reason);
    when 'cash_withdrawal'  then return reverse_cash_withdrawal(p_shop, p_id, p_reason);
    when 'capital_movement' then return reverse_capital_movement(p_shop, p_id, p_reason);
    when 'adjustment'       then return reverse_adjustment(p_shop, p_id, p_reason);
    when 'loan'             then return reverse_loan(p_shop, p_id, p_reason);
    else raise exception 'INVALID_TYPE: cannot reverse a document of type "%".', p_type;
  end case;
end $fn$;

grant execute on function reverse_document(uuid, text, uuid, text) to authenticated;

select 'settled bills can be archived, and a loan can be undone' as note;
