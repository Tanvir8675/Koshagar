// modules/invoice.js — Invoice building / rendering / printing
// Phase 3 extraction. Classic script sharing index.html's global scope; loaded
// after the main script. Runtime-only (invoked from buttons), so load order is
// safe. Depends on globals: data, dateToYMDLocal, todayStr, makeTimeId,
// getTxCustomerName, getTxSupplierName, normalizePhone, round2,
// getDisplayUnitPrice, getShopName, getShopAddress, getShopMobile, getProd,
// fmt, toast, activeInvoiceHtml.

function buildInvoiceNo(tx) {
  if(tx?.billId) return `INV-${String(tx.billId).replace(/\s+/g,'')}`;
  const dt = dateToYMDLocal(tx?.date || new Date()) || todayStr();
  return `INV-${dt.replace(/-/g,'')}-${String(tx?.id || makeTimeId())}`;
}

function getInvoiceLinesForTx(tx) {
  if(!tx) return [];
  if(tx.billId && (tx.type === 'sale' || tx.type === 'purchase')) {
    return (data.transactions || [])
      .filter(t => t.type === tx.type && String(t.billId || '') === String(tx.billId))
      .sort((a,b)=>(Number(a.id)||0)-(Number(b.id)||0));
  }
  return [tx];
}

function buildInvoicePayloadFromTx(tx) {
  const lines = getInvoiceLinesForTx(tx);
  if(!lines.length) return null;
  const first = lines[0];
  const type = first.type === 'purchase' ? 'purchase' : 'sale';
  const customerName = type === 'sale' ? getTxCustomerName(first) : '';
  const customerPhone = type === 'sale' ? normalizePhone(first.customerPhone || '') : '';
  const supplierName = type === 'purchase' ? getTxSupplierName(first) : '';
  const derivedTotal = round2(lines.reduce((s,l)=>s+(Number(l.total)||0),0));
  const derivedSubTotal = round2(lines.reduce((s,l)=>s + round2((Number(getDisplayUnitPrice(l)) || 0) * (Number(l.qty) || 0)), 0));
  const hasBillMeta = !!first.billId &&
    Number.isFinite(Number(first.billGrossTotal)) &&
    Number.isFinite(Number(first.billDiscountTotal)) &&
    Number.isFinite(Number(first.billNetTotal));
  const hasPaidMeta = hasBillMeta && Number.isFinite(Number(first.billPaidTotal));
  const subTotal = hasBillMeta ? round2(Number(first.billGrossTotal) || 0) : derivedSubTotal;
  const discount = hasBillMeta ? round2(Math.max(0, Number(first.billDiscountTotal) || 0)) : round2(Math.max(0, derivedSubTotal - derivedTotal));
  const total = hasBillMeta ? round2(Number(first.billNetTotal) || 0) : derivedTotal;
  const costTotal = type === 'sale'
    ? round2(lines.reduce((s,l)=>s + round2((Number(l.cost)||0) * (Number(l.qty)||0)), 0))
    : round2(lines.reduce((s,l)=>s + round2((Number(l.price)||0) * (Number(l.qty)||0)), 0));
  const profit = type === 'sale' ? round2(total - costTotal) : 0;
  let paid = hasPaidMeta ? round2(Number(first.billPaidTotal) || 0) : round2(lines.reduce((s,l)=>s + (Number(l.cashPaid)||0),0));
  if(Math.abs(total - paid) <= 0.1) paid = total;
  const due = Math.max(0, round2(total - paid));
  const date = dateToYMDLocal(first.date) || todayStr();
  const time = new Date(first.date || Date.now()).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'});
  return {
    invoiceNo: buildInvoiceNo(first),
    type,
    billId: first.billId || '',
    date,
    time,
    customerName,
    customerPhone,
    supplierName,
    lines,
    subTotal,
    discount,
    total,
    paid,
    due,
    profit
  };
}

function renderInvoiceHtml(inv) {
  if(!inv) return '';
  const shopName = getShopName();
  const shopAddress = getShopAddress();
  const shopMobile = getShopMobile();
  const rows = inv.lines.map((l, i) => {
    const p = getProd(l.productId);
    const unitPrice = round2(Number(getDisplayUnitPrice(l)) || 0);
    const grossLineTotal = round2((Number(l.qty) || 0) * unitPrice);
    return `<tr>
      <td style="padding:6px;border:1px solid #222;vertical-align:top">${i+1}</td>
      <td style="padding:6px;border:1px solid #222;vertical-align:top">${p?.name || '?'}</td>
      <td style="padding:6px;border:1px solid #222;vertical-align:top;text-align:center">${round2(l.qty)} ${p?.unit || ''}</td>
      <td style="padding:6px;border:1px solid #222;vertical-align:top;text-align:right">${fmt(unitPrice)}</td>
      <td style="padding:6px;border:1px solid #222;vertical-align:top;text-align:right;font-weight:700">${fmt(grossLineTotal)}</td>
    </tr>`;
  }).join('');
  const partyTitle = inv.type === 'sale' ? 'Invoice To' : 'Vendor';
  const partyName = inv.type === 'sale' ? (inv.customerName || 'Walk-in') : (inv.supplierName || 'Unknown Supplier');
  const partyPhone = inv.type === 'sale' ? (inv.customerPhone || '') : '';
  return `<div id="printInvoiceRoot" style="font-family:Outfit,sans-serif;color:#111;padding:2px 10px 8px;border-top:4px solid #111">
    <div style="text-align:center;font-size:1.55rem;letter-spacing:2.6px;font-weight:700;margin:2px 0 3px">INVOICE</div>
    <div style="text-align:center;font-size:2rem;font-weight:800;text-decoration:underline;line-height:1.08">${shopName}</div>
    <div style="text-align:center;font-size:0.78rem;color:#555;margin:4px 0 10px">${shopAddress ? `Address: ${shopAddress}` : ''}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px">
      <div style="border:1px solid #222;padding:8px 10px;font-size:0.9rem;line-height:1.38;border-radius:4px;background:#fcfcfc">
        <div style="font-weight:700;margin-bottom:2px">${partyTitle}</div>
        <div><span style="color:#666">Name:</span> ${partyName}</div>
        <div><span style="color:#666">Address:</span> </div>
      </div>
      <div style="border:1px solid #222;padding:8px 10px;font-size:0.9rem;line-height:1.38;border-radius:4px;background:#fcfcfc">
        <div><span style="color:#666">Invoice ID:</span> ${inv.invoiceNo}</div>
        <div><span style="color:#666">Bill ID:</span> ${inv.billId || '-'}</div>
        <div><span style="color:#666">Date:</span> ${inv.date}</div>
        <div><span style="color:#666">Mobile:</span> ${shopMobile || '-'}</div>
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:0.91rem">
      <thead>
        <tr>
          <th style="text-align:center;padding:6px;border:1px solid #222;width:54px;background:#efefef">SL. No</th>
          <th style="text-align:center;padding:6px;border:1px solid #222;background:#efefef">Product Name</th>
          <th style="text-align:center;padding:6px;border:1px solid #222;width:120px;background:#efefef">Qty</th>
          <th style="text-align:center;padding:6px;border:1px solid #222;width:140px;background:#efefef">Unit Price</th>
          <th style="text-align:center;padding:6px;border:1px solid #222;width:140px;background:#efefef">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:10px;gap:12px">
      <div style="font-size:0.9rem;min-width:260px">
        Signature: __________________
      </div>
      <div style="min-width:310px;font-size:0.9rem;line-height:1.38;border:1px solid #222;border-radius:4px;padding:8px 10px;background:#fafafa">
        <div style="display:flex;justify-content:space-between"><span>Sub Total:</span><span style="font-weight:700">${fmt(inv.subTotal || inv.total)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>Discount:</span><span>${fmt(inv.discount || 0)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>Total after discount:</span><span style="font-weight:700">${fmt(inv.total)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>Paid:</span><span>${fmt(inv.paid)}</span></div>
        <div style="display:flex;justify-content:space-between;border-top:1px dashed #bbb;margin-top:4px;padding-top:4px"><span style="font-weight:700">Due:</span><span style="font-weight:800">${fmt(inv.due)}</span></div>
      </div>
    </div>
  </div>`;
}

function openInvoiceFromTx(txId) {
  toast('ℹ️ Invoice printing is not available in this version.');
  return;
}

function openInvoiceFromGroup(mode, billId, seedTxId) {
  toast('ℹ️ Invoice printing is not available in this version.');
  return;
}

function closeInvoiceModal() {
  document.getElementById('invoiceModalOverlay').classList.remove('active');
  document.getElementById('invoiceModal').style.display = 'none';
}

function printInvoice() {
  if(!activeInvoiceHtml) { toast('⚠️ No invoice to print'); return; }
  const w = window.open('', '_blank');
  if(!w) { toast('⚠️ Your browser blocked the print window. Please allow pop-ups and try again.'); return; }
  w.document.write(`<html><head><title>Invoice</title>
    <style>
      @page { size: A4 portrait; margin: 10mm; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body { font-family: Outfit, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      #printInvoiceRoot {
        width: 190mm;
        min-height: 0;
        margin: 0 auto;
        box-sizing: border-box;
      }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }
    </style>
  </head><body>${activeInvoiceHtml}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}
