// modules/invoice.js - Invoice building / rendering / printing
// Classic script sharing index.html's global scope.

function buildInvoiceNo(tx) {
  if(tx?.billId) return `INV-${String(tx.billId).replace(/\s+/g, '')}`;
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
  const derivedTotal = round2(lines.reduce((s, l) => s + (Number(l.total) || 0), 0));
  const derivedSubTotal = round2(lines.reduce((s, l) => s + round2((Number(getDisplayUnitPrice(l)) || 0) * (Number(l.qty) || 0)), 0));
  const hasBillMeta = !!first.billId &&
    Number.isFinite(Number(first.billGrossTotal)) &&
    Number.isFinite(Number(first.billDiscountTotal)) &&
    Number.isFinite(Number(first.billNetTotal));
  const hasPaidMeta = hasBillMeta && Number.isFinite(Number(first.billPaidTotal));
  const subTotal = hasBillMeta ? round2(Number(first.billGrossTotal) || 0) : derivedSubTotal;
  const discount = type === 'sale'
    ? (hasBillMeta ? round2(Math.max(0, Number(first.billDiscountTotal) || 0)) : round2(Math.max(0, derivedSubTotal - derivedTotal)))
    : 0;
  const total = hasBillMeta ? round2(Number(first.billNetTotal) || 0) : derivedTotal;
  let paid = hasPaidMeta ? round2(Number(first.billPaidTotal) || 0) : round2(lines.reduce((s, l) => s + (Number(l.cashPaid) || 0), 0));
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
    const p = getProd(l.productId);
    const unitPrice = round2(Number(getDisplayUnitPrice(l)) || 0);
    const lineTotal = round2((Number(l.qty) || 0) * unitPrice);
    return `<tr>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;text-align:center;vertical-align:middle">${i + 1}</td>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;vertical-align:middle">${escapeHtml(p?.name || '?')}</td>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;text-align:center;vertical-align:middle">${escapeHtml(`${round2(l.qty)} ${p?.unit || ''}`.trim())}</td>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;text-align:center;vertical-align:middle">${fmt(unitPrice)}</td>
      <td style="height:17px;padding:2px 5px;border:1px solid #111;text-align:center;vertical-align:middle">${fmt(lineTotal)}</td>
    </tr>`;
  }).join('');
  return `<div id="printInvoiceRoot" style="font-family:Arial, Helvetica, sans-serif;color:#000;background:#fff;width:190mm;min-height:270mm;margin:0 auto;box-sizing:border-box;padding:22mm 18mm 18mm">
    <div style="display:grid;grid-template-columns:34mm 1fr 34mm;align-items:start;margin-bottom:6mm">
      <div><img src="${logoSrc}" alt="Logo" style="width:22mm;height:22mm;object-fit:contain"></div>
      <div style="text-align:center;font-size:12px;text-decoration:underline;margin-top:1mm">INVOICE</div>
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
  w.focus();
  w.print();
}
