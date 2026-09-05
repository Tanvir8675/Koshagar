// data/write-shop.js — every write goes through a database function.
//
// WHY NOT JUST SAVE THE `data` OBJECT
// The old app sent the whole book up as one JSON blob and let "newer wins"
// decide. That is what emptied the shop: two devices, one blob each, the
// smaller one written last. Nothing here sends a blob. Each action calls the
// posting function built for it, the database validates it, and the answer is
// either a document id or a named error.
//
// WHAT THE DATABASE ENFORCES, NOT THIS FILE
// Stock cannot go negative, a payment cannot exceed the bill, a closed month
// cannot be written, FIFO cost comes out of real lots. None of that is checked
// here, on purpose - a check in the browser is a suggestion, and the old app's
// missing overpayment guard is exactly how 6,026.22 of impossible payments got
// in. This file only shapes the payload and reports what came back.
//
// IDEMPOTENCY
// Every call carries a key. A double-tap on a slow connection, or a retry after
// a dropped reply, returns the ORIGINAL result instead of posting twice. The key
// is generated per user action, not per attempt.

window.KoshWrite = (function () {
  const num = (v) => Number(v || 0);
  const r2  = (v) => Math.round(num(v) * 100) / 100;

  // A key that is stable for one user action and unique across actions.
  const newKey = (what) =>
    `ui:${what}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

  const shop = () => {
    const id = window.ACTIVE_SHOP_ID || localStorage.getItem('koshagar.shopId');
    if (!id) throw new Error('No shop is open. Sign in again.');
    return id;
  };

  // The app works in local dates; the database wants both the calendar day the
  // shopkeeper means and the exact instant, and they are not the same thing
  // near midnight. business_date decides which period a document belongs to.
  const when = (dateStr) => {
    const day = String(dateStr || '').slice(0, 10);
    return {
      business_date: day,
      occurred_at: /^\d{4}-\d{2}-\d{2}$/.test(day)
        ? new Date(`${day}T${new Date().toTimeString().slice(0, 8)}`).toISOString()
        : new Date().toISOString()
    };
  };

  // Old records are read-only. The database refuses these writes on its own -
  // assert_can_write() raises SHOP_ARCHIVED - but the refusal has to happen
  // HERE too, before a form is filled in and submitted. A shopkeeper who can
  // type a whole sale into a screen has already spent the time; being told at
  // the end that none of it could be saved is the worst moment to say it.
  //
  // Reads and EXPORTS still use shop(): the whole point of keeping old books is
  // that they can be looked at and taken out.
  const writeShop = () => {
    if (window.__VIEWING_ARCHIVE) {
      throw new Error('These are old records - read only. Go back to your current '
                      + 'books before entering anything.');
    }
    return shop();
  };

  // NOTHING IS WRITTEN WHILE THE SCREENS ARE SHOWING THE CACHE.
  //
  // runEngineCommand() already refuses every document entry when the app is on
  // its offline copy, and that covers sales, purchases, payments, expenses,
  // adjustments and the rest. It does NOT cover the shop-lifecycle actions -
  // reset, archive, delete old books, restore a file - which are called
  // straight from their own dialogs.
  //
  // Offline those would have failed anyway, at the network, but as a raw fetch
  // error after the confirmation phrase had been typed and the password given.
  // A refusal that arrives at the end of a destructive action is the worst one
  // there is, so it is said here instead, in a sentence.
  const assertOnline = () => {
    if (window.__READ_ONLY === true) {
      throw new Error('No connection - you are looking at a saved copy of your books. '
                      + 'Nothing can be changed until you are back online.');
    }
  };

  const call = (fn, payload, key) => {
    assertOnline();
    return window.KoshApi.rpc(fn, {
      p_shop: writeShop(),
      p_payload: { idempotency_key: key, ...payload }
    });
  };

  // -----------------------------------------------------------------------
  // Cash documents
  // -----------------------------------------------------------------------
  const addExpense = ({ date, amount, note, key }) =>
    call('post_expense', { ...when(date), amount: r2(amount), note: String(note || '') },
         key || newKey('exp'));

  const addWithdrawal = ({ date, amount, reason, key }) =>
    call('post_cash_withdrawal', { ...when(date), amount: r2(amount), reason: String(reason || '') },
         key || newKey('wd'));

  // post_capital_movement reads 'kind', not 'direction'.
  const addCapital = ({ date, amount, kind, note, key }) =>
    call('post_capital_movement',
         { ...when(date), amount: r2(amount), kind, note: String(note || '') },
         key || newKey('cap'));

  // Borrowed money. Not capital: capital is the owner's own and is never repaid,
  // a loan belongs to somebody else and comes with a name and a due date.
  // post_loan writes the loans row, the cash coming IN, and the payable it
  // raises, in one transaction. Repayment is then an ordinary payment out
  // against that payable - the allocation machinery already proven for
  // suppliers, rather than a second half-built one for lenders.
  //
  // The party matters: without one, post_loan records the loan but raises NO
  // payable, and the debt is untracked. The caller resolves the lender first.
  const postLoan = ({ date, party, lenderName, lenderPhone, principal, purpose,
                      dueDate, relatedPurchaseId, key }) =>
    call('post_loan', {
      ...when(date),
      party_id: party || null,
      lender_name: String(lenderName || '').trim(),
      lender_phone: String(lenderPhone || '').trim() || null,
      principal: r2(principal),
      purpose: String(purpose || ''),
      due_date: dueDate || null,
      related_purchase_id: relatedPurchaseId || null
    }, key || newKey('loan'));

  const setOpeningCash = ({ date, amount, key }) =>
    call('set_opening_cash', { ...when(date), amount: r2(amount) }, key || newKey('open'));

  // -----------------------------------------------------------------------
  // Reversal — the only way to undo a posted document
  // -----------------------------------------------------------------------
  // Deleting a posted document is refused by the database. A reversal writes an
  // opposite entry and leaves both halves visible, so the books still explain
  // themselves months later. That is the whole reason the March scare could be
  // untangled at all.
  // reverse_document takes positional arguments, not a payload object like the
  // posting functions do. `type` is one of: sale, purchase, payment, expense,
  // cash_withdrawal, capital_movement.
  const reverse = ({ type, id, reason }) =>
    window.KoshApi.rpc('reverse_document', {
      p_shop: writeShop(),
      p_type: type,
      p_id: id,
      p_reason: String(reason || 'Corrected in the app')
    });

  const deleteExpense    = (id, reason) => reverse({ type: 'expense', id, reason });
  const deleteWithdrawal = (id, reason) => reverse({ type: 'cash_withdrawal', id, reason });
  const deleteCapital    = (id, reason) => reverse({ type: 'capital_movement', id, reason });

  // -----------------------------------------------------------------------
  // Lookups the UI does not carry
  // -----------------------------------------------------------------------
  // The screens work in unit NAMES ("PCS") and party names; the database works
  // in ids. Cached per shop because a bill can have twenty lines and each one
  // would otherwise be its own round trip.
  // Keyed BY SHOP, not just cached. "PCS" is a different row in every shop, so a
  // cache that ignores which shop is open will hand shop A's unit id to shop B -
  // where it matches nothing, and the database rejects the line with a message
  // naming neither the product nor the unit. Switching shops must not be able to
  // poison this quietly.
  let _units = null;
  let _unitsShop = null;
  async function unitId(name) {
    const sid = shop();
    if (!_units || _unitsShop !== sid) {
      const rows = await window.KoshApi.selectAll('units', `shop_id=eq.${sid}&select=id,name`);
      _units = new Map(rows.map((u) => [String(u.name).trim().toUpperCase(), u.id]));
      _unitsShop = sid;
    }
    const key = String(name || '').trim().toUpperCase();
    const id = _units.get(key);
    if (!id) throw new Error(`Unit "${name}" is not set up in this shop.`);
    return id;
  }
  const forgetUnits = () => { _units = null; _unitsShop = null; };

  // -----------------------------------------------------------------------
  // TELLING A PRODUCT ABOUT A UNIT IT HAS NOT MET
  //
  // Conversions are master data: the database refuses a document in a unit the
  // product has no factor for (resolve_conversion, 06_functions.sql) rather
  // than inventing one at posting time. That is the right rule - a made-up
  // factor silently misprices stock forever.
  //
  // But the entry screen lets a shopkeeper say "1 COIL = 109 GAUGE" while
  // writing the bill, and nothing was recording it. The purchase was then
  // refused with "Add it to the product first", pointing at a screen that does
  // not exist. So the conversion the shopkeeper just typed is registered here,
  // before the document is posted.
  //
  // Only ever written ONCE. If the product already has a factor for that unit,
  // the stored one wins and this does nothing - a shopkeeper mistyping 190 for
  // 109 today must not silently revalue every COIL ever bought.
  async function ensureConversion(productId, unitName, factor) {
    const f = Number(factor);
    const name = String(unitName || '').trim();
    if (!productId || !name || !(f > 0)) return;
    const uid = await unitId(name);          // throws a plain sentence if unknown
    const existing = await window.KoshApi.select('product_units',
      `product_id=eq.${productId}&unit_id=eq.${uid}&select=unit_id`);
    if (existing && existing.length) return;
    await window.KoshApi.insert('product_units', {
      shop_id: shop(), product_id: productId, unit_id: uid, factor: f
    });
  }

  // Every line of a bill, before the bill is posted. Sequential rather than
  // parallel: two lines of the same product in a new unit would otherwise both
  // find nothing and both insert, and the unique constraint would reject the
  // second - failing a bill that was perfectly valid.
  async function ensureLineConversions(lines) {
    for (const l of (lines || [])) {
      if (l && l.entryUnit && Number(l.entryFactor) > 0) {
        await ensureConversion(l.productId, l.entryUnit, Number(l.entryFactor));
      }
    }
  }

  const PHONE = /^01[3-9][0-9]{8}$/;

  // Phone is the identity when it is there, name only as a fallback - which is
  // how two "Rahman"s stay two people. A NEW party must have a phone; the
  // database enforces that, and only the pre-migration rows are exempt.
  //
  // `required` says whether this document actually needs a party. It does when
  // money is left owing - a debt with nobody attached cannot be collected, which
  // is why post_sale and post_purchase both refuse one. It does NOT when the
  // bill is settled in full: nothing is owed, so nothing has to be chased, and
  // demanding a phone there stopped a cash purchase from being entered at all.
  // In that case an unknown name resolves to no party rather than an error, and
  // the caller keeps the typed name in the document note so it is still on the
  // record.
  async function findOrCreateParty({ name, phone, kind = 'customer', required = true }) {
    const nm = String(name || '').trim();
    const ph = String(phone || '').trim();
    if (!nm) return null;

    if (PHONE.test(ph)) {
      const hit = await window.KoshApi.select('parties',
        `shop_id=eq.${shop()}&phone=eq.${ph}&select=id,kind`);
      if (hit.length) return hit[0].id;
    } else {
      const hit = await window.KoshApi.select('parties',
        `shop_id=eq.${shop()}&name=eq.${encodeURIComponent(nm)}&select=id,kind`);
      if (hit.length) return hit[0].id;
      if (!required) return null;
      throw new Error(`"${nm}" is new, so a phone number is required.`);
    }
    const [row] = await window.KoshApi.insert('parties', [{
      shop_id: shop(), name: nm, phone: ph, kind, is_legacy: false
    }]);
    return row.id;
  }

  // A settled bill can still name someone the shop has no party row for: a cash
  // purchase from "test" with no phone given. Nothing is owed, so the database
  // wants no party - but the name is part of what the bill says, and dropping it
  // would leave the purchase reports blank where the supplier used to be. It
  // goes into the note in one fixed shape, and load-shop reads it back with
  // partyNameFromNote() below. These two are a pair; change one and change both.
  const PARTY_NOTE = /^(?:Supplier|Customer): (.+?)(?:\n|$)/;
  const withPartyName = (kind, name, note) => {
    const nm = String(name || '').trim();
    const rest = String(note || '').trim();
    if (!nm) return rest;
    return `${kind === 'supplier' ? 'Supplier' : 'Customer'}: ${nm}` + (rest ? `\n${rest}` : '');
  };
  const partyNameFromNote = (note) => {
    const m = PARTY_NOTE.exec(String(note || ''));
    return m ? m[1].trim() : '';
  };

  // -----------------------------------------------------------------------
  // Trading documents
  // -----------------------------------------------------------------------
  // `lines` come in as { productId, unit, qtyEntered, unitPrice, lineDiscount }
  // and, for a purchase bought at a discount, { listUnitPrice, qtyBase }.
  //
  // THE COMPANY PRICE AND THE DISCOUNT ARE BOTH KEPT, NOT JUST THE RESULT.
  //
  // A purchase at 15% off a company price of 100 used to be sent as a flat 85,
  // and 85 was the only number the books ever held. The shop still SELLS at 100
  // - the discount is the shopkeeper's margin, not the customer's - so a sale
  // screen quoting 85 invites a second 15% off the same goods and turns a
  // margin into a loss.
  //
  // purchase_lines already had somewhere to put both: line_total is a generated
  // column, round(qty_base * unit_price, 2) - line_discount. So the LIST price
  // goes in unit_price, the discount goes in line_discount, and line_total
  // comes out at exactly the net it was before. Valuation, FIFO cost, stock
  // value and what the supplier is owed all read line_total, so not one of them
  // moves - the shop simply now remembers what the company charges.
  //
  // Sales are untouched: a sale passes lineDiscount for its bill discount and
  // no listUnitPrice, so it takes the branch it always did.
  const buildLines = (lines) => Promise.all((lines || []).map(async (l) => {
    const net = Number(l.unitPrice);
    const list = Number(l.listUnitPrice);
    const qtyBase = Number(l.qtyBase);
    const priced = (Number.isFinite(list) && list > net && qtyBase > 0)
      ? { unit_price: list, line_discount: r2((list - net) * qtyBase) }
      : { unit_price: net,  line_discount: r2(l.lineDiscount || 0) };
    return {
      product_id: l.productId,
      unit_id: await unitId(l.unit),
      qty_entered: Number(l.qtyEntered),
      ...priced
    };
  }));

  async function postSale({ date, party, lines, billDiscount = 0, cashPaid = 0, note, key }) {
    return call('post_sale', {
      ...when(date),
      party_id: party || null,
      bill_discount: r2(billDiscount),
      cash_paid: r2(cashPaid),
      note: String(note || ''),
      lines: await buildLines(lines)
    }, key || newKey('sale'));
  }

  async function postPurchase({ date, party, lines, billDiscount = 0, extraCost = 0,
                                cashPaid = 0, note, key }) {
    return call('post_purchase', {
      ...when(date),
      party_id: party || null,
      bill_discount: r2(billDiscount),
      extra_cost: r2(extraCost),
      cash_paid: r2(cashPaid),
      note: String(note || ''),
      lines: await buildLines(lines)
    }, key || newKey('pur'));
  }

  // A return is filed against a LINE, but the document also has to be named. The
  // flat `data` shape the screens read only carries line ids, so the parent is
  // looked up here rather than making every caller remember it.
  async function parentOf(lineId, kind) {
    const table = kind === 'sale_return' ? 'sale_lines' : 'purchase_lines';
    const col   = kind === 'sale_return' ? 'sale_id' : 'purchase_id';
    const rows  = await window.KoshApi.select(table, `id=eq.${lineId}&select=${col}`);
    if (!rows.length) throw new Error('Could not find the original bill for this return.');
    return rows[0][col];
  }

  // A return points at the ORIGINAL line, which is what lets the database give
  // back the cost that line actually consumed instead of guessing today's.
  async function postReturn({ date, kind, party, originalSaleId, originalPurchaseId,
                             lines, refundCash = 0, note, key }) {
    if (!originalSaleId && !originalPurchaseId && lines && lines[0]) {
      const parent = await parentOf(lines[0].originalLineId, kind);
      if (kind === 'sale_return') originalSaleId = parent; else originalPurchaseId = parent;
    }
    return call('post_return', {
      ...when(date),
      kind,                                  // 'sale_return' | 'purchase_return'
      party_id: party || null,
      original_sale_id: originalSaleId || null,
      original_purchase_id: originalPurchaseId || null,
      refund_cash: r2(refundCash),
      note: String(note || ''),
      lines: (lines || []).map((l) => ({
        original_line_id: l.originalLineId,
        qty_base: Number(l.qtyBase),
        unit_price: Number(l.unitPrice)
      }))
    }, key || newKey('ret'));
  }

  // Money against a party's bills. The database allocates it oldest-first and
  // refuses anything above what is owed - the rule you set after the old app
  // let 6,026.22 of overpayments through.
  const recordPayment = ({ date, party, direction, amount, method = 'cash', note, key }) =>
    call('record_payment', {
      ...when(date),
      party_id: party,
      direction,                             // 'in' from a customer, 'out' to a supplier
      amount: r2(amount),
      method,
      note: String(note || '')
    }, key || newKey('pay'));

  const postAdjustment = async ({ date, kind, productId, unit, qtyEntered, unitCost = 0, reason, key }) =>
    call('post_adjustment', {
      ...when(date),
      kind,                                  // 'increase' | 'decrease'
      product_id: productId,
      unit_id: await unitId(unit),
      qty_entered: Number(qtyEntered),
      unit_cost: Number(unitCost || 0),
      note: String(reason || '')
    }, key || newKey('adj'));

  // The screens hold LINE ids (the flat shape they have always read), but a
  // reversal undoes a DOCUMENT. This maps one to the other.
  //
  // Worth being clear about: reversing a line reverses the whole bill it belongs
  // to. A five-line bill with one wrong line comes back entirely, and the bill is
  // re-entered. That is a real change from the old app, which would happily
  // delete one line and leave a bill whose total no longer matched its contents -
  // and those mismatched bills are a large part of what made the old books hard
  // to reconcile.
  async function deleteTransaction(tx) {
    const t = String(tx && tx.type || '');
    if (t === 'capital-in' || t === 'capital-out') {
      return reverse({ type: 'capital_movement', id: tx.id, reason: 'Removed in the app' });
    }
    if (t === 'adjustment') {
      return reverse({ type: 'adjustment', id: tx.id, reason: 'Removed in the app' });
    }
    if (t === 'sale' || t === 'purchase') {
      const kind = t === 'sale' ? 'sale_return' : 'purchase_return';
      const doc  = await parentOf(tx.id, kind);
      return reverse({ type: t, id: doc, reason: 'Removed in the app' });
    }
    if (t === 'return') {
      // returnGroupId is the return DOCUMENT the line belongs to; tx.id is the
      // line. Reversing puts the goods back where they were before the return
      // and undoes the refund or the credit note it raised.
      const doc = tx.returnGroupId || (await parentOfReturnLine(tx.id));
      return reverse({ type: 'return', id: doc, reason: 'Removed in the app' });
    }
    throw new Error(`Cannot remove a "${t}" entry.`);
  }

  // -----------------------------------------------------------------------
  // Editing
  // -----------------------------------------------------------------------
  // An edit is a reversal plus a repost, done by the database in one
  // transaction (edit_document, 29_edit_documents.sql). Nothing here decides
  // anything financial: it rebuilds the WHOLE document as it should now read
  // and hands it over. Stock, cash, the party's due, profit and every report
  // follow from the rows those two documents write, so they all move together.
  //
  // Why the whole document and not just the line: a bill's total IS its lines.
  // The screens edit one line, so the untouched lines are read back from the
  // database and sent again unchanged - which is also what stops an edit from
  // quietly turning a five-line bill into a one-line bill.
  const DOC_SHAPE = {
    sale:     { doc: 'sales',     lines: 'sale_lines',     fk: 'sale_id' },
    purchase: { doc: 'purchases', lines: 'purchase_lines', fk: 'purchase_id' },
    return:   { doc: 'returns',   lines: 'return_lines',   fk: 'return_id' }
  };

  async function parentOfReturnLine(lineId) {
    const rows = await window.KoshApi.select('return_lines', `id=eq.${lineId}&select=return_id`);
    if (!rows.length) throw new Error('Could not find the return this line belongs to.');
    return rows[0].return_id;
  }

  // Signed cash for a document: positive when money came IN.
  async function documentCash(table, id) {
    const rows = await window.KoshApi.select('cash_ledger',
      `source_table=eq.${table}&source_id=eq.${id}&select=direction,amount`);
    return r2(rows.reduce((s, c) => s + (c.direction === 'in' ? num(c.amount) : -num(c.amount)), 0));
  }

  // What was settled at the counter stays settled, as far as the new total
  // allows. A bill paid in full stays paid in full; a part-paid bill keeps what
  // was paid unless the correction makes the bill smaller than that.
  const carryCash = (prevPaid, prevTotal, newTotal) =>
    prevPaid >= prevTotal - 0.001 ? r2(newTotal) : r2(Math.min(prevPaid, newTotal));

  async function loadDocument(type, docId) {
    const shape = DOC_SHAPE[type];
    const [docs, lines] = await Promise.all([
      window.KoshApi.select(shape.doc, `id=eq.${docId}&select=*`),
      window.KoshApi.select(shape.lines, `${shape.fk}=eq.${docId}&select=*&order=line_no`)
    ]);
    if (!docs.length) throw new Error('That entry is no longer in the books.');
    if (docs[0].status !== 'posted') {
      throw new Error('That entry has already been reversed, so it cannot be edited.');
    }
    if (!lines.length) throw new Error('That entry has no items to edit.');
    return { doc: docs[0], lines };
  }

  // `patch` describes the ONE line the screen edited, plus anything document-
  // level the screen let the user change:
  //   { lineId, productId, unit, qtyEntered, qtyBase, unitPrice, lineDiscount,
  //     date, party, extraCost, note, reason }
  // unitPrice is per BASE unit, matching what post_sale/post_purchase store.
  async function editTransaction(tx, patch = {}) {
    const type = String(tx && tx.type || '');
    if (!DOC_SHAPE[type]) {
      throw new Error(`A "${type || 'this'}" entry cannot be edited yet.`);
    }
    const lineId = patch.lineId || tx.id;
    const docId = type === 'return'
      ? (tx.returnGroupId || await parentOfReturnLine(lineId))
      : await parentOf(lineId, type === 'sale' ? 'sale_return' : 'purchase_return');

    const { doc, lines } = await loadDocument(type, docId);
    const date = patch.date || doc.business_date;
    const isEdited = (l) => String(l.id) === String(lineId);
    if (!lines.some(isEdited)) {
      throw new Error('That item is no longer part of this bill.');
    }

    // ---- returns ---------------------------------------------------------
    if (type === 'return') {
      const outLines = lines.map((l) => ({
        original_line_id: l.original_sale_line_id || l.original_purchase_line_id,
        qty_base: isEdited(l) ? Number(patch.qtyBase) : num(l.qty_base),
        unit_price: isEdited(l) ? Number(patch.unitPrice) : num(l.unit_price)
      }));
      const oldTotal = lines.reduce((s, l) => s + num(l.line_total), 0);
      const newTotal = r2(outLines.reduce((s, l) => s + r2(l.qty_base * l.unit_price), 0));
      // A sale return pays money OUT, a purchase return takes it IN; either way
      // the refund already made is a positive amount of cash that moved.
      const prevRefund = Math.abs(await documentCash('returns', docId));

      return window.KoshApi.rpc('edit_document', {
        p_shop: writeShop(),
        p_type: 'return',
        p_id: docId,
        p_reason: String(patch.reason || 'Corrected in the app'),
        p_payload: {
          idempotency_key: patch.key || newKey('edit-ret'),
          ...when(date),
          kind: doc.kind,
          party_id: doc.party_id || null,
          original_sale_id: doc.original_sale_id || null,
          original_purchase_id: doc.original_purchase_id || null,
          refund_cash: carryCash(prevRefund, r2(oldTotal), newTotal),
          note: patch.note != null ? String(patch.note) : (doc.note || ''),
          lines: outLines
        }
      });
    }

    // ---- sales and purchases --------------------------------------------
    const outLines = await Promise.all(lines.map(async (l) => {
      const edited = isEdited(l);
      const unitName = edited ? (patch.unit || l.unit_name) : l.unit_name;
      return {
        product_id: edited ? patch.productId : l.product_id,
        unit_id: await unitId(unitName),
        qty_entered: edited ? Number(patch.qtyEntered) : num(l.qty_entered),
        qty_base_hint: edited ? Number(patch.qtyBase) : num(l.qty_base),
        unit_price: edited ? Number(patch.unitPrice) : num(l.unit_price),
        line_discount: edited ? r2(patch.lineDiscount || 0) : r2(l.line_discount)
      };
    }));
    // Only for the cash arithmetic below - the database recomputes every total
    // from the lines it is given, and qty_base_hint is dropped before sending.
    const newGross = r2(outLines.reduce(
      (s, l) => s + r2(r2(l.qty_base_hint * l.unit_price) - l.line_discount), 0));
    const oldGross = r2(lines.reduce((s, l) => s + num(l.line_total), 0));
    const discount = r2(doc.bill_discount);
    const payload = {
      idempotency_key: patch.key || newKey('edit-' + type),
      ...when(date),
      party_id: patch.party !== undefined ? (patch.party || null) : (doc.party_id || null),
      bill_discount: discount,
      note: patch.note != null ? String(patch.note) : (doc.note || ''),
      lines: outLines.map(({ qty_base_hint, ...line }) => line)
    };

    if (type === 'sale') {
      const prevPaid = await documentCash('sales', docId);
      payload.cash_paid = carryCash(prevPaid, r2(oldGross - discount), r2(newGross - discount));
    } else {
      // A purchase's cash row is goods + carrying, and the supplier is never
      // owed the carrying (28_extra_cost_is_cash.sql). Split them back apart
      // before deciding what is still paid, or the freight would be counted as
      // money paid against the goods.
      const extra = patch.extraCost != null ? r2(patch.extraCost) : r2(doc.extra_cost);
      const prevPaid = r2(Math.abs(await documentCash('purchases', docId)) - num(doc.extra_cost));
      payload.extra_cost = extra;
      payload.cash_paid = carryCash(Math.max(0, prevPaid),
                                    r2(oldGross - discount), r2(newGross - discount));
    }

    return window.KoshApi.rpc('edit_document', {
      p_shop: writeShop(),
      p_type: type,
      p_id: docId,
      p_reason: String(patch.reason || 'Corrected in the app'),
      p_payload: payload
    });
  }

  // The single-row documents. Same rule, less arithmetic: there are no lines to
  // rebuild, so the screen's own fields ARE the corrected document.
  // `summary` is the note of what changed, shown under the corrected row
  // afterwards. It is separate from the document's own note or reason, which is
  // what the entry says about itself.
  const editOne = (type, id, payload, summary, keyName) =>
    window.KoshApi.rpc('edit_document', {
      p_shop: writeShop(),
      p_type: type,
      p_id: id,
      p_reason: String(summary || 'Corrected in the app'),
      p_payload: { idempotency_key: newKey(keyName), ...payload }
    });

  const editExpense = ({ id, date, amount, note, summary }) =>
    editOne('expense', id,
            { ...when(date), amount: r2(amount), note: String(note || '') },
            summary, 'edit-exp');

  const editWithdrawal = ({ id, date, amount, reason, summary }) =>
    editOne('cash_withdrawal', id,
            { ...when(date), amount: r2(amount), reason: String(reason || '') },
            summary, 'edit-wd');

  // A payment row on screen can be one SLICE of a payment that settled several
  // bills (load-shop.js splits them as `paymentId:0`, `paymentId:1`), and it is
  // the whole payment that gets corrected. Editing 2,000 of a 5,000 payment
  // would otherwise silently rewrite all 5,000.
  const paymentDocId = (id) => String(id || '').split(':')[0];

  const editPayment = ({ id, date, party, direction, amount, method = 'cash', note, summary }) =>
    editOne('payment', paymentDocId(id), {
      ...when(date),
      party_id: party,
      direction,                             // 'in' from a customer, 'out' to a supplier
      amount: r2(amount),
      method,
      note: String(note || '')
    }, summary, 'edit-pay');

  const editAdjustment = async ({ id, date, kind, productId, unit, qtyEntered,
                                 unitCost = 0, reason, summary }) =>
    editOne('adjustment', id, {
      ...when(date),
      kind,
      product_id: productId,
      unit_id: await unitId(unit),
      qty_entered: Number(qtyEntered),
      unit_cost: Number(unitCost || 0),
      note: String(reason || '')
    }, summary, 'edit-adj');

  const deleteSale     = (id, reason) => reverse({ type: 'sale', id, reason });
  const deletePurchase = (id, reason) => reverse({ type: 'purchase', id, reason });
  const deletePayment  = (id, reason) =>
    reverse({ type: 'payment', id: String(id || '').split(':')[0], reason });

  // -----------------------------------------------------------------------
  // Master data
  // -----------------------------------------------------------------------
  // Goes through create_product() rather than a plain insert. The product row
  // and its base-unit conversion have to exist together: a product without that
  // conversion is one the database cannot price, so it saves fine and then
  // refuses every line ever entered against it. One function, one transaction,
  // no way to do half of it.
  async function addProduct({ name, unit, category }) {
    return window.KoshApi.rpc('create_product', {
      p_shop: writeShop(),
      p_name: String(name || '').trim(),
      p_unit_id: await unitId(unit),
      p_category: String(category || '').trim()
    });
  }

  // -----------------------------------------------------------------------
  // Shop lifecycle
  // -----------------------------------------------------------------------
  // Everything one shop holds, as a single JSON document. Membership is checked
  // inside the function, so this cannot be used to read somebody else's books.
  const exportShop = (shopId) =>
    window.KoshApi.rpc('export_shop_data', { p_shop: shopId || shop() });

  // The mirror of exportShop: the file goes back in as it came out. The server
  // refuses anything but an empty set of books, so this cannot land on top of
  // entries that are already there.
  const restoreShop = (shopId, payload) =>
    (assertOnline(), window.KoshApi.rpc('restore_shop_data', { p_shop: shopId || shop(), p_payload: payload }));

  const createShop  = (name) =>
    (assertOnline(), window.KoshApi.rpc('create_additional_shop', { p_name: String(name || 'KoshAgar') }));
  const archiveShop = (shopId, note) =>
    (assertOnline(), window.KoshApi.rpc('archive_shop', { p_shop: shopId, p_note: String(note || '') }));
  const unarchiveShop = (shopId) =>
    (assertOnline(), window.KoshApi.rpc('unarchive_shop', { p_shop: shopId }));

  // The only true delete in the system. It refuses unless the shop is archived,
  // the caller owns it, they still have another active shop, and the export
  // phrase is passed word for word.
  // purge_old_shop wraps it with one more refusal: the NEWEST archive cannot go,
  // because that is the one a mistaken reset is recovered from.
  const purgeShop = (shopId) =>
    (assertOnline(), window.KoshApi.rpc('purge_old_shop', {
      p_shop: shopId, p_confirm_export: 'I HAVE EXPORTED THIS SHOP'
    }));

  // The shop's own row. Master data, so RLS decides (owner only) rather than a
  // posting function - there is no money in a shop name.
  const updateShop = (patch) =>
    (assertOnline(), window.KoshApi.update('shops', `id=eq.${shop()}`, {
      name: String(patch.name || '').trim(),
      address: String(patch.address || ''),
      phone: String(patch.phone || '')
    }));

  // Filing a SETTLED bill away from the active due list. Not a deletion and not
  // a reversal: the bill and its payments stay exactly as they are, and the
  // database refuses to archive one that is still owed.
  const archiveBill = (billId, reason) =>
    window.KoshApi.rpc('archive_party_bill', {
      p_shop: writeShop(), p_bill: billId, p_reason: String(reason || '')
    });
  const unarchiveBill = (billId) =>
    window.KoshApi.rpc('unarchive_party_bill', { p_shop: writeShop(), p_bill: billId });

  const updateProduct = (id, patch) =>
    window.KoshApi.update('products', `id=eq.${id}&shop_id=eq.${shop()}`, patch);

  // A product that has ever moved is never deleted - the history points at it.
  // Deactivating hides it from entry screens and leaves every past document
  // readable, which is what "no silent delete" has to mean in practice.
  const deactivateProduct = (id) => updateProduct(id, { is_active: false });

  return {
    newKey, shop,
    addExpense, addWithdrawal, addCapital, postLoan, setOpeningCash,
    reverse, deleteExpense, deleteWithdrawal, deleteCapital,
    updateShop, archiveBill, unarchiveBill,
    ensureConversion, ensureLineConversions,
    exportShop, restoreShop, createShop, archiveShop, unarchiveShop, purgeShop,
    addProduct, updateProduct, deactivateProduct,
    unitId, forgetUnits, findOrCreateParty, parentOf,
    withPartyName, partyNameFromNote,
    postSale, postPurchase, postReturn, recordPayment, postAdjustment,
    deleteSale, deletePurchase, deletePayment, deleteTransaction,
    editTransaction, editExpense, editWithdrawal, editAdjustment, editPayment,
    parentOfReturnLine
  };
})();
