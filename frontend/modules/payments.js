// modules/payments.js — Customer & supplier payment / credit-archive modals
// Phase 3 extraction. Classic script sharing index.html's global scope; loaded
// after the main script. Runtime-only (modal buttons), so load order is safe.
// INTEGRITY-SENSITIVE: savePayment / saveSupplierPayment / saveEditPayment /
// deletePaymentEntry mutate money records and persist via runEngineCommand.
// Depends on globals: data, isCreditArchived, getCreditCustomerKey,
// getCreditDue, getSupplierIdentityKey, getSupplierDue, getCreditTotalPaid,
// getSupplierTotalPaid, round2, fmt, todayStr, toast, getProd, dateToYMDLocal,
// makeTimeId, toIsoFromLocalDate, auditLog, runEngineCommand,
// requireMonthUnlockOverride, verifyAdminPinInput, appConfirm, and the modal
// state globals activePayCreditId, activePayCustomerKey, activeSupCreditId,
// activeSupSupplierKey (declared in index.html).

// Inline modal-error helpers — show validation messages INSIDE the pay modal
// (the toast renders behind the modal overlay, so it was invisible). Falls back
// to toast if the error element is missing.
function setPayError(elId, msg) {
  const e = document.getElementById(elId);
  if(!e) { toast(msg); return; }
  e.textContent = (typeof trPhrase === 'function') ? trPhrase(msg) : msg;
  e.style.display = 'block';
}
function clearPayError(elId) {
  const e = document.getElementById(elId);
  if(e) { e.textContent = ''; e.style.display = 'none'; }
}

function creditAuditContext(credit, extra = {}) {
  const p = credit?.productId ? getProd(credit.productId) : null;
  return cleanAuditDetails({
    creditId: credit?.id,
    txId: credit?.txId,
    billId: credit?.billId,
    customer: credit?.customerName,
    customerPhone: credit?.customerPhone,
    product: p?.name || credit?.productId,
    total: credit?.total,
    paidBefore: getCreditTotalPaid(credit),
    dueBefore: getCreditDue(credit),
    date: dateToYMDLocal(credit?.date),
    ...extra
  });
}

function supplierCreditAuditContext(sc, extra = {}) {
  const p = sc?.productId ? getProd(sc.productId) : null;
  return cleanAuditDetails({
    scId: sc?.id,
    txId: sc?.txId,
    billId: sc?.billId,
    supplier: sc?.supplierName,
    supplierPhone: sc?.supplierPhone,
    product: p?.name || sc?.productId,
    total: sc?.total,
    paidBefore: getSupplierTotalPaid(sc),
    dueBefore: getSupplierDue(sc),
    date: dateToYMDLocal(sc?.date),
    ...extra
  });
}

function getOpenCustomerCreditsByKey(customerKey) {
  return (data.credits || [])
    .filter(c => !isCreditArchived(c) && getCreditCustomerKey(c) === customerKey && getCreditDue(c) > 0.0001)
    .sort((a,b)=>new Date(a.date)-new Date(b.date));
}
function getOpenSupplierCreditsByKey(supplierKey) {
  return (data.supplierCredits || [])
    .filter(sc => !isCreditArchived(sc) && getSupplierIdentityKey(sc) === supplierKey && getSupplierDue(sc) > 0.0001)
    .sort((a,b)=>new Date(a.date)-new Date(b.date));
}

function openPayModalByCustomerKey(customerKey) {
  const credits = getOpenCustomerCreditsByKey(customerKey);
  if(!credits.length) { toast('⚠️ No unpaid bill found for this person.'); return; }
  activePayCreditId = null;
  activePayCustomerKey = customerKey;
  const total = round2(credits.reduce((s,c)=>s+(Number(c.total)||0),0));
  const paid = round2(credits.reduce((s,c)=>s+getCreditTotalPaid(c),0));
  const due = round2(credits.reduce((s,c)=>s+getCreditDue(c),0));
  const titleName = credits[0].customerName || 'Customer';
  document.getElementById('payModalSub').textContent = `Combined payment for ${titleName} (${credits.length} bill${credits.length>1?'s':''})`;
  document.getElementById('pmTotal').textContent = fmt(total);
  document.getElementById('pmPaid').textContent  = fmt(paid);
  document.getElementById('pmDue').textContent   = fmt(due);
  document.getElementById('pmAmount').value      = '';
  document.getElementById('pmAmount').max        = due;
  document.getElementById('pmNote').value        = '';
  setAppDateValue('pmDate');
  document.getElementById('pmPreview').style.display = 'none';
  document.getElementById('payModalOverlay').classList.add('active');
  document.getElementById('payModal').style.display = 'block';
  setTimeout(()=>document.getElementById('pmAmount').focus(),100);
}

function openSupplierPayModalByKey(supplierKey) {
  const credits = getOpenSupplierCreditsByKey(supplierKey);
  if(!credits.length) { toast('⚠️ No unpaid bill found for this person.'); return; }
  activeSupCreditId = null;
  activeSupSupplierKey = supplierKey;
  const total = round2(credits.reduce((s,c)=>s+(Number(c.total)||0),0));
  const paid = round2(credits.reduce((s,c)=>s+getSupplierTotalPaid(c),0));
  const due = round2(credits.reduce((s,c)=>s+getSupplierDue(c),0));
  const titleName = credits[0].supplierName || 'Supplier';
  document.getElementById('supPayModalSub').textContent = `Combined payment to ${titleName} (${credits.length} bill${credits.length>1?'s':''})`;
  document.getElementById('supPmTotal').textContent = fmt(total);
  document.getElementById('supPmPaid').textContent  = fmt(paid);
  document.getElementById('supPmDue').textContent   = fmt(due);
  document.getElementById('supPmAmount').value      = '';
  document.getElementById('supPmNote').value        = '';
  setAppDateValue('supPmDate');
  document.getElementById('supPmPreview').style.display = 'none';
  document.getElementById('supPayModalOverlay').classList.add('active');
  document.getElementById('supPayModal').style.display = 'block';
  setTimeout(()=>document.getElementById('supPmAmount').focus(),100);
}

function openPayModal(creditId) {
  const credit = data.credits.find(c=>c.id===creditId);
  if(!credit) return;
  activePayCreditId = creditId;
  activePayCustomerKey = null;
  const due       = getCreditDue(credit);
  const totalPaid = getCreditTotalPaid(credit);
  document.getElementById('payModalSub').textContent = 'Payment for ' + credit.customerName + '\'s credit account';
  document.getElementById('pmTotal').textContent = fmt(credit.total);
  document.getElementById('pmPaid').textContent  = fmt(totalPaid);
  document.getElementById('pmDue').textContent   = fmt(due);
  document.getElementById('pmAmount').value      = '';
  document.getElementById('pmAmount').max        = due;
  document.getElementById('pmNote').value        = '';
  setAppDateValue('pmDate');
  document.getElementById('pmPreview').style.display = 'none';
  document.getElementById('payModalOverlay').classList.add('active');
  document.getElementById('payModal').style.display = 'block';
  setTimeout(()=>document.getElementById('pmAmount').focus(),100);
}

function updatePayPreview() {
  clearPayError('pmError');
  let due = 0;
  if(activePayCreditId !== null) {
    const credit = data.credits.find(c=>c.id===activePayCreditId);
    if(!credit) return;
    due = getCreditDue(credit);
  } else if(activePayCustomerKey) {
    due = round2(getOpenCustomerCreditsByKey(activePayCustomerKey).reduce((s,c)=>s+getCreditDue(c),0));
  } else return;
  const paying = parseFloat(document.getElementById('pmAmount').value)||0;
  const after  = Math.max(0, due-paying);
  const prev   = document.getElementById('pmPreview');
  if(paying>0) {
    prev.style.display='block';
    document.getElementById('pmRemaining').textContent = after<=0?'✅ Fully Settled!':fmt(after);
  } else {
    prev.style.display='none';
  }
}

function closePayModal() {
  clearPayError('pmError');
  activePayCreditId = null;
  activePayCustomerKey = null;
  document.getElementById('payModalOverlay').classList.remove('active');
  document.getElementById('payModal').style.display = 'none';
}

async function savePayment() {
  const amount = round2(parseFloat(document.getElementById('pmAmount').value));
  const date   = readAppDateValue('pmDate');
  if(!(await requireMonthUnlockOverride(date, 'customer due payment'))) return;
  const note   = document.getElementById('pmNote').value.trim();
  const due = activePayCreditId !== null
    ? getCreditDue(data.credits.find(c=>c.id===activePayCreditId))
    : round2(getOpenCustomerCreditsByKey(activePayCustomerKey).reduce((s,c)=>s+getCreditDue(c),0));
  clearPayError('pmError');
  if(!amount||amount<=0) { setPayError('pmError', '⚠️ Enter a valid amount greater than 0'); return; }
  if(!moneyLte(amount, due)) { setPayError('pmError', '⚠️ The amount cannot be more than the outstanding balance.'); return; }
  if(activePayCreditId === null && !activePayCustomerKey) { setPayError('pmError', '⚠️ No credit selected'); return; }
  await runEngineCommand({
    label: 'savePayment',
    refresh: 'tx',
    successToast: '✅ Payment recorded successfully!',
    mutate: async () => {
      if(activePayCreditId !== null) {
        const credit = data.credits.find(c=>c.id===activePayCreditId);
        if(!credit) return;
        data.payments.push({ id: makeTimeId('payment'), creditId: credit.id, amount, date: toIsoFromLocalDate(date), note });
        // due/settled are derived live; never persist stale copies.
        delete credit.due;
        delete credit.settled;
        auditLog('customer_payment_saved', creditAuditContext(credit, { amount, paymentDate: date, note }));
      } else {
        let remain = amount;
        const credits = getOpenCustomerCreditsByKey(activePayCustomerKey);
        credits.forEach(c => {
          if(remain <= 0.0001) return;
          const cdue = getCreditDue(c);
          const take = round2(Math.min(remain, cdue));
          if(take > 0) {
            data.payments.push({ id: makeTimeId('payment'), creditId: c.id, amount: take, date: toIsoFromLocalDate(date), note: note || 'Grouped payment' });
            remain = round2(remain - take);
          }
        });
        auditLog('customer_group_payment_saved', cleanAuditDetails({
          customerKey: activePayCustomerKey,
          customer: credits[0]?.customerName,
          customerPhone: credits[0]?.customerPhone,
          billsPaid: credits.length,
          creditIds: credits.map(c => c.id),
          amount,
          paymentDate: date
        }));
      }
    },
    onSuccess: () => closePayModal()
  });
}

async function deleteCredit(creditId) {
  const credit = data.credits.find(c=>c.id===creditId);
  if(!credit) return;
  if(isCreditArchived(credit)) {
    toast('ℹ️ This bill is already archived.');
    return;
  }
  if(getCreditDue(credit) > 0.001) {
    toast('⚠️ Only fully-paid customer bills can be deleted.');
    return;
  }
  const pin = window.prompt('Enter admin PIN to archive settled customer record:', '');
  if(pin === null || !await verifyAdminPinInput(pin)) { toast('❌ Wrong PIN. Please try again.'); return; }
  const reason = (window.prompt('Archive reason (required):', '') || '').trim();
  if(!reason) { toast('⚠️ Please enter a reason.'); return; }
  if(!(await appConfirm('Archive settled customer record?', 'History will be preserved and hidden from active due lists.', { okText: 'Archive' }))) return;
  await runEngineCommand({
    label: 'deleteCredit',
    refresh: 'tx',
    successToast: '🗂 Archived',
    mutate: async () => {
      credit.archived = true;
      credit.archivedAt = new Date().toISOString();
      credit.archiveReason = reason;
      auditLog('customer_credit_archived', creditAuditContext(credit, { reason }));
    }
  });
}

async function deleteSupplierCredit(scId) {
  const sc = (data.supplierCredits || []).find(s=>s.id===scId);
  if(!sc) return;
  if(isCreditArchived(sc)) {
    toast('ℹ️ This bill is already archived.');
    return;
  }
  if(getSupplierDue(sc) > 0.001) {
    toast('⚠️ Only fully-paid supplier bills can be deleted.');
    return;
  }
  const pin = window.prompt('Enter admin PIN to archive settled supplier record:', '');
  if(pin === null || !await verifyAdminPinInput(pin)) { toast('❌ Wrong PIN. Please try again.'); return; }
  const reason = (window.prompt('Archive reason (required):', '') || '').trim();
  if(!reason) { toast('⚠️ Please enter a reason.'); return; }
  if(!(await appConfirm('Archive settled supplier record?', 'History will be preserved and hidden from active due lists.', { okText: 'Archive' }))) return;
  await runEngineCommand({
    label: 'deleteSupplierCredit',
    refresh: 'tx',
    successToast: '🗂 Supplier record archived',
    mutate: async () => {
      sc.archived = true;
      sc.archivedAt = new Date().toISOString();
      sc.archiveReason = reason;
      auditLog('supplier_credit_archived', supplierCreditAuditContext(sc, { reason }));
    }
  });
}

// —— SUPPLIER PAYMENT MODAL ————————————————————————————————————————————————————

function openSupplierPayModal(scId) {
  const sc = data.supplierCredits.find(s=>s.id===scId);
  if(!sc) return;
  activeSupCreditId = scId;
  activeSupSupplierKey = null;
  const due  = getSupplierDue(sc);
  const paid = getSupplierTotalPaid(sc);
  const p    = getProd(sc.productId);
  const isMulti = Array.isArray(sc.products) && sc.products.length > 1;
  document.getElementById('supPayModalSub').textContent = `Payment to ${sc.supplierName} for ${isMulti ? 'multiple items' : (p?.name||'?')}`;
  document.getElementById('supPmTotal').textContent = fmt(sc.total);
  document.getElementById('supPmPaid').textContent  = fmt(paid);
  document.getElementById('supPmDue').textContent   = fmt(due);
  document.getElementById('supPmAmount').value      = '';
  document.getElementById('supPmNote').value        = '';
  setAppDateValue('supPmDate');
  document.getElementById('supPmPreview').style.display = 'none';
  document.getElementById('supPayModalOverlay').classList.add('active');
  document.getElementById('supPayModal').style.display = 'block';
  setTimeout(()=>document.getElementById('supPmAmount').focus(),100);
}

function updateSupplierPayPreviewModal() {
  clearPayError('supPmError');
  let due = 0;
  if(activeSupCreditId !== null) {
    const sc = data.supplierCredits.find(s=>s.id===activeSupCreditId);
    if(!sc) return;
    due = getSupplierDue(sc);
  } else if(activeSupSupplierKey) {
    due = round2(getOpenSupplierCreditsByKey(activeSupSupplierKey).reduce((s,c)=>s+getSupplierDue(c),0));
  } else return;
  const paying = parseFloat(document.getElementById('supPmAmount').value)||0;
  const after  = Math.max(0, due-paying);
  const prev   = document.getElementById('supPmPreview');
  if(paying>0) {
    prev.style.display='block';
    document.getElementById('supPmRemaining').textContent = after<=0?'✅ Fully Settled!':fmt(after);
  } else {
    prev.style.display='none';
  }
}

function closeSupplierPayModal() {
  clearPayError('supPmError');
  activeSupCreditId = null;
  activeSupSupplierKey = null;
  document.getElementById('supPayModalOverlay').classList.remove('active');
  document.getElementById('supPayModal').style.display = 'none';
}

let activeEditPaymentId = null;
let activeEditPaymentType = null;

function editPaymentEntry(paymentId, type) {
  const arr = type === 'supplier' ? (data.supplierPayments||[]) : (data.payments||[]);
  const p = arr.find(x => String(x.id) === String(paymentId));
  if(!p) { toast('❌ This payment could not be found.'); return; }
  activeEditPaymentId = paymentId;
  activeEditPaymentType = type;
  document.getElementById('editPayModalTitle').textContent = type === 'supplier' ? '✏️ Edit Supplier Payment' : '✏️ Edit Customer Payment';
  const parentName = type === 'supplier'
    ? ((data.supplierCredits||[]).find(sc => String(sc.id) === String(p.scId))?.supplierName || 'Supplier')
    : ((data.credits||[]).find(c => String(c.id) === String(p.creditId))?.customerName || 'Customer');
  document.getElementById('editPayModalSub').textContent = parentName;
  document.getElementById('editPmAmount').value = p.amount;
  setAppDateValue('editPmDate', p.date);
  document.getElementById('editPmNote').value = p.note || '';
  document.getElementById('editPayModalOverlay').classList.add('active');
  document.getElementById('editPayModal').style.display = 'block';
  setTimeout(()=>document.getElementById('editPmAmount').focus(),100);
}

function closeEditPayModal() {
  activeEditPaymentId = null;
  activeEditPaymentType = null;
  document.getElementById('editPayModalOverlay').classList.remove('active');
  document.getElementById('editPayModal').style.display = 'none';
}

async function saveEditPayment() {
  const amount = round2(parseFloat(document.getElementById('editPmAmount').value)||0);
  const date = readAppDateValue('editPmDate');
  const note = document.getElementById('editPmNote').value.trim();
  if(amount <= 0) { toast('⚠️ Enter a valid amount.'); return; }
  if(!activeEditPaymentId || !activeEditPaymentType) return;
  const paymentId = activeEditPaymentId;
  const type = activeEditPaymentType;

  // Pre-check: new amount must not exceed remaining due (excluding this payment's own contribution)
  if(type === 'supplier') {
    const sp = (data.supplierPayments||[]).find(x => String(x.id) === String(paymentId));
    if(sp) {
      const sc = (data.supplierCredits||[]).find(c => String(c.id) === String(sp.scId));
      if(sc) {
        const otherPaid = round2((data.supplierPayments||[]).filter(x => String(x.id) !== String(paymentId) && String(x.scId) === String(sp.scId)).reduce((s,x)=>s+(Number(x.amount)||0),0));
        const initialPaid = Number(sc.paid) || 0;
        const maxAllowed = round2((Number(sc.total)||0) - initialPaid - otherPaid);
        if(!moneyLte(amount, maxAllowed)) { toast('⚠️ The amount cannot be more than the remaining due.'); return; }
      }
    }
  } else {
    const cp = (data.payments||[]).find(x => String(x.id) === String(paymentId));
    if(cp) {
      const cr = (data.credits||[]).find(c => String(c.id) === String(cp.creditId));
      if(cr) {
        const otherPaid = round2((data.payments||[]).filter(x => String(x.id) !== String(paymentId) && String(x.creditId) === String(cp.creditId)).reduce((s,x)=>s+(Number(x.amount)||0),0));
        const initialPaid = Number(cr.paid) || 0;
        const maxAllowed = round2((Number(cr.total)||0) - initialPaid - otherPaid);
        if(!moneyLte(amount, maxAllowed)) { toast('⚠️ The amount cannot be more than the remaining due.'); return; }
      }
    }
  }

  await runEngineCommand({
    label: type === 'supplier' ? 'editSupplierPayment' : 'editCustomerPayment',
    refresh: 'tx',
    successToast: '✅ Payment updated',
    mutate: async () => {
      const arr = type === 'supplier' ? (data.supplierPayments||[]) : (data.payments||[]);
      const idx = arr.findIndex(x => String(x.id) === String(paymentId));
      if(idx === -1) throw new Error('Payment not found');
      const old = { amount: arr[idx].amount, date: arr[idx].date, note: arr[idx].note };
      arr[idx].amount = amount;
      arr[idx].date = toIsoFromLocalDate(date);
      arr[idx].note = note;
      if(type === 'supplier') {
        const sp = arr[idx];
        const sc = (data.supplierCredits || []).find(c => String(c.id) === String(sp.scId));
        auditLog('supplier_payment_edited', supplierCreditAuditContext(sc, {
          paymentId,
          oldAmount: old.amount,
          newAmount: amount,
          oldDate: dateToYMDLocal(old.date),
          newDate: date,
          note
        }));
      } else {
        const cp = arr[idx];
        const cr = (data.credits || []).find(c => String(c.id) === String(cp.creditId));
        auditLog('customer_payment_edited', creditAuditContext(cr, {
          paymentId,
          oldAmount: old.amount,
          newAmount: amount,
          oldDate: dateToYMDLocal(old.date),
          newDate: date,
          note
        }));
      }
    },
    onSuccess: () => closeEditPayModal()
  });
}

async function deletePaymentEntry(paymentId, type) {
  if(!confirm('Delete this payment? The outstanding amount will increase accordingly.')) return;
  await runEngineCommand({
    label: type === 'supplier' ? 'deleteSupplierPayment' : 'deleteCustomerPayment',
    refresh: 'tx',
    successToast: 'Payment removed',
    mutate: async () => {
      if(type === 'supplier') {
        const sp = (data.supplierPayments||[]).find(p=>String(p.id)===String(paymentId));
        if(!sp) throw new Error('Payment not found');
        const sc = (data.supplierCredits || []).find(c => String(c.id) === String(sp.scId));
        data.supplierPayments = data.supplierPayments.filter(p=>String(p.id)!==String(paymentId));
        auditLog('supplier_payment_deleted', supplierCreditAuditContext(sc, { paymentId, amount: sp.amount }));
      } else {
        const cp = (data.payments||[]).find(p=>String(p.id)===String(paymentId));
        if(!cp) throw new Error('Payment not found');
        const cr = (data.credits || []).find(c => String(c.id) === String(cp.creditId));
        data.payments = data.payments.filter(p=>String(p.id)!==String(paymentId));
        auditLog('customer_payment_deleted', creditAuditContext(cr, { paymentId, amount: cp.amount }));
      }
    }
  });
}

async function saveSupplierPayment() {
  const amount = round2(parseFloat(document.getElementById('supPmAmount').value));
  const date   = readAppDateValue('supPmDate');
  if(!(await requireMonthUnlockOverride(date, 'supplier due payment'))) return;
  const note   = document.getElementById('supPmNote').value.trim();
  const due = activeSupCreditId !== null
    ? getSupplierDue(data.supplierCredits.find(s=>s.id===activeSupCreditId))
    : round2(getOpenSupplierCreditsByKey(activeSupSupplierKey).reduce((s,c)=>s+getSupplierDue(c),0));
  clearPayError('supPmError');
  if(!amount||amount<=0) { setPayError('supPmError', '⚠️ Enter a valid amount greater than 0'); return; }
  if(!moneyLte(amount, due)) { setPayError('supPmError', '⚠️ The amount cannot be more than the supplier due.'); return; }
  if(activeSupCreditId === null && !activeSupSupplierKey) { setPayError('supPmError', '⚠️ No supplier credit selected'); return; }
  await runEngineCommand({
    label: 'saveSupplierPayment',
    refresh: 'tx',
    successToast: '✅ Supplier payment recorded!',
    mutate: async () => {
      if(!data.supplierPayments) data.supplierPayments = [];
      if(activeSupCreditId !== null) {
        const sc = data.supplierCredits.find(s=>s.id===activeSupCreditId);
        if(!sc) return;
        data.supplierPayments.push({ id: makeTimeId('supplierPayment'), scId: sc.id, amount, date: toIsoFromLocalDate(date), note });
        // due/settled are derived live; never persist stale copies.
        delete sc.due;
        delete sc.settled;
        auditLog('supplier_payment_saved', supplierCreditAuditContext(sc, { amount, paymentDate: date, note }));
      } else {
        let remain = amount;
        const credits = getOpenSupplierCreditsByKey(activeSupSupplierKey);
        credits.forEach(sc => {
          if(remain <= 0.0001) return;
          const sdue = getSupplierDue(sc);
          const take = round2(Math.min(remain, sdue));
          if(take > 0) {
            data.supplierPayments.push({ id: makeTimeId('supplierPayment'), scId: sc.id, amount: take, date: toIsoFromLocalDate(date), note: note || 'Grouped payment' });
            remain = round2(remain - take);
          }
        });
        auditLog('supplier_group_payment_saved', cleanAuditDetails({
          supplierKey: activeSupSupplierKey,
          supplier: credits[0]?.supplierName,
          supplierPhone: credits[0]?.supplierPhone,
          billsPaid: credits.length,
          scIds: credits.map(sc => sc.id),
          amount,
          paymentDate: date
        }));
      }
    },
    onSuccess: () => closeSupplierPayModal()
  });
}
