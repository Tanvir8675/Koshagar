// ui/dashboard.js — Dashboard rendering
// Phase 3 extraction. Classic script sharing index.html's global scope; loaded
// after the main script. Runtime-only (showPage('dashboard') / refresh), so
// load order is safe. Depends on globals: pgReset, todayStr,
// getCentralCalculationBundle, i18nText, fmt, currentLang, escapeHtml,
// dateToYMDLocal, displayDateOnly, displayDateTime, renderPaged, txGroupRow, groupReturnTxns, txReturnGroupRow,
// and onclick handlers (quickCapitalAdjust, addExtraExpense, cancelEditExpense,
// startEditExpense, deleteExtraExpense, addCashWithdrawal, cancelEditWithdrawal,
// startEditWithdrawal, deleteCashWithdrawal, undoInvestmentTx, showStockAlerts).

function renderDashboard(keepPaging = false) {
  if(!keepPaging) {
    ['todaySaleList','todayBuyList','todayReturnList'].forEach(id=>pgReset(id));
  }
  const now = todayStr();
  const calc = getCentralCalculationBundle('daily', now);
  const snap = calc.snap;
  const metrics = calc.metrics;
  const ops = calc.ops;
  document.getElementById('dashDate').textContent = displayDateOnly(new Date());
  const dashAgg = ops.dashboardAggregates;
  const grossRev    = metrics.sales.grossRevenue;
  const returnTotal = metrics.sales.returnRevenue;
  const rev         = metrics.sales.netRevenue;
  const profit      = metrics.sales.profit;
  const pSpend      = metrics.dashboard.purchaseCashOut;
  const pDue        = metrics.dashboard.supplierDueOpen;
  const low   = ops.lowStockCount;
  const out   = ops.outStockCount;

  // Cash vs credit breakdown for today
  const todayCreditSalesDue = metrics.sales.creditDueInPeriod;
  const saleCashIn = metrics.sales.saleCashIn;
  const saleReturnCashOut = metrics.sales.saleReturnCashOut;
  const paymentsReceivedToday = metrics.cash.periodPaymentsReceived;
  const purchaseReturnCashIn = metrics.cash.purchaseReturnCashIn;
  const purchaseCashPaid = metrics.purchase.cashPaidAtBuy;
  const purchaseExtraCostCashOut = metrics.purchase.extraCostCashOut || 0;
  const supplierDuePaidCashOut = metrics.purchase.supplierDuePaidCashOut;
  const openingCash = metrics.cash.openingCash;
  const capitalCashIn = metrics.cash.capitalCashIn || 0;
  const investmentCashIn = metrics.cash.investmentCashIn || 0;
  const loanCashIn = metrics.cash.loanCashIn || 0;
  const cashInToday = metrics.cash.cashIn;
  const cashOutToday = metrics.cash.cashOut;
  const totalInWithOpening = metrics.cash.totalInWithOpening;
  const totalCashInHand = metrics.cash.closingCash;
  const netCashChange = metrics.cash.netCashChange;
  const extraExpensesToday = metrics.cash.extraExpensesTotal || 0;
  const extraExpensesListToday = metrics.cash.extraExpensesList || [];
  const withdrawalsListToday = metrics.cash.cashWithdrawalsList || [];
  const loanPaymentCashOut = metrics.cash.loanPaymentCashOut || 0;
  const capitalRowsToday = (calc.snap?.capitalInRaw || []).slice().sort((a,b)=>new Date(b.date)-new Date(a.date));
  const t = i18nText;

  document.getElementById('dashStats').innerHTML = `
    <div class="stat"><div class="stat-label">${t('todayRevenue')}</div><div class="stat-value ${rev>=0?'gold':'red'}">${fmt(rev)}</div><div class="stat-sub">Gross ${fmt(grossRev)} − Return ${fmt(returnTotal)} = Net ${fmt(rev)}</div></div>
    <div class="stat"><div class="stat-label">${t('todayProfit')}</div><div class="stat-value ${profit>=0?'green':'red'}">${fmt(profit)}</div>${returnTotal>0&&grossRev===0?`<div class="stat-sub" style="color:var(--red)">No sales today</div>`:''}</div>
    <div class="stat"><div class="stat-label">${t('purchasedCash')}</div><div class="stat-value blue">${fmt(pSpend)}</div>${pDue>0?`<div class="stat-sub" style="color:var(--red)">Supplier due: ${fmt(pDue)}</div>`:`<div class="stat-sub">Fully paid</div>`}</div>
    <div class="stat" style="cursor:pointer" onclick="showStockAlerts()"><div class="stat-label">${t('stockAlerts')}</div><div class="stat-value ${(low+out)>0?'red':'green'}">${low+out}</div><div class="stat-sub">${low} low · ${out} out</div></div>`;

  // Cash flow summary card (inserted before category breakdown)
  const cashSummaryEl = document.getElementById('dashCashSummary');
  if(cashSummaryEl) {
    cashSummaryEl.style.display = '';
    cashSummaryEl.innerHTML = `
      <div class="card-label">💵 ${currentLang==='bn' ? 'আজকের ব্রেকডাউন' : "Today's Breakdown"}</div>
      <div class="report-row" style="padding:9px 0">
        <div style="font-size:0.85rem;color:var(--ink2)">${t('openingCash')}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="font-weight:700;font-family:'Instrument Serif',serif">${fmt(openingCash)}</div>
          <input id="dashInvestInput" type="number" min="0" step="0.01" placeholder="${t('investment')}" style="width:110px;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);font-family:'Outfit',sans-serif;font-size:0.8rem">
          <button onclick="quickCapitalAdjust('${now}','capital-in','dashInvestInput')" style="padding:6px 8px;border:none;border-radius:8px;background:var(--green);color:#fff;font-family:'Outfit',sans-serif;font-size:0.74rem;font-weight:700;cursor:pointer">${t('investSave')}</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0">
        <div style="background:var(--green-light);border:1px solid var(--border);border-radius:10px;padding:10px">
          <div style="font-size:0.72rem;font-weight:700;color:var(--green);text-transform:uppercase;margin-bottom:6px">${t('cashIn')}</div>
          <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Sale Cash In</div><div style="font-weight:700;color:var(--green)">+${fmt(saleCashIn)}</div></div>
          ${paymentsReceivedToday>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Due Received</div><div style="font-weight:700;color:var(--green)">+${fmt(paymentsReceivedToday)}</div></div>`:''}
          ${purchaseReturnCashIn>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Purchase Return Cash Back</div><div style="font-weight:700;color:var(--green)">+${fmt(purchaseReturnCashIn)}</div></div>`:''}
          ${investmentCashIn>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Investment In</div><div style="font-weight:700;color:var(--green)">+${fmt(investmentCashIn)}</div></div>`:''}
          ${loanCashIn>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Loan In</div><div style="font-weight:700;color:var(--green)">+${fmt(loanCashIn)}</div></div>`:''}
          ${(investmentCashIn<=0&&loanCashIn<=0)?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Funding In</div><div style="font-weight:700;color:var(--green)">+${fmt(capitalCashIn)}</div></div>`:''}
          <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed var(--border);margin-top:6px;padding-top:8px">
            <div style="font-size:0.8rem;font-weight:700">Total In (Today)</div>
            <div style="font-weight:700;color:var(--green);font-family:'Instrument Serif',serif">${fmt(cashInToday)}</div>
          </div>
        </div>
        <div style="background:var(--blue-light);border:1px solid var(--border);border-radius:10px;padding:10px">
          <div style="font-size:0.72rem;font-weight:700;color:var(--blue);text-transform:uppercase;margin-bottom:6px">${t('cashOut')}</div>
          <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Purchase Paid (Cash)</div><div style="font-weight:700;color:var(--blue)">-${fmt(purchaseCashPaid)}</div></div>
          ${purchaseExtraCostCashOut>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Purchase Extra Costing</div><div style="font-weight:700;color:var(--red)">-${fmt(purchaseExtraCostCashOut)}</div></div>`:''}
          ${saleReturnCashOut>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Sale Return Refund</div><div style="font-weight:700;color:var(--red)">-${fmt(saleReturnCashOut)}</div></div>`:''}
          ${supplierDuePaidCashOut>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Supplier Due Paid</div><div style="font-weight:700;color:var(--blue)">-${fmt(supplierDuePaidCashOut)}</div></div>`:''}
          ${loanPaymentCashOut>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Loan Payment</div><div style="font-weight:700;color:var(--blue)">-${fmt(loanPaymentCashOut)}</div></div>`:''}
          ${extraExpensesToday>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Extra Expenses</div><div style="font-weight:700;color:var(--red)">-${fmt(extraExpensesToday)}</div></div>`:''}
          <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed var(--border);margin-top:6px;padding-top:8px">
            <div style="font-size:0.8rem;font-weight:700">Total Out (Today)</div>
            <div style="font-weight:700;color:var(--red);font-family:'Instrument Serif',serif">${fmt(cashOutToday)}</div>
          </div>
        </div>
      </div>
      <div class="report-row" style="padding:9px 0">
        <div style="font-size:0.85rem;color:var(--ink2)">Credit Sales (Still Due)</div>
        <div style="font-weight:700;color:var(--red);font-family:'Instrument Serif',serif;font-size:1.05rem">${fmt(todayCreditSalesDue)}</div>
      </div>
      <div class="report-row" style="padding:9px 0">
        <div style="font-size:0.85rem;color:var(--ink2)">Total Cash in (Including Opening Balance)</div>
        <div style="font-weight:700;color:var(--green);font-family:'Instrument Serif',serif;font-size:1.05rem">${fmt(totalInWithOpening)}</div>
      </div>
      <div class="report-row" style="padding:9px 0;border-bottom:none">
        <div style="font-size:0.85rem;color:var(--ink2)">Net Cash Change Today</div>
        <div style="font-weight:700;color:${netCashChange>=0?'var(--green)':'var(--red)'};font-family:'Instrument Serif',serif;font-size:1.05rem">${netCashChange>=0?'+':''}${fmt(netCashChange)}</div>
      </div>
      <div style="border-top:2px solid var(--border);margin-top:8px;padding-top:10px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:0.85rem;font-weight:700">Cash in Hand (Expected) = (Opening + In) - Out</div>
        <div style="font-weight:700;font-size:1.2rem;font-family:'Instrument Serif',serif;color:${totalCashInHand>=0?'var(--green)':'var(--red)'}">${fmt(totalCashInHand)}</div>
      </div>
      <div style="border-top:1.5px dashed var(--border);margin-top:14px;padding-top:12px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--ink2);margin-bottom:8px">☕ Daily Extra Expenses</div>
        <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
          <input id="expenseAmount" type="number" min="0" step="0.01" placeholder="Amount" style="flex:1;min-width:90px;padding:8px 10px;border:1.5px solid var(--border);border-radius:9px;font-family:'Outfit',sans-serif;font-size:0.88rem;background:var(--surface)">
          <input id="expenseNote" type="text" placeholder="Note (e.g. Tea break)" style="flex:2;min-width:130px;padding:8px 10px;border:1.5px solid var(--border);border-radius:9px;font-family:'Outfit',sans-serif;font-size:0.88rem;background:var(--surface)">
          <input id="expenseDate" type="text" class="app-date-input" placeholder="dd-mm-yyyy" value="${displayDateOnly(todayStr())}" style="flex:1;min-width:120px;padding:8px 10px;border:1.5px solid var(--border);border-radius:9px;font-family:'Outfit',sans-serif;font-size:0.85rem;background:var(--surface)">
          <button id="expenseSaveBtn" onclick="addExtraExpense()" style="padding:8px 14px;border:none;border-radius:9px;background:var(--ink);color:#fff;font-family:'Outfit',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;white-space:nowrap">+ Add</button>
          <button id="expenseCancelBtn" onclick="cancelEditExpense()" style="display:none;padding:8px 12px;border:1.5px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink2);font-family:'Outfit',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;white-space:nowrap">✕ Cancel</button>
        </div>
        <div id="dashExpensesList"></div>
      </div>
      <div style="border-top:1.5px dashed var(--border);margin-top:14px;padding-top:12px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--ink2);margin-bottom:8px">💸 Cash Withdrawals (Owner Drawings)</div>
        <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
          <input id="withdrawalAmount" type="number" min="0" step="0.01" placeholder="Amount" style="flex:1;min-width:90px;padding:8px 10px;border:1.5px solid var(--border);border-radius:9px;font-family:'Outfit',sans-serif;font-size:0.88rem;background:var(--surface)">
          <input id="withdrawalReason" type="text" placeholder="Reason (e.g. Personal use)" style="flex:2;min-width:130px;padding:8px 10px;border:1.5px solid var(--border);border-radius:9px;font-family:'Outfit',sans-serif;font-size:0.88rem;background:var(--surface)">
          <input id="withdrawalDate" type="text" class="app-date-input" placeholder="dd-mm-yyyy" value="${displayDateOnly(todayStr())}" style="flex:1;min-width:120px;padding:8px 10px;border:1.5px solid var(--border);border-radius:9px;font-family:'Outfit',sans-serif;font-size:0.85rem;background:var(--surface)">
          <button id="withdrawalSaveBtn" onclick="addCashWithdrawal()" style="padding:8px 14px;border:none;border-radius:9px;background:var(--ink);color:#fff;font-family:'Outfit',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;white-space:nowrap">+ Add</button>
          <button id="withdrawalCancelBtn" onclick="cancelEditWithdrawal()" style="display:none;padding:8px 12px;border:1.5px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink2);font-family:'Outfit',sans-serif;font-size:0.85rem;font-weight:700;cursor:pointer;white-space:nowrap">✕ Cancel</button>
        </div>
        <div id="dashWithdrawalsList"></div>
      </div>
      <div style="border-top:1.5px dashed var(--border);margin-top:12px;padding-top:10px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--ink2);margin-bottom:6px">🏦 Today's Investment Ledger</div>
        <div id="dashCapitalLedgerList"></div>
      </div>`;
    renderPaged(
      'dashExpensesList',
      extraExpensesListToday,
      e => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:0.82rem;font-weight:600">${escapeHtml(e.note)}</div>
            <div style="font-size:0.68rem;color:var(--ink2)">${displayDateOnly(e.date) || e.date}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-family:'Instrument Serif',serif;font-size:0.95rem;color:var(--red)">-${fmt(e.amount)}</span>
            <button onclick="startEditExpense('${e.id}')" style="background:none;border:none;color:var(--blue);font-size:0.95rem;cursor:pointer;padding:3px 6px;border-radius:6px;opacity:0.75" title="Edit">✏️</button>
            <button onclick="deleteExtraExpense('${e.id}')" class="del-btn" style="font-size:0.8rem;padding:3px 7px">🗑</button>
          </div>
        </div>`,
      'dashExpensesList',
      '<div style="font-size:0.78rem;color:var(--ink2);padding:4px 0">No extra expenses today.</div>'
    );
    renderPaged(
      'dashWithdrawalsList',
      withdrawalsListToday,
      w => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:0.82rem;font-weight:600">${escapeHtml(w.reason)}</div>
            <div style="font-size:0.68rem;color:var(--ink2)">${displayDateOnly(w.date) || w.date}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-family:'Instrument Serif',serif;font-size:0.95rem;color:var(--red)">-${fmt(w.amount)}</span>
            <button onclick="startEditWithdrawal('${w.id}')" style="background:none;border:none;color:var(--blue);font-size:0.95rem;cursor:pointer;padding:3px 6px;border-radius:6px;opacity:0.75" title="Edit">✏️</button>
            <button onclick="deleteCashWithdrawal('${w.id}')" class="del-btn" style="font-size:0.8rem;padding:3px 7px">🗑</button>
          </div>
        </div>`,
      'dashWithdrawalsList',
      '<div style="font-size:0.78rem;color:var(--ink2);padding:4px 0">No withdrawals today.</div>'
    );
    renderPaged(
      'dashCapitalLedgerList',
      capitalRowsToday,
      t => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:0.76rem;color:var(--ink2)">${displayDateTime(t.date) || dateToYMDLocal(t.date)}${t.reason ? ` · ${escapeHtml(t.reason)}` : ''}</div>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-weight:700;color:var(--green)">+${fmt(t.total)}</span>
            <button onclick="undoInvestmentTx('${t.id}')" style="font-size:0.78rem;padding:3px 8px;border:none;border-radius:7px;background:var(--red);color:#fff;font-weight:700;cursor:pointer">↩ Undo</button>
          </div>
        </div>`,
      'dashCapitalLedgerList',
      '<div style="font-size:0.78rem;color:var(--ink2);padding:4px 0">No investment entries today.</div>'
    );
  }

  // Category breakdown
  const catBreakdown = dashAgg.byCategoryEntries.length===0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No sales today</div></div>'
    : dashAgg.byCategoryEntries.map(([cat,d])=>{
      const profit=d.revenue-d.cost;
      return `<div class="report-row">
        <div><div class="report-name">${cat}</div></div>
        <div><div class="report-rev">${fmt(d.revenue)}</div><div class="report-profit-sub">Profit: ${fmt(profit)}</div></div></div>`;
    }).join('');
  document.getElementById('categoryBreakdown').innerHTML = catBreakdown;

  renderPaged('todaySaleList', dashAgg.groupedTodaySales, txGroupRow, 'todaySaleList',
    '<div class="empty"><div class="empty-icon">🛒</div><div class="empty-text">No sales today</div></div>');
  renderPaged('todayBuyList', dashAgg.groupedTodayBuys, txGroupRow, 'todayBuyList',
    '<div class="empty"><div class="empty-icon">📦</div><div class="empty-text">No purchases today</div></div>');
  const returnSection = document.getElementById('todayReturnSection');
  if(dashAgg.todayReturns.length > 0) {
    returnSection.style.display = '';
    const groupedReturns = groupReturnTxns(dashAgg.todayReturns);
    renderPaged('todayReturnList', groupedReturns, txReturnGroupRow, 'todayReturnList', '');
  } else {
    returnSection.style.display = 'none';
  }

  // Credit summary on dashboard
  const openCredits = ops.openCredits;
  const totalDue    = ops.totalOpenCustomerDue;
  const dashCreditSummary = document.getElementById('dashCreditSummary');
  if(openCredits.length > 0) {
    dashCreditSummary.style.display = '';
    document.getElementById('dashCreditCard').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:700;font-size:0.95rem">${openCredits.length} customers have outstanding balances</div>
          <div style="font-size:0.75rem;color:var(--ink2);margin-top:2px">Click to view details →</div>
        </div>
        <div style="font-family:'Instrument Serif',serif;font-size:1.4rem;color:var(--red);font-weight:700">${fmt(totalDue)}</div>
      </div>`;
  } else {
    dashCreditSummary.style.display = 'none';
  }
}
