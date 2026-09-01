-- =========================================================================
-- KoshAgar ERP — 96_fix_period_constraint.sql
--
-- Run ONCE against a database that already has 01–06 loaded.
-- Found by the smoke test at step 10.
--
-- closed_period_has_closer demanded BOTH closed_at and closed_by on a closed
-- period. closed_by references auth.users, so anything without a logged-in
-- session cannot satisfy it - including the data import that will close your
-- historical months (March through August) and any scheduled month-end job.
--
-- The rule that matters is that a closed period records WHEN it was closed.
-- WHO is valuable but cannot be mandatory: a null closer means the system
-- closed it, and the audit_log row written alongside says which process did.
-- =========================================================================

alter table accounting_periods
  drop constraint if exists closed_period_has_closer;

alter table accounting_periods
  add constraint closed_period_has_closed_at
  check (status <> 'closed' or closed_at is not null);

-- Confirm.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'accounting_periods'::regclass
  and contype = 'c'
order by conname;
