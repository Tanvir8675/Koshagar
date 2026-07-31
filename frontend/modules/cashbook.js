// modules/cashbook.js — Cash withdrawals (owner drawings)
// Phase 3 extraction. Classic script (loads over file:// and http), shares the
// global scope of index.html. Depends on globals defined there: data, round2,
// fmt, toast, todayStr, displayDateOnly, readAppDateValue, setAppDateValue, requireMonthUnlockOverride, runEngineCommand,
// buildFinancialView, showPage. Loaded after the main script, before bootstrap.

// ── CASH WITHDRAWALS (owner drawings) ────────────────────────────
// Cash taken out of the business by the owner, with a reason. Reduces
// cash-in-hand but is NOT a business expense (does not reduce profit) —
// kept as its own ledger, separate from the disabled capital-out path.
let editingWithdrawalId = null;

function getNextWithdrawalId() {
  const ids = (data.cashWithdrawals || []).map(w => Number(w.id) || 0);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function startEditWithdrawal(id) {
  const w = (data.cashWithdrawals || []).find(x => String(x.id) === String(id));
  if(!w) return;
  editingWithdrawalId = String(id);
  showPage('dashboard');
  setTimeout(() => {
    const amtEl    = document.getElementById('withdrawalAmount');
    const reasonEl = document.getElementById('withdrawalReason');
    const dateEl   = document.getElementById('withdrawalDate');
    const btn      = document.getElementById('withdrawalSaveBtn');
    const cancel   = document.getElementById('withdrawalCancelBtn');
    if(amtEl)    amtEl.value    = w.amount;
    if(reasonEl) reasonEl.value = w.reason;
    if(dateEl)   setAppDateValue(dateEl, w.date);
    if(btn)      { btn.textContent = '✔ Update'; btn.style.background = 'var(--blue)'; }
    if(cancel)   cancel.style.display = 'inline-block';
    amtEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    amtEl?.focus();
  }, 80);
}

function cancelEditWithdrawal() {
  editingWithdrawalId = null;
  const amtEl    = document.getElementById('withdrawalAmount');
  const reasonEl = document.getElementById('withdrawalReason');
  const dateEl   = document.getElementById('withdrawalDate');
  const btn      = document.getElementById('withdrawalSaveBtn');
  const cancel   = document.getElementById('withdrawalCancelBtn');
  if(amtEl)    amtEl.value    = '';
  if(reasonEl) reasonEl.value = '';
  if(dateEl)   setAppDateValue(dateEl);
  if(btn)      { btn.textContent = '+ Add'; btn.style.background = 'var(--ink)'; }
  if(cancel)   cancel.style.display = 'none';
}

async function addCashWithdrawal() {
  const amtEl    = document.getElementById('withdrawalAmount');
  const reasonEl = document.getElementById('withdrawalReason');
  const dateEl   = document.getElementById('withdrawalDate');
  const amt = parseFloat(amtEl?.value);
  if(!amt || amt <= 0) { toast('⚠️ Enter a valid amount'); return; }
  const reason = reasonEl?.value?.trim() || 'Cash withdrawal';
  const date = readAppDateValue(dateEl);
  if(!(await requireMonthUnlockOverride(date, editingWithdrawalId ? 'withdrawal edit' : 'withdrawal add'))) return;
  const cashNow = round2(buildFinancialView('daily', date).cashInHand || 0);
  if(round2(amt) > cashNow + 0.01) {
    toast(`⚠️ Withdrawal ৳${fmt(round2(amt))} exceeds cash in hand ৳${fmt(cashNow)} — cash balance will go negative`);
  }
  if(!data.cashWithdrawals) data.cashWithdrawals = [];

  if(editingWithdrawalId) {
    await runEngineCommand({
      label: 'updateCashWithdrawal',
      refresh: 'dashboard',
      keepDashboardPaging: true,
      successToast: '✅ Withdrawal updated',
      mutate: async () => {
        const w = data.cashWithdrawals.find(x => String(x.id) === editingWithdrawalId);
        if(w) { w.amount = round2(amt); w.reason = reason; w.date = date; }
      },
      onSuccess: () => cancelEditWithdrawal()
    });
  } else {
    await runEngineCommand({
      label: 'addCashWithdrawal',
      refresh: 'dashboard',
      keepDashboardPaging: true,
      successToast: '✅ Withdrawal recorded',
      mutate: async () => {
        data.cashWithdrawals.push({ id: getNextWithdrawalId(), date, amount: round2(amt), reason });
      },
      onSuccess: () => {
        amtEl.value    = '';
        reasonEl.value = '';
      }
    });
  }
}

async function deleteCashWithdrawal(id) {
  if(!data.cashWithdrawals) return;
  if(editingWithdrawalId === String(id)) cancelEditWithdrawal();
  const w = data.cashWithdrawals.find(x => String(x.id) === String(id));
  if(w && !(await requireMonthUnlockOverride(w.date, 'withdrawal delete'))) return;
  await runEngineCommand({
    label: 'deleteCashWithdrawal',
    refresh: 'both',
    keepDashboardPaging: true,
    successToast: '🗑️ Withdrawal removed',
    mutate: async () => {
      data.cashWithdrawals = data.cashWithdrawals.filter(x => String(x.id) !== String(id));
    }
  });
}
// ── END CASH WITHDRAWALS ─────────────────────────────────────────
