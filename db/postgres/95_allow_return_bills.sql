-- =========================================================================
-- KoshAgar ERP — 95_allow_return_bills.sql
-- Run ONCE before 07_returns_reversals.sql.
--
-- A return that is not refunded in cash reduces the party's balance by raising
-- an opposite-direction bill. party_bills.source_table did not allow 'returns',
-- so those credits would have had to be filed as 'opening' - untrue, and it
-- would have broken the link back to the document that caused them.
-- =========================================================================
alter table party_bills drop constraint if exists party_bills_source_table_check;

alter table party_bills
  add constraint party_bills_source_table_check
  check (source_table in ('sales', 'purchases', 'returns', 'opening'));

select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'party_bills'::regclass and conname = 'party_bills_source_table_check';
