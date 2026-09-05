-- =========================================================================
-- KoshAgar ERP — 30_document_edits.sql
--
-- WHY
-- An edit reverses one document and posts another. Both are in the books, which
-- is correct - but on screen the correction looks like an ordinary entry that
-- was always there. Nothing says "this used to be 85 a unit". The shopkeeper
-- can no longer tell a first entry from a fifth correction, and neither can
-- anyone asking why the day's figures moved.
--
-- The audit_log already records every edit, but nothing on the entry screens
-- reads it, and it is not meant to be read a row at a time by a phone.
--
-- WHAT THIS ADDS
-- One small table linking the corrected document to the one it replaced, with a
-- plain-language note of what changed ("Price: 85 → 90"). The app reads it with
-- the rest of the shop and prints it on the row, beside the entry it explains.
--
-- The note is written by the app because the app is what knows what the person
-- typed over. The link and the timestamp are written here, where they cannot be
-- forgotten or edited afterwards - the table is read-only to every client, like
-- every other transactional table.
-- =========================================================================

create table if not exists document_edits (
  id             uuid        primary key default gen_random_uuid(),
  shop_id        uuid        not null references shops(id) on delete restrict,
  original_type  text        not null check (original_type in
                   ('sale', 'purchase', 'return', 'expense',
                    'cash_withdrawal', 'adjustment', 'payment')),
  original_id    uuid        not null,
  replacement_id uuid        not null,
  summary        text        not null default '',
  created_by     uuid        references auth.users(id),
  created_at     timestamptz not null default now()
);

create index if not exists document_edits_replacement_idx
  on document_edits (shop_id, replacement_id);
create index if not exists document_edits_original_idx
  on document_edits (shop_id, original_id);

comment on table document_edits is
  'One row per correction: which document replaced which, and what changed. Written only by edit_document(); read-only to clients, like every other transactional table.';

alter table document_edits enable row level security;
drop policy if exists document_edits_read on document_edits;
create policy document_edits_read on document_edits for select
  using (shop_id in (select current_shop_ids()));

grant select on document_edits to authenticated;

-- -------------------------------------------------------------------------
-- edit_document, unchanged except that it now records the link it creates.
-- -------------------------------------------------------------------------
create or replace function edit_document(
  p_shop uuid, p_type text, p_id uuid, p_payload jsonb, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_key    text := p_payload->>'idempotency_key';
  v_hit    jsonb;
  v_table  text;
  v_reason text := coalesce(nullif(p_reason, ''), 'Corrected in the app');
  v_result jsonb;
  v_new    uuid;
begin
  if p_type not in ('sale', 'purchase', 'return',
                    'expense', 'cash_withdrawal', 'adjustment', 'payment') then
    raise exception 'INVALID_TYPE: cannot edit a document of type "%".', p_type;
  end if;

  -- A retry of the same user action returns what the first attempt posted,
  -- rather than reversing a second document. The key is recorded by the
  -- post_* function below; this only reads it.
  if v_key is not null then
    v_hit := idempotent_hit(p_shop, v_key);
    if v_hit is not null then return v_hit; end if;
  end if;

  v_table := case p_type when 'sale'            then 'sales'
                         when 'purchase'        then 'purchases'
                         when 'return'          then 'returns'
                         when 'expense'         then 'expenses'
                         when 'cash_withdrawal' then 'cash_withdrawals'
                         when 'payment'         then 'payments'
                         else 'adjustments' end;

  -- A return points at the lines that are about to be reversed.
  if p_type in ('sale', 'purchase') then
    if exists (
      select 1 from returns r
      where r.shop_id = p_shop and r.status = 'posted'
        and (case when p_type = 'sale' then r.original_sale_id
                  else r.original_purchase_id end) = p_id
    ) then
      raise exception
        'HAS_RETURNS: a return has already been filed against this bill. Undo the return first, then edit the bill.';
    end if;
  end if;

  -- Money already applied to the bill this edit would void.
  if exists (
    select 1
    from payment_allocations a
    join party_bills b on b.id = a.bill_id
    join payments   pm on pm.id = a.payment_id
    where b.shop_id = p_shop and b.source_table = v_table and b.source_id = p_id
      and pm.status = 'posted'
  ) then
    raise exception
      'HAS_PAYMENTS: a payment has already been settled against this bill. Undo the payment first, then edit the bill.';
  end if;

  case p_type
    when 'sale' then
      perform reverse_sale(p_shop, p_id, v_reason);
      v_result := post_sale(p_shop, p_payload);
    when 'purchase' then
      perform reverse_purchase(p_shop, p_id, v_reason);
      v_result := post_purchase(p_shop, p_payload);
    when 'return' then
      perform reverse_return(p_shop, p_id, v_reason);
      v_result := post_return(p_shop, p_payload);
    when 'expense' then
      perform reverse_expense(p_shop, p_id, v_reason);
      v_result := post_expense(p_shop, p_payload);
    when 'cash_withdrawal' then
      perform reverse_cash_withdrawal(p_shop, p_id, v_reason);
      v_result := post_cash_withdrawal(p_shop, p_payload);
    when 'payment' then
      -- The corrected amount is re-allocated from scratch, oldest bill first,
      -- exactly as a payment taken today would be. Anything above what is owed
      -- is still refused by record_payment, so an edit cannot slip past the
      -- overpayment rule that a straight UPDATE would have gone round.
      perform reverse_payment(p_shop, p_id, v_reason);
      v_result := record_payment(p_shop, p_payload);
    else
      perform reverse_adjustment(p_shop, p_id, v_reason);
      v_result := post_adjustment(p_shop, p_payload);
  end case;

  -- Each posting function names its own id. Nothing here should guess wrong and
  -- record a link to nothing, so a missing id is left null rather than invented.
  v_new := coalesce(v_result->>'sale_id',     v_result->>'purchase_id',
                    v_result->>'return_id',   v_result->>'expense_id',
                    v_result->>'withdrawal_id', v_result->>'adjustment_id',
                    v_result->>'payment_id')::uuid;

  if v_new is not null then
    insert into document_edits (shop_id, original_type, original_id, replacement_id,
                                summary, created_by)
    values (p_shop, p_type, p_id, v_new, v_reason, auth.uid());
  end if;

  perform write_audit(p_shop, 'document_edited', v_table, p_id, null,
                      jsonb_build_object('type', p_type, 'reason', v_reason,
                                         'replacement', v_result));

  return v_result || jsonb_build_object('replaced_id', p_id, 'edited', true);
end $fn$;

grant execute on function edit_document(uuid, text, uuid, jsonb, text) to authenticated;

select 'corrections now record what they replaced and why' as note;
