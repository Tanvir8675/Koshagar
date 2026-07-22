// modules/inventory.js — Opening / initial stock
// Phase 3 extraction. Classic script sharing index.html's global scope.
// Depends on globals: data, round2, fmt, toast, todayStr, escapeHtml,
// dateToYMDLocal, displayDateTime, getProd, getLastPurchasePrice, makeTimeId, auditLog,
// runEngineCommand, requireMonthUnlockOverride, toIsoFromLocalDate, cdInit,
// cdSetValue, cdClear. Loaded after the main script, before bootstrap.

// ── OPENING / INITIAL STOCK ──────────────────────────────────────
// Inventory the shop already had at start. Stored as purchase transactions
// flagged opening:true so they flow into stock + FIFO value automatically,
// but computeFinancialSnapshot excludes them from period purchase/cash
// metrics (no cash was spent now). price = cost keeps the total = qty × price
// validator invariant; cashPaid = 0; no supplier credit.
let editingOpeningId = null;
let openingPriceMode = 'unit';

function openingHasPurchases(productId, excludeTxId = null) {
  if(!productId || productId === '__CAPITAL__') return true;
  return (getTxByProduct().get(productId) || []).some(t =>
    t && t.type === 'purchase' && String(t.id) !== String(excludeTxId || '')
  );
}

function resolveOpeningLineUnit(productId) {
  const p = getProd(productId);
  const establishedBase = String(p?.unit || '').trim();
  const sel = String(document.getElementById('openLineUnit')?.value || '').trim() || establishedBase;
  const N = parseFloat(document.getElementById('openLineVarFactor')?.value);
  const target = String(document.getElementById('openLineVarTarget')?.value || '').trim();
  const firstPurchase = !openingHasPurchases(productId, editingOpeningId);
  const mk = (baseUnit, factor, o = {}) => ({
    entryUnit: sel || baseUnit,
    unit: sel || baseUnit,
    baseUnit,
    factor: (Number.isFinite(factor) && factor > 0) ? factor : 1,
    needsRatio: !!o.needsRatio,
    setsBase: !!o.setsBase
  });
  if(!p) return mk(establishedBase || sel, 1);
  if(sel && establishedBase && sel.toUpperCase() === establishedBase.toUpperCase() && !firstPurchase) {
    return mk(establishedBase, 1);
  }
  if(firstPurchase) {
    if(isMeasureUnit(sel)) {
      const canon = dimensionBaseUnit(sel) || sel;
      const f = convertStandardUnit(1, sel, canon);
      const factor = (f && f > 0) ? f : 1;
      return mk(canon, factor, { setsBase: canon.toUpperCase() !== establishedBase.toUpperCase() });
    }
    const tgt = target || 'PCS';
    const canon = dimensionBaseUnit(tgt) || tgt;
    const perTarget = (canon.toUpperCase() === tgt.toUpperCase()) ? 1 : (convertStandardUnit(1, tgt, canon) || 1);
    const factor = (Number.isFinite(N) && N > 0) ? round2(N * perTarget) : N;
    return mk(canon, factor, { needsRatio: true, setsBase: true });
  }
  const base = establishedBase;
  const sellable = (typeof getSellableUnits === 'function') ? getSellableUnits(p) : getProductUnits(p);
  const known = sellable.find(u => u.name.toUpperCase() === sel.toUpperCase() && !u.isBase);
  if(known && known.factor > 0) return mk(base, known.factor);
  if(isMeasureUnit(sel)) {
    const f = convertStandardUnit(1, sel, base);
    if(f && f > 0) return mk(base, f);
    return mk(base, 1);
  }
  const tgt = target || base;
  const perTarget = (tgt.toUpperCase() === base.toUpperCase()) ? 1 : (convertStandardUnit(1, tgt, base) || 0);
  if(perTarget > 0 && Number.isFinite(N) && N > 0) return mk(base, round2(N * perTarget), { needsRatio: true });
  return mk(base, N, { needsRatio: true });
}

function refreshOpeningPurchaseFeatures() {
  const row = document.getElementById('openLineUnitRow');
  const sel = document.getElementById('openLineUnit');
  if(!row || !sel) return;
  const p = getProd(document.getElementById('openProduct')?.value);
  if(!p) {
    row.style.display = 'none';
    sel.innerHTML = '';
    const varRow = document.getElementById('openLineVarRow');
    if(varRow) varRow.style.display = 'none';
    updateOpeningPreview();
    return;
  }
  row.style.display = '';
  const names = [];
  const seen = new Set();
  const addUnit = (u) => {
    const n = String(u || '').trim();
    const k = n.toUpperCase();
    if(n && !seen.has(k)) { seen.add(k); names.push(n); }
  };
  addUnit(p.unit);
  (Array.isArray(p.altUnits) ? p.altUnits : []).forEach(a => addUnit(a && a.name));
  DEFAULT_UNITS.forEach(addUnit);
  (Array.isArray(data.units) ? data.units : []).forEach(addUnit);
  const prev = sel.value;
  sel.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
  sel.value = names.find(n => n.toUpperCase() === String(prev || '').toUpperCase())
    || names.find(n => n.toUpperCase() === String(p.unit || '').toUpperCase())
    || names.find(n => n.toUpperCase() === 'PCS')
    || names[0] || '';
  onOpenLineUnitChange();
}

function onOpenLineUnitChange() {
  const varRow = document.getElementById('openLineVarRow');
  const varInp = document.getElementById('openLineVarFactor');
  const targetSel = document.getElementById('openLineVarTarget');
  const lbl = document.getElementById('openLineVarLbl');
  const p = getProd(document.getElementById('openProduct')?.value);
  if(!varRow || !p) { updateOpeningPreview(); return; }
  const sel = String(document.getElementById('openLineUnit')?.value || '');
  const r = resolveOpeningLineUnit(p.id);
  const isContainerSelection = !!sel && !isMeasureUnit(sel);
  if(r.needsRatio && isContainerSelection) {
    if(lbl) lbl.textContent = `1 ${sel} =`;
    if(targetSel) {
      const firstPurchase = !openingHasPurchases(p.id, editingOpeningId);
      const opts = measureTargetOptions(p.unit, firstPurchase);
      const prev = targetSel.value;
      targetSel.innerHTML = opts.map(u => `<option value="${u}">${u}</option>`).join('');
      targetSel.value = opts.find(u => u.toUpperCase() === String(prev || '').toUpperCase())
        || (firstPurchase ? (opts.find(u => u.toUpperCase() === 'PCS') || opts[0])
                          : (opts.find(u => u.toUpperCase() === String(p.unit || '').toUpperCase()) || opts[0]))
        || '';
    }
    varRow.style.display = '';
  } else {
    varRow.style.display = 'none';
    if(varInp) varInp.value = '';
  }
  updateOpeningPreview();
}

function setOpeningPriceMode(mode) {
  openingPriceMode = (mode === 'total') ? 'total' : 'unit';
  const tog = document.getElementById('openBulkCostToggle');
  if(tog) tog.checked = (openingPriceMode === 'total');
  const listLbl = document.getElementById('openListPriceLbl');
  if(listLbl) listLbl.textContent = openingPriceMode === 'total' ? 'Company / List Total ৳' : 'Company / List Price per Unit ৳';
  const costLbl = document.getElementById('openCostLbl');
  if(costLbl) costLbl.textContent = openingPriceMode === 'total' ? 'Total Cost ৳ (unit cost is auto-calculated)' : 'Unit cost (purchase price)';
  recomputeOpeningNet();
}

function readOpeningCostingFields(entryFactor) {
  const factor = Number(entryFactor) > 0 ? Number(entryFactor) : 1;
  const g = id => parseFloat(document.getElementById(id)?.value);
  const list = g('openListPrice');
  const dType = document.getElementById('openDiscType')?.value === 'amount' ? 'amount' : 'percent';
  const dVal = g('openDiscValue');
  const extraCost = g('openLandedCost');
  const qtyEntered = parseFloat(document.getElementById('openQty')?.value) || 0;
  const bulk = openingPriceMode === 'total';
  const costInput = g('openCost');
  const baseQty = round2(qtyEntered * factor);
  const productTotal = bulk ? round2(costInput || 0) : round2(qtyEntered * (costInput || 0));
  const out = {};
  if(Number.isFinite(list) && list > 0) {
    const listR = round2(list);
    let discAmt = 0;
    if(dType === 'percent') { const pct = Number.isFinite(dVal) ? clamp(round2(dVal), 0, 100) : 0; discAmt = round2(listR * pct / 100); }
    else { discAmt = Number.isFinite(dVal) ? clamp(round2(dVal), 0, listR) : 0; }
    if(bulk && qtyEntered > 0) {
      out.listUnitPrice = round2(listR / qtyEntered);
      out.discountAmount = round2(discAmt / qtyEntered);
    } else {
      out.listUnitPrice = listR;
      out.discountAmount = discAmt;
    }
    out.discountPercent = out.listUnitPrice > 0 ? round2(out.discountAmount / out.listUnitPrice * 100) : 0;
  }
  if(Number.isFinite(extraCost) && extraCost > 0) {
    out.lineExtraCost = round2(extraCost);
    if(baseQty > 0) out.landedUnitCost = Number(((productTotal + out.lineExtraCost) / baseQty).toFixed(6));
  }
  return out;
}

function recomputeOpeningNet() {
  const summary = document.getElementById('openingDiscountSummary');
  const list = parseFloat(document.getElementById('openListPrice')?.value);
  if(!Number.isFinite(list) || list <= 0) {
    if(summary) summary.textContent = '';
    updateOpeningPreview();
    return;
  }
  const dType = document.getElementById('openDiscType')?.value === 'amount' ? 'amount' : 'percent';
  const dVal = parseFloat(document.getElementById('openDiscValue')?.value);
  let discAmt = 0;
  if(dType === 'percent') { const pct = Number.isFinite(dVal) ? clamp(dVal, 0, 100) : 0; discAmt = round2(list * pct / 100); }
  else { discAmt = Number.isFinite(dVal) ? clamp(dVal, 0, list) : 0; }
  const net = round2(Math.max(0, list - discAmt));
  const priceEl = document.getElementById('openCost');
  if(priceEl) priceEl.value = net;
  if(summary) summary.textContent = (openingPriceMode === 'total' ? 'Actual Total Cost ৳' : 'Actual Cost / unit ৳') + ' = ' + fmt(net);
  updateOpeningPreview();
}

function resetOpeningDiscountInputs() {
  ['openListPrice','openDiscValue','openLandedCost','openSupplier','openSupplierPhone'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  const dt = document.getElementById('openDiscType'); if(dt) dt.value = 'percent';
  const s = document.getElementById('openingDiscountSummary'); if(s) s.textContent = '';
}

function updateOpeningPreview() {
  const box = document.getElementById('openPreview');
  if(!box) return;
  const productId = document.getElementById('openProduct')?.value;
  const p = getProd(productId);
  const qty = parseFloat(document.getElementById('openQty')?.value) || 0;
  const costInput = parseFloat(document.getElementById('openCost')?.value) || 0;
  if(!p || qty <= 0) { box.style.display = 'none'; return; }
  let r = { entryUnit: p.unit || '', factor: 1, baseUnit: p.unit || '' };
  try { r = resolveOpeningLineUnit(productId); } catch(e) { console.warn('opening unit conversion failed:', e); }
  const factor = Number(r.factor) || 1;
  const baseQty = round2(qty * factor);
  const total = openingPriceMode === 'total' ? round2(costInput) : round2(qty * costInput);
  const extraCost = round2(Math.max(0, parseFloat(document.getElementById('openLandedCost')?.value) || 0));
  const totalWithExtra = round2(total + extraCost);
  const unitCost = baseQty > 0 ? round2(totalWithExtra / baseQty) : 0;
  const qtyText = factor !== 1 ? `${qty} ${r.entryUnit || ''} (${baseQty} ${r.baseUnit || p.unit || ''})` : `${qty} ${r.baseUnit || p.unit || ''}`;
  box.style.display = 'block';
  box.innerHTML = `
    <div class="preview-row"><span class="preview-label">Product</span><span class="preview-val">${escapeHtml(p.name)}</span></div>
    <div class="preview-row"><span class="preview-label">Qty → Unit Cost</span><span class="preview-val">${qtyText} → ${fmt(unitCost)}/${escapeHtml(r.baseUnit || p.unit || 'unit')}</span></div>
    ${extraCost > 0 ? `<div class="preview-row"><span class="preview-label">Extra Costing</span><span class="preview-val">+${fmt(extraCost)}</span></div>` : ''}
    <div class="preview-row"><span class="preview-label">Total Opening Value</span><span class="preview-val" style="color:var(--gold);font-size:1.05rem">${fmt(totalWithExtra)}</span></div>
  `;
}

function refreshOpeningStockUiNow() {
  if(typeof invalidateCoreCalcState === 'function') invalidateCoreCalcState();
  if(typeof updateDataLists === 'function') updateDataLists();
  if(typeof renderStock === 'function') renderStock(stockFilter, stockCategory);
  else {
    if(typeof renderOpeningList === 'function') renderOpeningList();
    if(typeof populateAdjustForm === 'function') populateAdjustForm();
  }
  if(typeof renderDashboard === 'function') renderDashboard();
}

function fillOpenCostDefault() {
  const costEl = document.getElementById('openCost');
  const pid = document.getElementById('openProduct')?.value;
  if(!costEl || !pid) return;
  costEl.value = round2(getLastPurchasePrice(pid) || 0);
  refreshOpeningPurchaseFeatures();
  updateOpeningPreview();
}

function populateOpeningForm() {
  if(document.getElementById('cdWrap_openProduct')) cdInit('openProduct', data.products || []);
  const d = document.getElementById('openDate'); if(d && !d.value) setAppDateValue(d);
  refreshOpeningPurchaseFeatures();
  renderOpeningList();
}

function resetOpenFormFields() {
  editingOpeningId = null;
  cdClear('openProduct');
  ['openQty', 'openCost', 'openNote', 'openLineVarFactor'].forEach(id => { const e = document.getElementById(id); if(e) e.value = ''; });
  resetOpeningDiscountInputs();
  setOpeningPriceMode('unit');
  refreshOpeningPurchaseFeatures();
  const preview = document.getElementById('openPreview'); if(preview) preview.style.display = 'none';
  const d = document.getElementById('openDate'); if(d) setAppDateValue(d);
  const btn = document.getElementById('openSaveBtn'); if(btn) { btn.textContent = 'Record Opening Stock'; btn.style.background = 'var(--green)'; }
}

function toggleOpenSection() {
  const sec = document.getElementById('openingStockView');
  if(!sec) return;
  if(getComputedStyle(sec).display === 'none') {
    const adj = document.getElementById('stockAdjustView'); if(adj) adj.style.display = 'none';
    resetOpenFormFields();
    populateOpeningForm();
    sec.style.display = '';
    if(typeof setStockBrowseVisible === 'function') setStockBrowseVisible(false);
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    sec.style.display = 'none';
    if(typeof setStockBrowseVisible === 'function') setStockBrowseVisible(true);
  }
}

function cancelEditOpening() {
  resetOpenFormFields();
  const sec = document.getElementById('openingStockView'); if(sec) sec.style.display = 'none';
  if(typeof setStockBrowseVisible === 'function') setStockBrowseVisible(true);
}

function startEditOpening(id) {
  const tx = (data.transactions || []).find(t => String(t.id) === String(id) && t.type === 'purchase' && t.opening);
  if(!tx) return;
  const sec = document.getElementById('openingStockView'); if(sec) sec.style.display = '';
  populateOpeningForm();
  editingOpeningId = String(id);
  cdSetValue('openProduct', tx.productId);
  refreshOpeningPurchaseFeatures();
  const set = (elId, val) => { const e = document.getElementById(elId); if(e) e.value = val; };
  setOpeningPriceMode('unit');
  const unitSel = document.getElementById('openLineUnit');
  if(unitSel && tx.entryUnit) {
    unitSel.value = tx.entryUnit;
    onOpenLineUnitChange();
  }
  set('openQty', tx.entryQty || tx.qty);
  set('openCost', tx.netUnitCost || tx.price || tx.cost);
  set('openLandedCost', Number(tx.lineExtraCost) > 0 ? round2(Number(tx.lineExtraCost)) : '');
  set('openListPrice', tx.listUnitPrice || '');
  set('openDiscType', 'percent');
  set('openDiscValue', tx.discountPercent || '');
  set('openSupplier', tx.supplier || '');
  set('openSupplierPhone', tx.supplierPhone || '');
  setAppDateValue('openDate', tx.date);
  set('openNote', tx.note || '');
  updateOpeningPreview();
  const btn = document.getElementById('openSaveBtn'); if(btn) { btn.textContent = '✔ Update Opening Stock'; btn.style.background = 'var(--blue)'; }
  sec?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderOpeningList() {
  const el = document.getElementById('openList');
  if(!el) return;
  const list = (data.transactions || [])
    .filter(t => t.type === 'purchase' && t.opening)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 30);
  if(!list.length) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--ink2);padding:4px 0">No opening stock recorded.</div>';
    return;
  }
  el.innerHTML = list.map(t => {
    const p = getProd(t.productId);
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:0.82rem;font-weight:600">${escapeHtml(p?.name || String(t.productId))}</div>
        <div style="font-size:0.68rem;color:var(--ink2)">${displayDateTime(t.date) || dateToYMDLocal(t.date)} · qty ${fmt(t.qty)} @ ${fmt(t.cost)}${t.note ? ` · ${escapeHtml(t.note)}` : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-family:'Instrument Serif',serif;font-size:0.95rem;color:var(--green)">${fmt(round2((Number(t.cost) || 0) * (Number(t.qty) || 0)))}</span>
        <button onclick="startEditOpening('${t.id}')" style="background:none;border:none;color:var(--blue);font-size:0.95rem;cursor:pointer;padding:3px 6px;border-radius:6px;opacity:0.75" title="Edit">✏️</button>
        <button onclick="deleteOpeningStock('${t.id}')" class="del-btn" style="font-size:0.8rem;padding:3px 7px">🗑</button>
      </div>
    </div>`;
  }).join('');
}

async function addOpeningStock() {
  const productId = document.getElementById('openProduct')?.value;
  const entryQty = round2(parseFloat(document.getElementById('openQty')?.value));
  const costInput = round2(parseFloat(document.getElementById('openCost')?.value));
  const date = readAppDateValue('openDate');
  const note = (document.getElementById('openNote')?.value || '').trim() || 'Opening stock';
  const supplier = (document.getElementById('openSupplier')?.value || '').trim();
  const supplierPhone = normalizePhone(document.getElementById('openSupplierPhone')?.value || '');
  const r = resolveOpeningLineUnit(productId);
  const selectedUnit = String(document.getElementById('openLineUnit')?.value || '').trim();
  if(r.needsRatio && selectedUnit && !isMeasureUnit(selectedUnit)) {
    const ov = parseFloat(document.getElementById('openLineVarFactor')?.value);
    if(!Number.isFinite(ov) || ov <= 0) { toast('⚠️ Enter the unit conversion (1 unit = how many base)'); return; }
  }
  const factor = Number(r.factor) || 1;
  const qty = round2(entryQty * factor);
  const total = openingPriceMode === 'total' ? round2(costInput) : round2(entryQty * costInput);
  const unitCost = qty > 0 ? Number((total / qty).toFixed(6)) : 0;
  const costing = readOpeningCostingFields(factor);
  const discType = document.getElementById('openDiscType')?.value === 'amount' ? 'amount' : 'percent';
  const discVal = parseFloat(document.getElementById('openDiscValue')?.value);
  if(discType === 'percent' && Number.isFinite(discVal) && (discVal < 0 || discVal > 100)) { toast('⚠️ Discount % must be between 0 and 100'); return; }
  if(Number.isFinite(discVal) && discVal < 0) { toast('⚠️ Discount cannot be negative'); return; }
  const listPrice = parseFloat(document.getElementById('openListPrice')?.value);
  if(Number.isFinite(listPrice) && listPrice < 0) { toast('⚠️ List price cannot be negative'); return; }
  const landed = parseFloat(document.getElementById('openLandedCost')?.value);
  if(Number.isFinite(landed) && landed < 0) { toast('⚠️ Extra costing cannot be negative'); return; }
  if(!productId) { toast('⚠️ Select a product'); return; }
  if(!qty || qty <= 0) { toast('⚠️ Enter a valid quantity'); return; }
  if(!Number.isFinite(unitCost) || unitCost < 0) { toast('⚠️ Enter the unit cost'); return; }
  const editing = editingOpeningId;
  if(!(await requireMonthUnlockOverride(date, editing ? 'opening stock edit' : 'opening stock'))) return;
  if(editing) {
    await runEngineCommand({
      label: 'updateOpeningStock',
      refresh: 'tx',
      successToast: '✅ Opening stock updated',
      mutate: async () => {
        const tx = (data.transactions || []).find(t => String(t.id) === String(editing) && t.type === 'purchase' && t.opening);
        if(tx) {
          if(r.setsBase && r.baseUnit) {
            const prod = getProd(productId);
            if(prod && prod.id !== '__CAPITAL__') prod.unit = r.baseUnit;
          }
          if(r.entryUnit && isContainerUnit(r.entryUnit)) {
            const prod = getProd(productId);
            if(prod && prod.id !== '__CAPITAL__') upsertProductAltUnit(prod, r.entryUnit, factor);
          }
          tx.productId = productId;
          tx.qty = qty;
          tx.price = unitCost;
          tx.cost = unitCost;
          tx.entryUnit = r.entryUnit || '';
          tx.entryFactor = factor;
          tx.entryQty = entryQty;
          tx.netUnitCost = unitCost;
          tx.listUnitPrice = costing.listUnitPrice;
          tx.discountPercent = costing.discountPercent;
          tx.discountAmount = costing.discountAmount;
          tx.landedUnitCost = costing.landedUnitCost;
          tx.lineExtraCost = costing.lineExtraCost || 0;
          tx.grossAmount = (costing.listUnitPrice != null) ? round2(costing.listUnitPrice * entryQty) : undefined;
          tx.discountTotal = (costing.discountAmount != null) ? round2(costing.discountAmount * entryQty) : undefined;
          tx.netAmount = total;
          tx.total = total;
          tx.supplier = supplier;
          tx.supplierPhone = supplierPhone;
          tx.note = note;
          tx.date = toIsoFromLocalDate(date);
        }
      },
      onSuccess: () => {
        cancelEditOpening();
        refreshOpeningStockUiNow();
        setTimeout(refreshOpeningStockUiNow, 0);
      }
    });
  } else {
    await runEngineCommand({
      label: 'addOpeningStock',
      refresh: 'tx',
      successToast: '✅ Opening stock recorded',
      mutate: async () => {
        const newTxId = makeTimeId('tx');
        if(r.setsBase && r.baseUnit) {
          const prod = getProd(productId);
          if(prod && prod.id !== '__CAPITAL__') prod.unit = r.baseUnit;
        }
        if(r.entryUnit && isContainerUnit(r.entryUnit)) {
          const prod = getProd(productId);
          if(prod && prod.id !== '__CAPITAL__') upsertProductAltUnit(prod, r.entryUnit, factor);
        }
        data.transactions.push({
          id: newTxId,
          type: 'purchase',
          opening: true,
          returnType: undefined,
          linkedTxId: undefined,
          productId,
          qty,
          entryUnit: r.entryUnit || '',
          entryFactor: factor,
          entryQty,
          price: unitCost, // keep total = qty × price invariant (validator)
          netUnitCost: unitCost,
          listUnitPrice: costing.listUnitPrice,
          discountPercent: costing.discountPercent,
          discountAmount: costing.discountAmount,
          landedUnitCost: costing.landedUnitCost,
          lineExtraCost: costing.lineExtraCost || 0,
          grossAmount: (costing.listUnitPrice != null) ? round2(costing.listUnitPrice * entryQty) : undefined,
          discountTotal: (costing.discountAmount != null) ? round2(costing.discountAmount * entryQty) : undefined,
          netAmount: total,
          cost: unitCost,
          total,
          cashPaid: 0, // opening stock is not a cash purchase
          supplier,
          supplierPhone,
          customer: '',
          note,
          date: toIsoFromLocalDate(date)
        });
        auditLog('tx_saved', auditTxContext(data.transactions.find(t => String(t.id) === String(newTxId)), {
          opening: true,
          value: total,
          note
        }));
      },
      onSuccess: () => {
        const q = document.getElementById('openQty'); if(q) q.value = '';
        const c = document.getElementById('openCost'); if(c) c.value = '';
        updateOpeningPreview();
        refreshOpeningStockUiNow();
        setTimeout(refreshOpeningStockUiNow, 0);
      }
    });
  }
}

async function deleteOpeningStock(id) {
  const tx = (data.transactions || []).find(t => String(t.id) === String(id) && t.type === 'purchase' && t.opening);
  if(!tx) return;
  if(editingOpeningId === String(id)) cancelEditOpening();
  if(!(await requireMonthUnlockOverride(dateToYMDLocal(tx.date), 'opening stock delete'))) return;
  await runEngineCommand({
    label: 'deleteOpeningStock',
    refresh: 'tx',
    successToast: '🗑️ Opening stock removed',
    mutate: async () => {
      data.transactions = data.transactions.filter(t => !(String(t.id) === String(id) && t.type === 'purchase' && t.opening));
      auditLog('tx_deleted', auditTxContext(tx, { reason: 'opening_stock_delete' }));
    },
    onSuccess: () => {
      refreshOpeningStockUiNow();
      setTimeout(refreshOpeningStockUiNow, 0);
    }
  });
}
// ── END OPENING / INITIAL STOCK ──────────────────────────────────
