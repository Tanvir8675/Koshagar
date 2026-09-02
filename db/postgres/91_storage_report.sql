-- =========================================================================
-- KoshAgar ERP — 91_storage_report.sql
--
-- What is actually using the 500 MB. Safe to run any time; reads only.
--
-- A fresh Supabase project starts around 40-50 MB before you add a single row:
-- the auth schema, realtime, storage, extensions and Postgres' own catalogs.
-- That baseline is fixed - it does not grow as the shop trades.
--
-- Deleting rows also does not shrink the file straight away. The space is
-- marked reusable and the next inserts fill it, which is why the number can sit
-- still for a while after a cleanup and then stop rising for a long time.
-- =========================================================================

-- 1. Where the space actually is, biggest first.
select
  n.nspname                                              as schema,
  c.relname                                              as object,
  pg_size_pretty(pg_total_relation_size(c.oid))          as total,
  pg_size_pretty(pg_relation_size(c.oid))                as data,
  pg_size_pretty(pg_indexes_size(c.oid))                 as indexes,
  c.reltuples::bigint                                    as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
order by pg_total_relation_size(c.oid) desc
limit 25;

-- 2. The headline split: your shop's tables versus everything else.
select
  case when n.nspname = 'public' then 'your data (public schema)'
       else 'Supabase platform (' || n.nspname || ')' end as what,
  pg_size_pretty(sum(pg_total_relation_size(c.oid)))      as size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
group by 1
order by sum(pg_total_relation_size(c.oid)) desc;

-- 3. Dead rows still holding space after the cleanup. These are reused by the
--    next inserts - they are not lost, just not yet returned.
select relname                          as table_name,
       n_live_tup                       as live_rows,
       n_dead_tup                       as dead_rows,
       last_autovacuum
from pg_stat_user_tables
where n_dead_tup > 0
order by n_dead_tup desc
limit 15;

-- 4. Whole database.
select pg_size_pretty(pg_database_size(current_database())) as database_total;
