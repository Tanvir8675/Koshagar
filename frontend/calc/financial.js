// calc/financial.js — KoshCalc financial calculation layer
// Phase 3 extraction. Classic script sharing index.html's global scope; loads
// AFTER the main script (so the globals it reads at call time already exist)
// and before bootstrap. Pure, DOM-free financial math — the single source of
// truth for snapshot/report calculations. Reads the global `data` object and
// pure helpers (round2, buildPeriodMatcher, getNetTxView, getReturnCost,
// getCreditDueAsOf, getSupplierDueAsOf, getCreditDue, getStock, getProd,
// getOpeningCashForDate, getTotalInventoryValueAsOf, getPeriodStartDate,
// getPeriodEndDate,
// groupTxnsByBill, groupReturnTxns, isLinkedReturnTx, buildCreditMetrics,
// todayStr). No DOM access.

// ===== KoshCalc — isolated financial calculation namespace (Phase 1) =====
var KoshCalc = window.KoshCalc || (window.KoshCalc = {});

function saleCostTotal(t) {
  if(typeof getSaleCostTotal === 'function') return getSaleCostTotal(t);
  const exact = Number(t && t.costTotal);
  if(Number.isFinite(exact) && exact >= 0) return round2(exact);
  return round2((Number(t && t.cost) || 0) * (Number(t && t.qty) || 0));
}

function returnCostTotal(t) {
  if(typeof getReturnCostTotal === 'function') return getReturnCostTotal(t);
  return round2(getReturnCost(t) * (Number(t && t.qty) || 0));
}

KoshCalc._loadPeriodTransactionsFromSqlite = function(periodType, periodDate) {
  try {
    if(!window.KoshDB || !KoshDB.available || !KoshDB.hasBusinessData()) return null;
    const badDate = KoshDB.query("SELECT COUNT(*) FROM transactions WHERE local_date IS NULL OR local_date NOT GLOB '????-??-??'");
    const badDateCount = badDate && badDate[0] && badDate[0].values && badDate[0].values[0] ? Number(badDate[0].values[0][0]) || 0 : 0;
    if(badDateCount > 0) return null;

    let startYmd = getPeriodStartDate(periodType, periodDate);
    let endYmd = typeof getPeriodEndDate === 'function' ? getPeriodEndDate(periodType, periodDate) : (periodDate || todayStr());
    if(!startYmd || !endYmd) return null;
    if(startYmd > endYmd) { const tmp = startYmd; startYmd = endYmd; endYmd = tmp; }

    const res = KoshDB.query(
      `SELECT json FROM transactions
       WHERE local_date >= ? AND local_date <= ?
         AND type IN ('sale','purchase','return','adjustment','capital-in','capital-out')
       ORDER BY local_date ASC, id ASC`,
      [startYmd, endYmd]
    );
    if(!res || !res[0]) return [];
    const out = [];
    for(const row of res[0].values || []) {
      try { out.push(JSON.parse(row[0])); } catch(_) {}
    }
    return out;
  } catch(_) {
    return null;
  }
};

KoshCalc._loadPeriodJsonRowsFromSqlite = function(table, periodType, periodDate) {
  const allowed = {
    credits: true,
    payments: true,
    supplier_credits: true,
    supplier_payments: true,
    extra_expenses: true,
    cash_withdrawals: true
  };
  if(!allowed[table]) return null;
  try {
    if(!window.KoshDB || !KoshDB.available || !KoshDB.hasBusinessData()) return null;
    const badDate = KoshDB.query(`SELECT COUNT(*) FROM ${table} WHERE local_date IS NULL OR local_date NOT GLOB '????-??-??'`);
    const badDateCount = badDate && badDate[0] && badDate[0].values && badDate[0].values[0] ? Number(badDate[0].values[0][0]) || 0 : 0;
    if(badDateCount > 0) return null;

    let startYmd = getPeriodStartDate(periodType, periodDate);
    let endYmd = typeof getPeriodEndDate === 'function' ? getPeriodEndDate(periodType, periodDate) : (periodDate || todayStr());
    if(!startYmd || !endYmd) return null;
    if(startYmd > endYmd) { const tmp = startYmd; startYmd = endYmd; endYmd = tmp; }

    const res = KoshDB.query(
      `SELECT json FROM ${table}
       WHERE local_date >= ? AND local_date <= ?
       ORDER BY local_date ASC, id ASC`,
      [startYmd, endYmd]
    );
    if(!res || !res[0]) return [];
    const out = [];
    for(const row of res[0].values || []) {
      try { out.push(JSON.parse(row[0])); } catch(_) {}
    }
    return out;
  } catch(_) {
    return null;
  }
};

KoshCalc._computeFinancialSnapshotUncached = function(periodType, periodDate) {
  const inPeriod = buildPeriodMatcher(periodType, periodDate);
  const cutoffYmd = typeof getPeriodEndDate === 'function' ? getPeriodEndDate(periodType, periodDate) : (periodDate || todayStr());
  const periodTransactions = KoshCalc._loadPeriodTransactionsFromSqlite(periodType, periodDate) || data.transactions;
  const sqlPeriodScoped = periodTransactions !== data.transactions;
  const periodTx = sqlPeriodScoped ? periodTransactions : data.transactions.filter(t => inPeriod(t.date));
  const salesRaw = periodTx.filter(t => t.type === 'sale');
  const purchasesRaw = periodTx.filter(t => t.type === 'purchase' && !t.opening);
  const saleReturnsRaw = periodTx.filter(t =>
    t.type === 'return' &&
    (t.returnType === 'sale-return' || !t.returnType)
  );
  const purchaseReturnsRaw = periodTx.filter(t =>
    t.type === 'return' &&
    t.returnType === 'purchase-return'
  );
  const capitalInRaw = periodTx.filter(t => t.type === 'capital-in' && !t.seedOpening);
  const capitalOutRaw = periodTx.filter(t => t.type === 'capital-out');
  const adjustmentsRaw = periodTx.filter(t => t.type === 'adjustment');
  const salesNet = salesRaw.map(getNetTxView).filter(t => t.qty > 0.0001);
  const purchasesNet = purchasesRaw.map(getNetTxView).filter(t => t.qty > 0.0001);

  // Revenue/profit must always deduct ALL sale returns (linked + unlinked).
  // Linked returns are transactional adjustments and must remain visible in return totals.
  const grossSalesRevenue = round2(salesRaw.reduce((s, t) => s + (Number(t.total) || 0), 0));
  const saleReturnRevenue = round2(saleReturnsRaw.reduce((s, t) => s + (Number(t.total) || 0), 0));
  // Period-consistent net sales: only current-period sale minus current-period sale return.
  const netRevenue = round2(grossSalesRevenue - saleReturnRevenue);

  const grossSalesCost = round2(salesRaw.reduce((s, t) => s + saleCostTotal(t), 0));
  const saleReturnCost = round2(saleReturnsRaw.reduce((s, t) => s + returnCostTotal(t), 0));
  const netCost = round2(grossSalesCost - saleReturnCost);
  // Stock adjustment losses (damage/theft/correction): user-stated value × qty.
  const adjustmentLossTotal = round2(adjustmentsRaw.reduce((s, t) => s + round2((Number(t.cost) || 0) * (Number(t.qty) || 0)), 0));
  // Single source of truth for profit: net revenue - net cost - adjustment losses.
  const profit = round2(netRevenue - netCost - adjustmentLossTotal);

  const saleCashIn = round2(salesRaw.reduce((s, t) => s + (t.cashPaid !== undefined ? t.cashPaid : t.total), 0));
  const saleReturnCashOut = round2(saleReturnsRaw.reduce((s, t) => s + (t.cashPaid !== undefined ? t.cashPaid : t.total), 0));
  const cashSales = round2(saleCashIn - saleReturnCashOut);

  const periodCredits = KoshCalc._loadPeriodJsonRowsFromSqlite('credits', periodType, periodDate) || data.credits.filter(c => inPeriod(c.date));
  const periodPayments = KoshCalc._loadPeriodJsonRowsFromSqlite('payments', periodType, periodDate) || data.payments.filter(p => inPeriod(p.date));
  const periodSupplierCredits = KoshCalc._loadPeriodJsonRowsFromSqlite('supplier_credits', periodType, periodDate) || (data.supplierCredits || []).filter(sc => inPeriod(sc.date));
  const periodSupplierPayments = KoshCalc._loadPeriodJsonRowsFromSqlite('supplier_payments', periodType, periodDate) || (data.supplierPayments || []).filter(sp => inPeriod(sp.date));
  const periodCreditGiven = round2(periodCredits.reduce((s, c) => s + (Number(c.total) || 0), 0));
  const periodCreditPaidNow = round2(periodCredits.reduce((s, c) => s + (Number(c.paid) || 0), 0));
  const periodCreditDue = round2(periodCredits.reduce((s, c) => s + getCreditDueAsOf(c, cutoffYmd), 0));
  const periodPaymentsReceived = round2(periodPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0));

  const purchaseCashPaid = round2(purchasesRaw.reduce((s, t) => s + (t.cashPaid !== undefined ? t.cashPaid : t.total), 0));
  const purchaseExtraCostCashOut = round2(purchasesRaw.reduce((s, t) => s + (Number(t.lineExtraCost) || 0), 0));
  const supplierDuePaidCashOut = round2(periodSupplierPayments.reduce((s, sp) => s + (Number(sp.amount) || 0), 0));
  const purchaseReturnCashIn = round2(purchaseReturnsRaw.reduce((s, t) => s + (t.cashPaid !== undefined ? t.cashPaid : t.total), 0));
  const purchaseCashOut = round2(purchaseCashPaid + purchaseExtraCostCashOut + supplierDuePaidCashOut - purchaseReturnCashIn);
  const netPurchaseValue = round2(
    purchasesRaw.reduce((s, t) => s + (Number(t.total) || 0) + (Number(t.lineExtraCost) || 0), 0)
    - purchaseReturnsRaw.reduce((s, t) => s + (Number(t.total) || 0), 0)
  );
  const netPurchaseQty = round2(
    purchasesRaw.reduce((s, t) => s + (Number(t.qty) || 0), 0)
    - purchaseReturnsRaw.reduce((s, t) => s + (Number(t.qty) || 0), 0)
  );
  const periodSupplierDue = round2(
    periodSupplierCredits.reduce((s, sc) => s + getSupplierDueAsOf(sc, cutoffYmd), 0)
  );
  const purchaseNetSpendNow = round2(purchaseCashOut + periodSupplierDue);

  const customerDueAll = round2((data.credits || []).reduce((s, c) => s + getCreditDueAsOf(c, cutoffYmd), 0));
  const supplierDueAll = round2((data.supplierCredits || []).reduce((s, sc) => s + getSupplierDueAsOf(sc, cutoffYmd), 0));
  const investmentInRaw = capitalInRaw.filter(t => String(t.capitalSource || 'investment') !== 'loan');
  const loanInRaw = capitalInRaw.filter(t => String(t.capitalSource || '') === 'loan');
  const investmentCashIn = round2(investmentInRaw.reduce((s, t) => s + (Number(t.total) || Number(t.cashPaid) || 0), 0));
  const loanCashIn = round2(loanInRaw.reduce((s, t) => s + (Number(t.total) || Number(t.cashPaid) || 0), 0));
  const capitalCashIn = round2(investmentCashIn + loanCashIn);
  const capitalCashOut = round2(capitalOutRaw.reduce((s, t) => s + (Number(t.total) || Number(t.cashPaid) || 0), 0));
  const extraExpensesList = KoshCalc._loadPeriodJsonRowsFromSqlite('extra_expenses', periodType, periodDate) || (data.extraExpenses || []).filter(e => inPeriod(e.date));
  const extraExpensesTotal = round2(extraExpensesList.reduce((s, e) => s + (Number(e.amount) || 0), 0));
  // Owner cash withdrawals (drawings): reduce cash-in-hand, NOT profit.
  const cashWithdrawalsList = KoshCalc._loadPeriodJsonRowsFromSqlite('cash_withdrawals', periodType, periodDate) || (data.cashWithdrawals || []).filter(w => inPeriod(w.date));
  const cashWithdrawalsTotal = round2(cashWithdrawalsList.reduce((s, w) => s + (Number(w.amount) || 0), 0));
  const loanPaymentsList = KoshCalc._loadPeriodJsonRowsFromSqlite('loan_payments', periodType, periodDate) || (data.loanPayments || []).filter(lp => inPeriod(lp.date));
  const loanPaymentCashOut = round2(loanPaymentsList.reduce((s, lp) => s + (Number(lp.amount) || 0), 0));
  const netCashDelta = round2(saleCashIn + periodPaymentsReceived + purchaseReturnCashIn + capitalCashIn - purchaseCashPaid - purchaseExtraCostCashOut - saleReturnCashOut - supplierDuePaidCashOut - capitalCashOut - extraExpensesTotal - cashWithdrawalsTotal - loanPaymentCashOut);
  const totalIncomeBreakdown = round2(saleCashIn + periodPaymentsReceived + purchaseReturnCashIn + capitalCashIn);
  const totalCostBreakdown = round2(purchaseCashPaid + purchaseExtraCostCashOut + saleReturnCashOut + supplierDuePaidCashOut + capitalCashOut + extraExpensesTotal + cashWithdrawalsTotal + loanPaymentCashOut);
  const purchaseCreditAtBuy = round2(Math.max(0, purchasesRaw.reduce((s, t) => s + (Number(t.total) || 0), 0) - purchaseCashPaid));

  return {
    inPeriod,
    salesRaw,
    purchasesRaw,
    saleReturnsRaw,
    purchaseReturnsRaw,
    capitalInRaw,
    investmentInRaw,
    loanInRaw,
    capitalOutRaw,
    adjustmentsRaw,
    salesNet,
    purchasesNet,
    grossSalesRevenue,
    saleReturnRevenue,
    netRevenue,
    grossSalesCost,
    saleReturnCost,
    netCost,
    profit,
    adjustmentLossTotal,
    saleCashIn,
    saleReturnCashOut,
    cashSales,
    periodCredits,
    periodCreditGiven,
    periodCreditPaidNow,
    periodCreditDue,
    periodPaymentsReceived,
    supplierDuePaidCashOut,
    purchaseCashPaid,
    purchaseExtraCostCashOut,
    purchaseReturnCashIn,
    capitalCashIn,
    investmentCashIn,
    loanCashIn,
    capitalCashOut,
    purchaseCashOut,
    purchaseNetSpendNow,
    netPurchaseValue,
    netPurchaseQty,
    periodSupplierDue,
    customerDueAll,
    supplierDueAll,
    netCashDelta,
    totalIncomeBreakdown,
    totalCostBreakdown,
    purchaseCreditAtBuy,
    extraExpensesTotal,
    extraExpensesList,
    cashWithdrawalsTotal,
    cashWithdrawalsList,
    loanPaymentCashOut,
    loanPaymentsList
  };
};

// ===== Phase 5 — financial snapshot memoization =====
// Full-content signature (dual FNV-1a, 64-bit combined) over every field the
// snapshot reads. Re-checked on each call, so any changed value changes the
// key and a stale result can never be served. Also force-cleared by
// invalidateCoreCalcState() as a fast path. Returned snapshots are treated
// as read-only by all callers.
let __financialSnapshotCache = new Map();
let __financialViewCache = new Map();
let __centralBundleCache = new Map();

// Called by the main script's invalidateCoreCalcState() via the global KoshCalc
// object (load-order-safe — no cross-script `let` reference).
KoshCalc.invalidateSnapshotCache = function() {
  __financialSnapshotCache.clear();
  __financialViewCache.clear();
  __centralBundleCache.clear();
};

function computeFinancialSignature() {
  let h1 = 0x811c9dc5 >>> 0, h2 = 0xc2b2ae35 >>> 0;
  const feed = (val) => {
    const s = String(val);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x7c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ 0x7c, 0x85ebca77) >>> 0;
  };
  const txs = data.transactions || [];
  feed('T'); feed(txs.length);
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i];
    feed(t.id); feed(t.type); feed(t.date);
    feed(t.qty); feed(t.total); feed(t.cost); feed(t.costTotal); feed(t.price);
    feed(t.cashPaid); feed(t.returnType); feed(t.linkedTxId); feed(t.seedOpening); feed(t.opening);
  }
  const credits = data.credits || [];
  feed('C'); feed(credits.length);
  for (let i = 0; i < credits.length; i++) {
    const c = credits[i];
    feed(c.id); feed(c.date); feed(c.total); feed(c.paid);
    feed(c.txId); feed(Array.isArray(c.txIds) ? c.txIds.join(',') : '');
  }
  const payments = data.payments || [];
  feed('P'); feed(payments.length);
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i];
    feed(p.id); feed(p.date); feed(p.amount); feed(p.creditId);
  }
  const supplierCredits = data.supplierCredits || [];
  feed('S'); feed(supplierCredits.length);
  for (let i = 0; i < supplierCredits.length; i++) {
    const sc = supplierCredits[i];
    feed(sc.id); feed(sc.date); feed(sc.total); feed(sc.paid);
  }
  const supplierPayments = data.supplierPayments || [];
  feed('Q'); feed(supplierPayments.length);
  for (let i = 0; i < supplierPayments.length; i++) {
    const sp = supplierPayments[i];
    feed(sp.id); feed(sp.date); feed(sp.amount); feed(sp.scId);
  }
  const extraExpenses = data.extraExpenses || [];
  feed('E'); feed(extraExpenses.length);
  for (let i = 0; i < extraExpenses.length; i++) {
    const e = extraExpenses[i];
    feed(e.id); feed(e.date); feed(e.amount);
  }
  const cashWithdrawals = data.cashWithdrawals || [];
  feed('W'); feed(cashWithdrawals.length);
  for (let i = 0; i < cashWithdrawals.length; i++) {
    const w = cashWithdrawals[i];
    feed(w.id); feed(w.date); feed(w.amount);
  }
  return (h1 >>> 0).toString(16) + ':' + (h2 >>> 0).toString(16);
}

KoshCalc.computeFinancialSnapshot = function(periodType, periodDate) {
  // Resolve the date exactly as the impl does (periodDate || today) so a cached
  // entry can never survive a midnight rollover and serve a stale "today".
  const key = (window.__dataRevision || 0) + '|' + (periodType || '') + '|' + (periodDate || todayStr());
  const cached = __financialSnapshotCache.get(key);
  if (cached) return cached;
  const result = KoshCalc._computeFinancialSnapshotUncached(periodType, periodDate);
  __financialSnapshotCache.set(key, result);
  if (__financialSnapshotCache.size > 200) {
    __financialSnapshotCache.delete(__financialSnapshotCache.keys().next().value);
  }
  return result;
};

// Backward-compatible global shim — existing callers stay untouched.
function computeFinancialSnapshot(periodType, periodDate) {
  return KoshCalc.computeFinancialSnapshot(periodType, periodDate);
}

KoshCalc.buildFinancialView = function(periodType, periodDate, opts = {}) {
  const includeBusiness = opts.includeBusiness !== false;
  const viewCacheKey = [periodType || 'daily', periodDate || todayStr(), includeBusiness ? 'business' : 'lean', window.__dataRevision || 0].join('|');
  const cachedView = __financialViewCache.get(viewCacheKey);
  if(cachedView) return cachedView;
  const snap = computeFinancialSnapshot(periodType, periodDate);
  const periodStartDate = getPeriodStartDate(periodType, periodDate);
  const periodEndDate = typeof getPeriodEndDate === 'function' ? getPeriodEndDate(periodType, periodDate) : (periodDate || todayStr());
  const openingCash = getOpeningCashForDate(periodStartDate);
  // Dashboard "Purchased (Cash)" should show period (daily/weekly/monthly/yearly) supplier due, not all-time due.
  const supplierDueOpen = round2(Number(snap.periodSupplierDue) || 0);
  const cashIn = round2(snap.saleCashIn + snap.periodPaymentsReceived + snap.purchaseReturnCashIn + (Number(snap.capitalCashIn) || 0));
  const cashOut = round2(snap.purchaseCashPaid + (Number(snap.purchaseExtraCostCashOut) || 0) + snap.saleReturnCashOut + snap.supplierDuePaidCashOut + (Number(snap.capitalCashOut) || 0) + snap.extraExpensesTotal + (Number(snap.cashWithdrawalsTotal) || 0) + (Number(snap.loanPaymentCashOut) || 0));
  const totalInWithOpening = round2(openingCash + cashIn);

  // Reconciled closing cash: always derived from selected date's daily close,
  // so daily and monthly agree on the same end date actual cash.
  const endDayOpening = getOpeningCashForDate(periodEndDate);
  const endDaySnap = computeFinancialSnapshot('daily', periodEndDate);
  const cashInHand = round2(endDayOpening + (Number(endDaySnap.netCashDelta) || 0));

  const netCashChange = round2(cashInHand - openingCash);
  const purchaseCashNow = round2(snap.purchaseCashPaid + (Number(snap.purchaseExtraCostCashOut) || 0) + snap.supplierDuePaidCashOut - round2(snap.purchaseReturnCashIn));
  // For report consistency, stock must be valued "as of" selected period end date.
  const stockValue = includeBusiness ? round2(getTotalInventoryValueAsOf(periodEndDate)) : 0;
  const customerDueAll = round2(snap.customerDueAll || 0);
  const supplierDueAll = round2(snap.supplierDueAll || 0);
  const netBusinessWorth = round2(cashInHand + stockValue + customerDueAll - supplierDueAll);
  const view = {
    snap,
    openingCash,
    supplierDueOpen,
    cashIn,
    cashOut,
    totalInWithOpening,
    cashInHand,
    netCashChange,
    purchaseCashNow,
    stockValue,
    customerDueAll,
    supplierDueAll,
    netBusinessWorth
  };
  __financialViewCache.set(viewCacheKey, view);
  if(__financialViewCache.size > 80) {
    __financialViewCache.delete(__financialViewCache.keys().next().value);
  }
  return view;
};

// Backward-compatible global shim — existing callers stay untouched.
function buildFinancialView(periodType, periodDate, opts = {}) {
  return KoshCalc.buildFinancialView(periodType, periodDate, opts);
}

KoshCalc.buildFinancialUiMetrics = function(view) {
  const snap = view.snap;
  const grossRevenue = round2(snap.grossSalesRevenue || 0);
  const returnRevenue = round2(snap.saleReturnRevenue || 0);
  const netRevenue = round2(snap.netRevenue || 0);
  const profit = round2(snap.profit || 0);
  const marginPct = netRevenue > 0 ? round2((profit / netRevenue) * 100) : 0;
  const purchaseCashOut = round2(snap.purchaseCashOut || 0);
  const supplierDueOpen = round2(view.supplierDueOpen || 0);

  return {
    sales: {
      grossRevenue,
      returnRevenue,
      netRevenue,
      profit,
      marginPct,
      adjustmentLoss: round2(snap.adjustmentLossTotal || 0),
      cashSales: round2(snap.cashSales || 0),
      saleCashIn: round2(snap.saleCashIn || 0),
      saleReturnCashOut: round2(snap.saleReturnCashOut || 0),
      creditDueInPeriod: round2(snap.periodCreditDue || 0)
    },
    purchase: {
      netPurchaseValue: round2(snap.netPurchaseValue || 0),
      netPurchaseQty: round2(snap.netPurchaseQty || 0),
      cashPaidAtBuy: round2(snap.purchaseCashPaid || 0),
      extraCostCashOut: round2(snap.purchaseExtraCostCashOut || 0),
      supplierDuePaidCashOut: round2(snap.supplierDuePaidCashOut || 0),
      purchaseReturnCashIn: round2(snap.purchaseReturnCashIn || 0),
      cashOutNow: purchaseCashOut,
      outstandingSupplierDueNow: round2(snap.periodSupplierDue || 0),
      netSpendNow: round2(snap.purchaseNetSpendNow || 0)
    },
    cash: {
      openingCash: round2(view.openingCash || 0),
      cashIn: round2(view.cashIn || 0),
      cashOut: round2(view.cashOut || 0),
      totalInWithOpening: round2(view.totalInWithOpening || 0),
      closingCash: round2(view.cashInHand || 0),
      netCashChange: round2(view.netCashChange || 0),
      totalIncomeBreakdown: round2(snap.totalIncomeBreakdown || 0),
      totalCostBreakdown: round2(snap.totalCostBreakdown || 0),
      periodPaymentsReceived: round2(snap.periodPaymentsReceived || 0),
      purchaseReturnCashIn: round2(snap.purchaseReturnCashIn || 0),
      capitalCashIn: round2(snap.capitalCashIn || 0),
      investmentCashIn: round2(snap.investmentCashIn || snap.capitalCashIn || 0),
      loanCashIn: round2(snap.loanCashIn || 0),
      capitalCashOut: round2(snap.capitalCashOut || 0),
      extraExpensesTotal: round2(snap.extraExpensesTotal || 0),
      extraExpensesList: snap.extraExpensesList || [],
      cashWithdrawalsTotal: round2(snap.cashWithdrawalsTotal || 0),
      cashWithdrawalsList: snap.cashWithdrawalsList || []
    },
    business: {
      stockValue: round2(view.stockValue || 0),
      customerDueAll: round2(view.customerDueAll || 0),
      supplierDueAll: round2(view.supplierDueAll || 0),
      netBusinessWorth: round2(view.netBusinessWorth || 0)
    },
    dashboard: {
      purchaseCashOut,
      supplierDueOpen
    }
  };
};

// Backward-compatible global shim — existing callers stay untouched.
function buildFinancialUiMetrics(view) {
  return KoshCalc.buildFinancialUiMetrics(view);
}

function buildCentralOperationalMetrics(periodType, periodDate, view, metrics) {
  const snap = view.snap;
  const inPeriod = buildPeriodMatcher(periodType, periodDate);
  const lowStockCount = data.products.filter(p => { const s = getStock(p.id); return s > 0 && s < 5; }).length;
  const outStockCount = data.products.filter(p => getStock(p.id) <= 0).length;
  const allPeriodReturns = [
    ...(snap.saleReturnsRaw || []),
    ...(snap.purchaseReturnsRaw || [])
  ].filter(t => getProd(t.productId));
  const dashboardAggregates = buildDashboardAggregates({
    sales: snap.salesNet.filter(t => getProd(t.productId)),
    buys: snap.purchasesNet.filter(t => getProd(t.productId)),
    allReturns: allPeriodReturns
  });
  const openCredits = data.credits.filter(c => getCreditDue(c) > 0.001);
  const totalOpenCustomerDue = round2(openCredits.reduce((s, c) => s + getCreditDue(c), 0));
  return {
    lowStockCount,
    outStockCount,
    dashboardAggregates,
    openCredits,
    totalOpenCustomerDue
  };
}

KoshCalc.getCentralCalculationBundle = function(periodType, periodDate, opts = {}) {
  const safeType = periodType || 'daily';
  const safeDate = periodDate || todayStr();
  const saleTxQ = String(opts.saleTxQ || '').toLowerCase().trim();
  const purchTxQ = String(opts.purchTxQ || '').toLowerCase().trim();
  const includeBusiness = opts.includeBusiness !== false;
  const includeOps = opts.includeOps !== false;
  const cacheKey = [safeType, safeDate, saleTxQ, purchTxQ, includeBusiness ? 'business' : 'lean', includeOps ? 'ops' : 'noops', window.__dataRevision || 0].join('|');
  const cached = __centralBundleCache.get(cacheKey);
  if(cached) return cached;
  const view = KoshCalc.buildFinancialView(safeType, safeDate, { includeBusiness });
  const snap = view.snap;
  const metrics = buildFinancialUiMetrics(view);
  const creditMetrics = buildCreditMetrics(safeType, safeDate);
  const ops = includeOps ? buildCentralOperationalMetrics(safeType, safeDate, view, metrics) : null;
  // Use the same pre-filtered arrays from the snapshot — single source of truth.
  const saleTxns = (snap.salesRaw || []).filter(t => (Number(t.qty) || 0) > 0.0001);
  const saleRetTxns = snap.saleReturnsRaw || [];
  const purchaseTxns = (snap.purchasesRaw || []).filter(t => (Number(t.qty) || 0) > 0.0001);
  const purchaseRetTxns = snap.purchaseReturnsRaw || [];
  const saleReportAgg = buildSaleReportAggregates({ txns: saleTxns, retTxnsAll: saleRetTxns, saleTxQ });
  const purchaseReportAgg = buildPurchaseReportAggregates({ txns: purchaseTxns, purchRetTxnsAll: purchaseRetTxns, purchTxQ });
  const bundle = {
    periodType: safeType,
    periodDate: safeDate,
    view,
    snap: view.snap,
    metrics,
    creditMetrics,
    ops,
    report: {
      saleTxQ,
      purchTxQ,
      saleReportAgg,
      purchaseReportAgg
    }
  };
  __centralBundleCache.set(cacheKey, bundle);
  if(__centralBundleCache.size > 80) {
    __centralBundleCache.delete(__centralBundleCache.keys().next().value);
  }
  return bundle;
};

// Backward-compatible global shim — existing callers stay untouched.
function getCentralCalculationBundle(periodType, periodDate, opts = {}) {
  return KoshCalc.getCentralCalculationBundle(periodType, periodDate, opts);
}

function buildDashboardAggregates({ sales, buys, allReturns }) {
  const byCategory = {};
  sales.forEach(t => {
    const p = getProd(t.productId);
    const cat = p?.category || 'Uncategorized';
    if(!byCategory[cat]) byCategory[cat] = { qty: 0, revenue: 0, cost: 0 };
    byCategory[cat].qty += t.qty;
    byCategory[cat].revenue += t.total;
    byCategory[cat].cost += saleCostTotal(t);
  });
  allReturns
    .filter(t => (t.returnType === 'sale-return' || !t.returnType))
    .forEach(t => {
      const p = getProd(t.productId);
      const cat = p?.category || 'Uncategorized';
      if(!byCategory[cat]) byCategory[cat] = { qty: 0, revenue: 0, cost: 0 };
      byCategory[cat].qty -= (Number(t.qty) || 0);
      byCategory[cat].revenue -= (Number(t.total) || 0);
      byCategory[cat].cost -= returnCostTotal(t);
    });
  return {
    byCategoryEntries: Object.entries(byCategory).sort((a, b) => b[1].revenue - a[1].revenue),
    groupedTodaySales: groupTxnsByBill([...sales].reverse(), 'sale'),
    groupedTodayBuys: groupTxnsByBill([...buys].reverse(), 'purchase'),
    todayReturns: [...allReturns].reverse(),
    openCredits: data.credits.filter(c => getCreditDue(c) > 0.001)
  };
}

function buildSaleReportAggregates({ txns, retTxnsAll, saleTxQ }) {
  const retTxns = retTxnsAll; // include linked returns — same scope as computeFinancialSnapshot
  const byProd = {};
  txns.forEach(t => {
    if(!byProd[t.productId]) byProd[t.productId] = { qty: 0, revenue: 0, cost: 0 };
    byProd[t.productId].qty += t.qty;
    byProd[t.productId].revenue += t.total;
    byProd[t.productId].cost += saleCostTotal(t);
  });
  retTxns.forEach(t => {
    if(!byProd[t.productId]) byProd[t.productId] = { qty: 0, revenue: 0, cost: 0 };
    byProd[t.productId].qty -= t.qty;
    byProd[t.productId].revenue -= t.total;
    byProd[t.productId].cost -= returnCostTotal(t);
  });
  const sorted = Object.entries(byProd).sort((a, b) => b[1].revenue - a[1].revenue);
  const maxRev = sorted.length ? sorted[0][1].revenue : 1;
  const byCategory = {};
  sorted.forEach(([pid, d]) => {
    const p = getProd(pid);
    const cat = p?.category || 'Uncategorized';
    if(!byCategory[cat]) byCategory[cat] = { qty: 0, revenue: 0, cost: 0 };
    byCategory[cat].qty += d.qty;
    byCategory[cat].revenue += d.revenue;
    byCategory[cat].cost += d.cost;
  });
  const profitAnalysis = sorted.map(([pid, d]) => {
    const p = getProd(pid);
    const profit = d.revenue - d.cost;
    const margin = d.revenue > 0 ? (profit / d.revenue * 100).toFixed(1) : 0;
    const status = profit < 0 ? 'loss' : profit < (d.revenue * 0.1) ? 'low' : 'high';
    const badge = profit < 0 ? '❌ Loss' : profit < (d.revenue * 0.1) ? '🐢 Low Profit' : '🚀 Fast Moving';
    return { pid, name: p?.name || pid, qty: d.qty, revenue: d.revenue, cost: d.cost, profit, margin, status, badge };
  }).sort((a, b) => b.profit - a.profit);
  const allProductQty = sorted.map(([pid, d]) => {
    const p = getProd(pid);
    return { pid, name: p?.name || pid, qty: d.qty, revenue: d.revenue, profit: d.revenue - d.cost };
  }).sort((a, b) => b.qty - a.qty);
  const avgQty = allProductQty.length > 0 ? allProductQty.reduce((s, p) => s + p.qty, 0) / allProductQty.length : 0;
  const allTxns = [...txns, ...retTxnsAll].sort((a, b) => new Date(b.date) - new Date(a.date));
  const filteredSaleTxns = saleTxQ
    ? allTxns.filter(t => {
        const p = getProd(t.productId);
        return (p?.name || '').toLowerCase().includes(saleTxQ) ||
               (p?.category || '').toLowerCase().includes(saleTxQ) ||
               (t.customer || '').toLowerCase().includes(saleTxQ) ||
               String(t.billId || '').toLowerCase().includes(saleTxQ);
      })
    : allTxns;
  const filteredSaleReturnTxns = filteredSaleTxns.filter(t => t.type === 'return' && (t.returnType === 'sale-return' || !t.returnType));
  const filteredSaleOnlyTxns = filteredSaleTxns.filter(t => t.type === 'sale');
  return {
    txCount: txns.length,
    returnCount: retTxnsAll.length,
    retTxns,
    sorted,
    maxRev,
    byCategoryEntries: Object.entries(byCategory).sort((a, b) => b[1].revenue - a[1].revenue),
    profitAnalysis,
    fastSellingProds: allProductQty.filter(p => p.qty >= avgQty),
    slowSellingProds: allProductQty.filter(p => p.qty < avgQty).reverse(),
    groupedSaleTxns: groupTxnsByBill(filteredSaleOnlyTxns, 'sale'),
    groupedSaleReturnTxns: groupReturnTxns(filteredSaleReturnTxns)
  };
}

function buildPurchaseReportAggregates({ txns, purchRetTxnsAll, purchTxQ }) {
  const purchRetTxns = purchRetTxnsAll.filter(t => !isLinkedReturnTx(t));
  // Distributor discount: gross = company/list amount (falls back to net for rows
  // with no list price); spend = net amount actually paid. discount = gross − net.
  const grossOf = t => (Number(t.grossAmount) || Number(t.total) || 0);
  const byProd = {};
  txns.forEach(t => {
    if(!byProd[t.productId]) byProd[t.productId] = { qty: 0, spend: 0, gross: 0 };
    byProd[t.productId].qty += t.qty;
    byProd[t.productId].spend += t.total;
    byProd[t.productId].gross += grossOf(t);
  });
  purchRetTxns.forEach(t => {
    if(!byProd[t.productId]) byProd[t.productId] = { qty: 0, spend: 0, gross: 0 };
    byProd[t.productId].qty -= t.qty;
    byProd[t.productId].spend -= t.total;
    byProd[t.productId].gross -= grossOf(t);
  });
  const grossPurchaseTotal = round2(
    txns.reduce((s, t) => s + grossOf(t), 0) - purchRetTxns.reduce((s, t) => s + grossOf(t), 0)
  );
  const netPurchaseTotal = round2(
    txns.reduce((s, t) => s + (Number(t.total) || 0), 0) - purchRetTxns.reduce((s, t) => s + (Number(t.total) || 0), 0)
  );
  const purchaseDiscountTotal = round2(grossPurchaseTotal - netPurchaseTotal);
  const sorted = Object.entries(byProd).sort((a, b) => b[1].spend - a[1].spend);
  const maxSpend = sorted.length ? sorted[0][1].spend : 1;
  const byCategory = {};
  sorted.forEach(([pid, d]) => {
    const p = getProd(pid);
    const cat = p?.category || 'Uncategorized';
    if(!byCategory[cat]) byCategory[cat] = { qty: 0, spend: 0 };
    byCategory[cat].qty += d.qty;
    byCategory[cat].spend += d.spend;
  });
  const bySupplier = {};
  txns.forEach(t => {
    const sup = t.supplier || '(No Supplier)';
    if(!bySupplier[sup]) bySupplier[sup] = { count: 0, spend: 0 };
    bySupplier[sup].count++;
    bySupplier[sup].spend += t.total;
  });
  const allPurchTxns = [...txns, ...purchRetTxnsAll].sort((a, b) => new Date(b.date) - new Date(a.date));
  const filteredPurchTxns = purchTxQ
    ? allPurchTxns.filter(t => {
        const p = getProd(t.productId);
        const isPurchaseReturn = t.type === 'return' && t.returnType === 'purchase-return';
        return (p?.name || '').toLowerCase().includes(purchTxQ) ||
               (p?.category || '').toLowerCase().includes(purchTxQ) ||
               (t.supplier || '').toLowerCase().includes(purchTxQ) ||
               String(t.billId || '').toLowerCase().includes(purchTxQ) ||
               (isPurchaseReturn && 'purchase return'.includes(purchTxQ));
      })
    : allPurchTxns;
  const filteredPurchaseReturnTxns = filteredPurchTxns.filter(t => t.type === 'return' && t.returnType === 'purchase-return');
  const filteredPurchaseOnlyTxns = filteredPurchTxns.filter(t => t.type === 'purchase');
  return {
    txCount: txns.length,
    returnCount: purchRetTxnsAll.length,
    uniqueSupplierCount: new Set(txns.map(t => t.supplier).filter(Boolean)).size,
    grossPurchaseTotal,
    netPurchaseTotal,
    purchaseDiscountTotal,
    purchRetTxnsAll,
    sorted,
    maxSpend,
    byCategoryEntries: Object.entries(byCategory).sort((a, b) => b[1].spend - a[1].spend),
    bySupplierEntries: Object.entries(bySupplier).sort((a, b) => b[1].spend - a[1].spend),
    groupedPurchTxns: groupTxnsByBill(filteredPurchaseOnlyTxns, 'purchase'),
    groupedPurchaseReturnTxns: groupReturnTxns(filteredPurchaseReturnTxns)
  };
}

// ===== Register remaining pure calc helpers on KoshCalc (Phase 1) =====
// Internal aggregate/credit helpers exposed as the canonical calc API.
// (computeFinancialSnapshot / buildFinancialView / buildFinancialUiMetrics /
// getCentralCalculationBundle route through KoshCalc via shims.)
Object.assign(KoshCalc, {
  buildCentralOperationalMetrics,
  buildDashboardAggregates,
  buildSaleReportAggregates,
  buildPurchaseReportAggregates,
  buildCreditMetrics
});
