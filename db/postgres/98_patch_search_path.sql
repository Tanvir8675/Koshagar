-- =========================================================================
-- KoshAgar ERP — 98_patch_search_path.sql
--
-- Run ONCE against a database that already has 01–06 loaded.
--
-- Fixes the 34 "Function Search Path Mutable" warnings from the Supabase
-- security advisor. A function without an explicit search_path resolves table
-- names using whatever search_path the caller happens to have set, so a caller
-- can create their own `products` table in another schema and have the function
-- silently read and write that instead. It matters most for the SECURITY
-- DEFINER functions, which run with elevated rights - but pinning all of them
-- costs nothing and removes the whole class of problem.
--
-- ALTER rather than CREATE OR REPLACE, so nothing else about the functions
-- changes and no table DDL is re-run.
--
-- The source files 01–06 have been updated too, so a fresh install from
-- scratch already includes this and does not need the patch.
-- =========================================================================

-- 01_foundation
alter function public.period_is_writable(uuid, date)          set search_path = public;
alter function public.assert_period_writable(uuid, date)      set search_path = public;
alter function public.next_document_no(uuid, text, date)      set search_path = public;
alter function public.touch_updated_at()                      set search_path = public;
alter function public.write_audit(uuid, text, text, uuid, jsonb, jsonb, text)
                                                              set search_path = public;

-- 02_master_data
alter function public.ensure_base_unit_conversion()           set search_path = public;
alter function public.protect_base_unit_factor()              set search_path = public;

-- 03_operations
alter function public.check_return_within_original()          set search_path = public;
alter function public.forbid_delete_posted()                  set search_path = public;

-- 04_finance
alter function public.bill_balance(uuid)                      set search_path = public;
alter function public.payment_unallocated(uuid)               set search_path = public;
alter function public.check_allocation_valid()                set search_path = public;

-- 05_views
alter function public.cash_balance_as_of(uuid, uuid, date)    set search_path = public;

-- 06_functions
alter function public.consume_fifo(uuid, uuid, numeric, text, uuid)
                                                              set search_path = public;
alter function public.resolve_conversion(uuid, uuid, uuid)    set search_path = public;
alter function public.idempotent_hit(uuid, text)              set search_path = public;
alter function public.assert_party_in_shop(uuid, uuid)        set search_path = public;
alter function public.default_cash_account(uuid)              set search_path = public;

-- Safety net: if an earlier run left the two-argument resolve_conversion behind
-- (the version without a shop_id check), remove it so nothing can call it.
drop function if exists public.resolve_conversion(uuid, uuid);

-- Confirm: this should return zero rows.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'
  )
order by 1;
