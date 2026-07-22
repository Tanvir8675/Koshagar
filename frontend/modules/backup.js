// modules/backup.js — Auto-backup + JSON export/import (restore/merge)
// Phase 3 extraction. Classic script sharing index.html's global scope; MUST
// load before app.js (app.js boot wires these via addEventListener at load).
// Runtime-only (settings buttons). INTEGRITY-NOTE: confirmImport replaces/merges
// all data (user-triggered, PIN-gated). Depends on globals: storageGet/Set,
// AB_FREQ_KEY, AB_LAST_KEY, isLoggedIn, data, nextPid/nextTid/.../nextAuditId,
// toast, closeSettings, runEngineCommand, reconcileDataConsistency, showPage,
// sha256pin, simpleHash, userPin, makeTimeId, makePid, window.MyShopNative.

function getAutoBackupFreq() { return storageGet('local', AB_FREQ_KEY) || 'off'; }
function getAutoBackupLastDate() { return storageGet('local', AB_LAST_KEY) || null; }
function setAutoBackupFreq(val) { storageSet('local', AB_FREQ_KEY, val); }
function setAutoBackupLastDate(val) { storageSet('local', AB_LAST_KEY, val); }

function updateAutoBackupBadge() {
  const freq = getAutoBackupFreq();
  const badge = document.getElementById('autoBackupBadge');
  if(!badge) return;
  if(freq === 'off') { badge.textContent = 'OFF'; badge.className = 'backup-badge off'; }
  else {
    const labels = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
    badge.textContent = labels[freq] || freq.toUpperCase();
    badge.className = 'backup-badge';
  }
}

const SAFETY_BACKUP_INDEX_KEY = 'koshSafetyBackupIndexV1';
const SAFETY_BACKUP_KEY_PREFIX = 'koshSafetyBackupV1:';
const SAFETY_BACKUP_KEEP = 8;

function buildBackupPayload(reason) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    reason: reason || 'manual',
    data,
    nextPid,
    nextTid,
    nextCid,
    nextScid,
    nextBillId,
    nextReturnGroupId,
    nextPayId,
    nextSupPayId,
    nextAuditId
  };
}

function idbGetValue(key) {
  return new Promise((resolve, reject) => {
    try {
      if(!db) { resolve(null); return; }
      const tx = db.transaction('data', 'readonly');
      const os = tx.objectStore('data');
      const req = os.get(key);
      req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
    } catch (err) {
      reject(err);
    }
  });
}

function idbPutValue(key, value) {
  return new Promise((resolve, reject) => {
    try {
      if(!db) { resolve(false); return; }
      const tx = db.transaction('data', 'readwrite');
      const os = tx.objectStore('data');
      os.put({ key, value });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    } catch (err) {
      reject(err);
    }
  });
}

function idbDeleteValue(key) {
  return new Promise((resolve) => {
    try {
      if(!db) { resolve(false); return; }
      const tx = db.transaction('data', 'readwrite');
      tx.objectStore('data').delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

async function readSafetyBackupIndex() {
  try {
    const raw = db ? await idbGetValue(SAFETY_BACKUP_INDEX_KEY) : storageGet('local', SAFETY_BACKUP_INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(x => x && x.key) : [];
  } catch (_) {
    return [];
  }
}

async function writeSafetyBackupIndex(index) {
  const value = JSON.stringify(index);
  if(db) await idbPutValue(SAFETY_BACKUP_INDEX_KEY, value);
  else storageSet('local', SAFETY_BACKUP_INDEX_KEY, value);
}

async function removeSafetyBackup(key) {
  if(db) await idbDeleteValue(key);
  else storageRemove('local', key);
}

async function readSafetyBackupPayload(key) {
  const raw = db ? await idbGetValue(key) : storageGet('local', key);
  return raw ? JSON.parse(raw) : null;
}

async function saveInternalSafetyBackup(reason) {
  try {
    if(!isLoggedIn || !data) return false;
    const payload = buildBackupPayload(reason || 'safety');
    const json = JSON.stringify(payload);
    const at = payload.exportedAt;
    const key = `${SAFETY_BACKUP_KEY_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    let index = await readSafetyBackupIndex();
    if(db) await idbPutValue(key, json);
    else storageSet('local', key, json);
    index.unshift({ key, at, reason: reason || 'safety', bytes: json.length });
    const expired = index.slice(SAFETY_BACKUP_KEEP);
    index = index.slice(0, SAFETY_BACKUP_KEEP);
    await writeSafetyBackupIndex(index);
    await Promise.all(expired.map(item => removeSafetyBackup(item.key)));
    window.__lastSafetyBackup = { at, reason: reason || 'safety', count: index.length };
    return true;
  } catch (err) {
    console.warn('Safety backup failed:', err);
    return false;
  }
}

function safetyBackupReasonLabel(reason) {
  const labels = {
    'before-reset-system': 'Before Reset System',
    'before-import-replace': 'Before Import Replace',
    'before-import-merge': 'Before Import Merge',
    'before-safety-restore': 'Before Safety Restore',
    'manual-export': 'Manual Export',
    'scheduled-auto-backup': 'Auto Backup'
  };
  const raw = String(reason || 'Safety Backup');
  if(labels[raw]) return labels[raw];
  if(raw.startsWith('before-delete-by-date-')) return 'Before Delete by Date ' + raw.replace('before-delete-by-date-', '');
  return raw.replace(/-/g, ' ');
}

function safetyBackupSizeLabel(bytes) {
  const n = Number(bytes) || 0;
  if(n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if(n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

async function openSafetyBackupsModal() {
  if(!isLoggedIn) { toast('âŒ Please log in first.'); return; }
  closeSettings();
  document.getElementById('safetyBackupOverlay').classList.add('active');
  document.getElementById('safetyBackupPanel').style.display = 'block';
  await renderSafetyBackupList();
}

function closeSafetyBackupsModal() {
  document.getElementById('safetyBackupOverlay').classList.remove('active');
  document.getElementById('safetyBackupPanel').style.display = 'none';
}

function closeSafetyRestoreModal() {
  document.getElementById('safetyRestoreOverlay').classList.remove('active');
  document.getElementById('safetyRestorePanel').style.display = 'none';
  document.getElementById('safetyRestoreKey').value = '';
  document.getElementById('safetyRestorePinInput').value = '';
  document.getElementById('safetyRestoreError').textContent = '';
}

async function renderSafetyBackupList() {
  const listEl = document.getElementById('safetyBackupList');
  if(!listEl) return;
  const index = await readSafetyBackupIndex();
  if(!index.length) {
    listEl.innerHTML = '<div class="empty" style="padding:18px"><div class="empty-text">No safety backups yet</div></div>';
    return;
  }
  listEl.innerHTML = index.map(item => {
    const key = encodeURIComponent(item.key);
    const when = item.at ? new Date(item.at).toLocaleString() : 'Unknown time';
    const reason = escapeHtml(safetyBackupReasonLabel(item.reason));
    const size = safetyBackupSizeLabel(item.bytes);
    return `
      <div class="report-row" style="align-items:center;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:800;color:var(--ink)">${reason}</div>
          <div style="font-size:0.76rem;color:var(--ink2);margin-top:2px">${escapeHtml(when)} · ${escapeHtml(size)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="small-btn secondary" onclick="exportSafetyBackup('${key}')">Export</button>
          <button class="small-btn" style="background:var(--red)" onclick="openSafetyRestoreModal('${key}')">Restore</button>
        </div>
      </div>`;
  }).join('');
}

async function exportSafetyBackup(encodedKey) {
  try {
    const key = decodeURIComponent(encodedKey);
    const payload = await readSafetyBackupPayload(key);
    if(!payload || !payload.data) { toast('âŒ Backup not found'); return; }
    const json = JSON.stringify(payload, null, 2);
    const dateStr = String(payload.exportedAt || new Date().toISOString()).slice(0,10);
    const fileName = `shop-safety-backup-${dateStr}.json`;
    if(window.MyShopNative && typeof window.MyShopNative.exportBackup === 'function') {
      const result = await window.MyShopNative.exportBackup(json, fileName);
      if(result && result.ok) toast('âœ… Safety backup exported!');
      else if(!(result && result.canceled)) toast('âŒ Could not export safety backup.');
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('âœ… Safety backup downloaded!');
  } catch(err) {
    console.error('Safety backup export failed:', err);
    toast('âŒ Could not export safety backup.');
  }
}

function openSafetyRestoreModal(encodedKey) {
  document.getElementById('safetyRestoreKey').value = encodedKey;
  document.getElementById('safetyRestorePinInput').value = '';
  document.getElementById('safetyRestoreError').textContent = '';
  document.getElementById('safetyRestoreSubtitle').textContent = 'This will replace current data with the selected safety snapshot.';
  document.getElementById('safetyRestoreOverlay').classList.add('active');
  document.getElementById('safetyRestorePanel').style.display = 'block';
  setTimeout(() => document.getElementById('safetyRestorePinInput').focus(), 0);
}

async function confirmSafetyRestore() {
  const encodedKey = document.getElementById('safetyRestoreKey').value;
  const pin = document.getElementById('safetyRestorePinInput').value.trim();
  const errorEl = document.getElementById('safetyRestoreError');
  if(!encodedKey) { closeSafetyRestoreModal(); return; }
  if(!pin) { errorEl.textContent = '⚠️ Enter your PIN'; return; }
  if(await sha256pin(pin) !== userPin && simpleHash(pin) !== userPin) {
    errorEl.textContent = '❌ Incorrect PIN';
    return;
  }
  try {
    const payload = await readSafetyBackupPayload(decodeURIComponent(encodedKey));
    if(!payload || !payload.data || !Array.isArray(payload.data.products) || !Array.isArray(payload.data.transactions)) {
      errorEl.textContent = '❌ This safety backup is not valid.';
      return;
    }
    await saveInternalSafetyBackup('before-safety-restore');
    await runEngineCommand({
      label: 'restoreSafetyBackup',
      refresh: 'tx',
      forceSave: true,
      successToast: '✅ Safety backup restored',
      mutate: async () => {
        data = payload.data || { products: [], transactions: [], credits: [], payments: [], supplierCredits: [], supplierPayments: [] };
        nextPid = Number(payload.nextPid) || 1;
        nextTid = Math.max(1100000001, Number(payload.nextTid) || 0);
        nextCid = Math.max(2100000001, Number(payload.nextCid) || 0);
        nextScid = Math.max(2200000001, Number(payload.nextScid) || 0);
        nextBillId = Math.max(1200000001, Number(payload.nextBillId) || 0);
        nextReturnGroupId = Math.max(4100000001, Number(payload.nextReturnGroupId) || 0);
        nextPayId = Math.max(3100000001, Number(payload.nextPayId) || 0);
        nextSupPayId = Math.max(3200000001, Number(payload.nextSupPayId) || 0);
        nextAuditId = Math.max(9100000001, Number(payload.nextAuditId) || 0);
        reconcileDataConsistency();
      },
      onSuccess: () => {
        closeSafetyRestoreModal();
        closeSafetyBackupsModal();
        showPage('dashboard');
      }
    });
  } catch(err) {
    console.error('Safety restore failed:', err);
    errorEl.textContent = '❌ Restore failed. Please try again.';
  }
}

function openAutoBackupModal() {
  closeSettings();
  const freq = getAutoBackupFreq();
  const last = getAutoBackupLastDate();
  document.querySelectorAll('input[name="abFreq"]').forEach(r => { r.checked = (r.value === freq); });
  ['off','daily','weekly','monthly'].forEach(v => {
    const el = document.getElementById(`abOpt_${v}`);
    if(el) el.classList.toggle('selected', v === freq);
  });
  const statusEl = document.getElementById('autoBackupStatusText');
  if(statusEl) {
    if(freq === 'off') {
      statusEl.innerHTML = '<b>Auto backup is off.</b> Turn it on and the app will save backup files automatically.';
    } else {
      const lastStr = last ? (displayDateTime(last) || displayDateOnly(last) || 'Never') : 'Never';
      const labels = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
      statusEl.innerHTML = `<b>Active:</b> ${labels[freq]} backup enabled.<br><b>Last backup:</b> ${lastStr}`;
    }
  }
  document.getElementById('autoBackupOverlay').classList.add('active');
  document.getElementById('autoBackupModal').style.display = 'block';
  document.querySelectorAll('input[name="abFreq"]').forEach(r => {
    r.onchange = () => {
      ['off','daily','weekly','monthly'].forEach(v => {
        const el = document.getElementById(`abOpt_${v}`);
        if(el) el.classList.toggle('selected', v === r.value);
      });
    };
  });
}

function closeAutoBackupModal() {
  document.getElementById('autoBackupOverlay').classList.remove('active');
  document.getElementById('autoBackupModal').style.display = 'none';
}

function saveAutoBackupSettings() {
  const selected = document.querySelector('input[name="abFreq"]:checked');
  if(!selected) { closeAutoBackupModal(); return; }
  setAutoBackupFreq(selected.value);
  updateAutoBackupBadge();
  closeAutoBackupModal();
  const msgs = { off: '🚫 Auto backup disabled', daily: '✅ Daily auto backup enabled', weekly: '✅ Weekly auto backup enabled', monthly: '✅ Monthly auto backup enabled' };
  toast(msgs[selected.value] || '✅ Saved');
}

function shouldAutoBackupNow() {
  const freq = getAutoBackupFreq();
  if(freq === 'off') return false;
  const last = getAutoBackupLastDate();
  if(!last) return true;
  const diffDays = Math.floor((new Date() - new Date(last)) / 86400000);
  if(freq === 'daily')   return diffDays >= 1;
  if(freq === 'weekly')  return diffDays >= 7;
  if(freq === 'monthly') return diffDays >= 30;
  return false;
}

async function runAutoBackupIfNeeded() {
  if(!isLoggedIn || !shouldAutoBackupNow()) return;
  try {
    const exportObj = buildBackupPayload('scheduled-auto-backup');
    const json = JSON.stringify(exportObj, null, 2);
    const dateStr = new Date().toISOString().slice(0,10);
    if(window.MyShopNative && typeof window.MyShopNative.autoBackup === 'function') {
      const result = await window.MyShopNative.autoBackup(json, `shop-autobackup-${dateStr}.json`);
      if(!result || !result.ok) {
        throw new Error(result && result.error ? result.error : 'Auto backup write failed');
      }
    } else {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shop-autobackup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    setAutoBackupLastDate(new Date().toISOString());
    const labels = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
    toast(`📦 ${labels[getAutoBackupFreq()]} Auto backup complete!`);
  } catch(e) { console.error('Auto backup failed:', e); }
}

// —— EXPORT / IMPORT ——————————————————————————————————————————————————————————

async function exportData() {
  if(!isLoggedIn) { toast('❌ Please log in first.'); return; }
  closeSettings();
  try {
    const exportObj = buildBackupPayload('manual-export');
    const json = JSON.stringify(exportObj, null, 2);
    const dateStr = new Date().toISOString().slice(0,10);
    if(window.MyShopNative && typeof window.MyShopNative.exportBackup === 'function') {
      const result = await window.MyShopNative.exportBackup(json, `shop-backup-${dateStr}.json`);
      if(result && result.ok) toast('✅ Backup file saved!');
      else if(!(result && result.canceled)) toast('❌ Could not save the backup. Please try again.');
    } else {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shop-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('✅ Backup file downloaded!');
    }
  } catch(e) {
    toast('❌ Could not save the backup. Please try again.');
    console.error(e);
  }
}

let pendingImportData = null;
let importMode = 'replace'; // 'replace' or 'merge'

function setImportMode(mode) {
  importMode = mode;
  const replaceBtn = document.getElementById('importModeReplace');
  const mergeBtn = document.getElementById('importModeMerge');
  const desc = document.getElementById('importModeDesc');
  if(mode === 'replace') {
    replaceBtn.style.background = 'var(--green)'; replaceBtn.style.color = '';
    mergeBtn.style.background = 'var(--surface2)'; mergeBtn.style.color = 'var(--ink)';
    desc.textContent = '🔄 Replace: current data will be deleted and replaced with backup.';
  } else {
    mergeBtn.style.background = 'var(--blue)'; mergeBtn.style.color = '#fff';
    replaceBtn.style.background = 'var(--surface2)'; replaceBtn.style.color = 'var(--ink)';
    desc.textContent = '➕ Merge: backup data will be added to existing data. Duplicate transactions are skipped.';
  }
  if(pendingImportData) updateImportSubtitle(pendingImportData);
}

function updateImportSubtitle(parsed) {
  const pCount = parsed.data.products.length;
  const tCount = parsed.data.transactions.length;
  const dateStr = parsed.exportedAt ? (displayDateOnly(parsed.exportedAt) || 'Unknown') : 'Unknown';
  document.getElementById('importSubtitle').textContent =
    `Backup from ${dateStr} — ${pCount} products, ${tCount} transactions. Select mode, then enter PIN.`;
}

function openImportModalFromParsed(parsed) {
  const ver = Number(parsed?.version || 1);
  if(!Number.isFinite(ver) || ver < 1 || ver > 2) {
    toast('❌ This backup is from an unsupported version and cannot be opened.');
    return;
  }
  if(!parsed.data || !Array.isArray(parsed.data.products) || !Array.isArray(parsed.data.transactions)) {
    toast('❌ This file is not a valid backup.');
    return;
  }
  pendingImportData = parsed;
  importMode = 'replace';
  setImportMode('replace');
  updateImportSubtitle(parsed);
  document.getElementById('importPinInput').value = '';
  document.getElementById('importError').textContent = '';
  document.getElementById('importOverlay').classList.add('active');
  document.getElementById('importPanel').style.display = 'block';
  setTimeout(() => document.getElementById('importPinInput').focus(), 0);
}

async function openImportFile() {
  if(!isLoggedIn) { toast('❌ Please log in first.'); return; }
  closeSettings();
  if(window.MyShopNative && typeof window.MyShopNative.importBackup === 'function') {
    try {
      const result = await window.MyShopNative.importBackup();
      if(!result || result.canceled) return;
      if(!result.ok || !result.content) {
        toast('❌ Could not read the file. Please try again.');
        return;
      }
      const parsed = JSON.parse(result.content);
      openImportModalFromParsed(parsed);
      return;
    } catch (err) {
      console.error(err);
      toast('❌ Could not read the file. Please try again.');
      return;
    }
  }
  document.getElementById('importFileInput').value = '';
  document.getElementById('importFileInput').click();
}

function handleImportFileSelected(e) {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const parsed = JSON.parse(ev.target.result);
      openImportModalFromParsed(parsed);
    } catch(err) {
      toast('❌ Could not read the file. Please try again.');
    }
  };
  reader.readAsText(file);
}

function closeImportModal() {
  document.getElementById('importOverlay').classList.remove('active');
  document.getElementById('importPanel').style.display = 'none';
  pendingImportData = null;
}

function repairImportedOverpaidPayments(targetData) {
  const d = targetData || {};
  const repairs = [];
  const cleanPaymentList = (payments, parentRows, parentIdKey, paymentParentKey, label) => {
    if(!Array.isArray(payments) || !Array.isArray(parentRows)) return payments || [];
    const parentName = parent => (
      parent?.customerName || parent?.supplierName || parent?.loanName || parent?.name || 'Unknown'
    );
    const parentPhone = parent => (
      parent?.customerPhone || parent?.supplierPhone || parent?.loanPhone || parent?.phone || ''
    );
    const repairLabel = (parent, payment) => {
      const phone = parentPhone(parent);
      const parts = [
        `${label} ${parent?.[parentIdKey]}`,
        parentName(parent),
        phone ? `phone ${phone}` : '',
        payment?.id ? `payment ${payment.id}` : '',
        payment?.date ? `payment date ${dateToYMDLocal(payment.date)}` : ''
      ].filter(Boolean);
      return parts.join(' · ');
    };
    const grouped = new Map();
    payments.forEach(p => {
      const key = String(p?.[paymentParentKey] || '');
      if(!key) return;
      if(!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(p);
    });
    const keep = new Set(payments);
    parentRows.forEach(parent => {
      const parentId = String(parent?.[parentIdKey] || '');
      if(!parentId) return;
      const rows = grouped.get(parentId) || [];
      if(!rows.length) return;
      const limit = round2(Math.max(0, (Number(parent.total) || 0) - (Number(parent.paid) || 0)));
      const sorted = rows.slice().sort((a, b) => {
        const ad = new Date(a?.date || 0) - new Date(b?.date || 0);
        if(ad !== 0) return ad;
        return (Number(a?.id) || 0) - (Number(b?.id) || 0);
      });
      let used = 0;
      sorted.forEach(p => {
        const original = round2(Number(p.amount) || 0);
        if(original <= 0) { keep.delete(p); return; }
        const room = round2(limit - used);
        if(room <= 0.001) {
          repairs.push({
            type: label,
            parentId,
            billId: parent?.billId || '',
            txId: parent?.txId || '',
            name: parentName(parent),
            phone: parentPhone(parent),
            paymentId: p?.id || '',
            paymentDate: dateToYMDLocal(p?.date),
            action: 'removed excess payment',
            originalAmount: original,
            newAmount: 0,
            reducedBy: original
          });
          keep.delete(p);
          return;
        }
        if(original > room + 0.001) {
          p.amount = room;
          p.note = `${p.note ? p.note + ' | ' : ''}Import adjusted overpayment from ${fmt(original)} to ${fmt(room)}`;
          repairs.push({
            type: label,
            parentId,
            billId: parent?.billId || '',
            txId: parent?.txId || '',
            name: parentName(parent),
            phone: parentPhone(parent),
            paymentId: p?.id || '',
            paymentDate: dateToYMDLocal(p?.date),
            action: 'reduced overpayment',
            originalAmount: original,
            newAmount: room,
            reducedBy: round2(original - room)
          });
          used = round2(used + room);
          return;
        }
        used = round2(used + original);
      });
    });
    return payments.filter(p => keep.has(p));
  };

  d.payments = cleanPaymentList(d.payments || [], d.credits || [], 'id', 'creditId', 'Customer credit');
  d.supplierPayments = cleanPaymentList(d.supplierPayments || [], d.supplierCredits || [], 'id', 'scId', 'Supplier credit');
  const loanRows = (d.transactions || []).filter(t => t && t.type === 'capital-in' && t.capitalSource === 'loan');
  d.loanPayments = cleanPaymentList(d.loanPayments || [], loanRows, 'id', 'loanTxId', 'Loan');
  return repairs;
}

async function confirmImport() {
  const pin = document.getElementById('importPinInput').value.trim();
  const errorEl = document.getElementById('importError');
  if(!pin) { errorEl.textContent = '⚠️ Enter your PIN'; return; }
  if(await sha256pin(pin) !== userPin && simpleHash(pin) !== userPin) { errorEl.textContent = '❌ Incorrect PIN'; return; }
  if(!pendingImportData) { closeImportModal(); return; }
  const chosenMode = importMode; // capture before any async changes
  try {
    await saveInternalSafetyBackup(chosenMode === 'replace' ? 'before-import-replace' : 'before-import-merge');
    let mergeResult = { newProds: 0, merged: 0, skipped: 0 };
    let importRepairs = [];
    await runEngineCommand({
      label: 'confirmImport',
      refresh: 'tx',
      successToast: '',
      mutate: async () => {
        if(chosenMode === 'replace') {
          data = pendingImportData.data || { products: [], transactions: [], credits: [], payments: [], supplierCredits: [], supplierPayments: [] };
          nextPid = Number(pendingImportData.nextPid) || 1;
          nextTid = Math.max(1100000001, Number(pendingImportData.nextTid) || 0);
          nextCid = Math.max(2100000001, Number(pendingImportData.nextCid) || 0);
          nextScid = Math.max(2200000001, Number(pendingImportData.nextScid) || 0);
          nextBillId = Math.max(1200000001, Number(pendingImportData.nextBillId) || 0);
          nextReturnGroupId = Math.max(4100000001, Number(pendingImportData.nextReturnGroupId) || 0);
          nextPayId = Math.max(3100000001, Number(pendingImportData.nextPayId) || 0);
          nextSupPayId = Math.max(3200000001, Number(pendingImportData.nextSupPayId) || 0);
          nextAuditId = Math.max(9100000001, Number(pendingImportData.nextAuditId) || 0);
        } else {
          // MERGE mode — keep existing data, add non-duplicate entries from backup
          const incoming = pendingImportData.data || { products: [], transactions: [], credits: [], payments: [], supplierCredits: [], supplierPayments: [] };
          // Merge products
          const existingProductKeys = new Set(data.products.map(p => p.name.toLowerCase()+'|'+p.unit));
          const newProds = incoming.products.filter(p => !existingProductKeys.has(p.name.toLowerCase()+'|'+p.unit));
          const prodIdMap = {};
          newProds.forEach(p => {
            const oldId = p.id; const newId = makePid();
            prodIdMap[oldId] = newId;
            data.products.push({...p, id: newId});
          });
          incoming.products.filter(p => existingProductKeys.has(p.name.toLowerCase()+'|'+p.unit)).forEach(p => {
            const existing = data.products.find(e => e.name.toLowerCase() === p.name.toLowerCase() && e.unit === p.unit);
            if(existing) prodIdMap[p.id] = existing.id;
          });
          // Merge transactions
          const existingTxIds = new Set(data.transactions.map(t => String(t.id)));
          const txMergeKey = (t, mappedPid, mappedLinkedId) =>
            (t.date?t.date.slice(0,10):'')+'\x00'+mappedPid+'\x00'+t.type+'\x00'+Number(t.qty)+'\x00'+Number(t.price)+'\x00'+String(mappedLinkedId || '');
          const existingTxDayKeys = new Set(data.transactions.map(t => txMergeKey(t, t.productId, t.linkedTxId)));
          let mergedCount = 0; let skippedCount = 0;
          const txIdMap = {};
          const sortedIncomingTx = [...(incoming.transactions || [])].sort((a, b) => {
            const ar = a && a.type === 'return' ? 1 : 0;
            const br = b && b.type === 'return' ? 1 : 0;
            if(ar !== br) return ar - br;
            const ad = new Date(a?.date || 0) - new Date(b?.date || 0);
            if(ad !== 0) return ad;
            return (Number(a?.id) || 0) - (Number(b?.id) || 0);
          });
          sortedIncomingTx.forEach(t => {
            if(!t) return;
            const oldId = String(t.id);
            const mappedPid = prodIdMap[t.productId] || t.productId;
            if(existingTxIds.has(oldId)) { txIdMap[oldId] = oldId; skippedCount++; return; }
            const mappedLinkedId = t.linkedTxId
              ? (txIdMap[String(t.linkedTxId)] || (existingTxIds.has(String(t.linkedTxId)) ? String(t.linkedTxId) : null))
              : '';
            if(t.type === 'return' && t.linkedTxId && !mappedLinkedId) {
              skippedCount++;
              return;
            }
            const dayKey = txMergeKey(t, mappedPid, mappedLinkedId);
            if(existingTxDayKeys.has(dayKey)) {
              const ex = data.transactions.find(x =>
                (x.date?x.date.slice(0,10):'') === (t.date?t.date.slice(0,10):'') &&
                String(x.productId) === String(mappedPid) &&
                x.type === t.type &&
                Number(x.qty) === Number(t.qty) &&
                Number(x.price) === Number(t.price) &&
                String(x.linkedTxId || '') === String(mappedLinkedId || '')
              );
              if(ex) txIdMap[oldId] = String(ex.id);
              skippedCount++; return;
            }
            const newTx = {...t, id: makeTimeId('tx'), productId: mappedPid};
            if(t.type === 'return') newTx.linkedTxId = mappedLinkedId || null;
            existingTxIds.add(String(newTx.id)); existingTxDayKeys.add(dayKey);
            txIdMap[oldId] = String(newTx.id);
            data.transactions.push(newTx); mergedCount++;
          });
          // Merge credits & payments
          if(Array.isArray(incoming.credits)) {
            const existingCreditIds = new Set(data.credits.map(c=>c.id));
            const existingPayIds = new Set(data.payments.map(pp=>pp.id));
            incoming.credits.forEach(c=>{
              if(!existingCreditIds.has(c.id)) {
                const newCid = makeTimeId('credit'); const oldCid = c.id;
                const mappedTxIds = Array.isArray(c.txIds) ? c.txIds.map(id => txIdMap[String(id)] || id).filter(Boolean) : c.txIds;
                data.credits.push({...c, id: newCid, txId: txIdMap[String(c.txId)] || c.txId, txIds: mappedTxIds});
                if(Array.isArray(incoming.payments)) {
                  incoming.payments.filter(p=>p.creditId===oldCid).forEach(p=>{ if(!existingPayIds.has(p.id)) { data.payments.push({...p, creditId: newCid}); existingPayIds.add(p.id); } });
                }
              }
            });
          } else if(Array.isArray(incoming.payments)) {
            const existingPayIds = new Set(data.payments.map(p=>p.id));
            incoming.payments.forEach(p=>{ if(!existingPayIds.has(p.id)) data.payments.push({...p}); });
          }
          // Merge supplierCredits & supplierPayments
          if(Array.isArray(incoming.supplierCredits)) {
            const existingSCIds = new Set(data.supplierCredits.map(sc=>sc.id));
            const existingSPIds = new Set((data.supplierPayments||[]).map(ssp=>ssp.id));
            incoming.supplierCredits.forEach(sc=>{
              if(!existingSCIds.has(sc.id)) {
                const newScId = makeTimeId('supplierCredit'); const oldScId = sc.id;
                const mappedTxIds = Array.isArray(sc.txIds) ? sc.txIds.map(id => txIdMap[String(id)] || id).filter(Boolean) : sc.txIds;
                data.supplierCredits.push({...sc, id: newScId, txId: txIdMap[String(sc.txId)]||sc.txId, txIds: mappedTxIds, productId: prodIdMap[sc.productId]||sc.productId});
                if(Array.isArray(incoming.supplierPayments)) {
                  incoming.supplierPayments.filter(sp=>sp.scId===oldScId).forEach(sp=>{ if(!existingSPIds.has(sp.id)) { if(!data.supplierPayments) data.supplierPayments=[]; data.supplierPayments.push({...sp, scId: newScId}); existingSPIds.add(sp.id); } });
                }
              }
            });
          }
          mergeResult = { newProds: newProds.length, merged: mergedCount, skipped: skippedCount };
        }
        importRepairs = repairImportedOverpaidPayments(data);
        if(importRepairs.length && typeof auditLog === 'function') {
          auditLog('import_payment_overpay_repaired', { count: importRepairs.length, details: importRepairs.slice(0, 20) });
        }
        reconcileDataConsistency();
      },
      onSuccess: () => {
        if(chosenMode === 'replace') toast('✅ Data restored successfully!');
        if(chosenMode === 'merge') toast(`✅ Merged: ${mergeResult.newProds} new products, ${mergeResult.merged} new transactions! (${mergeResult.skipped} duplicates skipped)`);
        if(importRepairs.length) setTimeout(() => toast(`Import repaired ${importRepairs.length} old overpayment issue(s). Check Audit Trail.`), 700);
        closeImportModal();
        showPage('dashboard');
      }
    });
  } catch(err) {
    errorEl.textContent = '❌ Import failed. Try again.';
    console.error(err);
  }
}
