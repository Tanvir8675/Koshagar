// modules/invoice.js - Invoice building / rendering / printing
// Classic script sharing index.html's global scope.

// WHAT THE PRINTED INVOICE IS NUMBERED.
//
// The database numbers documents by kind: sales are INV-2026-000004, purchases
// are PUR-2026-000002. On a printed invoice those two read as unrelated series,
// and the sale's number does not say what it is.
//
// So the printed number carries both: what the paper is (INV) and what it is
// for (SEL / PUR).
//
//   INV-2026-000004  ->  INV-SEL-2026-000004
//   PUR-2026-000002  ->  INV-PUR-2026-000002
//
// The stored number is untouched - the transaction rows, the search and every
// record still show the document's own number. This is the letterhead, not the
// identity.
function buildInvoiceNo(tx) {
  // The same rule the transaction rows and the credit page use; see
  // displayBillNo() in index.html. One document, one number, every screen.
  if(tx?.billId) return displayBillNo(tx.billId);
  const dt = dateToYMDLocal(tx?.date || new Date()) || todayStr();
  return `INV-${dt.replace(/-/g, '')}-${String(tx?.id || makeTimeId())}`;
}

function getInvoiceLinesForTx(tx) {
  if(!tx) return [];
  if(tx.billId && (tx.type === 'sale' || tx.type === 'purchase')) {
    return (data.transactions || [])
      .filter(t => t.type === tx.type && String(t.billId || '') === String(tx.billId))
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  }
  return [tx];
}

// How one invoice line should be PRESENTED.
//
// A line's money is authoritative as a TOTAL — never as a per-unit rate. Printing
// `qty × round2(unitPrice)` re-derives the total from a rounded rate and loses
// money: 1 COIL = 109 pcs sold for 3200 → 29.357798/pc → 29.36 → ×109 = 3200.24,
// which then shows up as a phantom 0.24 "discount". So: take the stored exact
// total, present the qty in the unit actually transacted in (1 COIL, not 109 PCS),
// and derive the rate from total ÷ that qty — which makes the printed
// Qty × Unit Price = Total reconcile exactly for converted lines.
function getInvoiceLineView(l) {
  const p = getProd(l.productId);
  const lineTotal = round2(Number(getDisplayLineTotal(l)) || 0);
  const entryFactor = Number(l.entryFactor);
  const entryQty = Number(l.entryQty);
  const usesEntryUnit = !!l.entryUnit && entryFactor > 0 && entryQty > 0;
  const qty = usesEntryUnit ? entryQty : round2(Number(l.qty) || 0);
  const unit = usesEntryUnit ? String(l.entryUnit) : (p?.unit || '');
  const baseUnit = p?.unit || '';
  const baseQty = round2(Number(l.qty) || 0);
  return {
    name: p?.name || '?',
    qty,
    unit,
    // "1 COIL (109 PCS)" so the stock unit stays visible on the printed invoice.
    qtyLabel: (usesEntryUnit && unit !== baseUnit)
      ? `${qty} ${unit} (${baseQty} ${baseUnit})`.trim()
      : `${qty} ${unit}`.trim(),
    unitPrice: qty > 0 ? round2(lineTotal / qty) : 0,
    lineTotal
  };
}

function getTxCustomerPhoneForInvoice(tx) {
  const direct = normalizePhone(tx?.customerPhone || '');
  if(direct) return direct;
  let credit = (data.credits || []).find(c => String(c.txId) === String(tx?.id));
  if(!credit && tx?.billId) {
    credit = (data.credits || []).find(c => String(c.billId || '') === String(tx.billId));
  }
  if(!credit) {
    credit = (data.credits || []).find(c => Array.isArray(c.txIds) && c.txIds.some(id => String(id) === String(tx?.id)));
  }
  return normalizePhone(credit?.customerPhone || '');
}

function getTxSupplierPhoneForInvoice(tx) {
  const direct = normalizePhone(tx?.supplierPhone || '');
  if(direct) return direct;
  let sc = (data.supplierCredits || []).find(s => String(s.txId) === String(tx?.id));
  if(!sc && tx?.billId) {
    sc = (data.supplierCredits || []).find(s => String(s.billId || '') === String(tx.billId));
  }
  if(!sc) {
    sc = (data.supplierCredits || []).find(s => Array.isArray(s.txIds) && s.txIds.some(id => String(id) === String(tx?.id)));
  }
  return normalizePhone(sc?.supplierPhone || '');
}

function buildInvoicePayloadFromTx(tx) {
  const lines = getInvoiceLinesForTx(tx);
  if(!lines.length) return null;

  const first = lines[0];
  const type = first.type === 'purchase' ? 'purchase' : 'sale';
  const customerName = type === 'sale' ? getTxCustomerName(first) : '';
  const customerPhone = type === 'sale' ? getTxCustomerPhoneForInvoice(first) : '';
  const supplierName = type === 'purchase' ? getTxSupplierName(first) : '';
  const supplierPhone = type === 'purchase' ? getTxSupplierPhoneForInvoice(first) : '';
  // A DISCOUNT GIVEN ON THE WHOLE BILL IS NOT ON ANY LINE.
  //
  // It lives on the document header (sales.bill_discount / purchases.
  // bill_discount) and the lines know nothing about it. Adding the lines up and
  // calling that the total printed an invoice that claimed a debt the customer
  // did not have: 100 of goods, 90 paid, and the 10 that was DISCOUNTED shown
  // as "Due". The database had already settled the bill in full - post_sale
  // charges gross minus the discount and raises no receivable when it is paid.
  //
  // Counted once per bill: every row carries the same header figure, so summing
  // it row by row would multiply it by the number of items.
  const headerDiscount = round2(Number(first.docBillDiscount) || 0);
  const derivedTotal = round2(Math.max(0,
    lines.reduce((s, l) => s + (Number(l.total) || 0), 0) - headerDiscount));
  // Sum the SAME numbers the table prints, so the rows always add up to Sub Total.
  // (Was `qty × rounded unit price`, which drifted from the printed totals and
  // manufactured a fake discount on bills that had none.)
  const derivedSubTotal = round2(lines.reduce((s, l) => s + getInvoiceLineView(l).lineTotal, 0));
  const subTotal = derivedSubTotal;
  // Both kinds of discount at once: what came off the lines, and what came off
  // the bill. The gap between what the rows print and what the bill came to IS
  // the discount, whichever way it was given.
  //
  // A purchase gets the same treatment now. It was hardcoded to zero, so a
  // discounted purchase invoice showed a sub total and a total that did not
  // agree and nothing in between to explain the gap.
  const discount = round2(Math.max(0, derivedSubTotal - derivedTotal));
  const total = derivedTotal;
  let paid = round2(lines.reduce((s, l) => s + (Number(l.cashPaid) || 0), 0));
  if(Math.abs(total - paid) <= 0.1) paid = total;
  const due = Math.max(0, round2(total - paid));
  const date = dateToYMDLocal(first.date) || todayStr();
  const dateTime = formatInvoiceDateTime(first.date || date);

  return {
    invoiceNo: buildInvoiceNo(first),
    type,
    billId: first.billId || '',
    date,
    dateTime,
    customerName,
    customerPhone,
    supplierName,
    supplierPhone,
    lines,
    subTotal,
    discount,
    total,
    paid,
    due
  };
}

function formatInvoiceDateTime(dateLike) {
  const date = new Date(dateLike || Date.now());
  if(Number.isNaN(date.getTime())) return '';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  let hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, '0');
  const ampm = hour >= 12 ? 'pm' : 'am';
  hour = hour % 12 || 12;
  return `${dd}-${mm}-${yyyy} ${hour}:${minute}${ampm}`;
}

function renderInvoiceHtml(inv) {
  if(!inv) return '';
  const shopName = getShopName();
  const shopAddress = getShopAddress();
  const shopMobile = getShopMobile();
  const logoSrc = new URL('./icons/icon_192.png', window.location.href).href;
  const partyName = inv.type === 'sale' ? (inv.customerName || 'Walk-in') : (inv.supplierName || 'Unknown Supplier');
  const partyPhone = inv.type === 'sale' ? (inv.customerPhone || '') : (inv.supplierPhone || '');
  const rows = inv.lines.map((l, i) => {
    const v = getInvoiceLineView(l);
    return `<tr>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;text-align:center;vertical-align:middle">${i + 1}</td>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;vertical-align:middle">${escapeHtml(v.name)}</td>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;text-align:center;vertical-align:middle">${escapeHtml(v.qtyLabel)}</td>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;text-align:center;vertical-align:middle">${fmt(v.unitPrice)}</td>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;text-align:center;vertical-align:middle">${fmt(v.lineTotal)}</td>
    </tr>`;
  }).join('');
  return `<div id="printInvoiceRoot" style="font-family:Arial, Helvetica, sans-serif;color:#000;background:#fff;width:190mm;min-height:270mm;margin:0 auto;box-sizing:border-box;padding:22mm 18mm 18mm">
    <div style="display:grid;grid-template-columns:40mm 1fr 40mm;align-items:start;margin-bottom:6mm">
      <div><img src="${logoSrc}" alt="Logo" style="display:block;width:32mm;height:32mm;object-fit:contain"></div>
      <div style="text-align:center;font-size:26px;font-weight:700;letter-spacing:3px;text-decoration:underline;text-underline-offset:4px;margin-top:6mm">INVOICE</div>
      <div></div>
    </div>

    <table style="border-collapse:collapse;font-size:12px;margin-bottom:0;width:60mm">
      <tr>
        <td style="border:1px solid #111;width:30mm;padding:3px 6px">Invoice ID:</td>
        <td style="border:1px solid #111;width:30mm;padding:3px 6px">Date:</td>
      </tr>
      <tr>
        <td style="border:1px solid #111;padding:3px 6px">${escapeHtml(inv.invoiceNo)}</td>
        <td style="border:1px solid #111;padding:3px 6px">${escapeHtml(inv.dateTime || inv.date)}</td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8mm">
      <tr>
        <td style="border:1px solid #111;width:50%;padding:3px 6px;vertical-align:top">
          <div>Bill to:</div>
          <div>Customer Name: ${escapeHtml(partyName)}</div>
          <div>Address</div>
          <div>Mobile No: ${escapeHtml(partyPhone || '')}</div>
        </td>
        <td style="border:1px solid #111;width:50%;padding:3px 6px;vertical-align:top">
          <div style="text-decoration:underline">${escapeHtml(shopName)}</div>
          <div>Address: ${escapeHtml(shopAddress || '')}</div>
          <div>Mobile No: ${escapeHtml(shopMobile || '')}</div>
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr>
          <th style="text-align:center;padding:3px;border:1px solid #111;width:12mm;font-weight:400">Ser<br>No</th>
          <th style="text-align:center;padding:3px;border:1px solid #111;font-weight:400">Product Name</th>
          <th style="text-align:center;padding:3px;border:1px solid #111;width:30mm;font-weight:400">Qty</th>
          <th style="text-align:center;padding:3px;border:1px solid #111;width:30mm;font-weight:400">Unit Price<br>(BDT)</th>
          <th style="text-align:center;padding:3px;border:1px solid #111;width:30mm;font-weight:400">Total<br>(BDT)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="display:grid;grid-template-columns:1fr 50mm;margin-top:10mm">
      <div></div>
      <div style="border:1px solid #111;font-size:12px;padding:4px 7px;line-height:1.42">
        <div>Sub Total: ${fmt(inv.subTotal || inv.total)}</div>
        <div>Discount: ${fmt(inv.discount || 0)}</div>
        <div>Total after Discount: ${fmt(inv.total)}</div>
        <div>Paid: ${fmt(inv.paid)}</div>
        <div>Due: ${fmt(inv.due)}</div>
      </div>
    </div>

    <div style="margin-top:20mm;font-size:12px;width:36mm;text-align:left">
      <div style="border-top:2px solid #111;width:34mm;margin-bottom:2mm"></div>
      <div>Authorized Signature</div>
    </div>
  </div>`;
}

function showInvoice(inv) {
  if(!inv) { toast('No invoice to print'); return; }
  activeInvoiceHtml = renderInvoiceHtml(inv);
  const overlay = document.getElementById('invoiceModalOverlay');
  const modal = document.getElementById('invoiceModal');
  const sub = document.getElementById('invoiceModalSub');
  const preview = document.getElementById('invoicePreview');
  if(sub) sub.textContent = `${inv.invoiceNo} - ${inv.dateTime || inv.date}`;
  if(preview) preview.innerHTML = activeInvoiceHtml;
  if(overlay) overlay.classList.add('active');
  if(modal) modal.style.display = 'block';
}

function openInvoiceFromTx(txId) {
  const tx = (data.transactions || []).find(t => String(t.id) === String(txId));
  showInvoice(buildInvoicePayloadFromTx(tx));
}

function openInvoiceFromGroup(mode, billId, seedTxId) {
  const tx = (data.transactions || []).find(t =>
    String(t.billId || '') === String(billId || '') &&
    (!mode || String(t.type) === String(mode))
  ) || (data.transactions || []).find(t => String(t.id) === String(seedTxId));
  showInvoice(buildInvoicePayloadFromTx(tx));
}

function closeInvoiceModal() {
  document.getElementById('invoiceModalOverlay').classList.remove('active');
  document.getElementById('invoiceModal').style.display = 'none';
}

function printInvoice() {
  if(!activeInvoiceHtml) { toast('No invoice to print'); return; }
  const w = window.open('', '_blank');
  if(!w) { toast('Your browser blocked the print window. Please allow pop-ups and try again.'); return; }
  w.document.write(`<html><head><title>Invoice</title>
    <style>
      @page { size: A4 portrait; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body { font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }
    </style>
  </head><body>${activeInvoiceHtml}</body></html>`);
  w.document.close();

  // THE LOGO WENT MISSING FROM EVERY PRINTED INVOICE.
  //
  // print() was called on the line after document.close(), and the print dialog
  // captures the page as it stands at that instant. The logo is an <img> with a
  // URL - in the new window it has not been fetched yet, so what got printed was
  // the empty box where it was going to be. On screen it looked right, because
  // by then it had loaded.
  //
  // So: wait for every image to finish, then print. An image that FAILS resolves
  // too - a missing logo is not a reason to refuse to print an invoice - and the
  // whole wait is capped, so a hung request cannot leave the window sitting
  // there with no dialog and no explanation.
  const ready = Array.from(w.document.images).map((img) =>
    (img.complete && img.naturalWidth > 0)
      ? Promise.resolve()
      : new Promise((done) => {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }));

  Promise.race([
    Promise.all(ready),
    new Promise((done) => setTimeout(done, 3000))
  ]).then(() => {
    try { w.focus(); w.print(); } catch (_) { /* the window was closed by hand */ }
  });
}
