-- =========================================================================
-- KoshAgar ERP - 35_keep_last_archive.sql
--
-- Deleting old records, with the safety net nailed down.
--
-- Reset closes the current books and opens new ones, so archives accumulate -
-- one per reset, each a complete copy of that period. Keeping every one of them
-- for ever is not necessary: each reset also wrote a file to the owner's own
-- device, so the older archives are a second copy of something they already
-- hold.
--
-- The MOST RECENT archive is different. It is the one the shop was working in
-- until moments ago, and the only thing standing behind a reset that turns out
-- to have been a mistake. purge_archived_shop() would happily delete it - it
-- only checks that a shop is archived, not which one - so this refuses that
-- specific case.
--
-- The rule: you may delete any closed set of books EXCEPT the newest one.
-- =========================================================================

create or replace function purge_old_shop(p_shop uuid, p_confirm_export text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_name text; v_archived_at timestamptz; v_newest timestamptz;
begin
  if not has_shop_role(p_shop, 'owner') then
    raise exception 'NOT_OWNER: only the owner can delete old records.';
  end if;

  select name, archived_at into v_name, v_archived_at
    from shops where id = p_shop and is_archived;
  if v_name is null then
    raise exception
      'NOT_ARCHIVED: only closed books can be deleted. The set you are working in cannot be.';
  end if;

  -- The newest archive is the safety net for the most recent reset.
  select max(s.archived_at) into v_newest
    from shops s
    join shop_members m on m.shop_id = s.id and m.user_id = auth.uid()
   where s.is_archived;

  if v_archived_at is not distinct from v_newest then
    raise exception
      'KEEP_LAST_ARCHIVE: "%" is your most recent closed set of books, and is what a mistaken reset would be recovered from. It cannot be deleted. Delete an older one, or reset again first.',
      v_name;
  end if;

  -- Everything else - ownership, the export phrase, the audit row written into
  -- a shop that will still exist afterwards - is already handled there.
  return purge_archived_shop(p_shop, p_confirm_export);
end $fn$;

grant execute on function purge_old_shop(uuid, text) to authenticated;

comment on function purge_old_shop is
  'Permanently deletes one closed set of books, refusing the most recent archive - that one is the safety net for the last reset. Everything else defers to purge_archived_shop().';

select 'old records can be deleted, except the newest archive' as note;
