// modules/inventory.js — Opening / initial stock
// Phase 3 extraction. Classic script sharing index.html's global scope.
// Depends on globals: data, round2, fmt, toast, todayStr, escapeHtml,
// dateToYMDLocal, getProd, getLastPurchasePrice, makeTimeId, auditLog,
// runEngineCommand, requireMonthUnlockOverride, toIsoFromLocalDate, cdInit,
// cdSetValue, cdClear. Loaded after the main script, before bootstrap.

// ── OPENING / INITIAL STOCK ──────────────────────────────────────
// Inventory the shop already had at start. Stored as purchase transactions
// flagged opening:true so they flow into stock + FIFO value automatically,
// but computeFinancialSnapshot excludes them from period purchase/cash
// metrics (no cash was spent now). price = cost keeps the total = qty × price
// validator invariant; cashPaid = 0; no supplier credit.
let editingOpeningId = null;

function fillOpenCostDefault() {
  const costEl = document.getElementById('openCost');
  const pid = document.getElementById('openProduct')?.value;
  if(!costEl || !pid) return;
  costEl.value = round2(getLastPurchasePrice(pid) || 0);
}

function populateOpeningForm() {
  if(document.getElementById('cdWrap_openProduct')) cdInit('openProduct', data.products || []);
  const d = document.getElementById('openDate'); if(d && !d.value) d.value = todayStr();
  renderOpeningList();
}

function resetOpenFormFields() {
  editingOpeningId = null;
  cdClear('openProduct');
  ['openQty', 'openCost', 'openNote'].forEach(id => { const e = document.getElementById(id); if(e) e.value = ''; });
  const d = document.getElementById('openDate'); if(d) d.value = todayStr();
  const btn = document.getElementById('openSaveBtn'); if(btn) { btn.textContent = 'Record Opening Stock'; btn.style.background = 'var(--green)'; }
}

function toggleOpenSection() {
  const sec = document.getElementById('openingStockView');
  if(!sec) return;
  if(getComputedStyle(sec).display === 'none') {
    resetOpenFormFields();
    populateOpeningForm();
    sec.style.display = '';
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    sec.style.display = 'none';
  }
}

function cancelEditOpening() {
  resetOpenFormFields();
  const sec = document.getElementById('openingStockView'); if(sec) sec.style.display = 'none';
}

function startEditOpening(id) {
  const tx = (data.transactions || []).find(t => String(t.id) === String(id) && t.type === 'purchase' && t.opening);
  if(!tx) return;
  const sec = document.getElementById('openingStockView'); if(sec) sec.style.display = '';
  populateOpeningForm();
  editingOpeningId = String(id);
  cdSetValue('openProduct', tx.productId);
  const set = (elId, val) => { const e = document.getElementById(elId); if(e) e.value = val; };
  set('openQty', tx.qty);
  set('openCost', tx.cost);
  set('openDate', dateToYMDLocal(tx.date));
  set('openNote', tx.note || '');
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
        <div style="font-size:0.68rem;color:var(--ink2)">${dateToYMDLocal(t.date)} · qty ${fmt(t.qty)} @ ${fmt(t.cost)}${t.note ? ` · ${escapeHtml(t.note)}` : ''}</div>
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
  const qty = round2(parseFloat(document.getElementById('openQty')?.value));
  const unitCost = round2(parseFloat(document.getElementById('openCost')?.value));
  const date = document.getElementById('openDate')?.value || todayStr();
  const note = (document.getElementById('openNote')?.value || '').trim() || 'Opening stock';
  if(!productId) { toast('⚠️ Select a product'); return; }
  if(!qty || qty <= 0) { toast('⚠️ Enter a valid quantity'); return; }
  if(!Number.isFinite(unitCost) || unitCost < 0) { toast('⚠️ Enter the unit cost'); return; }
  const editing = editingOpeningId;
  if(!(await requireMonthUnlockOverride(date, editing ? 'opening stock edit' : 'opening stock'))) return;
  if(editing) {
    await runEngineCommand({
      label: 'updateOpeningStock',
      refresh: 'both',
      successToast: '✅ Opening stock updated',
      mutate: async () => {
        const tx = (data.transactions || []).find(t => String(t.id) === String(editing) && t.type === 'purchase' && t.opening);
        if(tx) {
          tx.productId = productId;
          tx.qty = qty;
          tx.price = unitCost;
          tx.cost = unitCost;
          tx.total = round2(qty * unitCost);
          tx.note = note;
          tx.date = toIsoFromLocalDate(date);
        }
      },
      onSuccess: () => cancelEditOpening()
    });
  } else {
    await runEngineCommand({
      label: 'addOpeningStock',
      refresh: 'both',
      successToast: '✅ Opening stock recorded',
      mutate: async () => {
        const newTxId = makeTimeId('tx');
        data.transactions.push({
          id: newTxId,
          type: 'purchase',
          opening: true,
          returnType: undefined,
          linkedTxId: undefined,
          productId,
          qty,
          price: unitCost, // keep total = qty × price invariant (validator)
          cost: unitCost,
          total: round2(qty * unitCost),
          cashPaid: 0, // opening stock is not a cash purchase
          supplier: '',
          customer: '',
          note,
          date: toIsoFromLocalDate(date)
        });
        auditLog('tx_saved', { txId: newTxId, type: 'purchase', opening: true, qty, value: round2(qty * unitCost) });
      },
      onSuccess: () => {
        const q = document.getElementById('openQty'); if(q) q.value = '';
        const c = document.getElementById('openCost'); if(c) c.value = '';
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
    refresh: 'both',
    successToast: '🗑️ Opening stock removed',
    mutate: async () => {
      data.transactions = data.transactions.filter(t => !(String(t.id) === String(id) && t.type === 'purchase' && t.opening));
    }
  });
}
// ── END OPENING / INITIAL STOCK ──────────────────────────────────
