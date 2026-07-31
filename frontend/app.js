// app.js — application bootstrap / wiring (Phase 3)
// Classic script, loaded LAST (after the main script + calc/ + modules/), so
// every function and global it touches is already defined. Contains the INIT
// IIFE (DB init, PIN load, data load, event-listener wiring, auth/session
// routing) and the boot watchdog. Shares index.html's global scope.

// —— INIT —————————————————————————————————————————————————————————————————————
(async()=>{
  try {
    const withTimeout = async (promiseFactory, ms, label) => {
      let timer = null;
      try {
        return await Promise.race([
          promiseFactory(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
          })
        ]);
      } finally {
        if(timer) clearTimeout(timer);
      }
    };
    console.log('Initializing app...');
    await withTimeout(() => initDB(), 8000, 'Database initialization');
    console.log('DB initialized, db object:', !!db);
    if(window.KoshDB) {
      const sqlOk = await withTimeout(() => KoshDB.init(), 20000, 'SQLite initialization');
      if(sqlOk) console.log('Relational SQLite ready — schema v', KoshDB.schemaVersion);
      else console.warn('SQLite unavailable — JSON backup mode only:', KoshDB.lastError);
    }
    const rememberedUser = normalizeUserId(storageGet('local', AUTH_KEYS.lastUser) || '');
    await withTimeout(() => loadUserPin(rememberedUser), 8000, 'PIN load');
    console.log('User PIN loaded, userPin:', !!userPin);
    const safeMode = new URLSearchParams(window.location.search).get('safe') === '1';
    if(!safeMode) {
      await withTimeout(() => loadData(), 12000, 'Data load');
    } else {
      console.warn('Safe mode active: skipping persisted data load');
      data = { products: [], transactions: [], credits: [], payments: [], supplierCredits: [], supplierPayments: [], openingCashByDate: {}, extraExpenses: [], cashWithdrawals: [], units: [...DEFAULT_UNITS], auditTrail: [] };
      invalidateCoreCalcState();
      setSyncUI('offline');
    }
    console.log('Data loaded');
    const rDateEl = document.getElementById('rDate');
    if(rDateEl) rDateEl.value=todayStr();
    try {
      updateDataLists();
      setupProductForm();
    } catch (uiSetupErr) {
      console.error('Non-fatal UI setup error:', uiSetupErr);
    }
    const exportDataBtn = document.getElementById('exportDataBtn');
    if(exportDataBtn) exportDataBtn.addEventListener('click', exportData);
    const importDataBtn = document.getElementById('importDataBtn');
    if(importDataBtn) importDataBtn.addEventListener('click', openImportFile);
    const importFileInput = document.getElementById('importFileInput');
    if(importFileInput) importFileInput.addEventListener('change', handleImportFileSelected);
    const importConfirmBtn = document.getElementById('importConfirmBtn');
    if(importConfirmBtn) importConfirmBtn.addEventListener('click', confirmImport);
    const importCancelBtn = document.getElementById('importCancelBtn');
    if(importCancelBtn) importCancelBtn.addEventListener('click', closeImportModal);
    const importPinInput = document.getElementById('importPinInput');
    if(importPinInput) importPinInput.addEventListener('keypress', (e) => { if(e.key==='Enter') confirmImport(); });
    const autoBackupSettingsBtn = document.getElementById('autoBackupSettingsBtn');
    if(autoBackupSettingsBtn) autoBackupSettingsBtn.addEventListener('click', openAutoBackupModal);
    const safetyBackupsBtn = document.getElementById('safetyBackupsBtn');
    if(safetyBackupsBtn) safetyBackupsBtn.addEventListener('click', openSafetyBackupsModal);
    const safetyRestoreConfirmBtn = document.getElementById('safetyRestoreConfirmBtn');
    if(safetyRestoreConfirmBtn) safetyRestoreConfirmBtn.addEventListener('click', confirmSafetyRestore);
    const safetyRestoreCancelBtn = document.getElementById('safetyRestoreCancelBtn');
    if(safetyRestoreCancelBtn) safetyRestoreCancelBtn.addEventListener('click', closeSafetyRestoreModal);
    const safetyRestorePinInput = document.getElementById('safetyRestorePinInput');
    if(safetyRestorePinInput) safetyRestorePinInput.addEventListener('keypress', (e) => { if(e.key==='Enter') confirmSafetyRestore(); });
    const dailyReconcileBtn = document.getElementById('dailyReconcileBtn');
    if(dailyReconcileBtn) dailyReconcileBtn.addEventListener('click', openReconcileModal);
    const runScenarioSuiteBtn = document.getElementById('runScenarioSuiteBtn');
    if(runScenarioSuiteBtn) runScenarioSuiteBtn.addEventListener('click', openScenarioSuiteModal);
    const viewAuditTrailBtn = document.getElementById('viewAuditTrailBtn');
    if(viewAuditTrailBtn) viewAuditTrailBtn.addEventListener('click', openAuditTrailModal);
    const autoBackupSaveBtn = document.getElementById('autoBackupSaveBtn');
    if(autoBackupSaveBtn) autoBackupSaveBtn.addEventListener('click', saveAutoBackupSettings);
    const autoBackupCancelBtn = document.getElementById('autoBackupCancelBtn');
    if(autoBackupCancelBtn) autoBackupCancelBtn.addEventListener('click', closeAutoBackupModal);
    updateAutoBackupBadge();
    const resetSystemBtn = document.getElementById('resetSystemBtn');
    if(resetSystemBtn) resetSystemBtn.addEventListener('click', handleResetSystemClick);
    const resetConfirmBtn = document.getElementById('resetConfirmBtn');
    if(resetConfirmBtn) resetConfirmBtn.addEventListener('click', resetSystem);
    const resetCancelBtn = document.getElementById('resetCancelBtn');
    if(resetCancelBtn) resetCancelBtn.addEventListener('click', closeResetModal);
    const resetPinInput = document.getElementById('resetPinInput');
    if(resetPinInput) {
      resetPinInput.addEventListener('keypress', (event) => {
        if(event.key === 'Enter') resetSystem();
      });
    }
    const deleteByDateBtn = document.getElementById('deleteByDateBtn');
    if(deleteByDateBtn) deleteByDateBtn.addEventListener('click', () => {
      closeSettings();
      openDeleteByDateModal();
    });
    const deleteByDateConfirmBtn = document.getElementById('deleteByDateConfirmBtn');
    if(deleteByDateConfirmBtn) deleteByDateConfirmBtn.addEventListener('click', deleteTransactionsByDate);
    const deleteByDateCancelBtn = document.getElementById('deleteByDateCancelBtn');
    if(deleteByDateCancelBtn) deleteByDateCancelBtn.addEventListener('click', closeDeleteByDateModal);
    const deletePinInput = document.getElementById('deletePinInput');
    if(deletePinInput) {
      deletePinInput.addEventListener('keypress', (event) => {
        if(event.key === 'Enter') deleteTransactionsByDate();
      });
    }
    setupNavSyncBindings();
    applyLanguage();
    syncAuthAutofillIsolation();
    ensureActionButtonsNotSubmit();

    // Hide bottom nav until login
    document.querySelector('.bottom-nav').style.display = 'none';
    document.getElementById('settingsOverlay').classList.remove('active');
    document.getElementById('settingsPanel').style.display = 'none';

    // Restore active session on refresh (same window/tab), otherwise show auth screen
    const registeredUsers = getRegisteredUsers();
    if(registeredUsers.length === 0) {
      console.log('No local account found, showing login page (cloud login supported)');
      document.getElementById('loginPage').style.display = 'flex';
      document.getElementById('setupPage').style.display = 'none';
      document.getElementById('resetPage').style.display = 'none';
      setSessionActive(false);
      setAuthInteractionEnabled(true);
      document.body.classList.remove('auth-booting');
      setTimeout(() => document.getElementById('loginUserId')?.focus(), 0);
    } else {
      if(hasActiveSession()) {
        console.log('PIN found with active session, restoring dashboard');
        isLoggedIn = true;
        syncAuthAutofillIsolation();
        ensureActionButtonsNotSubmit();
        closeAllTransientOverlays();
        document.getElementById('loginPage').style.display = 'none';
        document.getElementById('setupPage').style.display = 'none';
        document.getElementById('resetPage').style.display = 'none';
        document.querySelector('.bottom-nav').style.display = 'flex';
        document.body.classList.remove('auth-booting');
        showPage('dashboard');
      } else {
        console.log('PIN found, showing login page');
        isLoggedIn = false;
        document.getElementById('loginPage').style.display = 'flex';
        document.getElementById('setupPage').style.display = 'none';
        document.getElementById('resetPage').style.display = 'none';
        setAuthInteractionEnabled(true);
        document.body.classList.remove('auth-booting');
        setTimeout(() => document.getElementById('loginPin')?.focus(), 0);
      }
    }

    // Boot set page displays directly (not via showAuthPage), so re-run the
    // autofill isolation now that the correct auth page is visible. This strips
    // the `inert` attribute off the shown login page — otherwise it stays frozen
    // and credentials can't be typed/submitted until a manual refresh.
    syncAuthAutofillIsolation();

    // Check for date changes every minute and auto-refresh dashboard
    setInterval(checkDateChange, 60000);
    window.__appBooted = true;
    console.log('App initialized successfully');
  } catch(err) {
    console.error('Initialization error:', err);
    try {
      data = { products: [], transactions: [], credits: [], payments: [], supplierCredits: [], supplierPayments: [], openingCashByDate: {}, extraExpenses: [], cashWithdrawals: [], units: [...DEFAULT_UNITS], auditTrail: [] };
      nextPid = 1; nextTid = 1100000001; nextCid = 2100000001; nextScid = 2200000001; nextBillId = 1200000001; nextReturnGroupId = 4100000001; nextPayId = 3100000001; nextSupPayId = 3200000001; nextAuditId = 9100000001;
      if(typeof setSyncUI === 'function') {
        setSyncUI('offline');
      }
      document.querySelector('.bottom-nav').style.display = 'none';
      document.getElementById('settingsOverlay').classList.remove('active');
      document.getElementById('settingsPanel').style.display = 'none';
      const initMsg = `Initialization failed: ${err?.message || 'unknown error'}`;
      const loginError = document.getElementById('loginError');
      if(loginError) loginError.textContent = initMsg;
      toast(initMsg, 5000);
      if(typeof loadUserPin === 'function') {
        loadUserPin(normalizeUserId(storageGet('local', AUTH_KEYS.lastUser) || ''));
      }
      if(getRegisteredUsers().length > 0) {
        showAuthPage('loginPage');
      } else {
        showAuthPage('loginPage');
      }
      document.body.classList.remove('auth-booting');
    } catch (fallbackErr) {
      console.error('Fallback init error:', fallbackErr);
    }
  }
})();

setTimeout(() => {
  if(window.__appBooted) return;
  try {
    console.warn('Boot watchdog triggered: forcing auth fallback screen');
    const hasPin = true;
    if(typeof showAuthPage === 'function') {
      showAuthPage(hasPin ? 'loginPage' : 'setupPage');
    } else {
      const loginPage = document.getElementById('loginPage');
      const setupPage = document.getElementById('setupPage');
      const resetPage = document.getElementById('resetPage');
      if(loginPage) loginPage.style.display = hasPin ? 'flex' : 'none';
      if(setupPage) setupPage.style.display = hasPin ? 'none' : 'flex';
      if(resetPage) resetPage.style.display = 'none';
    }
    const nav = document.querySelector('.bottom-nav');
    if(nav) nav.style.display = 'none';
    document.body.classList.remove('auth-booting');
    const loginError = document.getElementById('loginError');
    if(loginError && !loginError.textContent) {
      loginError.textContent = 'Recovery mode: app boot timed out. You can continue from login/setup.';
    }
  } catch (watchdogErr) {
    console.error('Boot watchdog fallback failed:', watchdogErr);
  }
}, 7000);
