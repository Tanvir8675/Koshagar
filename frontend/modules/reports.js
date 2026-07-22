// modules/reports.js — Reports rendering (Sale / Purchase / Credit)
// Phase 3 extraction. Classic script sharing index.html's global scope; loaded
// after the main script. These are UI render functions invoked only at runtime
// (via showPage('report') / setReportTab), so load order is safe. Depend on
// many globals: getCentralCalculationBundle, buildCreditMetrics, getProd, fmt,
// escapeHtml, renderPaged, pgReset, dateToYMDLocal, displayDateTime, round2, getSupplierDue,
// getSupplierTotalPaid, getCreditDue, getCreditTotalPaid, txReturnGroupRow,
// txGroupRow, txGroupRowReport, openSupplierPayModal, quickCapitalAdjust,
// undoInvestmentTx, startEditExpense, deleteExtraExpense, reportTab, data.

function renderReport() {
  // Reset all report pagination when period/tab changes
  ['rTxList','rBreakdown','rProfitability','rProfitabilityList','rFastSelling','rSlowSelling','rPurchaseBreakdown','rPurchaseTxList'].forEach(id=>pgReset(id));
  if(reportTab === 'sale') {
    renderSaleReport();
  } else if(reportTab === 'purchase') {
    renderPurchaseReport();
  } else if(reportTab === 'credit') {
    renderCreditReport();
  } else if(reportTab === 'ledger') {
    renderLedgerReport();
  }
}

function renderSaleReportTxList() {
  const period = getReportPeriodSelection();
  const saleTxQ = (document.getElementById('rSaleTxSearch')?.value||'').toLowerCase().trim();
  const calc = getCentralCalculationBundle(period.type, period.date, { includeOps: false });
  const snap = calc.snap || {};
  const saleTxns = (snap.salesRaw || []).filter(t => (Number(t.qty) || 0) > 0.0001);
  const saleRetTxns = snap.saleReturnsRaw || [];
  const allTxns = [...saleTxns, ...saleRetTxns].sort((a, b) => new Date(b.date) - new Date(a.date));
  const filtered = saleTxQ
    ? allTxns.filter(t => {
        const p = getProd(t.productId);
        return (p?.name || '').toLowerCase().includes(saleTxQ) ||
               (p?.category || '').toLowerCase().includes(saleTxQ) ||
               (t.customer || '').toLowerCase().includes(saleTxQ) ||
               String(t.billId || '').toLowerCase().includes(saleTxQ);
      })
    : allTxns;
  const feed = [
    ...groupTxnsByBill(filtered.filter(t => t.type === 'sale'), 'sale').map(g => ({ kind: 'bill', date: g.date, payload: g })),
    ...groupReturnTxns(filtered.filter(t => t.type === 'return' && (t.returnType === 'sale-return' || !t.returnType))).map(g => ({ kind: 'return', date: g.date, payload: g }))
  ].sort((a,b)=>new Date(b.date)-new Date(a.date));
  pgReset('rTxList');
  renderPaged('rTxList', feed, item => item.kind === 'return' ? txReturnGroupRow(item.payload) : txGroupRowReport(item.payload), 'rTxList',
    '<div class="empty" style="padding:14px"><div class="empty-text">'+(saleTxQ?'No matching transactions':'No transactions')+'</div></div>');
}

function renderPurchaseReportTxList() {
  const period = getReportPeriodSelection();
  const purchTxQ = (document.getElementById('rPurchTxSearch')?.value||'').toLowerCase().trim();
  const calc = getCentralCalculationBundle(period.type, period.date, { includeBusiness: false, includeOps: false });
  const snap = calc.snap || {};
  const purchaseTxns = (snap.purchasesRaw || []).filter(t => (Number(t.qty) || 0) > 0.0001);
  const purchaseRetTxns = snap.purchaseReturnsRaw || [];
  const allTxns = [...purchaseTxns, ...purchaseRetTxns].sort((a, b) => new Date(b.date) - new Date(a.date));
  const filtered = purchTxQ
    ? allTxns.filter(t => {
        const p = getProd(t.productId);
        return (p?.name || '').toLowerCase().includes(purchTxQ) ||
               (p?.category || '').toLowerCase().includes(purchTxQ) ||
               (t.supplier || '').toLowerCase().includes(purchTxQ) ||
               String(t.billId || '').toLowerCase().includes(purchTxQ);
      })
    : allTxns;
  const feed = [
    ...groupTxnsByBill(filtered.filter(t => t.type === 'purchase'), 'purchase').map(g => ({ kind: 'bill', date: g.date, payload: g })),
    ...groupReturnTxns(filtered.filter(t => t.type === 'return' && t.returnType === 'purchase-return')).map(g => ({ kind: 'return', date: g.date, payload: g }))
  ].sort((a,b)=>new Date(b.date)-new Date(a.date));
  pgReset('rPurchaseTxList');
  renderPaged('rPurchaseTxList', feed, item => item.kind === 'return' ? txReturnGroupRow(item.payload) : txGroupRowReport(item.payload), 'rPurchaseTxList',
    '<div class="empty" style="padding:14px"><div class="empty-text">'+(purchTxQ?'No matching transactions':'No transactions')+'</div></div>');
}

function renderSaleReport() {
  const period = getReportPeriodSelection();
  const rType2 = period.type;
  const rDate2 = period.date;
  const saleTxQ = (document.getElementById('rSaleTxSearch')?.value||'').toLowerCase().trim();
  const calc = getCentralCalculationBundle(rType2, rDate2, { saleTxQ, includeOps: false });
  const actionDate = getPeriodStartDate(rType2, rDate2);
  const snap = calc.snap;
  const metrics = calc.metrics;
  const saleAgg = calc.report.saleReportAgg;
  const grossRev2   = metrics.sales.grossRevenue;
  const returnTotal2= metrics.sales.returnRevenue;
  const rev         = metrics.sales.netRevenue;
  const profit      = metrics.sales.profit;
  const margin      = rev > 0 ? (profit/rev*100).toFixed(1) : 0;
  const periodCashRev = metrics.sales.cashSales;
  const periodSaleCashIn = metrics.sales.saleCashIn;
  const periodSaleReturnCashOut = metrics.sales.saleReturnCashOut;
  const periodPayments = metrics.cash.periodPaymentsReceived;
  const periodPurchase = metrics.purchase.cashOutNow;
  const periodPurchasePaid = metrics.purchase.cashPaidAtBuy;
  const periodPurchaseExtraCost = metrics.purchase.extraCostCashOut || 0;
  const periodSupplierDuePaid = metrics.purchase.supplierDuePaidCashOut;
  const periodLoanPaymentCashOut = metrics.cash.loanPaymentCashOut || 0;
  const periodPurchaseReturnCashBack = metrics.purchase.purchaseReturnCashIn;
  const periodOpeningCash = metrics.cash.openingCash;
  const periodCapitalCashIn = metrics.cash.capitalCashIn || 0;
  const periodCapitalRows = (calc.snap?.capitalInRaw || []).slice().sort((a,b)=>new Date(a.date)-new Date(b.date));
  const periodNetCash = metrics.cash.closingCash;
  const periodStockValue = metrics.business.stockValue;
  const totalCustomerDue = metrics.business.customerDueAll;
  const totalSupplierDue = metrics.business.supplierDueAll;
  const periodNetBusinessWorth = metrics.business.netBusinessWorth;
  const periodExtraExpenses = metrics.cash.extraExpensesTotal || 0;
  const periodExtraExpensesList = metrics.cash.extraExpensesList || [];
  if(saleTxQ) pgReset('rTxList');

  const saleBreakdownTitle = rType2 === 'daily'
    ? "💵 Today's Cash Summary"
    : (rType2 === 'weekly'
      ? "💵 Weekly Cash Summary"
      : (rType2 === 'yearly' ? "💵 Yearly Cash Summary (YTD)" : "💵 Monthly Cash Summary"));
  document.getElementById('rStats').innerHTML=`
    <div class="stat"><div class="stat-label">Net Revenue</div><div class="stat-value ${rev>=0?'gold':'red'}">${fmt(rev)}</div><div class="stat-sub">Sales ${fmt(grossRev2)}${returnTotal2>0?' − Returns '+fmt(returnTotal2):''}</div></div>
    <div class="stat"><div class="stat-label">Profit</div><div class="stat-value ${profit>=0?'green':'red'}">${fmt(profit)}</div></div>
    <div class="stat"><div class="stat-label">Sales</div><div class="stat-value blue">${saleAgg.txCount}</div><div class="stat-sub">${saleAgg.returnCount} returned</div></div>
    <div class="stat"><div class="stat-label">Margin</div><div class="stat-value ${profit>=0?'green':'red'}">${margin}%</div></div>
    <div class="stat full" style="background:var(--gold-light);border-color:#e8c47a">
      <div class="card-label">${saleBreakdownTitle}</div>
      <div class="report-row" style="padding:9px 0">
        <div style="font-size:0.85rem;color:var(--ink2)">Opening Cash</div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="font-weight:700;font-family:'Instrument Serif',serif">${fmt(periodOpeningCash)}</div>
          <input id="reportInvestInput" type="number" min="0" step="0.01" placeholder="Investment" style="width:110px;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);font-family:'Outfit',sans-serif;font-size:0.8rem">
          <button onclick="quickCapitalAdjust('${actionDate}','capital-in','reportInvestInput')" style="padding:6px 8px;border:none;border-radius:8px;background:var(--green);color:#fff;font-family:'Outfit',sans-serif;font-size:0.74rem;font-weight:700;cursor:pointer">Invest Save</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0">
        <div style="background:var(--green-light);border:1px solid var(--border);border-radius:10px;padding:10px">
          <div style="font-size:0.72rem;font-weight:700;color:var(--green);text-transform:uppercase;margin-bottom:6px">Income</div>
          <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Sale Cash In</div><div style="font-weight:700;color:var(--green)">+${fmt(periodSaleCashIn)}</div></div>
          ${periodPayments>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Due Received</div><div style="font-weight:700;color:var(--green)">+${fmt(periodPayments)}</div></div>`:''}
          ${periodPurchaseReturnCashBack>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Purchase Return Cash Back</div><div style="font-weight:700;color:var(--green)">+${fmt(periodPurchaseReturnCashBack)}</div></div>`:''}
          <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Investment In</div><div style="font-weight:700;color:var(--green)">+${fmt(periodCapitalCashIn)}</div></div>
          <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed var(--border);margin-top:6px;padding-top:8px">
            <div style="font-size:0.8rem;font-weight:700">Total Income</div>
            <div style="font-weight:700;color:var(--green);font-family:'Instrument Serif',serif">${fmt(metrics.cash.totalIncomeBreakdown)}</div>
          </div>
        </div>
        <div style="background:var(--blue-light);border:1px solid var(--border);border-radius:10px;padding:10px">
          <div style="font-size:0.72rem;font-weight:700;color:var(--blue);text-transform:uppercase;margin-bottom:6px">Cost</div>
          <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Purchase Paid (Cash)</div><div style="font-weight:700;color:var(--blue)">-${fmt(periodPurchasePaid)}</div></div>
          ${periodPurchaseExtraCost>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Purchase Extra Costing</div><div style="font-weight:700;color:var(--red)">-${fmt(periodPurchaseExtraCost)}</div></div>`:''}
          ${periodSaleReturnCashOut>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Sale Return Refund</div><div style="font-weight:700;color:var(--red)">-${fmt(periodSaleReturnCashOut)}</div></div>`:''}
          ${periodSupplierDuePaid>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Supplier Due Paid</div><div style="font-weight:700;color:var(--blue)">-${fmt(periodSupplierDuePaid)}</div></div>`:''}
          ${periodLoanPaymentCashOut>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Loan Payment</div><div style="font-weight:700;color:var(--blue)">-${fmt(periodLoanPaymentCashOut)}</div></div>`:''}
          ${periodExtraExpenses>0?`<div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Extra Expenses</div><div style="font-weight:700;color:var(--red)">-${fmt(periodExtraExpenses)}</div></div>`:''}
          <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed var(--border);margin-top:6px;padding-top:8px">
            <div style="font-size:0.8rem;font-weight:700">Total Cost</div>
            <div style="font-weight:700;color:var(--red);font-family:'Instrument Serif',serif">${fmt(metrics.cash.totalCostBreakdown)}</div>
          </div>
        </div>
      </div>
      <div class="report-row" style="padding:9px 0">
        <div style="font-size:0.85rem;color:var(--ink2)">Net Cash Change ${rType2 === 'daily' ? 'Today' : 'In Period'}</div>
        <div style="font-weight:700;color:${metrics.cash.netCashChange>=0?'var(--green)':'var(--red)'};font-family:'Instrument Serif',serif;font-size:1.05rem">${metrics.cash.netCashChange>=0?'+':''}${fmt(metrics.cash.netCashChange)}</div>
      </div>
      <div style="border-top:2px solid var(--border);margin-top:8px;padding-top:10px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:0.85rem;font-weight:700">Cash in Hand (Expected) = (Opening + Income) - Cost</div>
        <div style="font-weight:700;font-size:1.2rem;font-family:'Instrument Serif',serif;color:${periodNetCash>=0?'var(--green)':'var(--red)'}">${fmt(periodNetCash)}</div>
      </div>
      <div style="margin-top:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px">
        <div style="font-size:0.8rem;font-weight:700;color:var(--ink);text-transform:uppercase;margin-bottom:8px">Total Business Value</div>
        <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Closing Cash</div><div style="font-weight:700">${fmt(periodNetCash)}</div></div>
        <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Stock Value (Current Inventory)</div><div style="font-weight:700;color:var(--blue)">+${fmt(periodStockValue)}</div></div>
        <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Customer Due (As of selected date)</div><div style="font-weight:700;color:var(--green)">+${fmt(totalCustomerDue)}</div></div>
        <div class="report-row" style="padding:7px 0"><div style="font-size:0.8rem;color:var(--ink2)">Supplier Due (As of selected date)</div><div style="font-weight:700;color:var(--red)">-${fmt(totalSupplierDue)}</div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px dashed var(--border);margin-top:6px;padding-top:8px">
          <div style="font-size:0.84rem;font-weight:700">Net Business Worth</div>
          <div style="font-weight:700;font-family:'Instrument Serif',serif;font-size:1.1rem;color:${periodNetBusinessWorth>=0?'var(--green)':'var(--red)'}">${fmt(periodNetBusinessWorth)}</div>
        </div>
      </div>
      <div style="border-top:1.5px dashed var(--border);margin-top:12px;padding-top:10px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--ink2);margin-bottom:6px">☕ Extra Expenses Breakdown</div>
        <div id="rExtraExpensesList"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:7px;margin-top:2px">
          <div style="font-size:0.8rem;font-weight:700;color:var(--ink2)">Total Extra Expenses</div>
          <div style="font-weight:700;color:var(--red);font-family:'Instrument Serif',serif">${fmt(periodExtraExpenses)}</div>
        </div>
      </div>
      <div style="border-top:1.5px dashed var(--border);margin-top:12px;padding-top:10px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--ink2);margin-bottom:6px">🏦 Capital Ledger (Investment In)</div>
        <div id="rCapitalLedgerList"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:7px;margin-top:2px">
          <div style="font-size:0.8rem;font-weight:700;color:var(--ink2)">Total Investment In</div>
          <div style="font-weight:700;color:var(--green);font-family:'Instrument Serif',serif">${fmt(periodCapitalCashIn)}</div>
        </div>
      </div>
    </div>`;
  renderPaged(
    'rExtraExpensesList',
    periodExtraExpensesList,
    e => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:0.82rem;font-weight:600">${escapeHtml(e.note)}</div>
          <div style="font-size:0.68rem;color:var(--ink2)">${e.date}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-family:'Instrument Serif',serif;font-size:0.92rem;color:var(--red)">-${fmt(e.amount)}</span>
          <button onclick="startEditExpense('${e.id}')" style="background:none;border:none;color:var(--blue);font-size:0.9rem;cursor:pointer;padding:2px 5px;border-radius:5px;opacity:0.75" title="Edit">✏️</button>
          <button onclick="deleteExtraExpense('${e.id}')" class="del-btn" style="font-size:0.78rem;padding:2px 6px">🗑</button>
        </div>
      </div>`,
    'rExtraExpensesList',
    '<div style="font-size:0.78rem;color:var(--ink2);padding:4px 0">No extra expenses in this period.</div>'
  );
  renderPaged(
    'rCapitalLedgerList',
    periodCapitalRows,
    t => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:0.78rem;color:var(--ink2)">${displayDateTime(t.date) || dateToYMDLocal(t.date)}${t.reason ? ` · ${escapeHtml(t.reason)}` : ''}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="font-weight:700;color:var(--green)">+${fmt(t.total)}</div>
          <button onclick="undoInvestmentTx('${t.id}')" style="font-size:0.74rem;padding:2px 7px;border:none;border-radius:7px;background:var(--red);color:#fff;font-weight:700;cursor:pointer">↩ Undo</button>
        </div>
      </div>`,
    'rCapitalLedgerList',
    '<div style="font-size:0.78rem;color:var(--ink2);padding:4px 0">No investment in this period.</div>'
  );

  const sorted = saleAgg.sorted;
  const maxRev = saleAgg.maxRev;

  document.getElementById('rBar').innerHTML = sorted.length===0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No sales in this period</div></div>'
    : sorted.slice(0,6).map(([pid,d])=>{
      const p=getProd(pid);
      return `<div class="bar-row">
        <div class="bar-label">${p?.name||pid}</div>
        <div class="bar-bg"><div class="bar-fill" style="width:${(d.revenue/maxRev*100).toFixed(1)}%"></div></div>
        <div class="bar-val">${fmt(d.revenue)}</div></div>`;
    }).join('');

  renderPaged('rBreakdown',
    sorted,
    ([pid,d])=>{ const p=getProd(pid); const prof=d.revenue-d.cost; return `<div class="report-row"><div><div class="report-name">${p?.name||pid}</div><div class="report-qty">${d.qty} ${p?.unit||''} sold</div></div><div><div class="report-rev">${fmt(d.revenue)}</div><div class="report-profit-sub">Profit: ${fmt(prof)}</div></div></div>`; },
    'rBreakdown',
    '<div class="empty" style="padding:14px"><div class="empty-text">No data</div></div>');

  document.getElementById('rCategoryBreakdown').innerHTML = saleAgg.byCategoryEntries.length===0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No data</div></div>'
    : saleAgg.byCategoryEntries.map(([cat,d])=>{
      const prof=d.revenue-d.cost;
      return `<div class="report-row">
        <div><div class="report-name">${cat}</div></div>
        <div><div class="report-rev">${fmt(d.revenue)}</div><div class="report-profit-sub">Profit: ${fmt(prof)}</div></div></div>`;
    }).join('');
  const profitAnalysis = saleAgg.profitAnalysis;
  const fastSellingProds = saleAgg.fastSellingProds;
  const slowSellingProds = saleAgg.slowSellingProds;

  renderPaged('rFastSelling', fastSellingProds,
    p=>`<div class="report-row"><div><div class="report-name">${p.name} <span style="font-size:0.7rem;color:var(--green)">${p.qty} units</span></div><div class="report-qty">${fmt(p.revenue)} revenue</div></div><div style="text-align:right"><div style="color:var(--green);font-weight:700">${fmt(p.profit)}</div><div style="font-size:0.7rem;color:var(--ink2)">Profit</div></div></div>`,
    'rFastSelling',
    '<div class="empty" style="padding:14px"><div class="empty-text">No fast selling products</div></div>');

  renderPaged('rSlowSelling', slowSellingProds,
    p=>`<div class="report-row"><div><div class="report-name">${p.name} <span style="font-size:0.7rem;color:var(--gold)">${p.qty} units</span></div><div class="report-qty">${fmt(p.revenue)} revenue</div></div><div style="text-align:right"><div style="color:${p.profit<0?'var(--red)':'var(--gold)'};font-weight:700">${fmt(p.profit)}</div><div style="font-size:0.7rem;color:var(--ink2)">Profit</div></div></div>`,
    'rSlowSelling',
    '<div class="empty" style="padding:14px"><div class="empty-text">No slow selling products</div></div>');

  const profLegend = '<div style="font-size:0.85rem;margin-bottom:8px;padding:8px;background:var(--surface2);border-radius:8px"><strong>Green 🚀 = High Profit (&gt;10%)</strong> | <strong>Yellow 🐢 = Low Profit</strong> | <strong>Red ❌ = Loss</strong></div>';
  if(profitAnalysis.length===0) {
    document.getElementById('rProfitability').innerHTML = '<div class="empty" style="padding:14px"><div class="empty-text">No sales data</div></div>';
  } else {
    const profContainer = document.getElementById('rProfitability');
    profContainer.innerHTML = profLegend + '<div id="rProfitabilityList"></div>';
    renderPaged('rProfitabilityList', profitAnalysis,
      p=>`<div class="report-row" style="padding:12px;background:${p.status==='loss'?'var(--red-light)':p.status==='low'?'rgba(249,203,0,0.1)':'var(--green-light)'};margin-bottom:8px;border-radius:8px"><div><div class="report-name">${p.name} <span style="font-size:0.7rem;color:var(--ink2)">${p.pid}</span></div><div class="report-qty" style="margin-top:3px">${p.qty} units sold · ${fmt(p.revenue)} revenue</div><div style="font-size:0.75rem;color:var(--ink2);margin-top:2px">Cost: ${fmt(p.cost)} · Margin: ${p.margin}%${p.cost>0?` · ${(p.profit/p.cost*100).toFixed(1)}% on cost`:''}</div></div><div style="text-align:right"><div style="font-size:1rem;font-weight:700;color:${p.status==='loss'?'var(--red)':p.status==='low'?'var(--gold)':'var(--green)'}">${fmt(p.profit)}</div><div style="font-size:0.8rem;margin-top:4px">${p.badge}</div></div></div>`,
      'rProfitabilityList', '');
  }

  const saleReportTxFeed = [
    ...(saleAgg.groupedSaleTxns || []).map(g => ({ kind: 'bill', date: g.date, payload: g })),
    ...(saleAgg.groupedSaleReturnTxns || []).map(g => ({ kind: 'return', date: g.date, payload: g }))
  ].sort((a,b)=>new Date(b.date)-new Date(a.date));
  renderPaged('rTxList', saleReportTxFeed, item => item.kind === 'return' ? txReturnGroupRow(item.payload) : txGroupRowReport(item.payload), 'rTxList',
    '<div class="empty" style="padding:14px"><div class="empty-text">'+(saleTxQ?'No matching transactions':'No transactions')+'</div></div>');
}

function renderPurchaseReport() {
  const period = getReportPeriodSelection();
  const rType2 = period.type;
  const rDate2 = period.date;
  const purchTxQ = (document.getElementById('rPurchTxSearch')?.value||'').toLowerCase().trim();
  const calc = getCentralCalculationBundle(rType2, rDate2, { purchTxQ, includeBusiness: false, includeOps: false });
  const snap = calc.snap;
  const metrics = calc.metrics;
  const purchAgg = calc.report.purchaseReportAgg;
  const totalQty = metrics.purchase.netPurchaseQty;
  const uniqueSuppliers = purchAgg.uniqueSupplierCount || 0;
  const periodSupplierDuePaid = metrics.purchase.supplierDuePaidCashOut;
  const periodPurchaseCashAtBuy = metrics.purchase.cashPaidAtBuy;
  const periodPurchaseCashNow = metrics.purchase.cashOutNow;
  const periodPurchaseCreditNow = metrics.purchase.outstandingSupplierDueNow;
  const totalSpend = metrics.purchase.netSpendNow;
  if(purchTxQ) pgReset('rPurchaseTxList');

  document.getElementById('rPurchaseStats').innerHTML = `
    <div class="stat"><div class="stat-label">Net Spend</div><div class="stat-value blue">${fmt(totalSpend)}</div>${purchAgg.returnCount>0?`<div class="stat-sub">${purchAgg.returnCount} purchase return(s) deducted</div>`:''}<div class="stat-sub">${fmt(periodPurchaseCashNow)} + ${fmt(periodPurchaseCreditNow)} = ${fmt(totalSpend)}</div></div>
    <div class="stat">
      <div class="stat-label">Purchase Breakdown</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px">
        <div>
          <div style="font-size:0.8rem;color:var(--ink2)">Cash Out (Incl. Supplier Due Paid)</div>
          <div style="font-family:'Instrument Serif',serif;font-size:1.25rem;color:var(--blue);font-weight:700">${fmt(periodPurchaseCashNow)}</div>
          ${periodSupplierDuePaid>0?`<div style="font-size:0.72rem;color:var(--ink2);margin-top:2px">Supplier due paid: ${fmt(periodSupplierDuePaid)}</div>`:''}
        </div>
        <div>
          <div style="font-size:0.8rem;color:var(--ink2)">On Credit (Outstanding Now)</div>
          <div style="font-family:'Instrument Serif',serif;font-size:1.25rem;color:var(--gold);font-weight:700">${fmt(periodPurchaseCreditNow)}</div>
        </div>
      </div>
    </div>
    <div class="stat"><div class="stat-label">Items Bought</div><div class="stat-value gold">${purchAgg.txCount}</div></div>
    <div class="stat"><div class="stat-label">Net Qty</div><div class="stat-value green">${totalQty}</div></div>
    <div class="stat"><div class="stat-label">Suppliers</div><div class="stat-value">${uniqueSuppliers}</div></div>
    ${purchAgg.purchaseDiscountTotal>0?`<div class="stat"><div class="stat-label">Distributor Discount</div><div class="stat-value green">${fmt(purchAgg.purchaseDiscountTotal)}</div><div class="stat-sub">List ${fmt(purchAgg.grossPurchaseTotal)} → Net ${fmt(purchAgg.netPurchaseTotal)}</div></div>`:''}`;

  const sorted = purchAgg.sorted;
  const maxSpend = purchAgg.maxSpend;

  document.getElementById('rPurchaseBar').innerHTML = sorted.length === 0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No purchases in this period</div></div>'
    : sorted.slice(0,6).map(([pid,d]) => {
      const p = getProd(pid);
      return `<div class="bar-row">
        <div class="bar-label">${p?.name||pid}</div>
        <div class="bar-bg"><div class="bar-fill" style="width:${(d.spend/maxSpend*100).toFixed(1)}%;background:var(--blue)"></div></div>
        <div class="bar-val">${fmt(d.spend)}</div></div>`;
    }).join('');

  renderPaged('rPurchaseBreakdown', sorted,
    ([pid,d])=>{ const p=getProd(pid); return `<div class="report-row"><div><div class="report-name">${p?.name||pid}</div><div class="report-qty">${d.qty} ${p?.unit||''} purchased</div></div><div><div class="report-rev" style="color:var(--blue)">${fmt(d.spend)}</div></div></div>`; },
    'rPurchaseBreakdown',
    '<div class="empty" style="padding:14px"><div class="empty-text">No data</div></div>');

  document.getElementById('rPurchaseCategoryBreakdown').innerHTML = purchAgg.byCategoryEntries.length === 0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No data</div></div>'
    : purchAgg.byCategoryEntries.map(([cat,d]) =>
      `<div class="report-row">
        <div><div class="report-name">${cat}</div><div class="report-qty">${d.qty} units</div></div>
        <div><div class="report-rev" style="color:var(--blue)">${fmt(d.spend)}</div></div></div>`
    ).join('');
  document.getElementById('rSupplierBreakdown').innerHTML = purchAgg.bySupplierEntries.length === 0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No supplier data</div></div>'
    : purchAgg.bySupplierEntries.map(([sup,d]) =>
      `<div class="report-row">
        <div><div class="report-name">${sup}</div><div class="report-qty">${d.count} transactions</div></div>
        <div><div class="report-rev" style="color:var(--blue)">${fmt(d.spend)}</div></div></div>`
    ).join('');
  const purchaseReportTxFeed = [
    ...(purchAgg.groupedPurchTxns || []).map(g => ({ kind: 'bill', date: g.date, payload: g })),
    ...(purchAgg.groupedPurchaseReturnTxns || []).map(g => ({ kind: 'return', date: g.date, payload: g }))
  ].sort((a,b)=>new Date(b.date)-new Date(a.date));
  renderPaged('rPurchaseTxList', purchaseReportTxFeed, item => item.kind === 'return' ? txReturnGroupRow(item.payload) : txGroupRow(item.payload), 'rPurchaseTxList',
    '<div class="empty" style="padding:14px"><div class="empty-text">'+(purchTxQ?'No matching transactions':'No purchase transactions')+'</div></div>');

  // Supplier dues — show ALL outstanding (not filtered by period), from central credit metrics
  const centralCreditAll = buildCreditMetrics('daily', todayStr());
  const allOpenSC = (centralCreditAll.allSupplierCredits || []).filter(sc=>getSupplierDue(sc)>0);
  const totalSupplierDue = round2(Number(centralCreditAll.totalSupplierDue) || 0);
  document.getElementById('rSupplierDues').innerHTML = allOpenSC.length === 0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">✅ No outstanding supplier dues</div></div>'
    : `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 12px;border-bottom:1px solid var(--border);margin-bottom:4px">
        <div style="font-size:0.82rem;color:var(--ink2)">Total due to suppliers</div>
        <div style="font-family:'Instrument Serif',serif;font-size:1.2rem;color:var(--red);font-weight:700">${fmt(totalSupplierDue)}</div>
       </div>` +
      allOpenSC.sort((a,b)=>new Date(b.date)-new Date(a.date)).map(sc=>{
        const due = getSupplierDue(sc);
        const paid = getSupplierTotalPaid(sc);
        const pct = sc.total>0 ? Math.min(100,(paid/sc.total*100)).toFixed(0) : 0;
        const p = getProd(sc.productId);
        const itemsText = Array.isArray(sc.products) && sc.products.length > 0
          ? sc.products.map(pr=>{
              const prod = getProd(pr.productId);
              return `${pr.qty} ${prod?.unit||''} ${prod?.name||'?'}`;
            }).join(', ')
          : `${sc.qty} ${p?.unit||''} ${p?.name||'?'}`;
        const spayments = (data.supplierPayments||[]).filter(sp=>String(sp.scId)===String(sc.id));
        const payHist = spayments.length>0
          ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">${spayments.map(sp=>`<div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2);padding:2px 0"><span>📅 ${displayDateTime(sp.date) || dateToYMDLocal(sp.date)}${sp.note?' · '+sp.note:''}</span><span style="color:var(--green);font-weight:700">+${fmt(sp.amount)}</span></div>`).join('')}</div>`
          : '';
        return `<div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
            <div>
              <div style="font-weight:700;font-size:0.9rem">${sc.supplierName}</div>
              <div style="font-size:0.72rem;color:var(--ink2)">${displayDateTime(sc.date) || dateToYMDLocal(sc.date)} · ${itemsText}</div>
            </div>
            <div style="font-family:'Instrument Serif',serif;font-size:1rem;color:var(--red);font-weight:700">${fmt(due)}</div>
          </div>
          <div style="height:5px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-bottom:4px">
            <div style="height:100%;width:${pct}%;background:var(--gold);border-radius:4px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2)">
            <span>Paid: ${fmt(paid)}</span><span>Total: ${fmt(sc.total)}</span>
          </div>
          ${payHist}
          <button onclick="openSupplierPayModal(${sc.id})" style="margin-top:8px;padding:6px 14px;background:var(--blue);color:#fff;border:none;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif">💰 Pay Supplier</button>
        </div>`;
      }).join('');
}

function renderLedgerReport() {
  const period = getReportPeriodSelection();
  const rType2 = period.type;
  const rDate2 = period.date;
  const calc = getCentralCalculationBundle(rType2, rDate2, { includeOps: false });
  const metrics = calc.metrics;
  const snap = calc.snap || {};
  const cash = metrics.cash || {};
  const sales = metrics.sales || {};
  const business = metrics.business || {};

  const investmentIn = round2(Number(cash.investmentCashIn ?? cash.capitalCashIn) || 0);
  const loanIn = round2(Number(cash.loanCashIn) || 0);
  const loanPaid = round2((data.loanPayments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const loanDue = round2((typeof getLoanFundingTxs === 'function' ? getLoanFundingTxs() : []).reduce((s, t) => s + (typeof getLoanDue === 'function' ? getLoanDue(t) : 0), 0));
  const capitalOut = round2(Number(cash.capitalCashOut) || 0);
  const withdrawals = round2(Number(cash.cashWithdrawalsTotal) || 0);
  const totalWithdrawal = round2(capitalOut + withdrawals);
  const openingCash = round2(Number(cash.openingCash) || 0);
  const businessCapital = round2(openingCash + investmentIn - totalWithdrawal);
  const businessWorth = round2(Number(business.netBusinessWorth) || 0);
  const customerCredit = round2(Number(business.customerDueAll) || 0);
  const supplierCredit = round2(Number(business.supplierDueAll) || 0);
  const netCreditPosition = round2(customerCredit - supplierCredit);
  const extraExpense = round2(Number(cash.extraExpensesTotal) || 0);
  const damageLoss = round2(Number(sales.adjustmentLoss) || 0);
  const totalProfit = round2(Number(sales.profit) || 0);
  const netProfitLoss = round2(totalProfit - extraExpense);
  const stockValue = round2(Number(business.stockValue) || 0);
  const cashInHand = round2(Number(cash.closingCash) || 0);

  const stat = (label, value, color = 'gold', sub = '') =>
    `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value ${color}">${fmt(value)}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
  const loanDueStat = () =>
    `<button type="button" class="stat loan-due-action ${loanDue > 0 ? 'blink' : ''}" onclick="openLoanLedgerPage()">
      <div class="stat-label">Loan Due</div>
      <div class="stat-value ${loanDue > 0 ? 'red' : 'green'}">${fmt(loanDue)}</div>
      <div class="stat-sub">Paid ${fmt(loanPaid)} - Click to view / pay loan</div>
    </button>`;

  document.getElementById('rLedgerStats').innerHTML = `
    ${stat('Business Capital', businessCapital, businessCapital >= 0 ? 'green' : 'red', `Opening cash ${fmt(openingCash)} + investment - withdrawal`)}
    ${stat('Business Worth', businessWorth, businessWorth >= 0 ? 'green' : 'red', `Cash ${fmt(cashInHand)} + stock ${fmt(stockValue)} + customer due - supplier due`)}
    ${stat('Total Customer Credit', customerCredit, 'green', 'Receivable from customers')}
    ${stat('Total Supplier Credit', supplierCredit, 'red', 'Payable to suppliers')}
    ${stat('Net Credit Position', netCreditPosition, netCreditPosition >= 0 ? 'green' : 'red', 'Customer due - supplier due')}
    ${stat('Total Extra Expense', extraExpense, extraExpense > 0 ? 'red' : 'green')}
    ${stat('Total Withdrawal', totalWithdrawal, totalWithdrawal > 0 ? 'red' : 'green', `Owner withdrawal ${fmt(withdrawals)}${capitalOut > 0 ? ` + capital out ${fmt(capitalOut)}` : ''}`)}
    ${stat('Total Investment', investmentIn, 'green')}
    ${loanIn > 0 ? stat('Total Loan In', loanIn, 'blue') : ''}
    ${loanIn > 0 ? loanDueStat() : ''}
    ${stat('Total Profit', totalProfit, totalProfit >= 0 ? 'green' : 'red', damageLoss > 0 ? `Damage/adjustment loss included: ${fmt(damageLoss)}` : 'Damage/adjustment loss included')}
    ${stat('Net Profit / Loss', netProfitLoss, netProfitLoss >= 0 ? 'green' : 'red', 'After extra expense and damages')}
  `;

  const rows = [
    ['Cash in Hand', cashInHand, 'Expected closing cash for selected date'],
    ['Stock Value', stockValue, 'Current inventory value as of selected date'],
    ['Customer Due', customerCredit, 'Money customers owe you'],
    ['Supplier Due', supplierCredit, 'Money you owe suppliers'],
    ['Investment In', investmentIn, 'Capital added in selected period'],
    ['Withdrawal / Drawings', totalWithdrawal, 'Owner withdrawals plus capital out'],
    ['Extra Expenses', extraExpense, 'Expenses outside product purchase cost'],
    ['Damage / Stock Adjustment Loss', damageLoss, 'Loss from stock adjustments'],
    ['Profit Before Extra Expense', totalProfit, 'Sales profit after product cost and damages'],
    ['Net Profit / Loss', netProfitLoss, 'Profit after extra expenses and damages']
  ];

  document.getElementById('rLedgerSummary').innerHTML = rows.map(([label, value, note]) => `
    <div class="report-row">
      <div><div class="report-name">${label}</div><div class="report-qty">${note}</div></div>
      <div class="report-rev" style="color:${Number(value) < 0 ? 'var(--red)' : 'var(--ink)'}">${fmt(value)}</div>
    </div>
  `).join('');
  if(window.loanLedgerPageOpen) renderLoanLedgerPage();
}

function renderCreditReport() {
  const period = getReportPeriodSelection();
  const rType2 = period.type;
  const rDate2 = period.date;
  const cm = getCentralCalculationBundle(rType2, rDate2, { includeBusiness: false, includeOps: false }).creditMetrics;

  document.getElementById('rCreditStats').innerHTML=`
    <div class="stat"><div class="stat-label">Total Customer Due</div><div class="stat-value red">${fmt(cm.totalCustomerDue)}</div><div class="stat-sub">${cm.openCustCount} customers</div></div>
    <div class="stat"><div class="stat-label">Total Supplier Due</div><div class="stat-value red">${fmt(cm.totalSupplierDue)}</div><div class="stat-sub">${cm.openSuppCount} suppliers</div></div>
    <div class="stat"><div class="stat-label">Total Credit Given (All)</div><div class="stat-value gold">${fmt(cm.totalAllGiven)}</div></div>
    <div class="stat"><div class="stat-label">New Credit Given (Period)</div><div class="stat-value blue">${fmt(cm.periodGiven)}</div><div class="stat-sub">Only credits created in selected period</div></div>
    <div class="stat"><div class="stat-label">Outstanding from New Period Credit</div><div class="stat-value red">${fmt(cm.periodNewDue)}</div></div>
    <div class="stat"><div class="stat-label">Period Collected</div><div class="stat-value green">${fmt(cm.periodCollected)}</div><div class="stat-sub">Due payments received in selected period</div></div>`;

  // Customer balance summary (all time, grouped) - includes settled for audit history
  document.getElementById('rCreditCustomers').innerHTML = cm.customerSorted.length===0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No customer credit history</div></div>'
    : cm.customerSorted.map(([,d])=>{
        const pct = d.total>0 ? Math.min(100,(d.paid/d.total*100)).toFixed(0) : 0;
        const settled = d.due <= 0.001;
        return `<div class="report-row" style="flex-direction:column;align-items:stretch;padding:12px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div><div class="report-name">${d.label}${d.phone?` · ${d.phone}`:''}</div><div class="report-qty">${d.count} credit sale(s)</div></div>
            <div style="text-align:right">
              <div style="font-family:'Instrument Serif',serif;font-size:1rem;color:${settled?'var(--green)':'var(--red)'};font-weight:700">${settled?'Settled':fmt(d.due)}</div>
              <div style="font-size:0.7rem;color:var(--ink2)">${settled?'history':'outstanding'}</div>
            </div>
          </div>
          <div style="height:5px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-bottom:4px">
            <div style="height:100%;width:${pct}%;background:${settled?'var(--green)':'var(--gold)'};border-radius:4px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2)">
            <span>Paid: ${fmt(d.paid)}</span><span>Total: ${fmt(d.total)}</span>${!settled?`<span style="color:var(--red);font-weight:700">Due: ${fmt(d.due)}</span>`:''}
          </div>
        </div>`;
      }).join('');

  // Supplier balance summary (all time, grouped) - includes settled for audit history
  document.getElementById('rCreditSuppliers').innerHTML = cm.supplierSorted.length===0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No supplier credit history</div></div>'
    : cm.supplierSorted.map(([name,d])=>{
        const pct = d.total>0 ? Math.min(100,(d.paid/d.total*100)).toFixed(0) : 0;
        const settled = d.due <= 0.001;
        return `<div class="report-row" style="flex-direction:column;align-items:stretch;padding:12px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div><div class="report-name">${name}</div><div class="report-qty">${d.count} purchase credit(s)</div></div>
            <div style="text-align:right">
              <div style="font-family:'Instrument Serif',serif;font-size:1rem;color:${settled?'var(--green)':'var(--red)'};font-weight:700">${settled?'Settled':fmt(d.due)}</div>
              <div style="font-size:0.7rem;color:var(--ink2)">${settled?'history':'outstanding'}</div>
            </div>
          </div>
          <div style="height:5px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-bottom:4px">
            <div style="height:100%;width:${pct}%;background:${settled?'var(--green)':'var(--blue)'};border-radius:4px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2)">
            <span>Paid: ${fmt(d.paid)}</span><span>Total: ${fmt(d.total)}</span>${!settled?`<span style="color:var(--red);font-weight:700">Due: ${fmt(d.due)}</span>`:''}
          </div>
        </div>`;
      }).join('');

  // Payment trend: payments received in this period grouped by product
  document.getElementById('rCreditTrend').innerHTML = cm.trendSorted.length===0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No credit sales in this period</div></div>'
    : cm.trendSorted.map(([pid,d])=>{
        const p=getProd(pid);
        return `<div class="report-row">
          <div><div class="report-name">${p?.name||pid}</div><div class="report-qty">${d.qty} ${p?.unit||''} on credit</div></div>
          <div><div class="report-rev" style="color:var(--blue)">${fmt(d.total)}</div><div style="font-size:0.7rem;color:var(--red);text-align:right">Due: ${fmt(d.due)}</div></div>
        </div>`;
      }).join('');

  // Settlement status (period credits)
  document.getElementById('rCreditSettlement').innerHTML = cm.periodCredits.length===0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No credit sales in this period</div></div>'
    : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <div style="background:var(--green-light);border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;color:var(--green);margin-bottom:4px">Settled</div>
          <div style="font-family:'Instrument Serif',serif;font-size:1.5rem;color:var(--green)">${cm.settledCount}</div>
        </div>
        <div style="background:var(--red-light);border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;color:var(--red);margin-bottom:4px">Outstanding</div>
          <div style="font-family:'Instrument Serif',serif;font-size:1.5rem;color:var(--red)">${cm.unsettledCount}</div>
        </div>
      </div>
      <div style="background:var(--gold-light);border-radius:10px;padding:10px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:0.85rem;font-weight:700">Total Collected (Period)</div>
        <div style="font-family:'Instrument Serif',serif;font-size:1.2rem;color:var(--green);font-weight:700">${fmt(cm.totalCollectedPeriod)}</div>
      </div>`;

  // Credit transactions list (period)
  document.getElementById('rCreditList').innerHTML = cm.periodCreditsSorted.length===0
    ? '<div class="empty" style="padding:14px"><div class="empty-text">No credit sales in this period</div></div>'
    : cm.periodCreditsSorted.map(credit=>{
        const due      = getCreditDue(credit);
        const paid     = getCreditTotalPaid(credit);
        const initialPaid = round2(Number(credit.paid) || 0);
        const pct      = credit.total>0 ? Math.min(100,(paid/credit.total*100)).toFixed(0) : 0;
        const settled  = due<=0;
        const dateStr  = displayDateTime(credit.date) || dateToYMDLocal(credit.date);
        const payments = data.payments.filter(p=>String(p.creditId)===String(credit.id));
        const laterPaid = round2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
        const payHist  = payments.length>0
          ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">${initialPaid>0?`<div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2);padding:2px 0"><span>📌 ${dateStr} · Initial paid</span><span style="color:var(--green);font-weight:700">+${fmt(initialPaid)}</span></div>`:''}${payments.map(p=>`<div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2);padding:2px 0"><span>📅 ${displayDateTime(p.date) || dateToYMDLocal(p.date)}${p.note?' · '+p.note:''}</span><span style="color:var(--green);font-weight:700">+${fmt(p.amount)}</span></div>`).join('')}</div>`
          : `${initialPaid>0?`<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border)"><div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2);padding:2px 0"><span>📌 ${dateStr} · Initial paid</span><span style="color:var(--green);font-weight:700">+${fmt(initialPaid)}</span></div></div>`:''}`;
        return `<div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
            <div>
              <div style="font-weight:700;font-size:0.9rem">${credit.customerName}</div>
              <div style="font-size:0.72rem;color:var(--ink2)">${dateStr} · ${(credit.products||[]).map(p=>{const pr=getProd(p.productId);return `${p.qty} ${pr?.unit||''} ${pr?.name||'?'}`;}).join(', ')}</div>
            </div>
            <span style="padding:4px 10px;border-radius:20px;font-size:0.72rem;font-weight:700;background:${settled?'var(--green-light)':'var(--red-light)'};color:${settled?'var(--green)':'var(--red)'}">${settled?'✅ Settled':'⏳ Outstanding'}</span>
          </div>
          <div style="height:5px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-bottom:4px">
            <div style="height:100%;width:${pct}%;background:${settled?'var(--green)':'var(--gold)'};border-radius:4px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2)">
            <span>Paid: ${fmt(paid)}</span><span>Total: ${fmt(credit.total)}</span>${due>0?`<span style="color:var(--red);font-weight:700">Due: ${fmt(due)}</span>`:''}
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--ink2);margin-top:2px">
            <span>Initial: ${fmt(initialPaid)}</span><span>Later: ${fmt(laterPaid)}</span>
          </div>
          ${payHist}
        </div>`;
      }).join('');
}
