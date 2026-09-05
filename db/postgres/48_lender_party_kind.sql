-- =========================================================================
-- KoshAgar ERP — 48_lender_party_kind.sql
--
-- A LENDER IS NOT A SUPPLIER
--
-- parties.kind offered three answers - customer, supplier, both - so the person
-- who lends the shop money was filed as a supplier, because that was the only
-- box that meant "someone the shop owes".
--
-- The two are not alike. A supplier delivers goods and is owed for them; the
-- amount is whatever the goods came to. A lender hands over cash and is owed it
-- back; the amount has nothing to do with anything bought - 20,000 borrowed can
-- buy 15,000 of stock. They are settled differently too: one is paid for, the
-- other is repaid.
--
-- The screens already tell them apart by asking what raised the bill
-- (party_bills.source_table), and nothing displayed is wrong today. But the
-- master record still says "supplier", and any question asked of the PARTIES
-- table rather than of the bills - "list my suppliers", a report, an export, a
-- screen not yet written - would count the moneylender among them.
--
-- So the record is corrected at the source.
--
-- 'both' stays as it is. It means customer AND supplier, which is a real
-- combination for a shop that buys from someone it also sells to. A lender who
-- is also a supplier is rare enough that it can be filed as the one the shop
-- deals with more often; inventing 'supplier_and_lender' would multiply the
-- values without making anything clearer.
-- =========================================================================

alter table parties drop constraint if exists parties_kind_check;
alter table parties
  add constraint parties_kind_check
  check (kind in ('customer', 'supplier', 'both', 'lender'));

comment on column parties.kind is
  'Who this party is to the shop: customer, supplier, both, or lender. A lender gives cash and is repaid; a supplier gives goods and is paid for them.';

-- -------------------------------------------------------------------------
-- The lenders already on record
--
-- Anyone who has lent the shop money is reclassified - unless they have also
-- sold it goods, in which case 'supplier' remains the more useful label and the
-- loan is still identifiable by the bill that raised it.
-- -------------------------------------------------------------------------
update parties p
   set kind = 'lender'
 where exists (select 1 from loans l where l.party_id = p.id)
   and not exists (
     select 1 from purchases pu where pu.party_id = p.id and pu.status = 'posted'
   )
   and p.kind <> 'lender';

select 'parties.kind now recognises a lender; existing lenders reclassified' as note;
