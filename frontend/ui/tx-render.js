// ui/tx-render.js — Transaction row rendering + grouping/display helpers
// Phase 3 extraction. Classic script sharing index.html's global scope; loaded
// after the main script. Runtime-only (used by dashboard/reports/invoice/calc
// at render time), so load order is safe. Depends on globals: getProd,
// dateToYMDLocal, displayDateOnly, displayDateTime, fmt, data, getLinkedReturnRows, round2,
// getSaleReturnProfitImpact, escapeHtml, and onclick handlers (startReturnFromTx,
// editTx, deleteTx).

function txRow(t, opts = {}) {
  const suppressPartyBadge = !!opts.suppressPartyBadge;
  const suppressInvoiceButton = !!opts.suppressInvoiceButton;
  const suppressReturnMeta = !!opts.suppressReturnMeta;
  const p = getProd(t.productId);
  const txDate = displayDateTime(t.date) || '';
  const isSaleReturn     = t.type==='return' && t.returnType==='sale-return';
  const isPurchaseReturn = t.type==='return' && t.returnType==='purchase-return';
  const isLegacyReturn   = t.type==='return' && !t.returnType;
  const typeIcon  = t.type==='sale'?'🛒': isSaleReturn?'↩️': isPurchaseReturn?'🔄': isLegacyReturn?'↩️': '📦';
  const typeLabel = t.type==='sale'?'Sale': isSaleReturn?'Sale Return': isPurchaseReturn?'Purchase Return': isLegacyReturn?'Return': 'Purchase';
  const typeClass = t.type==='return'?'return':t.type;
  const party = t.type==='sale'
    ? getTxCustomerName(t)
    : t.type==='purchase'
      ? getTxSupplierName(t)
      : '';
  const billText = t.billId ? ` · Bill ${t.billId}` : '';
  // Linked original transaction info
  let linkedInfo = '';
  if(t.type==='return' && t.linkedTxId) {
    const orig = data.transactions.find(tx=>tx.id===t.linkedTxId);
    if(orig) {
      const origProd = getProd(orig.productId);
      const origDate = displayDateTime(orig.date) || dateToYMDLocal(orig.date);
      const origType = orig.type==='sale'?'Sale':'Purchase';
      linkedInfo = `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px;padding:3px 7px;background:var(--surface2);border-radius:6px;display:inline-block">🔗 ${origType} #${orig.id} · ${origDate} · ${fmt(orig.total)}</div>`;
    } else {
      linkedInfo = `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px">🔗 Linked tx #${t.linkedTxId}</div>`;
    }
  }
  if(!suppressReturnMeta && t.type === 'return' && t.returnGroupId) {
    linkedInfo += `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px;padding:3px 7px;background:var(--surface2);border-radius:6px;display:inline-block">🧾 Return ID: ${t.returnGroupId}</div>`;
  }
  if(!suppressReturnMeta && t.type === 'return' && t.sourceBillId) {
    linkedInfo += `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px;padding:3px 7px;background:var(--surface2);border-radius:6px;display:inline-block">📌 From Bill: ${t.sourceBillId}</div>`;
  }
  if(t.type==='return' && !suppressPartyBadge) {
    let partyName = '';
    if(t.returnType === 'purchase-return') {
      const orig = t.linkedTxId ? data.transactions.find(tx=>tx.id===t.linkedTxId) : null;
      partyName = (orig ? getTxSupplierName(orig) : '') || (t.supplier || '');
      if(partyName) {
        linkedInfo += `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px;padding:3px 7px;background:var(--blue-light);border-radius:6px;display:inline-block">🏪 Supplier: ${partyName}</div>`;
      }
    } else {
      const orig = t.linkedTxId ? data.transactions.find(tx=>tx.id===t.linkedTxId) : null;
      partyName = (orig ? getTxCustomerName(orig) : '') || (t.customer || '');
      if(partyName) {
        linkedInfo += `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px;padding:3px 7px;background:var(--green-light);border-radius:6px;display:inline-block">👤 Customer: ${partyName}</div>`;
      }
    }
  }
  if(!suppressPartyBadge && t.type==='sale' && party) {
    linkedInfo += `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px;padding:3px 7px;background:var(--green-light);border-radius:6px;display:inline-block">👤 Customer: ${party}</div>`;
  }
  if(!suppressPartyBadge && t.type==='purchase' && party) {
    linkedInfo += `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px;padding:3px 7px;background:var(--blue-light);border-radius:6px;display:inline-block">🏪 Supplier: ${party}</div>`;
  }
  if(t.type === 'sale' || t.type === 'purchase') {
    const returnType = t.type === 'sale' ? 'sale-return' : 'purchase-return';
    const linkedReturns = getLinkedReturnRows(t.id, returnType);
    const returnedQty = round2(linkedReturns.reduce((s, r) => s + (Number(r.qty) || 0), 0));
    if(returnedQty > 0) {
      const baseQty = round2(Number(t._baseQty !== undefined ? t._baseQty : t.qty) || 0);
      const netQty = round2(Math.max(0, baseQty - returnedQty));
      const u = p?.unit || 'units';
      linkedInfo += `<div style="font-size:0.68rem;color:var(--ink2);margin-top:3px;padding:3px 7px;background:var(--surface2);border-radius:6px;display:inline-block">Net after return: ${netQty} ${u} (Returned ${returnedQty})</div>`;
    }
  }
  const purchaseCostBreakdown = (t.type === 'purchase' && (Number(t.lineExtraCost) || 0) > 0)
    ? `<div style="font-size:0.68rem;color:var(--ink2);margin-top:2px;white-space:nowrap">Product Cost ${fmt(Number(t.total)||0)} + Extra ${fmt(Number(t.lineExtraCost)||0)}</div>`
    : '';
  const editHistory = Array.isArray(t.editHistory) ? t.editHistory : [];
  const latestEdit = editHistory.length ? editHistory[editHistory.length - 1] : null;
  const editTrace = latestEdit
    ? `<div style="font-size:0.68rem;color:var(--gold);margin-top:3px;padding:3px 7px;background:var(--gold-light);border-radius:6px;display:inline-block">Edited ${displayDateTime(latestEdit.at) || dateToYMDLocal(latestEdit.at) || ''}${Array.isArray(latestEdit.changes) && latestEdit.changes.length ? ` · ${escapeHtml(latestEdit.changes.slice(0, 3).join(' · '))}${latestEdit.changes.length > 3 ? ' · more' : ''}` : ''}</div>`
    : '';
  return `<div class="tx-item">
    <div class="tx-icon ${typeClass}">${typeIcon}</div>
    <div class="tx-body"><div class="tx-name">${p?.name||'?'}</div>
      <div class="tx-sub">${t.qty} ${p?.unit||''} · ${fmt(getDisplayUnitPrice(t))}/unit · ${txDate}${billText}${t.reason?' · '+t.reason:''}</div>
      ${linkedInfo}${editTrace}</div>
    <div class="tx-right" style="display:flex;align-items:center;gap:8px">
      <div><div class="tx-amount ${typeClass}">${fmt(getDisplayLineTotal(t))}</div>
        ${purchaseCostBreakdown}
        <div class="tx-type-tag">${typeLabel}</div>
      </div>
      ${(!suppressInvoiceButton && (t.type === 'sale' || t.type === 'purchase')) ? `<button class="del-btn" style="color:var(--blue);opacity:0.75" onclick="openInvoiceFromTx(${t.id})" title="Print invoice">Invoice</button>` : ''}
      ${t.type!=='return'?`<button class="del-btn" style="color:var(--gold);opacity:0.7" onclick="startReturnFromTx(${t.id})" title="Return this transaction">↩️</button>`:''}
      <button class="del-btn" style="color:var(--blue);opacity:0.6" onclick="editTx(${t.id})" title="Edit this entry">✏️</button>
      <button class="del-btn" onclick="deleteTx(${t.id})" title="Delete this entry" style="color:var(--red);opacity:0.6">✕</button>
    </div>
  </div>`;
}

function getTxCustomerName(tx) {
  const direct = (tx?.customer || '').trim();
  if(direct) return direct;
  let credit = data.credits.find(c => String(c.txId) === String(tx?.id));
  if(!credit && tx?.billId) {
    credit = data.credits.find(c => String(c.billId || '') === String(tx.billId));
  }
  if(!credit) {
    credit = data.credits.find(c => Array.isArray(c.txIds) && c.txIds.some(id => String(id) === String(tx?.id)));
  }
  return (credit?.customerName || '').trim();
}

function getTxSupplierName(tx) {
  const direct = (tx?.supplier || '').trim();
  if(direct) return direct;
  let sc = (data.supplierCredits || []).find(s => String(s.txId) === String(tx?.id));
  if(!sc && tx?.billId) {
    sc = (data.supplierCredits || []).find(s => String(s.billId || '') === String(tx.billId));
  }
  if(!sc) {
    sc = (data.supplierCredits || []).find(s => Array.isArray(s.txIds) && s.txIds.some(id => String(id) === String(tx?.id)));
  }
  return (sc?.supplierName || '').trim();
}
function getDisplayUnitPrice(tx) {
  if(!tx) return 0;
  if(tx.type === 'purchase') {
    const extra = Number(tx.lineExtraCost) || 0;
    const landed = Number(tx.landedUnitCost);
    if(extra > 0 && Number.isFinite(landed) && landed > 0) return round2(landed);
    const totalWithExtra = round2((Number(tx.netAmount) || Number(tx.total) || 0) + extra);
    const qtyForExtra = Number(tx.qty);
    if(extra > 0 && totalWithExtra > 0 && Number.isFinite(qtyForExtra) && qtyForExtra > 0) {
      return round2(totalWithExtra / qtyForExtra);
    }
    const net = Number(tx.netUnitCost);
    if(Number.isFinite(net) && net > 0) return round2(net);
    const total = Number(tx.netAmount) || Number(tx.total);
    const qty = Number(tx.qty);
    if(Number.isFinite(total) && total > 0 && Number.isFinite(qty) && qty > 0) {
      return round2(total / qty);
    }
    return round2(Number(tx.price) || 0);
  }
  const lp = Number(tx.listPrice);
  if(Number.isFinite(lp) && lp > 0) return round2(lp);
  return round2(Number(tx.price) || 0);
}
function getDisplayLineTotal(tx) {
  if(!tx) return 0;
  if(tx.type === 'purchase') {
    return round2((Number(tx.total) || 0) + (Number(tx.lineExtraCost) || 0));
  }
  const hasBillDiscount = !!tx.billId && Math.abs(Number(tx.lineDiscount) || 0) > 0;
  if(hasBillDiscount && tx.type !== 'return') {
    return round2((Number(tx.qty) || 0) * (Number(getDisplayUnitPrice(tx)) || 0));
  }
  return round2(Number(tx.total) || 0);
}

function groupTxnsByBill(txns, mode) {
  const groups = [];
  const map = new Map();
  txns.forEach(t => {
    const isBillableType = (mode === 'sale' && t.type === 'sale') || (mode === 'purchase' && t.type === 'purchase');
    const key = (isBillableType && t.billId) ? `bill:${t.billId}` : `tx:${t.id}`;
    if(!map.has(key)) {
      const party = mode === 'sale' ? getTxCustomerName(t) : getTxSupplierName(t);
      const g = { key, billId: t.billId || '', date: t.date, party, rows: [], mode };
      map.set(key, g);
      groups.push(g);
    }
    map.get(key).rows.push(t);
  });
  groups.forEach(g => {
    g.rows.sort((a,b)=>a.id-b.id);
    if(mode === 'purchase') {
      g.productTotal = round2(g.rows.reduce((s, t) => s + (Number(t.total) || 0), 0));
      g.extraCost = round2(g.rows.reduce((s, t) => s + (Number(t.lineExtraCost) || 0), 0));
      g.total = round2(g.productTotal + g.extraCost);
      g.grossTotal = g.total;
      g.discount = 0;
    } else {
      g.total = round2(g.rows.reduce((s, t) => s + (Number(t.total) || 0), 0));
      const recomputedGross = round2(g.rows.reduce((s, t) => s + getDisplayLineTotal(t), 0));
      g.grossTotal = recomputedGross;
      // Always derive visible discount from visible rows to avoid mismatch after returns/deletes.
      g.discount = round2(Math.max(0, g.grossTotal - g.total));
    }
    if(mode === 'sale') {
      const grossProfit = round2(g.rows.reduce((s, t) => s + round2((Number(t.total) || 0) - (typeof getSaleCostTotal === 'function' ? getSaleCostTotal(t) : round2((Number(t.cost) || 0) * (Number(t.qty) || 0)))), 0));
      const rowIds = new Set(g.rows.map(r => String(r.id)));
      const linkedReturns = (data.transactions || []).filter(t =>
        t &&
        t.type === 'return' &&
        (t.returnType === 'sale-return' || !t.returnType) &&
        rowIds.has(String(t.linkedTxId || ''))
      );
      g.returnedQty = round2(linkedReturns.reduce((s, t) => s + (Number(t.qty) || 0), 0));
      g.returnedTotal = round2(linkedReturns.reduce((s, t) => s + (Number(t.total) || 0), 0));
      g.netAfterReturn = round2(Math.max(0, g.total - g.returnedTotal));
      const returnedProfitImpact = round2(linkedReturns.reduce((s, t) => s + getSaleReturnProfitImpact(t), 0));
      g.profit = round2(grossProfit - returnedProfitImpact);
    }
  });
  return groups;
}

function groupReturnTxns(txns) {
  const groups = [];
  const map = new Map();
  (txns || []).forEach(t => {
    if(!t || t.type !== 'return') return;
    const key = t.returnGroupId ? `rg:${t.returnGroupId}` : `tx:${t.id}`;
    if(!map.has(key)) {
      const g = {
        key,
        returnGroupId: t.returnGroupId || '',
        sourceBillId: t.sourceBillId || '',
        date: t.date,
        rows: []
      };
      map.set(key, g);
      groups.push(g);
    }
    map.get(key).rows.push(t);
  });
  groups.forEach(g => {
    g.rows.sort((a,b)=>(Number(a.id)||0)-(Number(b.id)||0));
    g.total = round2(g.rows.reduce((s, t) => s + (Number(t.total) || 0), 0));
  });
  return groups.sort((a,b)=>new Date(b.date)-new Date(a.date));
}

function txReturnGroupRow(g) {
  if(g.rows.length === 1 && !g.returnGroupId) return txRow(g.rows[0]);
  const dt = displayDateTime(g.date) || dateToYMDLocal(g.date) || '-';
  const metaParts = [`${g.rows.length} item${g.rows.length>1?'s':''}`, `Date: ${dt}`];
  if(g.returnGroupId) metaParts.push(`Return ID: ${g.returnGroupId}`);
  if(g.sourceBillId) metaParts.push(`From Bill: ${g.sourceBillId}`);
  const customerNames = [...new Set(g.rows
    .map(r => {
      const orig = r.linkedTxId ? data.transactions.find(tx=>tx.id===r.linkedTxId) : null;
      return ((orig && getTxCustomerName(orig)) || r.customer || '').trim();
    })
    .filter(Boolean))];
  const supplierNames = [...new Set(g.rows
    .map(r => {
      const orig = r.linkedTxId ? data.transactions.find(tx=>tx.id===r.linkedTxId) : null;
      return ((orig && getTxSupplierName(orig)) || r.supplier || '').trim();
    })
    .filter(Boolean))];
  const partyBadge = customerNames.length
    ? `<div style="font-size:0.76rem;color:var(--ink2);line-height:1.2;margin-top:3px;padding:3px 7px;background:var(--green-light);border-radius:6px;display:inline-block">👤 Customer: <span style="font-weight:700;color:var(--ink)">${escapeHtml(customerNames.join(', '))}</span></div>`
    : (supplierNames.length
      ? `<div style="font-size:0.76rem;color:var(--ink2);line-height:1.2;margin-top:3px;padding:3px 7px;background:var(--blue-light);border-radius:6px;display:inline-block">🏪 Supplier: <span style="font-weight:700;color:var(--ink)">${escapeHtml(supplierNames.join(', '))}</span></div>`
      : '');
  const items = g.rows.map(r => txRow(r, { suppressPartyBadge: true, suppressReturnMeta: true })).join('');
  return `<div style="border:1.5px solid var(--border);border-radius:12px;padding:10px 10px 4px;margin-bottom:10px;background:var(--surface)">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px">
      <div>
        <div style="font-size:0.82rem;font-weight:700;color:var(--ink)">↩️ ${g.rows.length>1?'Combined Return':'Return'}</div>
        ${partyBadge}
        <div style="font-size:0.72rem;color:var(--ink2)">${metaParts.join(' · ')}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:0.9rem;font-weight:700;color:var(--red)">Total Return: ${fmt(g.total)}</div>
      </div>
    </div>
    ${items}
  </div>`;
}

function txGroupRow(g, opts = {}) {
  const showBillProfit = !!opts.showBillProfit;
  if(g.rows.length === 1 && !g.billId) return txRow(g.rows[0]);
  const dt = displayDateTime(g.date) || dateToYMDLocal(g.date);
  const partyLabel = g.party ? (g.mode === 'sale' ? 'Customer' : 'Supplier') : '';
  const items = g.rows.map(r => txRow(r, { suppressPartyBadge: true, suppressInvoiceButton: true })).join('');
  const metaParts = [`${g.rows.length} item${g.rows.length>1?'s':''}`, `Date: ${dt}`];
  if(g.billId) metaParts.push(`Bill: ${g.billId}`);
  const partyTitle = g.party
    ? `<div style="font-size:0.76rem;color:var(--ink2);line-height:1.2;margin-top:3px;padding:3px 7px;background:${g.mode==='sale'?'var(--green-light)':'var(--blue-light)'};border-radius:6px;display:inline-block">${g.mode==='sale'?'👤':'🏪'} ${partyLabel}: <span style="font-weight:700;color:var(--ink)">${g.party}</span></div>`
    : '';
  const profitLine = (showBillProfit && g.mode === 'sale' && g.billId)
    ? `<div style="font-size:0.72rem;font-weight:700;color:${(Number(g.profit)||0)>=0?'var(--green)':'var(--red)'};margin-top:2px">Total Profit: ${fmt(Number(g.profit)||0)}</div>`
    : '';
  const discountLine = (g.billId && (Number(g.discount) || 0) > 0)
    ? `<div style="font-size:0.72rem;color:var(--ink2);margin-top:1px">SubTotal: ${fmt(g.grossTotal)} · Discount: -${fmt(g.discount)}</div>`
    : '';
  const purchaseExtraLine = (g.mode === 'purchase' && (Number(g.extraCost) || 0) > 0)
    ? `<div style="font-size:0.72rem;color:var(--ink2);margin-top:1px">Product: ${fmt(g.productTotal)} + Extra Costing: ${fmt(g.extraCost)}</div>`
    : '';
  const netAfterReturnLine = (g.mode === 'sale' && (Number(g.returnedQty) || 0) > 0)
    ? `<div style="font-size:0.72rem;color:var(--ink2);margin-top:1px">Net after return: ${fmt(g.netAfterReturn)} (Returned ${fmt(g.returnedTotal)})</div>`
    : '';
  return `<div style="border:1.5px solid var(--border);border-radius:12px;padding:10px 10px 4px;margin-bottom:10px;background:var(--surface)">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px">
      <div>
        <div style="font-size:0.82rem;font-weight:700;color:var(--ink)">🧾 ${g.rows.length>1?'Combined Bill':'Transaction'}</div>
        ${partyTitle}
        <div style="font-size:0.72rem;color:var(--ink2)">${metaParts.join(' · ')}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:0.9rem;font-weight:700;color:var(--gold)">${(g.billId && (Number(g.discount)||0)>0) ? 'Total after discount' : 'Total'}: ${fmt(g.total)}</div>
        ${discountLine}
        ${purchaseExtraLine}
        ${netAfterReturnLine}
        ${profitLine}
        ${g.billId ? `<button class="del-btn" style="color:var(--blue);opacity:0.75" onclick='openInvoiceFromGroup(${JSON.stringify(g.mode)}, ${JSON.stringify(g.billId)}, ${JSON.stringify(g.rows[0]?.id || '')})' title="Print invoice">Invoice</button>` : ''}
      </div>
    </div>
    ${items}
  </div>`;
}

function txGroupRowReport(g) {
  return txGroupRow(g, { showBillProfit: true });
}
