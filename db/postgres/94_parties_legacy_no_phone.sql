-- =========================================================================
-- KoshAgar ERP — 94_parties_legacy_no_phone.sql
-- Run ONCE, before the data import.
--
-- The imported history contains 71 credit documents (BDT 163,772) belonging to
-- named customers and suppliers whose phone number was never recorded - Sojol,
-- শিমুল, Ashik pharmacy and others. Phone was the party identity, so those
-- balances could not be imported without either losing them or inventing
-- numbers.
--
-- THE RULE: a party carried in from the old system may have no phone.
--           A party created from now on must have one.
--
-- Enforced in two places, so it cannot be worked around:
--   * a CHECK constraint allows a missing phone only when is_legacy is true;
--   * the RLS insert policy forbids an ordinary user from creating a legacy
--     party at all. Only the import, which runs with the service role and
--     bypasses RLS, can set that flag.
-- =========================================================================

-- 1. Mark where a party came from.
alter table parties
  add column if not exists is_legacy boolean not null default false;

comment on column parties.is_legacy is
  'True only for parties carried in from the pre-migration system. It is what permits a missing phone, and no API caller can set it.';

-- 2. Phone becomes optional...
alter table parties alter column phone drop not null;

-- 3. ...but still has to look like a phone when it is given.
alter table parties drop constraint if exists parties_phone_check;
alter table parties
  add constraint parties_phone_check
  check (phone is null or phone ~ '^01[3-9][0-9]{8}$');

-- 4. Only legacy parties may go without one.
alter table parties
  add constraint parties_phone_required_for_new
  check (phone is not null or is_legacy);

-- 5. Without a phone to identify them, legacy parties are identified by name -
--    so two "Sojol" rows cannot both exist and split his balance in half.
create unique index if not exists parties_legacy_name_unique
  on parties (shop_id, lower(trim(name)))
  where phone is null;

-- 6. An ordinary user cannot create a party that skips the phone rule.
drop policy if exists parties_insert on parties;
create policy parties_insert on parties for insert
  with check (has_shop_role(shop_id, 'owner') and is_legacy = false);

-- Verify.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'parties'::regclass and contype = 'c'
order by conname;
