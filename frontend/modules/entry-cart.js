// modules/entry-cart.js — Entry bill-cart: totals/discount/profit preview, FIFO
// cost quote, entry-draft persistence, cart render, add/remove item, bill ids.
// Phase 3 extraction. Classic script sharing index.html's global scope; loaded
// after the main script. Runtime-only (entry form), so load order is safe. The
// money/stock mutators (saveEntry, submitBillEntry, editTx, deleteTx) stay in
// index.html. Depends on globals: round2, clamp, entryBillItems,
// entryBillDiscount, entryBillExtraCost, entryType, nextBillId, nextReturnGroupId, data, toast,
// todayStr, quoteFifoSaleUnitCost, getFifoLots, getProd, fmt, getStock,
// cdSetValue, cdClear, storageSet/Get/Remove, ENTRY_DRAFT_KEY, __entryRestoring,
// __entryDraftSaveTimer, updateCreditPreview, updateSupplierPayPreview.

function buildEntryBillMetrics(items, discount, type) {
  const list = Array.isArray(items) ? items : [];
  const mode = type === 'sale' ? 'sale' : (type === 'purchase' ? 'purchase' : 'other');
  const grossTotal = round2(list.reduce((s, it) => s + (Number(it.total) || 0), 0));
  const extraCostTotal = mode === 'purchase'
    ? round2(list.reduce((s, it) => s + (Number(it.lineExtraCost) || 0), 0) + (Number(entryBillExtraCost) || 0))
    : 0;
  const costTotal = round2(list.reduce((s, it) => {
    const exact = Number(it.costTotal);
    return s + (Number.isFinite(exact) && exact >= 0 ? round2(exact) : round2((Number(it.cost) || 0) * (Number(it.qty) || 0)));
  }, 0));
  let discountAmount = 0;
  if(mode === 'sale' && grossTotal > 0) {
    const raw = round2(Number(discount?.value) || 0);
    if(raw > 0) {
      if((discount?.type || 'percent') === 'percent') {
        discountAmount = round2(clamp((grossTotal * raw) / 100, 0, grossTotal));
      } else {
        discountAmount = round2(clamp(raw, 0, grossTotal));
      }
    }
  }
  const netTotal = round2(Math.max(0, grossTotal - discountAmount));
  const profit = mode === 'sale' ? round2(netTotal - costTotal) : 0;
  return { grossTotal, extraCostTotal, discountAmount, netTotal, costTotal, profit };
}
function getEntryBillTotal() {
  return buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType).grossTotal;
}
function getEntryBillDiscountAmount() {
  return buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType).discountAmount;
}
function getEntryBillNetTotal() {
  return buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType).netTotal;
}
function getEntryBillPayableTotal() {
  const metrics = buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType);
  return entryType === 'purchase'
    ? round2(metrics.netTotal + metrics.extraCostTotal)
    : metrics.netTotal;
}
function getEntryBillCreditBaseTotal() {
  return buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType).netTotal;
}
function getEntryBillCostTotal() {
  return buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType).costTotal;
}
function getEntryBillProfit() {
  return buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType).profit;
}
function makeBillId() {
  return nextBillId++;
}
function makeReturnGroupId(returnType, linkedBaseTx, entryDateStr) {
  const srcBillId = String(linkedBaseTx?.billId || '').trim();
  const linkedTxKey = String(linkedBaseTx?.id || '').trim();
  const sameType = String(returnType || '');

  const existing = (data.transactions || []).find(t => {
    if(!t || t.type !== 'return' || !t.returnGroupId) return false;
    if(String(t.returnType || '') !== sameType) return false;
    if(srcBillId) return String(t.sourceBillId || '') === srcBillId;
    if(linkedTxKey) return String(t.linkedTxId || '') === linkedTxKey;
    return false;
  });
  if(existing) return existing.returnGroupId;
  return nextReturnGroupId++;
}
function getEntryWorkingTotal() {
  if((entryType === 'sale' || entryType === 'purchase') && entryBillItems.length > 0) {
    // Credit/due preview uses the party bill amount only. Purchase extra costing
    // is a separate cash-out, not supplier payable.
    return typeof getEntryBillCreditBaseTotal === 'function' ? getEntryBillCreditBaseTotal() : getEntryBillNetTotal();
  }
  const qty = parseFloat(document.getElementById('eQty')?.value) || 0;
  const price = parseFloat(document.getElementById('ePrice')?.value) || 0;
  return (entryType === 'purchase' && typeof entryPriceMode !== 'undefined' && entryPriceMode === 'total')
    ? round2(price)
    : round2(qty * price);
}
function readCurrentEntryLine(showToast=true) {
  const productId = document.getElementById('eProduct').value;
  const entryQty = round2(parseFloat(document.getElementById('eQty').value)); // in chosen unit
  // For PURCHASE this field is the line's TOTAL cost; for SALE it's unit price.
  const price = round2(parseFloat(document.getElementById('ePrice').value));
  if(!productId || !Number.isFinite(entryQty) || !Number.isFinite(price)) {
    if(showToast) toast('⚠️ Fill product, qty and ' + (entryType === 'purchase' ? 'total cost' : 'price'));
    return null;
  }
  if(entryQty <= 0) {
    if(showToast) toast('⚠️ Quantity must be greater than 0');
    return null;
  }
  if(price < 0) {
    if(showToast) toast(entryType === 'purchase' ? '⚠️ Total cost cannot be negative' : '⚠️ Price cannot be negative');
    return null;
  }
  // A container/other unit must have its "1 unit = N base" conversion filled in.
  if(typeof validateEntryUnitFactor === 'function' && !validateEntryUnitFactor(productId, showToast)) return null;
  // 4b — convert the chosen unit to the product's base (stock) unit. Money is
  // kept exact (entryQty × price); the stored per-base price is derived so the
  // qty×price invariant still holds within tolerance. Factor 1 for simple
  // products / sale, so behaviour there is unchanged.
  const conv = (typeof resolveEntryLineUnit === 'function')
    ? resolveEntryLineUnit(productId)
    : { unit: getProd(productId)?.unit || '', factor: 1, baseUnit: getProd(productId)?.unit || '', setsBase: false };
  const qty = round2(entryQty * (Number(conv.factor) || 1));
  if(!(qty > 0)) {
    if(showToast) toast('⚠️ Invalid unit conversion');
    return null;
  }
  // Purchase 'total' mode: field IS the line total cost. Purchase 'unit' mode or
  // sale: total = qty × unit price.
  const total = (entryType === 'purchase' && entryPriceMode === 'total')
    ? round2(price)
    : round2(entryQty * price);
  const pricePerBase = qty > 0 ? Number((total / qty).toFixed(6)) : price;
  const saleDate = readAppDateValue('eDate');
  const reservedQty = entryType === 'sale'
    ? round2(entryBillItems.filter(it => it.productId === productId).reduce((s, it) => s + (Number(it.qty) || 0), 0))
    : 0;
  const fifoQuote = entryType === 'sale' && typeof quoteFifoSaleCost === 'function'
    ? quoteFifoSaleCost(productId, qty, saleDate, reservedQty)
    : null;
  const fifoCost = fifoQuote ? (fifoQuote.unitCost || 0) : quoteFifoSaleUnitCost(productId, qty, saleDate, reservedQty);
  if(entryType === 'sale' && getFifoLots(productId).length === 0) {
    if(showToast) toast('⚠️ No purchase history. Add a purchase first');
    return null;
  }
  const line = {
    productId,
    qty,                 // base (stock) units
    price: pricePerBase, // per base unit
    cost: entryType === 'sale' ? fifoCost : pricePerBase,
    costTotal: entryType === 'sale' ? round2(fifoQuote?.totalCost || round2(qty * fifoCost)) : undefined,
    supplier: (document.getElementById('eSupplier').value || '').trim(),
    entryUnit: conv.unit,
    entryFactor: Number(conv.factor) || 1,
    entryQty,
    baseUnit: conv.baseUnit || '',     // product stock unit this line resolves to
    setsBase: !!conv.setsBase          // first purchase → this unit defines product.unit
  };
  line.total = total;
  // Distributor-discount / extra costing (purchase bill lines). netUnitCost is
  // the per-base net cost; list/discount are reference; landedUnitCost is net +
  // extra costing distributed per base unit for valuation/COGS.
  if(entryType === 'purchase' && typeof readPurchaseCostingFields === 'function') {
    const c = readPurchaseCostingFields(line.entryFactor);
    line.netUnitCost = pricePerBase;
    if(c.listUnitPrice != null) { line.listUnitPrice = c.listUnitPrice; line.discountPercent = c.discountPercent; line.discountAmount = c.discountAmount; }
    if(c.landedUnitCost != null) line.landedUnitCost = c.landedUnitCost;
    if(c.lineExtraCost != null) line.lineExtraCost = c.lineExtraCost;
  }
  return line;
}
// —— ENTRY DRAFT PERSISTENCE ————————————————————————————————————————————————
// Keeps the in-progress entry/bill alive across app switches (e.g. opening the
// calculator) and full page reloads triggered by the OS evicting the tab.
function captureEntryInputs() {
  const g = id => (document.getElementById(id)?.value || '');
  return {
    product: g('eProduct'),
    qty: g('eQty'),
    price: g('ePrice'),
    cost: g('eCost'),
    date: g('eDate'),
    supplier: g('eSupplier'),
    supplierPhone: g('eSupplierPhone'),
    saleCustomer: g('eSaleCustomer'),
    saleCustomerPhone: g('eSaleCustomerPhone'),
    returnReason: g('eReturnReason'),
    listPrice: g('eListPrice'),
    discType: (document.getElementById('eDiscType')?.value || 'percent'),
    discValue: g('eDiscValue'),
    landedCost: g('eLandedCost')
  };
}
function saveEntryDraft() {
  try {
    if(__entryRestoring) return;
    const inputs = captureEntryInputs();
    const hasItems = Array.isArray(entryBillItems) && entryBillItems.length > 0;
    const hasInput = !!(inputs.product || inputs.qty || inputs.price || inputs.supplier ||
      inputs.saleCustomer || inputs.saleCustomerPhone || inputs.returnReason);
    const hasDiscount = !!(entryBillDiscount && Number(entryBillDiscount.value) > 0);
    const hasBillExtraCost = !!(Number(entryBillExtraCost) > 0);
    if(!hasItems && !hasInput && !hasDiscount && !hasBillExtraCost) {
      clearEntryDraft();
      return;
    }
    const draft = {
      type: entryType,
      items: entryBillItems,
      discount: entryBillDiscount,
      extraCost: round2(Number(entryBillExtraCost) || 0),
      inputs,
      ts: Date.now()
    };
    storageSet('local', ENTRY_DRAFT_KEY, JSON.stringify(draft));
  } catch(e) {
    console.warn('saveEntryDraft failed:', e);
  }
}
// Debounced variant for high-frequency callers like typing in qty/price.
function saveEntryDraftDebounced() {
  if(__entryRestoring) return;
  if(__entryDraftSaveTimer) clearTimeout(__entryDraftSaveTimer);
  __entryDraftSaveTimer = setTimeout(() => { __entryDraftSaveTimer = null; saveEntryDraft(); }, 400);
}
function readEntryDraft() {
  try {
    const raw = storageGet('local', ENTRY_DRAFT_KEY);
    if(!raw) return null;
    const draft = JSON.parse(raw);
    if(!draft || typeof draft !== 'object') return null;
    return draft;
  } catch(e) {
    console.warn('readEntryDraft failed:', e);
    return null;
  }
}
function clearEntryDraft() {
  try { storageRemove('local', ENTRY_DRAFT_KEY); } catch(e) {}
}
// Re-apply a saved draft into memory + the form. Caller sets __entryRestoring.
// restoreInputLine: when false, the in-progress current line (product/qty/price/
// cost) is left blank instead of being restored — used on ordinary in-app
// navigation back to the entry page so no product stays auto-selected. The bill
// cart, discount, date and supplier/customer context are always restored.
function applyEntryDraft(draft, restoreInputLine = true) {
  if(!draft) return;
  try {
    entryBillItems = Array.isArray(draft.items) ? draft.items : [];
    entryBillDiscount = (draft.discount && typeof draft.discount === 'object')
      ? { type: draft.discount.type === 'amount' ? 'amount' : 'percent', value: Number(draft.discount.value) || 0 }
      : { type: 'percent', value: 0 };
    entryBillExtraCost = round2(Number(draft.extraCost) || 0);
    const i = draft.inputs || {};
    const setVal = (id, v) => { const el = document.getElementById(id); if(el) el.value = (v == null ? '' : v); };
    if(restoreInputLine) {
      // eProduct is a custom dropdown: restore the visible label too.
      if(i.product) cdSetValue('eProduct', i.product); else cdClear('eProduct');
      setVal('eQty', i.qty);
      setVal('ePrice', i.price);
      setVal('eCost', i.cost);
      setVal('eListPrice', i.listPrice);
      const dtEl = document.getElementById('eDiscType'); if(dtEl) dtEl.value = (i.discType === 'amount' ? 'amount' : 'percent');
      setVal('eDiscValue', i.discValue);
      setVal('eLandedCost', i.landedCost);
    } else {
      // Start the current input line fresh — no auto-selected product.
      cdClear('eProduct');
      setVal('eQty', '');
      setVal('ePrice', '');
      setVal('eCost', '');
    }
    if(i.date) setVal('eDate', i.date);
    setVal('eSupplier', i.supplier);
    setVal('eSupplierPhone', i.supplierPhone);
    setVal('eSaleCustomer', i.saleCustomer);
    setVal('eSaleCustomerPhone', i.saleCustomerPhone);
    setVal('eReturnReason', i.returnReason);
    // 4b — repopulate the unit selector so a restored purchase converts on the
    // right unit (else a coil qty could be mis-saved as base units).
    if(typeof refreshEntryUnitSelector === 'function') { try { refreshEntryUnitSelector(); } catch(_) {} }
  } catch(e) {
    console.warn('applyEntryDraft failed:', e);
  }
}
function renderEntryBillCart() {
  const row = document.getElementById('entryBillRow');
  const cart = document.getElementById('entryBillCart');
  if(!row || !cart) return;
  if(!(entryType === 'sale' || entryType === 'purchase')) {
    row.style.display = 'none';
    cart.style.display = 'none';
    return;
  }
  row.style.display = 'block';
  if(entryBillItems.length === 0) {
    cart.style.display = 'none';
    return;
  }
  cart.style.display = 'block';
  const lines = entryBillItems.map((it, idx) => {
    const p = getProd(it.productId);
    const meta = entryType === 'purchase' && it.supplier ? ` · ${it.supplier}` : '';
    const baseUnit = p?.unit || '';
    const converted = it.entryUnit && it.entryUnit !== baseUnit;
    const qtyInfo = converted
      ? `${it.entryQty} ${it.entryUnit} (${it.qty} ${baseUnit})`
      : `${it.qty} ${baseUnit} × ${fmt(it.price)}`;
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:0.82rem">
        <div style="font-weight:700">${p?.name||'?'}${meta}</div>
        <div style="color:var(--ink2)">${qtyInfo} = ${fmt(it.total)}</div>
      </div>
      <button class="del-btn" type="button" onclick="removeEntryBillItem(${idx})" title="Remove">✕</button>
    </div>`;
  }).join('');
  const billTotal = getEntryBillTotal();
  const billExtraCost = buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType).extraCostTotal;
  const billDiscount = getEntryBillDiscountAmount();
  const billNetTotal = getEntryBillNetTotal();
  const billProfit = getEntryBillProfit();
  const profitLabel = billProfit >= 0 ? 'Estimated Profit' : 'Estimated Loss';
  const profitHtml = entryType === 'sale'
    ? `<div style="display:flex;justify-content:space-between;align-items:center;padding-top:4px"><span style="font-size:0.82rem;color:var(--ink2)">${profitLabel}</span><b style="color:${billProfit>=0?'var(--green)':'var(--red)'}">${fmt(billProfit)}</b></div>`
    : '';
  const discountValueAttr = Number(entryBillDiscount.value) > 0 ? ` value="${round2(Number(entryBillDiscount.value))}"` : '';
  const extraCostValueAttr = Number(entryBillExtraCost) > 0 ? ` value="${round2(Number(entryBillExtraCost))}"` : '';
  const discountUi = entryType === 'sale' ? `<div style="margin-top:10px">
    <div style="font-size:0.72rem;font-weight:700;color:var(--ink2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px">Select Discount Type</div>
    <div style="display:grid;grid-template-columns:120px 1fr;gap:8px">
    <select id="entryBillDiscountType" onchange="onEntryBillDiscountTypeChange()">
      <option value="percent" ${(entryBillDiscount.type||'percent')==='percent'?'selected':''}>Discount %</option>
      <option value="amount" ${(entryBillDiscount.type||'percent')==='amount'?'selected':''}>Discount Amount</option>
    </select>
    <input id="entryBillDiscountValue" type="number" min="0" step="0.01"${discountValueAttr} oninput="onEntryBillDiscountValueInput(false)" onchange="onEntryBillDiscountValueInput(true)" onblur="onEntryBillDiscountValueInput(true)" placeholder="0">
    </div>
  </div>` : '';
  const invoiceExtraUi = entryType === 'purchase' ? `<div style="display:grid;grid-template-columns:150px 1fr;gap:8px;margin-top:10px;align-items:center">
    <div style="font-size:0.82rem;color:var(--ink2);font-weight:700">Invoice Extra Costing ৳</div>
    <input id="entryBillExtraCostValue" type="number" min="0" step="0.01"${extraCostValueAttr} oninput="onEntryBillExtraCostInput(false)" onchange="onEntryBillExtraCostInput(true)" onblur="onEntryBillExtraCostInput(true)" placeholder="0.00">
  </div>` : '';
  const discountRow = (entryType === 'sale' && billDiscount>0)
    ? `<div style="display:flex;justify-content:space-between;align-items:center;padding-top:4px"><span style="font-size:0.82rem;color:var(--ink2)">Discount</span><b style="color:var(--red)">-${fmt(billDiscount)}</b></div>`
    : '';
  const extraCostRow = entryType === 'purchase'
    ? `<div id="entryBillExtraCostRow" style="display:${billExtraCost > 0 ? 'flex' : 'none'};justify-content:space-between;align-items:center;padding-top:4px"><span style="font-size:0.82rem;color:var(--ink2)">Extra Costing (cash)</span><b id="entryBillExtraCostDisplay" style="color:var(--red)">+${fmt(billExtraCost)}</b></div>`
    : '';
  const visibleNetTotal = entryType === 'purchase' ? round2(billNetTotal + billExtraCost) : billNetTotal;
  cart.innerHTML = `<div style="font-size:0.75rem;font-weight:700;color:var(--ink2);margin-bottom:6px">Current Bill (${entryBillItems.length} item${entryBillItems.length>1?'s':''})</div>${lines}${discountUi}${invoiceExtraUi}<div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px"><span style="font-size:0.82rem;color:var(--ink2)">Gross Total</span><b style="color:var(--gold)">${fmt(billTotal)}</b></div>${discountRow}${extraCostRow}<div style="display:flex;justify-content:space-between;align-items:center;padding-top:4px"><b>Net Total</b><b id="entryBillNetTotalDisplay" style="color:var(--green)">${fmt(visibleNetTotal)}</b></div>${profitHtml}`;
}

function updateEntryBillCartTotalsOnly() {
  if(!(entryType === 'purchase' && entryBillItems.length > 0)) return;
  const metrics = buildEntryBillMetrics(entryBillItems, entryBillDiscount, entryType);
  const extraEl = document.getElementById('entryBillExtraCostDisplay');
  if(extraEl) extraEl.textContent = '+' + fmt(metrics.extraCostTotal);
  const netEl = document.getElementById('entryBillNetTotalDisplay');
  if(netEl) netEl.textContent = fmt(round2(metrics.netTotal + metrics.extraCostTotal));
  const rowEl = document.getElementById('entryBillExtraCostRow');
  if(rowEl) rowEl.style.display = metrics.extraCostTotal > 0 ? 'flex' : 'none';
}
function onEntryBillDiscountTypeChange() {
  const typeEl = document.getElementById('entryBillDiscountType');
  entryBillDiscount.type = typeEl?.value === 'amount' ? 'amount' : 'percent';
  renderEntryBillCart();
  updateCreditPreview();
  updateSupplierPayPreview();
  if(typeof updatePurchaseFundingPreview === 'function') updatePurchaseFundingPreview();
  saveEntryDraft();
}
function onEntryBillDiscountValueInput(commitRender = false) {
  const valEl = document.getElementById('entryBillDiscountValue');
  const raw = round2(Number(valEl?.value) || 0);
  entryBillDiscount.value = raw < 0 ? 0 : raw;
  if(commitRender) renderEntryBillCart();
  updateCreditPreview();
  updateSupplierPayPreview();
  if(typeof updatePurchaseFundingPreview === 'function') updatePurchaseFundingPreview();
  if(commitRender) saveEntryDraft(); else saveEntryDraftDebounced();
}
function onEntryBillExtraCostInput(commitRender = false) {
  const valEl = document.getElementById('entryBillExtraCostValue');
  const raw = round2(Number(valEl?.value) || 0);
  entryBillExtraCost = raw < 0 ? 0 : raw;
  if(commitRender) renderEntryBillCart(); else updateEntryBillCartTotalsOnly();
  updateSupplierPayPreview();
  if(typeof updatePurchaseFundingPreview === 'function') updatePurchaseFundingPreview();
  if(commitRender) saveEntryDraft(); else saveEntryDraftDebounced();
}
function removeEntryBillItem(idx) {
  if(idx < 0 || idx >= entryBillItems.length) return;
  entryBillItems.splice(idx, 1);
  renderEntryBillCart();
  updateCreditPreview();
  updateSupplierPayPreview();
  if(typeof updatePurchaseFundingPreview === 'function') updatePurchaseFundingPreview();
  saveEntryDraft();
}
function clearEntryBill() {
  entryBillItems = [];
  entryBillDiscount = { type: 'percent', value: 0 };
  entryBillExtraCost = 0;
  renderEntryBillCart();
  updateCreditPreview();
  updateSupplierPayPreview();
  if(typeof updatePurchaseFundingPreview === 'function') updatePurchaseFundingPreview();
}
function addCurrentItemToBill() {
  if(!(entryType === 'sale' || entryType === 'purchase')) {
    toast('⚠️ Bill mode works only for sales and purchases.');
    return;
  }
  const line = readCurrentEntryLine(true);
  if(!line) return;
  if(entryType === 'sale') {
    const already = round2(entryBillItems.filter(it => it.productId === line.productId).reduce((s, it) => s + it.qty, 0));
    const available = round2(getStock(line.productId));
    if(already + line.qty > available + 0.0001) {
      const p = getProd(line.productId);
      toast(`⚠️ Not enough stock for bill. Available: ${Math.max(0, available - already)} ${p?.unit || 'units'}`);
      return;
    }
  }
  entryBillItems.push(line);
  cdClear('eProduct');
  document.getElementById('eQty').value = '';
  document.getElementById('ePrice').value = '';
  document.getElementById('eCost').value = '';
  if(typeof resetPurchaseDiscountInputs === 'function') resetPurchaseDiscountInputs();
  document.getElementById('preview').style.display = 'none';
  renderEntryBillCart();
  updateCreditPreview();
  updateSupplierPayPreview();
  if(typeof updatePurchaseFundingPreview === 'function') updatePurchaseFundingPreview();
  saveEntryDraft();
  toast('✅ Item added to bill');
}
