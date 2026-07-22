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
  set('adjType', tx.adjustmentType || 'damage');
  set('adjQty', tx.qty);
  set('adjValue', tx.cost);
  setAppDateValue('adjDate', tx.date);
  set('adjNote', tx.note || '');
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
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-family:'Instrument Serif',serif;font-size:0.95rem;color:var(--red)">-${fmt(round2((Number(t.cost) || 0) * (Number(t.qty) || 0)))}</span>
        <button onclick="startEditAdjustment('${t.id}')" style="background:none;border:none;color:var(--blue);font-size:0.95rem;cursor:pointer;padding:3px 6px;border-radius:6px;opacity:0.75" title="Edit">✏️</button>
        <button onclick="deleteStockAdjustment('${t.id}')" class="del-btn" style="font-size:0.8rem;padding:3px 7px">🗑</button>
      </div>
    </div>`;
  }).join('');
}

async function addStockAdjustment() {
  const productId = document.getElementById('adjProduct')?.value;
  const type = document.getElementById('adjType')?.value || 'damage';
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
  let available = getStock(productId);
  // When editing the same product, add its existing removal back before the cap check.
  if(oldTx && String(oldTx.productId) === String(productId)) available = round2(available + (Number(oldTx.qty) || 0));
  if(qty > available + 0.0001) {
    toast(`⚠️ Only ${fmt(available)} in stock — cannot remove ${fmt(qty)}`);
    return;
  }
  if(editing) {
    await runEngineCommand({
      label: 'updateStockAdjustment',
      refresh: 'both',
      successToast: '✅ Adjustment updated',
      mutate: async () => {
        const tx = (data.transactions || []).find(t => String(t.id) === String(editing) && t.type === 'adjustment');
        if(tx) {
          tx.productId = productId;
          tx.adjustmentType = type;
          tx.qty = qty;
          tx.price = unitValue;
          tx.cost = unitValue;
          tx.total = round2(qty * unitValue);
          tx.note = note;
          tx.date = toIsoFromLocalDate(date);
        }
      },
      onSuccess: () => cancelEditAdjustment()
    });
  } else {
    await runEngineCommand({
      label: 'addStockAdjustment',
      refresh: 'both',
      successToast: '✅ Stock adjustment recorded',
      mutate: async () => {
        const newTxId = makeTimeId('tx');
        data.transactions.push({
          id: newTxId,
          type: 'adjustment',
          adjustmentType: type,
          returnType: undefined,
          linkedTxId: undefined,
          productId,
          qty,
          price: unitValue, // keep total = qty × price invariant (validator); also the loss value
          cost: unitValue,
          total: round2(qty * unitValue),
          cashPaid: 0,
          supplier: '',
          customer: '',
          note,
          date: toIsoFromLocalDate(date)
        });
        auditLog('tx_saved', auditTxContext(data.transactions.find(t => String(t.id) === String(newTxId)), {
          adjustmentType: type,
          value: round2(qty * unitValue),
          note
        }));
      },
      onSuccess: () => {
        const q = document.getElementById('adjQty'); if(q) q.value = '';
        const n = document.getElementById('adjNote'); if(n) n.value = '';
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
    mutate: async () => {
      data.transactions = data.transactions.filter(t => !(String(t.id) === String(id) && t.type === 'adjustment'));
      auditLog('tx_deleted', auditTxContext(tx, { reason: 'stock_adjustment_delete' }));
    }
  });
}
// ── END STOCK ADJUSTMENTS ────────────────────────────────────────
