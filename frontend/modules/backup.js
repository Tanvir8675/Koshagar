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
      const lastStr = last ? new Date(last).toLocaleDateString() : 'Never';
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
    const exportObj = { version: 1, exportedAt: new Date().toISOString(), data, nextPid, nextTid, nextCid, nextScid, nextBillId, nextReturnGroupId, nextPayId, nextSupPayId, nextAuditId };
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
    const exportObj = {
      version: 1,
      exportedAt: new Date().toISOString(),
      data: data,
      nextPid: nextPid,
      nextTid: nextTid,
      nextCid: nextCid,
      nextScid: nextScid,
      nextBillId: nextBillId,
      nextReturnGroupId: nextReturnGroupId,
      nextPayId: nextPayId,
      nextSupPayId: nextSupPayId,
      nextAuditId: nextAuditId
    };
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
  const dateStr = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleDateString() : 'Unknown';
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

async function confirmImport() {
  const pin = document.getElementById('importPinInput').value.trim();
  const errorEl = document.getElementById('importError');
  if(!pin) { errorEl.textContent = '⚠️ Enter your PIN'; return; }
  if(await sha256pin(pin) !== userPin && simpleHash(pin) !== userPin) { errorEl.textContent = '❌ Incorrect PIN'; return; }
  if(!pendingImportData) { closeImportModal(); return; }
  const chosenMode = importMode; // capture before any async changes
  try {
    let mergeResult = { newProds: 0, merged: 0, skipped: 0 };
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
          const existingTxDayKeys = new Set(data.transactions.map(t => (t.date?t.date.slice(0,10):'')+'\x00'+t.productId+'\x00'+t.type+'\x00'+Number(t.qty)+'\x00'+Number(t.price)));
          let mergedCount = 0; let skippedCount = 0;
          const txIdMap = {};
          incoming.transactions.forEach(t => {
            const oldId = String(t.id);
            const mappedPid = prodIdMap[t.productId] || t.productId;
            if(existingTxIds.has(oldId)) { txIdMap[oldId] = oldId; skippedCount++; return; }
            const dayKey = (t.date?t.date.slice(0,10):'')+'\x00'+mappedPid+'\x00'+t.type+'\x00'+Number(t.qty)+'\x00'+Number(t.price);
            if(existingTxDayKeys.has(dayKey)) {
              const ex = data.transactions.find(x => (x.date?x.date.slice(0,10):'') === (t.date?t.date.slice(0,10):'') && x.productId===mappedPid && x.type===t.type && Number(x.qty)===Number(t.qty) && Number(x.price)===Number(t.price));
              if(ex) txIdMap[oldId] = String(ex.id);
              skippedCount++; return;
            }
            const newTx = {...t, id: makeTimeId('tx'), productId: mappedPid};
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
                data.credits.push({...c, id: newCid, txId: txIdMap[String(c.txId)] || c.txId});
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
                data.supplierCredits.push({...sc, id: newScId, txId: txIdMap[String(sc.txId)]||sc.txId, productId: prodIdMap[sc.productId]||sc.productId});
                if(Array.isArray(incoming.supplierPayments)) {
                  incoming.supplierPayments.filter(sp=>sp.scId===oldScId).forEach(sp=>{ if(!existingSPIds.has(sp.id)) { if(!data.supplierPayments) data.supplierPayments=[]; data.supplierPayments.push({...sp, scId: newScId}); existingSPIds.add(sp.id); } });
                }
              }
            });
          }
          mergeResult = { newProds: newProds.length, merged: mergedCount, skipped: skippedCount };
        }
        reconcileDataConsistency();
      },
      onSuccess: () => {
        if(chosenMode === 'replace') toast('✅ Data restored successfully!');
        if(chosenMode === 'merge') toast(`✅ Merged: ${mergeResult.newProds} new products, ${mergeResult.merged} new transactions! (${mergeResult.skipped} duplicates skipped)`);
        closeImportModal();
        showPage('dashboard');
      }
    });
  } catch(err) {
    errorEl.textContent = '❌ Import failed. Try again.';
    console.error(err);
  }
}
