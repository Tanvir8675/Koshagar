-- =========================================================================
-- KoshAgar ERP — 93_grant_service_role.sql
-- Run ONCE. Required before the data import.
--
-- 09_rls.sql granted privileges to `authenticated` but never to `service_role`,
-- and Supabase's default privileges did not cover tables created this way. The
-- result: the service key could execute functions but could not read or write a
-- single table -
--
--   permission denied for table shops (42501)
--
-- service_role is the back-end identity: migrations, imports, scheduled jobs.
-- It carries BYPASSRLS, so these grants give it full access - which is exactly
-- why the key must never appear in the frontend.
-- =========================================================================

grant usage on schema public to service_role;

grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- Anything created later gets the same treatment, so a new table does not
-- silently break the next import.
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;
alter default privileges in schema public
  grant all on functions to service_role;

-- `authenticated` needs sequence usage for the bigserial keys it can reach.
grant usage, select on all sequences in schema public to authenticated;

-- Verify: should list shops, products, parties among others.
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'service_role' and table_schema = 'public'
  and table_name in ('shops', 'products', 'parties', 'sales')
order by table_name, privilege_type
limit 20;
