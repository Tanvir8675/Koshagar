-- =========================================================================
-- KoshAgar ERP — 18_grant_new_objects.sql
-- Run now. Fixes "permission denied for view v_my_shops".
--
-- 09_rls.sql said `grant select on all tables in schema public to
-- authenticated`. That grants on the tables and views existing AT THAT MOMENT.
-- Everything added afterwards - v_my_shops, v_storage_usage, v_loan_balances,
-- loans, cash_adjustments, profiles - got nothing, so a signed-in user was
-- refused the very view the app opens with.
--
-- The same trap as the service_role grant in 93. Fixed the same way, and this
-- time ALTER DEFAULT PRIVILEGES is set for authenticated too, so anything added
-- from here on is covered without another patch.
-- =========================================================================

grant select on all tables in schema public to authenticated;

-- Master data stays directly writable; RLS decides who may actually write.
grant insert, update on units, products, product_units, parties,
                        cash_accounts, accounting_periods to authenticated;
grant select, update on profiles to authenticated;

-- Future objects, so this cannot happen a third time.
alter default privileges in schema public grant select on tables to authenticated;

-- Everything callable by a signed-in user, including the ones added in 12-15.
grant execute on function
  post_loan(uuid, jsonb), export_shop_data(uuid), shop_is_empty(uuid),
  create_additional_shop(text), archive_shop(uuid, text), unarchive_shop(uuid),
  replace_shop(uuid, uuid, text), purge_archived_shop(uuid, text),
  post_cash_adjustment(uuid, jsonb), post_adjustment(uuid, jsonb),
  change_username(text)
  to authenticated;

alter default privileges in schema public grant execute on functions to authenticated;

-- Anonymous callers keep exactly what 16 left them: the two login helpers.
revoke all on all tables in schema public from anon;
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname not in ('username_available', 'resolve_login_identifier')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
  end loop;
end $$;

-- VERIFY: every view a signed-in user needs. All should say true.
select table_name,
       has_table_privilege('authenticated', 'public.' || table_name, 'SELECT') as authenticated_can_read
from information_schema.views
where table_schema = 'public'
order by table_name;
