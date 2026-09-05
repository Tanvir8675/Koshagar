-- =========================================================================
-- KoshAgar ERP - 51_audit_names_the_party.sql
--
-- THE AUDIT TRAIL SAID WHAT HAPPENED BUT NOT TO WHOM
--
-- Every posting function records the document it wrote - bill number, totals,
-- what was reversed - and the screen shows that back exactly as written. What
-- none of them record is the party:
--
--   Purchase posted
--   owed: 0 - goods: 200 - bill_no: PUR-2026-000014 - cash_paid: 200
--
-- The bill number is an index into the books, not an answer. Reading a trail
-- to find out who was paid 200 taka means opening every bill named in it.
--
-- The name is not put INTO audit_log. That table is append-only on purpose,
-- and a name copied into it at write time would freeze the spelling of a party
-- that gets corrected later - the trail would then disagree with the books it
-- exists to witness. The link is already there: entity_table and entity_id
-- name the document, and the document names the party. So the join is done at
-- read time, in a view.
--
-- Documents with no party - an expense, a withdrawal, a capital movement, a
-- stock correction - simply come back null, which is the truth about them.
--
-- audit_log itself is untouched: no column added, no row rewritten.
-- =========================================================================

create or replace view v_audit_feed as
select a.id,
       a.shop_id,
       a.occurred_at,
       a.actor,
       a.action,
       a.entity_table,
       a.entity_id,
       a.old_value,
       a.new_value,
       a.note,
       p.name as party_name,
       p.kind as party_kind
from audit_log a
left join parties p on p.id = coalesce(
  (select s.party_id  from sales s        where a.entity_table = 'sales'       and s.id  = a.entity_id),
  (select pu.party_id from purchases pu   where a.entity_table = 'purchases'   and pu.id = a.entity_id),
  (select r.party_id  from returns r      where a.entity_table = 'returns'     and r.id  = a.entity_id),
  (select pm.party_id from payments pm    where a.entity_table = 'payments'    and pm.id = a.entity_id),
  (select l.party_id  from loans l        where a.entity_table = 'loans'       and l.id  = a.entity_id),
  (select pb.party_id from party_bills pb where a.entity_table = 'party_bills' and pb.id = a.entity_id)
);

-- A view runs as its OWNER unless told otherwise, which would hand every shop's
-- history to every signed-in user however correct the table policies are. Same
-- reason, same fix as every view in 09_rls.sql.
alter view v_audit_feed set (security_invoker = true);

grant select on v_audit_feed to authenticated;

comment on view v_audit_feed is
  'audit_log with the party its document names, resolved at read time so a renamed party reads correctly in old entries. Null where the document has no party.';

select 'the audit trail can now say who each entry was with' as note;
