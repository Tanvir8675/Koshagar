// modules/adjustments.js — Stock adjustments (damage / theft / correction)
// Phase 3 extraction. Classic script sharing index.html's global scope.
// Depends on globals: data, round2, fmt, toast, todayStr, escapeHtml,
// dateToYMDLocal, displayDateTime, readAppDateValue, setAppDateValue, getProd, getStock, getLastPurchasePrice, makeTimeId,
// auditLog, runEngineCommand, requireMonthUnlockOverride, toIsoFromLocalDate,
// cdInit, cdSetValue, cdClear. Loaded after the main script, before bootstrap.

// ── STOCK ADJUSTMENTS (damage / theft / correction) ──────────────
// Stored as transactions (type:'adjustment') so on-hand stock AND FIFO
// inventory value both reduce from the same source (cannot drift). The
// user supplies the per-unit value, which becomes the recorded loss
// (profit decreases). No cash effect. The memo signature already covers
// transactions, so the snapshot cache invalidates automatically.
function fillAdjValueDefault() {
  const valEl = document.getElementById('adjValue');
  const pid = document.getElementById('adjProduct')?.value;
  if(!valEl || !pid) return;
  valEl.value = round2(getLastPurchasePrice(pid) || 0); // suggested loss value; user can override
}

// Populate the searchable product dropdown + date + recent list on the Stock page's adjustment view.
function populateAdjustForm() {
  if(document.getElementById('cdWrap_adjProduct')) cdInit('adjProduct', data.products || []);
  const adjDateEl = document.getElementById('adjDate');
  if(adjDateEl && !adjDateEl.value) setAppDateValue(adjDateEl);
  renderAdjustmentList();
}

let editingAdjustmentId = null;

function resetAdjFormFields() {
  editingAdjustmentId = null;
  cdClear('adjProduct');
  ['adjQty', 'adjValue', 'adjNote'].forEach(id => { const e = document.getElementById(id); if(e) e.value = ''; });
  const dateEl = document.getElementById('adjDate'); if(dateEl) setAppDateValue(dateEl);
  const typeEl = document.getElementById('adjType'); if(typeEl) typeEl.value = 'damage';
  const btn = document.getElementById('adjSaveBtn'); if(btn) { btn.textContent = 'Record Adjustment'; btn.style.background = 'var(--red)'; }
  if(typeof onAdjTypeChange === 'function') onAdjTypeChange();
}

function cancelEditAdjustment() {
  resetAdjFormFields();
  const sec = document.getElementById('stockAdjustView'); if(sec) sec.style.display = 'none';
  if(typeof setStockBrowseVisible === 'function') setStockBrowseVisible(true);
}

function startEditAdjustment(id) {
  const tx = (data.transactions || []).find(t => String(t.id) === String(id) && t.type === 'adjustment');
  if(!tx) return;
  const sec = document.getElementById('stockAdjustView'); if(sec) sec.style.display = '';
  populateAdjustForm();
  editingAdjustmentId = String(id);
  cdSetValue('adjProduct', tx.productId);
  const set = (elId, val) => { const e = document.getElementById(elId); if(e) e.value = val; };
  // The database's word for it is not always the form's word: correction_out is
  // simply "Correction" on screen. Without the translation the select fell
  // through to its first option, so editing a correction offered to record it
  // as Damage - and saving would have changed what the adjustment WAS.
  set('adjType', adjustmentTypeForForm(tx.adjustmentType));
  set('adjQty', tx.qty);
  set('adjValue', tx.cost);
  setAppDateValue('adjDate', tx.date);
  set('adjNote', tx.note || '');
  if(typeof onAdjTypeChange === 'function') onAdjTypeChange();
  const btn = document.getElementById('adjSaveBtn'); if(btn) { btn.textContent = '✔ Update Adjustment'; btn.style.background = 'var(--blue)'; }
  sec?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderAdjustmentList() {
  const el = document.getElementById('adjList');
  if(!el) return;
  const adj = (data.transactions || [])
    .filter(t => t.type === 'adjustment')
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 20);
  if(!adj.length) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--ink2);padding:4px 0">No stock adjustments yet.</div>';
    return;
  }
  el.innerHTML = adj.map(t => {
    const p = getProd(t.productId);
    const label = t.adjustmentType || 'adjustment';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:0.82rem;font-weight:600">${escapeHtml(p?.name || String(t.productId))} · ${escapeHtml(label)}</div>
        <div style="font-size:0.68rem;color:var(--ink2)">${displayDateTime(t.date) || dateToYMDLocal(t.date)} · qty ${fmt(t.qty)}${t.note ? ` · ${escapeHtml(t.note)}` : ''}</div>
        ${txEditNote(t)}
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-family:'Instrument Serif',serif;font-size:0.95rem;color:${t.adjustmentType === 'correction_in' ? 'var(--green)' : 'var(--red)'}">${t.adjustmentType === 'correction_in' ? '+' : '-'}${fmt(Number.isFinite(Number(t.total)) && Number(t.total) > 0 ? round2(t.total) : round2((Number(t.cost) || 0) * (Number(t.qty) || 0)))}</span>
        <button onclick="startEditAdjustment('${t.id}')" style="background:none;border:none;color:var(--blue);font-size:0.95rem;cursor:pointer;padding:3px 6px;border-radius:6px;opacity:0.75" title="Edit">✏️</button>
        <button onclick="deleteStockAdjustment('${t.id}')" class="del-btn" style="font-size:0.8rem;padding:3px 7px">🗑</button>
      </div>
    </div>`;
  }).join('');
}

// The form asks for two numbers whose meaning flips with the type: for a
// write-off they describe goods leaving and what that cost; for found stock they
// describe goods arriving and what they are worth. Leaving the labels saying
// "removed" while adding stock is how a shopkeeper records the opposite of what
// they meant.
function onAdjTypeChange() {
  const adding = (document.getElementById('adjType')?.value || '') === 'correction_in';
  const qtyLabel = document.getElementById('adjQtyLabel');
  const valLabel = document.getElementById('adjValueLabel');
  const saveBtn = document.getElementById('adjSaveBtn');
  if(qtyLabel) qtyLabel.textContent = adding ? 'Quantity found (added to stock)' : 'Quantity removed';
  if(valLabel) {
    valLabel.textContent = adding
      ? 'Cost per unit (what these goods cost you — they enter stock at this price)'
      : 'Value per unit (your loss valuation — old or new price)';
  }
  // Green for stock coming in, red for stock going out. The button is the last
  // thing looked at before saving.
  if(saveBtn) saveBtn.style.background = adding ? 'var(--green)' : 'var(--red)';
}

// What the screen calls it, and what the database calls it.
//
// 'correction' on its own is a decrease - that is what the form has always
// meant by it, and renaming the option would silently reinterpret every
// adjustment already recorded. The increase is its own kind.
// The reverse: what the form should show for an adjustment already recorded.
function adjustmentTypeForForm(kind) {
  const k = String(kind || '');
  if(k === 'correction_out') return 'correction';
  if(k === 'correction_in')  return 'correction_in';
  return (k === 'damage' || k === 'theft') ? k : 'damage';
}

function adjustmentKindFor(type) {
  if(type === 'correction') return 'correction_out';
  if(type === 'correction_in') return 'correction_in';
  return type;                       // damage and theft: the same word both sides
}

// Does this kind put goods ON the shelf? Only one does, but asking the question
// by name is clearer than testing the string in four places.
const adjustmentAddsStock = (kind) => kind === 'correction_in';

async function addStockAdjustment() {
  const productId = document.getElementById('adjProduct')?.value;
  const type = document.getElementById('adjType')?.value || 'damage';
  const kind = adjustmentKindFor(type);
  const qty = round2(parseFloat(document.getElementById('adjQty')?.value));
  const unitValue = round2(parseFloat(document.getElementById('adjValue')?.value));
  const date = readAppDateValue('adjDate');
  const note = (document.getElementById('adjNote')?.value || '').trim();
  if(!productId) { toast('⚠️ Select a product'); return; }
  if(!qty || qty <= 0) { toast('⚠️ Enter a valid quantity'); return; }
  if(!Number.isFinite(unitValue) || unitValue < 0) { toast('⚠️ Enter the value per unit'); return; }
  const editing = editingAdjustmentId;
  if(!(await requireMonthUnlockOverride(date, editing ? 'stock adjustment edit' : 'stock adjustment'))) return;
  const oldTx = editing ? (data.transactions || []).find(t => String(t.id) === String(editing) && t.type === 'adjustment') : null;
  // The stock cap applies only when goods are LEAVING. Found stock is not
  // limited by what the books already show - the whole point of recording it is
  // that the books were short.
  if(!adjustmentAddsStock(kind)) {
    let available = getStock(productId);
    // When editing the same product, add its existing removal back before the cap check.
    if(oldTx && String(oldTx.productId) === String(productId)
       && String(oldTx.adjustmentType || '') !== 'correction_in') {
      available = round2(available + (Number(oldTx.qty) || 0));
    }
    if(qty > available + 0.0001) {
      toast(`⚠️ Only ${fmt(available)} in stock — cannot remove ${fmt(qty)}`);
      return;
    }
  }
  if(editing) {
    await runEngineCommand({
      label: 'updateStockAdjustment',
      refresh: 'both',
      successToast: '✅ Adjustment updated',
      // The database puts the written-off stock back and takes the corrected
      // quantity out again, in one transaction - so the shelf, the stock value
      // and the loss reported for the day all move together.
      server: () => KoshWrite.editAdjustment({
        id: editing,
        date,
        kind,
        productId,
        unit: (getProd(productId) || {}).unit,
        qtyEntered: Math.abs(qty),
        unitCost: unitValue,
        reason: note,
        summary: describeChanges([
          ['Product', oldTx && oldTx.productId, productId, id => (getProd(id) || {}).name || '-'],
          ['Type', String((oldTx && oldTx.adjustmentType) || ''), type],
          ['Qty', round2(Number(oldTx && oldTx.qty) || 0), qty, fmt],
          ['Value/unit', round2(Number(oldTx && oldTx.cost) || 0), unitValue, fmt],
          ['Date', dateToYMDLocal(oldTx && oldTx.date) || '', date]
        ])
      }),
      onSuccess: () => cancelEditAdjustment()
    });
  } else {
    await runEngineCommand({
      label: 'addStockAdjustment',
      refresh: 'both',
      successToast: adjustmentAddsStock(kind)
      ? '✅ Stock increase recorded'
      : '✅ Stock adjustment recorded',
      server: () => KoshWrite.postAdjustment({
        date,
        kind,
        productId,
        unit: (getProd(productId) || {}).unit,
        qtyEntered: Math.abs(qty),
        unitCost: unitValue,
        reason: note
      }),
      onSuccess: () => {
        // The whole form, for the same reason as opening stock: a half-cleared
        // form still names a product, and the next quantity typed into it goes
        // to that one.
        resetAdjFormFields();
        populateAdjustForm();
      }
    });
  }
}

async function deleteStockAdjustment(id) {
  const tx = (data.transactions || []).find(t => String(t.id) === String(id) && t.type === 'adjustment');
  if(!tx) return;
  if(editingAdjustmentId === String(id)) cancelEditAdjustment();
  if(!(await requireMonthUnlockOverride(dateToYMDLocal(tx.date), 'stock adjustment delete'))) return;
  await runEngineCommand({
    label: 'deleteStockAdjustment',
    refresh: 'both',
    successToast: '🗑️ Adjustment removed',
    server: () => KoshWrite.reverse({ type: 'adjustment', id, reason: 'Removed in the app' }),
  });
}
// ── END STOCK ADJUSTMENTS ────────────────────────────────────────
