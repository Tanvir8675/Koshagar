// data/load-shop.js — fill the app's `data` object from the server.
//
// WHY AN ADAPTER RATHER THAN A REWRITE
// The UI reads a global `data` object in 159 places: t.type 68 times, t.total
// 48, t.productId 41, and so on. Rewriting all of those at once would mean
// changing every screen in a single step and having no working app until the
// last one was done.
//
// So this builds the SAME shape from the new tables. Reports, stock, credit and
// invoice keep working untouched, and screens can be moved onto the new views
// one at a time afterwards - each with the app still running.
//
// WHAT THE SHAPE COSTS
// The legacy shape is flat: one row per product line, with the bill's totals
// repeated on each. The new schema separates documents from lines, which is why
// the totals are now correct. Rebuilding the flat view means putting derived
// figures back, and two need care:
//
//   cashPaid  is a DOCUMENT fact, not a line fact. It is spread across the
//             lines in proportion to value, with the rounding remainder given
//             to the last line so the lines still sum to exactly what was paid.
//   cost      is per unit in the old shape and an amount in the new one, so it
//             is divided back out.
//
// Nothing here calculates business figures. Stock, dues, profit and cash all
// come from views; this only reshapes rows.

window.KoshLoad = (function () {
  const num = (v) => Number(v || 0);
  const r2 = (v) => Math.round(num(v) * 100) / 100;

  // The app's validator insists that total == qty x price, with no allowance for
  // a line discount and no idea about entry units. The database keeps them apart:
  // unit_price is per ENTERED unit and gross, line_total is net of the discount,
  // and qty_base is in stock units. Handing over the gross price with the net
  // total fails the check on every discounted line - and on every COIL or BOX
  // bought in a container unit.
  //
  // So price is derived: the net price per BASE unit. Left unrounded (the old
  // data carried values like 34.583333 too), because rounding it to paisa is
  // what makes qty x price drift away from the total again.
  const netUnitPrice = (lineTotal, qtyBase) =>
    num(qtyBase) > 0 ? num(lineTotal) / num(qtyBase) : 0;

  // Split a document's cash across its lines so the parts sum to the whole.
  function spreadCash(total, lines) {
    const gross = lines.reduce((s, l) => s + num(l.line_total), 0);
    if (!(total > 0) || !(gross > 0)) return lines.map(() => 0);
    const out = lines.map((l) => r2((num(l.line_total) / gross) * total));
    const drift = r2(total - out.reduce((s, v) => s + v, 0));
    if (out.length) out[out.length - 1] = r2(out[out.length - 1] + drift);
    return out;
  }

  async function loadInto(target, shopId) {
    const S = `shop_id=eq.${shopId}`;
    const api = window.KoshApi;

    // Every order ends in `id`. PostgREST pages these 1000 rows at a time, and
    // paging a NON-unique sort is unstable - rows shift between pages, so some
    // arrive twice and others never arrive at all. sale_lines passed 1000 rows
    // and a freshly posted line simply vanished from the read: the sale was in
    // the database, correct, and invisible in the app. A unique tiebreaker makes
    // the order total, which is what makes paging safe.
    const [
      products, units, parties,
      sales, saleLines, purchases, purchaseLines,
      returns, returnLines, adjustments,
      bills, payments, allocations,
      expenses, withdrawals, capital, openingCash, loans, edits
    ] = await Promise.all([
      api.selectAll('products',       `${S}&select=*&order=name,id`),
      api.selectAll('units',          `${S}&select=id,name&order=name,id`),
      api.selectAll('parties',        `${S}&select=*&order=id`),
      api.selectAll('sales',          `${S}&select=*&order=occurred_at,id`),
      api.selectAll('sale_lines',     `${S}&select=*&order=line_no,id`),
      api.selectAll('purchases',      `${S}&select=*&order=occurred_at,id`),
      api.selectAll('purchase_lines', `${S}&select=*&order=line_no,id`),
      api.selectAll('returns',        `${S}&select=*&order=occurred_at,id`),
      api.selectAll('return_lines',   `${S}&select=*&order=line_no,id`),
      api.selectAll('adjustments',    `${S}&select=*&order=occurred_at,id`),
      api.selectAll('party_bills',    `${S}&select=*&order=occurred_at,id`),
      api.selectAll('payments',       `${S}&select=*&order=occurred_at,id`),
      api.selectAll('payment_allocations', `${S}&select=*&order=id`),
      api.selectAll('expenses',       `${S}&select=*&order=occurred_at,id`),
      api.selectAll('cash_withdrawals', `${S}&select=*&order=occurred_at,id`),
      api.selectAll('capital_movements', `${S}&select=*&order=occurred_at,id`),
      api.selectAll('opening_cash',   `${S}&select=*&order=business_date`),
      api.selectAll('loans',          `${S}&select=*&order=occurred_at,id`),
      // Presentational only: it explains rows, it does not produce a figure.
      // So a shop whose database has not had 30_document_edits.sql run yet
      // loads normally and simply shows no edit notes, rather than refusing to
      // open the app over a missing badge.
      api.selectAll('document_edits', `${S}&select=*&order=created_at,id`)
         .catch((err) => { console.warn('document_edits unavailable:', err?.message || err); return []; })
    ]);

    const partyById = new Map(parties.map((p) => [p.id, p]));

    // Corrections. A document that replaced another carries the note of what
    // changed, so the row on screen can say so instead of looking like an entry
    // that was always that way. Keyed by the REPLACEMENT, because that is the
    // document still in the books; the one it replaced is reversed and gone from
    // every list. The last edit wins when a document has been corrected twice -
    // it is the one that produced what is on screen.
    const editByDoc = new Map();
    for (const e of (edits || [])) editByDoc.set(e.replacement_id, e);
    const editOf = (docId) => {
      const e = editByDoc.get(docId);
      return e ? { editedAt: e.created_at, editSummary: e.summary || '' } : null;
    };
    const linesOf = (rows, key) => {
      const m = new Map();
      for (const r of rows) {
        if (!m.has(r[key])) m.set(r[key], []);
        m.get(r[key]).push(r);
      }
      return m;
    };
    const cashOfDoc = (doc, kind) => {
      // What was actually paid at the counter: the document total less whatever
      // was left owing. The bill is the authority, since it is what payments
      // allocate against.
      const owed = bills
        .filter((b) => b.source_table === kind && b.source_id === doc.id && b.status === 'open')
        .reduce((s, b) => s + num(b.amount), 0);
      return { owed };
    };

    // -------------------------------------------------------------------
    // products
    // -------------------------------------------------------------------
    // products.base_unit_id is a uuid; the UI shows a unit NAME, so resolve it.
    const unitNameById = new Map(units.map((u) => [u.id, u.name]));
    target.products = products.map((p) => ({
      id: p.id,
      legacyId: p.legacy_id || '',
      name: p.name,
      unit: unitNameById.get(p.base_unit_id) || '',
      category: p.category || '',
      isActive: p.is_active !== false
    }));

    target.units = units.map((u) => u.name);

    // -------------------------------------------------------------------
    // transactions — the flat ledger every screen reads
    // -------------------------------------------------------------------
    const tx = [];
    const saleLinesBy = linesOf(saleLines, 'sale_id');
    const purchLinesBy = linesOf(purchaseLines, 'purchase_id');
    const returnLinesBy = linesOf(returnLines, 'return_id');

    // A bill settled in full needs no party row, so a cash sale or purchase can
    // name someone the shop has no record of. write-shop keeps that name in the
    // document note (withPartyName); this reads it back, so the reports still
    // say who the bill was with instead of showing a blank.
    const nameOf = (party, note) => party
      ? party.name
      : (window.KoshWrite ? window.KoshWrite.partyNameFromNote(note) : '');

    for (const s of sales) {
      if (s.status !== 'posted') continue;
      const ls = saleLinesBy.get(s.id) || [];
      const { owed } = cashOfDoc(s, 'sales');
      const net = ls.reduce((a, l) => a + num(l.line_total), 0) - num(s.bill_discount);
      const cash = spreadCash(r2(net - owed), ls);
      const party = s.party_id ? partyById.get(s.party_id) : null;
      ls.forEach((l, i) => tx.push({
        id: l.id, type: 'sale', date: s.occurred_at, localDate: s.business_date,
        productId: l.product_id, qty: num(l.qty_base),
        price: netUnitPrice(l.line_total, l.qty_base),
        entryUnitPrice: num(l.unit_price), lineDiscount: num(l.line_discount),
        cost: num(l.qty_base) > 0 ? r2(num(l.cogs_amount) / num(l.qty_base)) : 0,
        costTotal: num(l.cogs_amount),
        total: num(l.line_total), cashPaid: cash[i] || 0,
        billId: s.invoice_no, legacyBillId: s.legacy_no || '',
        customer: nameOf(party, s.note), customerPhone: party ? (party.phone || '') : '',
        supplier: '', productName: l.product_name, entryUnit: l.unit_name,
        entryFactor: num(l.entry_factor), entryQty: num(l.qty_entered),
        billDiscountTotal: num(s.bill_discount),
        // The bill's own discount, under a name of its own. billDiscountTotal
        // above is an older field that other code has treated as the LINE
        // discount total; revenue, the invoice and the refund rate all need the
        // header figure specifically, and they read this one.
        docBillDiscount: num(s.bill_discount),
        opening: 0,
        ...editOf(s.id)
      }));
    }

    for (const p of purchases) {
      if (p.status !== 'posted') continue;
      const ls = purchLinesBy.get(p.id) || [];
      const { owed } = cashOfDoc(p, 'purchases');
      // GOODS ONLY, deliberately. party_bills.amount is what the supplier is
      // still owed for the goods (28_extra_cost_is_cash.sql), so goods - owed is
      // the cash that went across the counter for them. Freight is cash too, but
      // it is carried separately on lineExtraCost below, and financial.js
      // subtracts THAT as its own cash-out line. Folding it in here as well made
      // the app count every taka of freight twice and report less cash in the
      // drawer than the database held.
      const net = ls.reduce((a, l) => a + num(l.line_total), 0) - num(p.bill_discount);
      const cash = spreadCash(r2(net - owed), ls);
      // Freight and labour belong to the LINES, not just the bill header.
      //
      // post_purchase already folds each line's share into landed_unit_cost, so
      // stock and COGS were right. But financial.js line 152 reads t.lineExtraCost
      // per line to work out the cash that left the counter, and nothing here was
      // emitting it - so the header carried the figure, every line said undefined,
      // and the extra cost simply never appeared in the app. It is spread the same
      // way the cash is, by line value, with the rounding remainder on the last
      // line so the parts still add up to the whole.
      const extra = spreadCash(r2(num(p.extra_cost)), ls);
      const party = p.party_id ? partyById.get(p.party_id) : null;
      ls.forEach((l, i) => tx.push({
        id: l.id, type: 'purchase', date: p.occurred_at, localDate: p.business_date,
        productId: l.product_id, qty: num(l.qty_base),
        price: netUnitPrice(l.line_total, l.qty_base),
        entryUnitPrice: num(l.unit_price), lineDiscount: num(l.line_discount),
        cost: num(l.landed_unit_cost), landedUnitCost: num(l.landed_unit_cost),
        total: num(l.line_total), cashPaid: cash[i] || 0,
        billId: p.bill_no, legacyBillId: p.legacy_no || '',
        supplier: nameOf(party, p.note), supplierPhone: party ? (party.phone || '') : '',
        customer: '', productName: l.product_name, entryUnit: l.unit_name,
        entryFactor: num(l.entry_factor), entryQty: num(l.qty_entered),
        lineExtraCost: extra[i] || 0, invoiceExtraCost: extra[i] || 0,
        billExtraCostTotal: num(p.extra_cost),
        docBillDiscount: num(p.bill_discount),
        opening: 0,
        ...editOf(p.id)
      }));
    }

    for (const r of returns) {
      if (r.status !== 'posted') continue;
      const ls = returnLinesBy.get(r.id) || [];
      const party = r.party_id ? partyById.get(r.party_id) : null;
      // A return moves cash whenever it is not settled against the party's
      // account: a customer handed money back, or a supplier handed it over.
      // This used to be hardcoded to 0, so financial.js - which reads exactly
      // this field for saleReturnCashOut and purchaseReturnCashIn - counted
      // every refund as nothing, and the drawer on screen drifted from the
      // drawer in the database by the refunded amount.
      //
      // Derived the same way a sale's cash is: post_return raises a credit note
      // for the part NOT refunded, so the part that WAS refunded is the rest.
      // The sign is not needed here - the type decides the direction, and
      // financial.js applies it.
      const { owed: retOwed } = cashOfDoc(r, 'returns');
      const retGross = ls.reduce((a, l) => a + num(l.line_total), 0);
      const refund = spreadCash(r2(retGross - retOwed), ls);
      ls.forEach((l, i) => tx.push({
        id: l.id, type: 'return',
        returnType: r.kind === 'sale_return' ? 'sale-return' : 'purchase-return',
        date: r.occurred_at, localDate: r.business_date,
        productId: l.product_id, qty: num(l.qty_base), price: num(l.unit_price),
        cost: num(l.qty_base) > 0 ? r2(num(l.cost_amount) / num(l.qty_base)) : 0,
        total: num(l.line_total), cashPaid: refund[i] || 0,
        linkedTxId: l.original_sale_line_id || l.original_purchase_line_id || '',
        billId: r.return_no, returnGroupId: r.id,
        customer: party ? party.name : '', supplier: party ? party.name : '',
        productName: l.product_name, opening: 0,
        ...editOf(r.id)
      }));
    }

    for (const a of adjustments) {
      if (a.status !== 'posted') continue;
      tx.push({
        id: a.id, type: a.kind === 'opening' ? 'purchase' : 'adjustment',
        adjustmentType: a.kind, date: a.occurred_at, localDate: a.business_date,
        productId: a.product_id, qty: num(a.qty_base), price: num(a.unit_cost),
        cost: num(a.unit_cost), total: r2(num(a.qty_base) * num(a.unit_cost)),
        cashPaid: 0, opening: a.kind === 'opening' ? 1 : 0,
        productName: a.product_name, reason: a.note || '',
        ...editOf(a.id)
      });
    }

    // Capital and loans are money events. The old shape carried them as
    // transactions against a fake product; here they have no product at all,
    // which is why productId is left empty rather than invented.
    for (const c of capital) {
      if (c.status !== 'posted') continue;
      tx.push({
        id: c.id, type: c.kind === 'in' ? 'capital-in' : 'capital-out',
        date: c.occurred_at, localDate: c.business_date,
        // '__CAPITAL__' is the sentinel the app's validator insists on for money
        // that is not a product movement. An empty productId here made every
        // local save fail with "an investment entry is set up incorrectly" -
        // while editing a purchase, which is a bewildering thing to be told.
        productId: '__CAPITAL__', qty: 1, price: num(c.amount), cost: 0,
        total: num(c.amount), cashPaid: num(c.amount),
        reason: c.note || '', opening: 0
      });
    }
    for (const l of loans) {
      if (l.status !== 'posted') continue;
      tx.push({
        id: l.id, type: 'capital-in', date: l.occurred_at, localDate: l.business_date,
        productId: '__CAPITAL__', qty: 1, price: num(l.principal), cost: 0,
        total: num(l.principal), cashPaid: num(l.principal),
        loanName: l.lender_name, loanPhone: l.lender_phone || '',
        // The repayment screen pays the LENDER, so it needs their party id -
        // record_payment allocates against that party's payables, and the loan
        // is one of them.
        loanPartyId: l.party_id || '',
        loanDueDate: l.due_date || '', capitalSource: 'loan',
        reason: l.purpose || '', opening: 0
      });
    }

    tx.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    target.transactions = tx;

    // -------------------------------------------------------------------
    // credit and payments
    // -------------------------------------------------------------------
    const allocByPayment = linesOf(allocations, 'payment_id');
    // A credit has to speak the same language as the transactions beside it.
    //
    // reconcileDataConsistency() rebuilds every credit by matching its billId
    // against t.billId on the purchase/sale rows. Those rows carry the human
    // bill NUMBER, so a credit carrying the document UUID matched nothing, had
    // its total forced to 0, and was then dropped by the filter - the debt was
    // in the database and invisible in the app.
    //
    // total/paid also have to be expressed the legacy way. party_bills stores
    // what is still OWED; the old shape stores the full bill and how much of it
    // was paid, and derives the rest. Reconcile recomputes total from the line
    // values, so paid is set against that same figure - then total - paid is
    // exactly the outstanding amount the database holds.
    const docNoById = new Map();
    const docLineTotal = new Map();
    // The bill's own discount, so `total` below can be what the party was
    // actually charged. Both posting functions settle against gross MINUS the
    // discount - post_sale's v_net, post_purchase's v_goods - so a bill total
    // taken from the lines alone is the figure before the discount was given.
    const docDiscount = new Map();
    for (const x of sales)     { docNoById.set(x.id, x.invoice_no); docDiscount.set(x.id, num(x.bill_discount)); }
    for (const x of purchases) { docNoById.set(x.id, x.bill_no);    docDiscount.set(x.id, num(x.bill_discount)); }
    for (const l of saleLines)
      docLineTotal.set(l.sale_id, r2((docLineTotal.get(l.sale_id) || 0) + num(l.line_total)));
    for (const l of purchaseLines)
      docLineTotal.set(l.purchase_id, r2((docLineTotal.get(l.purchase_id) || 0) + num(l.line_total)));

    // WHOSE DEBT IS THIS?
    //
    // The app used to answer with the direction alone: money owed TO the shop
    // was a customer's, money owed BY the shop was a supplier's. That holds for
    // ordinary trading and breaks the moment a return reverses it - a customer
    // who has already paid and brings goods back is owed money, and landed in
    // the supplier list.
    //
    // The bill says where it came from, so the bill is asked. Only the opening
    // balances have to fall back on what kind of party it is, because an
    // opening balance is exactly the case with no document behind it.
    const returnKindById = new Map(returns.map((r) => [r.id, r.kind]));
    const sideOfBill = (b) => {
      switch (b.source_table) {
        case 'sales':     return 'customer';
        case 'purchases': return 'supplier';
        case 'loans':     return 'supplier';   // a lender is owed, like a supplier
        case 'returns':
          return returnKindById.get(b.source_id) === 'purchase_return'
            ? 'supplier' : 'customer';
        default: {
          const party = partyById.get(b.party_id) || {};
          if (party.kind === 'supplier') return 'supplier';
          if (party.kind === 'customer') return 'customer';
          return b.direction === 'payable' ? 'supplier' : 'customer';
        }
      }
    };

    // A loan's bill has no document number of its own - source_id points at the
    // loan, not at an invoice - so the lender's name is what identifies it on
    // screen. Without this the credit page showed a raw uuid where a bill
    // number belongs.
    const lenderByLoanId = new Map(loans.map((l) => [l.id, l.lender_name]));

    const asCredit = (b) => {
      const party = partyById.get(b.party_id) || {};
      // WHAT THE CUSTOMER WAS CHARGED, NOT WHAT THE LINES ADD UP TO.
      //
      // party_bills.amount is what was still owed when the bill was posted, and
      // `paid` is derived as total - amount. So if `total` is the pre-discount
      // figure, the discount reappears as money the customer is credited with
      // having paid: a 1,000 bill with 300 off and 200 handed over read as
      // "Total 1,000, Paid 500" on the credit page while the invoice beside it
      // said "Total 700, Paid 200". Same bill, two stories.
      //
      // The due itself was right either way - it comes from b.amount - which is
      // exactly why this went unnoticed.
      const lineTotal = docLineTotal.get(b.source_id);
      const total = lineTotal != null
        ? r2(lineTotal - (docDiscount.get(b.source_id) || 0))
        : num(b.amount);
      return {
        id: b.id, date: b.occurred_at, localDate: b.business_date,
        // Which way the money runs, and which side of the counter it is owed
        // across. The screens need both: the first decides how a balance is
        // worked out, the second decides which list it belongs in.
        direction: b.direction,
        partySide: sideOfBill(b),
        sourceTable: b.source_table,
        // A loan is money borrowed, not goods bought on credit. The screens
        // need to say which, because what settles them differs: one is repaid,
        // the other is paid for.
        isLoan: b.source_table === 'loans',
        lenderName: b.source_table === 'loans' ? (lenderByLoanId.get(b.source_id) || '') : '',
        total,
        paid: Math.max(0, r2(total - num(b.amount))),
        customerName: party.name || '', customerPhone: party.phone || '',
        supplierName: party.name || '', supplierPhone: party.phone || '',
        partyId: b.party_id,
        billId: docNoById.get(b.source_id) || b.source_id,
        sourceDocId: b.source_id,
        dueDate: b.due_date || '',
        // A settled bill the shopkeeper has filed away. It stays in the data -
        // the screens keep it under "settled" so an argument months later can
        // still be checked - it just leaves the list of debts to chase.
        archived: !!b.archived_at,
        archivedAt: b.archived_at || '',
        archiveReason: b.archive_reason || ''
      };
    };
    target.credits         = bills.filter((b) => b.direction === 'receivable' && b.status === 'open').map(asCredit);
    target.supplierCredits = bills.filter((b) => b.direction === 'payable'    && b.status === 'open').map(asCredit);

    // ONE ROW PER ALLOCATION, not per payment.
    //
    // The legacy shape ties a payment to a single credit, so a 5,000 payment
    // spread over three bills has to arrive as three rows. Sending one row with
    // the full 5,000 against the first bill credited that bill in full and left
    // the other two untouched - and because each credit's due is floored at zero,
    // the overpaid part evaporated instead of moving on. Dues came out thousands
    // too high while the database was perfectly correct.
    //
    // The parts sum to the payment, so cash totals are unchanged either way.
    const asPayment = (p) => {
      const allocs = allocByPayment.get(p.id) || [];
      const party = partyById.get(p.party_id) || {};
      const base = {
        date: p.occurred_at, localDate: p.business_date,
        customer: party.name || '', supplier: party.name || '',
        partyId: p.party_id, method: p.method,
        ...editOf(p.id)
      };
      if (!allocs.length) {
        // Money taken with nothing to settle yet - an advance. It still moved
        // cash, so it must not be dropped.
        return [{ ...base, id: p.id, amount: num(p.amount), creditId: '', scId: '' }];
      }
      const rows = allocs.map((a, i) => ({
        ...base,
        id: allocs.length === 1 ? p.id : `${p.id}:${i}`,
        paymentId: p.id,
        amount: num(a.amount),
        creditId: a.bill_id, scId: a.bill_id
      }));
      // Anything not allocated to a bill is an advance sitting on the party.
      const spread = rows.reduce((t, r) => t + r.amount, 0);
      const rest = r2(num(p.amount) - spread);
      if (rest > 0.004) {
        rows.push({ ...base, id: `${p.id}:adv`, paymentId: p.id, amount: rest, creditId: '', scId: '' });
      }
      return rows;
    };
    const expand = (dir) => payments
      .filter((p) => p.status === 'posted' && p.direction === dir)
      .flatMap(asPayment);

    // Loan repayments are ordinary payments out, allocated against the payable
    // the loan raised (12_loans.sql). The loan screens work in "payments against
    // this loan", so the allocations are read back through the bill that links
    // them: party_bills.source_id IS the loan id.
    //
    // loanPayments was hardcoded to an empty array, which is why every loan
    // showed its full principal as still owing however much had been repaid.
    const loanIdByBill = new Map(
      bills.filter((b) => b.source_table === 'loans').map((b) => [b.id, b.source_id])
    );
    const paymentById = new Map(payments.map((p) => [p.id, p]));

    target.payments = expand('in');
    // A loan repayment is money out, so it arrives in this same list - and
    // financial.js counts supplierDuePaidCashOut AND loanPaymentCashOut as cash
    // leaving the drawer. Left in both, every repayment would be spent twice.
    // It belongs to the loan, so the loan takes it.
    target.supplierPayments = expand('out').filter((r) => !loanIdByBill.has(r.scId));
    target.loanPayments = allocations
      .filter((a) => loanIdByBill.has(a.bill_id))
      .map((a) => {
        const pm = paymentById.get(a.payment_id);
        return (pm && pm.status === 'posted') ? {
          id: a.id,
          loanTxId: loanIdByBill.get(a.bill_id),
          // The bill this repayment settled. The loan screens work by loan id,
          // but the credit page works by bill - and without this the same
          // repayment was visible on one screen and missing from the other.
          scId: a.bill_id,
          amount: num(a.amount),
          date: pm.occurred_at,
          localDate: pm.business_date,
          note: pm.note || ''
        } : null;
      })
      .filter(Boolean);

    // -------------------------------------------------------------------
    // cash
    // -------------------------------------------------------------------
    target.extraExpenses = expenses.filter((e) => e.status === 'posted').map((e) => ({
      id: e.id, date: e.occurred_at, localDate: e.business_date,
      amount: num(e.amount), note: e.note || e.category || '',
      ...editOf(e.id)
    }));
    target.cashWithdrawals = withdrawals.filter((w) => w.status === 'posted').map((w) => ({
      id: w.id, date: w.occurred_at, localDate: w.business_date,
      amount: num(w.amount), reason: w.reason || '',
      ...editOf(w.id)
    }));
    target.openingCashByDate = {};
    for (const o of openingCash) target.openingCashByDate[o.business_date] = num(o.amount);

    target.auditTrail = [];   // read on demand from audit_log, not held in memory

    return {
      products: target.products.length,
      transactions: target.transactions.length,
      credits: target.credits.length,
      supplierCredits: target.supplierCredits.length,
      payments: target.payments.length + target.supplierPayments.length
    };
  }

  return { loadInto };
})();
