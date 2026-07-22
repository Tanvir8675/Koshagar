// modules/credit-page.js — Credit page rendering + credit/supplier-pay form toggles
// Phase 3 extraction. Classic script sharing index.html's global scope; loaded
// after the main script. Runtime-only (showPage('credit'), filter/mode buttons,
// entry-form toggles), so load order is safe. Depends on globals: buildCreditMetrics,
// getSupplierDue, getCreditDue, getCreditTotalPaid, getSupplierTotalPaid,
// normalizePhone, round2, fmt, todayStr, getEntryWorkingTotal, pgReset,
// groupSupplierCredits, groupCustomerCredits, getProd, dateToYMDLocal, displayDateTime, data,
// renderPaged, creditPartyMode, creditFilter (state vars in index.html), and the
// payment-modal openers in modules/payments.js (openPayModal, openSupplierPayModal,
// openPayModalByCustomerKey, openSupplierPayModalByKey, deleteCredit,
// deleteSupplierCredit, editPaymentEntry, deletePaymentEntry).

function creditSearchHaystack(parts) {
  return parts
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
    .map(v => String(v).toLowerCase())
    .join(' ');
}

function creditProductSearchParts(items, fallbackProductId, fallbackQty, fallbackPrice) {
  const rows = Array.isArray(items) && items.length
    ? items
    : [{ productId: fallbackProductId, qty: fallbackQty, price: fallbackPrice }];
  return rows.flatMap(item => {
    const product = getProd(item.productId);
    return [
      product?.name,
      product?.code,
      product?.category,
      product?.unit,
      item.qty,
      item.price
    ];
  });
}

function creditRecordMatchesQuery(row, query, partyType) {
  const q = String(query || '').toLowerCase().trim();
  if(!q) return true;
  const qPhone = normalizePhone(q);
  const isSupplier = partyType === 'supplier';
  const name = isSupplier ? row.supplierName : row.customerName;
  const phone = isSupplier ? row.supplierPhone : row.customerPhone;
  const due = isSupplier ? getSupplierDue(row) : getCreditDue(row);
  const paid = isSupplier ? getSupplierTotalPaid(row) : getCreditTotalPaid(row);
  const productParts = creditProductSearchParts(row.products, row.productId, row.qty, row.price);
  const dateOnly = dateToYMDLocal(row.date);
  const haystack = creditSearchHaystack([
    name,
    phone,
    normalizePhone(phone || ''),
    row.billId,
    row.txId,
    row.id,
    dateOnly,
    typeof displayDateOnly === 'function' ? displayDateOnly(row.date) : '',
    typeof displayDateTime === 'function' ? displayDateTime(row.date) : '',
    row.total,
    paid,
    due,
    ...productParts
  ]);
  return haystack.includes(q) || (!!qPhone && haystack.includes(qPhone));
}

function buildCreditPageMetrics(creditPartyMode, creditFilter, query) {
  const centralCredit = buildCreditMetrics('daily', todayStr());
  const allCredits = [...(centralCredit.allCredits || [])].sort((a,b)=>new Date(b.date)-new Date(a.date));
  const allSupplierCredits = [...(centralCredit.allSupplierCredits || [])].sort((a,b)=>new Date(b.date)-new Date(a.date));
  const q = String(query || '').toLowerCase().trim();

  const totalCustDue = round2(Number(centralCredit.totalCustomerDue) || 0);
  const totalSuppDue = round2(Number(centralCredit.totalSupplierDue) || 0);
  const openCustCount = Number(centralCredit.openCustCount) || 0;
  const openSuppCount = Number(centralCredit.openSuppCount) || 0;

  let list = creditPartyMode === 'supplier' ? allSupplierCredits : allCredits;
  if(creditPartyMode === 'supplier') {
    if(creditFilter==='due') list = list.filter(sc=>getSupplierDue(sc)>0);
    if(creditFilter==='done') list = list.filter(sc=>getSupplierDue(sc)<=0);
    if(q) list = list.filter(sc=>creditRecordMatchesQuery(sc, q, 'supplier'));
  } else {
    if(creditFilter==='due') list = list.filter(c=>getCreditDue(c)>0);
    if(creditFilter==='done') list = list.filter(c=>getCreditDue(c)<=0);
    if(q) list = list.filter(c=>creditRecordMatchesQuery(c, q, 'customer'));
  }
  return {
    allCredits,
    allSupplierCredits,
    totalCustDue,
    totalSuppDue,
    openCustCount,
    openSuppCount,
    filteredList: list
  };
}

function onCreditToggle() {
  const on = document.getElementById('isCreditSale').checked;
  document.getElementById('creditSaleFields').style.display = on ? 'block' : 'none';
  const custRow = document.getElementById('creditCustNameRow');
  const phoneRow = document.getElementById('creditCustPhoneRow');
  if(custRow) custRow.style.display = 'none';
  if(phoneRow) phoneRow.style.display = 'none';
  if(!on) {
    document.getElementById('eCustName').value='';
    document.getElementById('eCustPhone').value='';
    document.getElementById('ePaidAmt').value='';
    document.getElementById('creditPreviewPills').style.display='none';
  }
  updateCreditPreview();
}

function onSupplierPayToggle() {
  const on = document.getElementById('isPartialPay').checked;
  document.getElementById('supplierPayFields').style.display = on ? 'block' : 'none';
  if(!on) {
    document.getElementById('eSupplierPaid').value='';
    document.getElementById('supplierPayPreviewPills').style.display='none';
  }
  updateSupplierPayPreview();
  if(typeof updatePurchaseFundingPreview === 'function') updatePurchaseFundingPreview();
}

function updateSupplierPayPreview() {
  const total = getEntryWorkingTotal();
  const paid  = Math.min(parseFloat(document.getElementById('eSupplierPaid').value)||0, total);
  const due   = Math.max(0, total - paid);
  const pills = document.getElementById('supplierPayPreviewPills');
  if(total > 0 && document.getElementById('isPartialPay').checked) {
    pills.style.display='flex';
    document.getElementById('spTotal').textContent = fmt(total);
    document.getElementById('spPaid').textContent  = fmt(paid);
    document.getElementById('spDue').textContent   = fmt(due);
  } else {
    pills.style.display='none';
  }
  if(typeof updatePurchaseFundingPreview === 'function') updatePurchaseFundingPreview();
}

function updateCreditPreview() {
  const total = getEntryWorkingTotal();
  const paid  = Math.min(parseFloat(document.getElementById('ePaidAmt').value)||0, total);
  const due   = Math.max(0, total - paid);
  const pills = document.getElementById('creditPreviewPills');
  if(total > 0 && document.getElementById('isCreditSale').checked) {
    pills.style.display='flex';
    document.getElementById('cpTotal').textContent = fmt(total);
    document.getElementById('cpPaid').textContent  = fmt(paid);
    document.getElementById('cpDue').textContent   = fmt(due);
  } else {
    pills.style.display='none';
  }
}

function setCreditPartyMode(mode) {
  pgReset('creditList');
  creditPartyMode = mode === 'supplier' ? 'supplier' : 'customer';
  const isSupplier = creditPartyMode === 'supplier';
  const cBtn = document.getElementById('creditModeCustomer');
  const sBtn = document.getElementById('creditModeSupplier');
  if(cBtn) {
    cBtn.className = 'type-btn' + (isSupplier ? '' : ' active-sale');
    cBtn.style.background = isSupplier ? 'var(--surface2)' : '';
    cBtn.style.color = isSupplier ? 'var(--ink2)' : '';
  }
  if(sBtn) {
    sBtn.className = 'type-btn' + (isSupplier ? ' active-buy' : '');
    sBtn.style.background = isSupplier ? '' : 'var(--surface2)';
    sBtn.style.color = isSupplier ? '' : 'var(--ink2)';
  }
  const search = document.getElementById('creditSearch');
  if(search) search.placeholder = isSupplier ? '🔍 Search supplier, phone, bill, product...' : '🔍 Search customer, phone, bill, product...';
  setCreditFilter('all');
}

function setCreditFilter(f) {
  pgReset('creditList');
  creditFilter = f;
  const activeClass = creditPartyMode === 'supplier' ? 'type-btn active-buy' : 'type-btn active-sale';
  ['all','due','done'].forEach(v=>{
    const btn = document.getElementById('cFilter'+v.charAt(0).toUpperCase()+v.slice(1));
    if(!btn) return;
    btn.className='type-btn';
    btn.style.background='var(--surface2)'; btn.style.color='var(--ink2)';
  });
  const activeBtn = document.getElementById('cFilter'+f.charAt(0).toUpperCase()+f.slice(1));
  if(activeBtn) { activeBtn.className=activeClass; activeBtn.style.background=''; activeBtn.style.color=''; }
  renderCreditPage();
}

function renderCreditPage() {
  const q = (document.getElementById('creditSearch')?.value||'').toLowerCase().trim();
  if(window.__creditLastQuery !== q) {
    pgReset('creditList');
    window.__creditLastQuery = q;
  }
  const cm = buildCreditPageMetrics(creditPartyMode, creditFilter, q);
  const allCredits = cm.allCredits;
  const allSupplierCredits = cm.allSupplierCredits;
  document.getElementById('creditStats').innerHTML=`
    <div class="stat"><div class="stat-label">Total Customer Due</div><div class="stat-value red">${fmt(cm.totalCustDue)}</div><div class="stat-sub">${cm.openCustCount} customers</div></div>
    <div class="stat"><div class="stat-label">Total Supplier Due</div><div class="stat-value red">${fmt(cm.totalSuppDue)}</div><div class="stat-sub">${cm.openSuppCount} suppliers</div></div>`;

  if(creditPartyMode === 'supplier') {
    const groupedList = groupSupplierCredits(cm.filteredList);
    if(groupedList.length===0) {
      const hint = creditFilter==='due' && allSupplierCredits.length>0
        ? '<div class="empty-text" style="margin-top:4px;color:var(--ink2)">No outstanding now. Switch to All/Settled for history.</div>'
        : '';
      document.getElementById('creditList').innerHTML=`<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">No supplier due records</div>${hint}</div>`;
      return;
    }
    renderPaged('creditList', groupedList, g=>{
      const due = g.due;
      const paid = g.paid;
      const total = g.total;
      const pct = total>0 ? Math.min(100,(paid/total*100)).toFixed(0) : 0;
    const settled = due<=0.001;
    const openBillCount = g.bills.filter(sc => getSupplierDue(sc) > 0.001).length;
      const latestDate = g.bills.length ? (displayDateTime(g.bills.slice().sort((a,b)=>new Date(b.date)-new Date(a.date))[0].date) || dateToYMDLocal(g.bills.slice().sort((a,b)=>new Date(b.date)-new Date(a.date))[0].date)) : '-';
      const phoneText = g.supplierPhone ? ` · 📞 ${g.supplierPhone}` : '';
      const billRows = g.bills
        .slice()
        .sort((a,b)=>new Date(b.date)-new Date(a.date))
        .map(sc => {
          const bDue = getSupplierDue(sc);
          const bPaid = getSupplierTotalPaid(sc);
          const bSettled = bDue <= 0.001;
          const billLabel = sc.billId ? `Bill ${sc.billId}` : `Tx #${sc.txId}`;
          const scInitialPaid = round2(Number(sc.paid) || 0);
          // Product list for subtitle
          const scItemsText = Array.isArray(sc.products) && sc.products.length > 0
            ? sc.products.map(pr=>{const prod=getProd(pr.productId);return `${pr.qty} ${prod?.unit||''} ${prod?.name||'?'}`;}).join(', ')
            : (()=>{const p=getProd(sc.productId);return `${sc.qty||''} ${p?.unit||''} ${p?.name||'?'}`.trim();})();
          // Product breakdown rows
          const scProds = Array.isArray(sc.products) && sc.products.length > 0
            ? sc.products.map(pr=>{const prod=getProd(pr.productId);const sub=round2((pr.qty||0)*(pr.price||0));return {name:prod?.name||'?',unit:prod?.unit||'',qty:pr.qty||0,price:pr.price||0,sub};})
            : (()=>{const p=getProd(sc.productId);const sub=round2((sc.qty||0)*(sc.price||0));return [{name:p?.name||'?',unit:p?.unit||'',qty:sc.qty||0,price:sc.price||0,sub}];})();
          const scProdBreakdown = `<div id="sbd_${sc.id}" style="display:none;margin-top:8px;border-radius:7px;background:var(--surface2);padding:6px 8px"><div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink2);margin-bottom:5px">Bill Breakdown</div><table style="width:100%;border-collapse:collapse;font-size:0.72rem"><thead><tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:3px 4px;color:var(--ink2);font-weight:600">Product</th><th style="text-align:right;padding:3px 4px;color:var(--ink2);font-weight:600">Qty</th><th style="text-align:right;padding:3px 4px;color:var(--ink2);font-weight:600">Unit Price</th><th style="text-align:right;padding:3px 4px;color:var(--ink2);font-weight:600">Subtotal</th></tr></thead><tbody>${scProds.map(r=>`<tr style="border-bottom:1px dashed var(--border)"><td style="padding:4px 4px;font-weight:600">${r.name}</td><td style="text-align:right;padding:4px 4px;color:var(--ink2)">${r.qty} ${r.unit}</td><td style="text-align:right;padding:4px 4px;color:var(--ink2)">${fmt(r.price)}</td><td style="text-align:right;padding:4px 4px;font-weight:700">${fmt(r.sub)}</td></tr>`).join('')}</tbody><tfoot><tr style="border-top:1.5px solid var(--border)"><td colspan="3" style="text-align:right;padding:5px 4px;font-weight:700;color:var(--ink2)">Total</td><td style="text-align:right;padding:5px 4px;font-weight:700;color:var(--ink);font-size:0.82rem">${fmt(sc.total)}</td></tr></tfoot></table></div>`;
          const scPayments = (data.supplierPayments || []).filter(p=>String(p.scId)===String(sc.id)).slice().sort((a,b)=>new Date(a.date)-new Date(b.date));
          const scHistRows = [];
          if(scInitialPaid > 0) scHistRows.push(`<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px dashed var(--border)"><span style="font-size:0.68rem;color:var(--ink2)">📅 ${displayDateTime(sc.date) || dateToYMDLocal(sc.date)} &nbsp;·&nbsp; Initial</span><span style="font-size:0.7rem;font-weight:700;color:var(--blue)">+${fmt(scInitialPaid)}</span></div>`);
          scPayments.forEach(p=>{const pDate=displayDateTime(p.date)||dateToYMDLocal(p.date);const note=p.note?` · ${p.note}`:'';scHistRows.push(`<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px dashed var(--border)"><span style="font-size:0.68rem;color:var(--ink2)">📅 ${pDate}${note}</span><div style="display:flex;align-items:center;gap:3px"><span style="font-size:0.7rem;font-weight:700;color:var(--blue)">+${fmt(Number(p.amount)||0)}</span><button onclick="editPaymentEntry('${p.id}','supplier')" style="background:none;border:none;cursor:pointer;font-size:0.78rem;padding:1px 4px;color:var(--gold);line-height:1" title="Edit">✏️</button><button onclick="deletePaymentEntry('${p.id}','supplier')" style="background:none;border:none;cursor:pointer;font-size:0.78rem;padding:1px 4px;color:var(--red);line-height:1" title="Delete">🗑</button></div></div>`);});
          const scHistHtml = scHistRows.length>0
            ? `<div style="margin-top:7px;border-radius:7px;background:var(--blue-light);padding:5px 8px"><div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink2);margin-bottom:3px">Payment History</div>${scHistRows.join('')}<div style="display:flex;justify-content:space-between;padding-top:4px"><span style="font-size:0.68rem;font-weight:700;color:var(--ink2)">Total Paid</span><span style="font-size:0.7rem;font-weight:700;color:var(--blue)">${fmt(bPaid)}</span></div></div>`
            : `<div style="margin-top:5px;font-size:0.68rem;color:var(--ink2)">No payments recorded yet.</div>`;
          return `<div style="border:1px dashed var(--border);border-radius:8px;padding:8px 9px;margin-top:8px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;cursor:pointer" onclick="(function(){var d=document.getElementById('sbd_${sc.id}');if(d)d.style.display=d.style.display==='none'?'block':'none';})()">
              <div>
                <div style="font-size:0.78rem;font-weight:700;color:var(--ink)">${billLabel} <span style="font-size:0.65rem;color:var(--gold);font-weight:600">▾ Details</span></div>
                <div style="font-size:0.72rem;color:var(--ink2)">${displayDateTime(sc.date) || dateToYMDLocal(sc.date)} · ${scItemsText}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:0.78rem;color:${bSettled?'var(--green)':'var(--red)'};font-weight:700">${bSettled?'✅ Settled':`Due: ${fmt(bDue)}`}</div>
              </div>
            </div>
            ${scProdBreakdown}
            ${scHistHtml}
            <div style="display:flex;gap:8px;margin-top:7px">
              ${!bSettled?`<button class="pay-btn" style="background:var(--blue)" onclick="openSupplierPayModal(${sc.id})">🏪 Pay Supplier</button>`:`<button class="pay-btn" style="background:var(--ink2);display:inline-flex;align-items:center;gap:5px" onclick="deleteSupplierCredit(${sc.id})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v10a2 2 0 002 2h12a2 2 0 002-2V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg>Archive</button>`}
            </div>
          </div>`;
        }).join('');
      return `<div class="credit-item">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
          <div>
            <div class="credit-name">${g.supplierName}</div>
            <div class="credit-meta">${latestDate}${phoneText} · ${g.count} bill(s)</div>
            <div style="font-size:0.72rem;color:var(--ink2);margin-top:2px"><b>Combined:</b> Total ${fmt(total)} · Paid ${fmt(paid)} · Outstanding ${fmt(due)}</div>
          </div>
          <span class="${settled?'badge-paid':'badge-due'}">${settled?'✅ Settled':'⏳ Outstanding'}</span>
        </div>
        <div class="credit-bar-wrap">
          <div class="credit-bar-fill" style="width:${pct}%;background:${settled?'var(--green)':'var(--blue)'}"></div>
        </div>
        <div class="credit-amounts">
          <span class="credit-paid-tag">Paid: ${fmt(paid)}</span>
          <span class="credit-due-tag" style="color:${settled?'var(--green)':'var(--red)'}">${settled?'Settled':'Outstanding: '+fmt(due)}</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          ${(!settled && openBillCount > 1)?`<button class="pay-btn" style="background:var(--blue)" onclick='openSupplierPayModalByKey(${JSON.stringify(g.key)})'>🏪 Pay All Bills</button>`:''}
        </div>
        ${billRows}
      </div>`;
    }, 'creditList', '');
    return;
  }

  const groupedCustomers = groupCustomerCredits(cm.filteredList);
  if(groupedCustomers.length===0) {
    const hint = creditFilter==='due' && allCredits.length>0
      ? '<div class="empty-text" style="margin-top:4px;color:var(--ink2)">No outstanding now. Switch to All/Settled for history.</div>'
      : '';
    document.getElementById('creditList').innerHTML=`<div class="empty"><div class="empty-icon">💳</div><div class="empty-text">No customer credit records</div>${hint}</div>`;
    return;
  }
  renderPaged('creditList', groupedCustomers, g=>{
    const pct = g.total>0 ? Math.min(100,(g.paid/g.total*100)).toFixed(0) : 0;
    const settled = g.due<=0.001;
    const openBillCount = g.bills.filter(c => getCreditDue(c) > 0.001).length;
    const phoneText = g.customerPhone ? ` · 📞 ${g.customerPhone}` : '';
    const billRows = g.bills
      .slice()
      .sort((a,b)=>new Date(b.date)-new Date(a.date))
      .map(credit => {
        const due = getCreditDue(credit);
        const totalPaid = getCreditTotalPaid(credit);
        const initialPaid = round2(Number(credit.paid) || 0);
        const bSettled = due<=0.001;
        const dateStr = displayDateTime(credit.date) || dateToYMDLocal(credit.date);
        const payments = data.payments.filter(p=>String(p.creditId)===String(credit.id)).slice().sort((a,b)=>new Date(a.date)-new Date(b.date));
        // Product breakdown
        const cProds = (credit.products||[]).map(p=>{const pr=getProd(p.productId);const sub=round2((p.qty||0)*(p.price||0));return {name:pr?.name||'?',unit:pr?.unit||'',qty:p.qty||0,price:p.price||0,sub};});
        const cProdBreakdown = cProds.length>0?`<div id="cbd_${credit.id}" style="display:none;margin-top:8px;border-radius:7px;background:var(--surface2);padding:6px 8px"><div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink2);margin-bottom:5px">Bill Breakdown</div><table style="width:100%;border-collapse:collapse;font-size:0.72rem"><thead><tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:3px 4px;color:var(--ink2);font-weight:600">Product</th><th style="text-align:right;padding:3px 4px;color:var(--ink2);font-weight:600">Qty</th><th style="text-align:right;padding:3px 4px;color:var(--ink2);font-weight:600">Unit Price</th><th style="text-align:right;padding:3px 4px;color:var(--ink2);font-weight:600">Subtotal</th></tr></thead><tbody>${cProds.map(r=>`<tr style="border-bottom:1px dashed var(--border)"><td style="padding:4px 4px;font-weight:600">${r.name}</td><td style="text-align:right;padding:4px 4px;color:var(--ink2)">${r.qty} ${r.unit}</td><td style="text-align:right;padding:4px 4px;color:var(--ink2)">${fmt(r.price)}</td><td style="text-align:right;padding:4px 4px;font-weight:700">${fmt(r.sub)}</td></tr>`).join('')}</tbody><tfoot><tr style="border-top:1.5px solid var(--border)"><td colspan="3" style="text-align:right;padding:5px 4px;font-weight:700;color:var(--ink2)">Total</td><td style="text-align:right;padding:5px 4px;font-weight:700;color:var(--ink);font-size:0.82rem">${fmt(credit.total)}</td></tr></tfoot></table></div>`:'';
        // Payment history
        const histRows = [];
        if(initialPaid > 0) histRows.push(`<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px dashed var(--border)"><span style="font-size:0.68rem;color:var(--ink2)">📅 ${dateStr} &nbsp;·&nbsp; Initial</span><span style="font-size:0.7rem;font-weight:700;color:var(--green)">+${fmt(initialPaid)}</span></div>`);
        payments.forEach(p=>{const pDate=displayDateTime(p.date)||dateToYMDLocal(p.date);const note=p.note?` · ${p.note}`:'';histRows.push(`<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px dashed var(--border)"><span style="font-size:0.68rem;color:var(--ink2)">📅 ${pDate}${note}</span><div style="display:flex;align-items:center;gap:3px"><span style="font-size:0.7rem;font-weight:700;color:var(--green)">+${fmt(Number(p.amount)||0)}</span><button onclick="editPaymentEntry('${p.id}','customer')" style="background:none;border:none;cursor:pointer;font-size:0.78rem;padding:1px 4px;color:var(--gold);line-height:1" title="Edit">✏️</button><button onclick="deletePaymentEntry('${p.id}','customer')" style="background:none;border:none;cursor:pointer;font-size:0.78rem;padding:1px 4px;color:var(--red);line-height:1" title="Delete">🗑</button></div></div>`);});
        const histHtml = histRows.length>0
          ? `<div style="margin-top:7px;border-radius:7px;background:var(--green-light);padding:5px 8px"><div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink2);margin-bottom:3px">Payment History</div>${histRows.join('')}<div style="display:flex;justify-content:space-between;padding-top:4px"><span style="font-size:0.68rem;font-weight:700;color:var(--ink2)">Total Paid</span><span style="font-size:0.7rem;font-weight:700;color:var(--green)">${fmt(totalPaid)}</span></div></div>`
          : `<div style="margin-top:5px;font-size:0.68rem;color:var(--ink2)">No payments recorded yet.</div>`;
        return `<div style="border:1px dashed var(--border);border-radius:8px;padding:8px 9px;margin-top:8px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;cursor:pointer" onclick="(function(){var d=document.getElementById('cbd_${credit.id}');if(d)d.style.display=d.style.display==='none'?'block':'none';})()">
            <div>
              <div style="font-size:0.78rem;font-weight:700;color:var(--ink)">${credit.billId ? `Bill ${credit.billId}` : `Tx #${credit.txId}`} <span style="font-size:0.65rem;color:var(--gold);font-weight:600">▾ Details</span></div>
              <div style="font-size:0.72rem;color:var(--ink2)">${dateStr} · ${(credit.products||[]).map(p=>{const pr=getProd(p.productId);return `${p.qty} ${pr?.unit||''} ${pr?.name||'?'}`;}).join(', ')}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:0.78rem;color:${bSettled?'var(--green)':'var(--red)'};font-weight:700">${bSettled?'✅ Settled':`Due: ${fmt(due)}`}</div>
            </div>
          </div>
          ${cProdBreakdown}
          ${histHtml}
          <div style="display:flex;gap:8px;margin-top:7px">
            ${!bSettled?`<button class="pay-btn" onclick="openPayModal(${credit.id})">💰 Pay This Bill</button>`:''}
            ${bSettled?`<button class="pay-btn" style="background:var(--ink2);display:inline-flex;align-items:center;gap:5px" onclick="deleteCredit(${credit.id})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v10a2 2 0 002 2h12a2 2 0 002-2V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg>Archive</button>`:''}
          </div>
        </div>`;
      }).join('');
    return `<div class="credit-item">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
        <div>
          <div class="credit-name">${g.customerName}</div>
          <div class="credit-meta">${g.count} bill(s)${phoneText}</div>
          <div style="font-size:0.72rem;color:var(--ink2);margin-top:2px"><b>Combined:</b> Total ${fmt(g.total)} · Paid ${fmt(g.paid)} · Outstanding ${fmt(g.due)}</div>
        </div>
        <span class="${settled?'badge-paid':'badge-due'}">${settled?'✅ Settled':'⏳ Outstanding'}</span>
      </div>
      <div class="credit-bar-wrap">
        <div class="credit-bar-fill" style="width:${pct}%;background:${settled?'var(--green)':'var(--gold)'}"></div>
      </div>
      <div class="credit-amounts">
        <span class="credit-paid-tag">Paid: ${fmt(g.paid)}</span>
        <span class="credit-due-tag" style="color:${settled?'var(--green)':'var(--red)'}">${settled?'Settled':'Outstanding: '+fmt(g.due)}</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:9px">
        ${(!settled && openBillCount > 1)?`<button class="pay-btn" onclick='openPayModalByCustomerKey(${JSON.stringify(g.key)})'>💰 Pay All Bills</button>`:''}
      </div>
      ${billRows}
    </div>`;
  }, 'creditList', '');
}
