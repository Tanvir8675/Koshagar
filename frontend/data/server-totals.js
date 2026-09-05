// data/server-totals.js — figures worked out by the database, not the browser.
//
// WHY THIS EXISTS
// Every money figure on screen is currently derived in calc/financial.js from
// the whole book held in memory. The database derives the same figures itself,
// from cash_ledger, which is the table that actually records money moving. Two
// calculators for one number is how a screen ends up confidently wrong: a rule
// changes in one of them and nothing announces the disagreement.
//
// So the cash figures on the dashboard now come from here: cash_summary() in
// 39_cash_summary.sql reads cash_ledger and returns the whole card in one call.
// The browser's own arithmetic is still run, but its job has changed - it is
// the CHECK, not the source. Every load compares the two and says, in the
// console and on the card, when they disagree.
//
// THE ONE CASE WHERE THE BROWSER'S FIGURES ARE STILL SHOWN
// When the database has not answered at all - offline, or the migration not
// run on this project yet - the card falls back to the local arithmetic AND
// says so on screen. A silent fallback would be the very thing this replaces:
// a second source of truth wearing a different hat.
//
// REPORTS
// The same call answers any period - rowFor() takes the report's own type and
// date. A report render is synchronous, so a period that has not been fetched
// yet renders with this device's arithmetic and re-renders when the server's
// answer lands. That is a fraction of a second, once per period, and the card
// says which of the two it is showing.
//
// THE POSITION, NOT ONLY THE FLOW
// business_snapshot() (40_ledger_as_of.sql) answers the other half: stock
// value, what is owed each way, and the business worth those add up to - as of
// a chosen date, which the existing "right now" views cannot do.
//
// WHAT WAS EARNED
// profit_summary() (41_profit_summary.sql) covers revenue, cost, profit and
// margin - the cost side read from what the FIFO engine recorded at posting
// time rather than replayed here.
//
// WHAT IS ON THE SHELF
// fetchStock() reads v_product_stock - quantity and FIFO value per product, as
// they stand now. The stock screen shows these; the browser's own replay is
// still run as the check.
//
// WHAT IS STILL OWED
// fetchBills() reads v_bill_balances, and getCreditDue()/getSupplierDue() use
// it. Every figure on the credit page comes through those two, so the totals,
// the per-customer grouping and each bill's own line all now agree with the
// database by construction rather than by coincidence.
//
// WHAT EACH PRODUCT SOLD
// fetchProductSales() answers that for a period, and the report's breakdowns
// are built from it.
//
// STILL TO MOVE
// Nothing of substance. What is left in calc/financial.js is the checking copy
// of arithmetic the database now owns, plus the presentation-shaped work that
// belongs in the browser: sorting, filtering, badges and grouping.
window.KoshTotals = (function () {
  // Keyed by shop and date range. Cleared on every load, because the numbers
  // are only true for the rows that were loaded with them.
  let _cache = new Map();
  // Where the business stood at the end of a day: stock, dues, worth. Keyed by
  // one date rather than a range, because a position has no duration.
  let _snaps = new Map();
  // What was earned over a period. A flow like cash, so keyed by a range.
  let _profits = new Map();
  // Stock as it stands now, per product. Not keyed by date: the stock screen
  // asks about today and nothing else.
  let _stock = null;
  // The container unit a product is bought in, when it has one: COIL, DOZ, BOX.
  let _conv = null;
  // What is still owed on each open bill, both directions. Keyed by bill id.
  let _bills = null;
  // Per product for a period: quantity, revenue, cost. Keyed by range like the
  // other flows.
  let _prodSales = new Map();
  let _lastCompare = null;

  const key = (from, to) => `${window.ACTIVE_SHOP_ID || ''}|${from}|${to}`;

  function forget() {
    _cache = new Map();
    _snaps = new Map();
    _profits = new Map();
    _stock = null;
    _conv = null;
    _bills = null;
    _prodSales = new Map();
    _lastCompare = null;
  }

  // Returns null rather than throwing. The server not answering must never stop
  // the screens from rendering - what is on them today is the browser's own
  // arithmetic, which does not need this call at all.
  async function fetchRange(from, to) {
    if (!window.KoshApi || !window.ACTIVE_SHOP_ID) return null;
    const k = key(from, to);
    if (_cache.has(k)) return _cache.get(k);
    try {
      const rows = await window.KoshApi.rpc('cash_summary', {
        p_shop: window.ACTIVE_SHOP_ID, p_from: from, p_to: to
      });
      // A set-returning function comes back as an array of one row.
      const row = Array.isArray(rows) ? rows[0] : rows;
      _cache.set(k, row || null);
      return row || null;
    } catch (e) {
      // The most likely cause by far is that 39_cash_summary.sql has not been
      // run on this database yet. Said once, plainly, not as a red error.
      console.info('Server cash summary unavailable:', e && e.message ? e.message : e);
      _cache.set(k, null);
      return null;
    }
  }

  const get = (from, to) => _cache.get(key(from, to)) || null;
  // Asked and answered - including answered with nothing. Without this, a
  // period the server could not summarise would be re-requested on every
  // render, forever.
  const known = (from, to) => _cache.has(key(from, to));

  // The dates a report period covers. The same two helpers the screens use, so
  // a week here is exactly the week the report is showing - including 'custom',
  // whose date is a "start|end" pair.
  function periodRange(type, date) {
    if (typeof getPeriodStartDate !== 'function' || typeof getPeriodEndDate !== 'function') return null;
    const from = getPeriodStartDate(type, date);
    const to = getPeriodEndDate(type, date);
    return (from && to) ? { from, to } : null;
  }

  // For a report period. Returns the figures if they are already here, and
  // otherwise null having started the request - `onArrive` is called once they
  // land so the caller can render again. Renders stay synchronous; the screen
  // simply shows its own arithmetic for the moment it takes.
  function rowFor(type, date, onArrive) {
    const r = periodRange(type, date);
    if (!r) return null;
    if (known(r.from, r.to)) return get(r.from, r.to);
    fetchRange(r.from, r.to).then((row) => {
      if (row && typeof onArrive === 'function') onArrive();
    });
    return null;
  }

  // The figures for a single day - what the dashboard needs. Null means the
  // database has not answered (offline, or 39_cash_summary.sql not run), which
  // the caller has to handle visibly rather than by quietly substituting
  // something else.
  const row = (day) => get(day, day);

  // ---------------------------------------------------------------------
  // THE POSITION ON A DATE — stock, dues, business worth
  //
  // Separate from the cash summary because it answers a different shape of
  // question. Cash is a flow over a period; stock and dues are a standing
  // position at one moment, and asking for them "between two dates" would be
  // meaningless. See 40_ledger_as_of.sql.
  // ---------------------------------------------------------------------
  const snapKey = (day) => `${window.ACTIVE_SHOP_ID || ''}|${day}`;

  async function fetchSnapshot(day) {
    if (!window.KoshApi || !window.ACTIVE_SHOP_ID || !day) return null;
    const k = snapKey(day);
    if (_snaps.has(k)) return _snaps.get(k);
    try {
      const rows = await window.KoshApi.rpc('business_snapshot', {
        p_shop: window.ACTIVE_SHOP_ID, p_date: day
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      _snaps.set(k, row || null);
      return row || null;
    } catch (e) {
      console.info('Server business snapshot unavailable:', e && e.message ? e.message : e);
      _snaps.set(k, null);
      return null;
    }
  }

  const snapshotOn = (day) => _snaps.get(snapKey(day)) || null;

  // For a report period: the position at the END of it, which is what "as of
  // the selected month" means. Same arrangement as rowFor - null now, a
  // re-render when it lands.
  function snapshotFor(type, date, onArrive) {
    const r = periodRange(type, date);
    if (!r) return null;
    const k = snapKey(r.to);
    if (_snaps.has(k)) return _snaps.get(k);
    fetchSnapshot(r.to).then((row) => {
      if (row && typeof onArrive === 'function') onArrive();
    });
    return null;
  }

  // ---------------------------------------------------------------------
  // WHAT WAS EARNED — revenue, cost, profit, margin
  //
  // The cost half is why this matters most. Profit needs the FIFO cost of the
  // goods each sale consumed; the database worked that out when the sale was
  // posted and stored it (sale_lines.cogs_amount). The browser has been
  // replaying the shop's whole purchase and sale history to arrive at the same
  // answer. See 41_profit_summary.sql.
  // ---------------------------------------------------------------------
  async function fetchProfit(from, to) {
    if (!window.KoshApi || !window.ACTIVE_SHOP_ID) return null;
    const k = key(from, to);
    if (_profits.has(k)) return _profits.get(k);
    try {
      const rows = await window.KoshApi.rpc('profit_summary', {
        p_shop: window.ACTIVE_SHOP_ID, p_from: from, p_to: to
      });
      const r = Array.isArray(rows) ? rows[0] : rows;
      _profits.set(k, r || null);
      return r || null;
    } catch (e) {
      console.info('Server profit summary unavailable:', e && e.message ? e.message : e);
      _profits.set(k, null);
      return null;
    }
  }

  const profitOn = (day) => _profits.get(key(day, day)) || null;

  function profitFor(type, date, onArrive) {
    const r = periodRange(type, date);
    if (!r) return null;
    const k = key(r.from, r.to);
    if (_profits.has(k)) return _profits.get(k);
    fetchProfit(r.from, r.to).then((row) => {
      if (row && typeof onArrive === 'function') onArrive();
    });
    return null;
  }

  // ---------------------------------------------------------------------
  // WHAT IS ON THE SHELF
  //
  // v_product_stock already holds this: quantity from the stock ledger, value
  // from the open FIFO lots at what each lot cost. The browser arrives at the
  // same two numbers by replaying every purchase, sale, return and adjustment
  // the shop has ever made, in order - the heaviest thing it does, and it does
  // it again on every render of the stock screen.
  // ---------------------------------------------------------------------
  async function fetchStock() {
    if (_stock) return _stock;
    if (!window.KoshApi || !window.ACTIVE_SHOP_ID) return null;
    try {
      const rows = await window.KoshApi.selectAll('v_product_stock',
        `shop_id=eq.${window.ACTIVE_SHOP_ID}&select=product_id,qty,stock_value`);
      _stock = new Map((rows || []).map((r) => [String(r.product_id), {
        qty: Number(r.qty) || 0,
        value: Number(r.stock_value) || 0
      }]));
      return _stock;
    } catch (e) {
      console.info('Server stock unavailable:', e && e.message ? e.message : e);
      return null;
    }
  }

  const stockLoaded = () => !!_stock;
  // Null for a product the server has never heard of, so the caller can tell
  // "no stock" from "no answer" - they are not the same thing.
  const stockOf = (productId) => _stock ? (_stock.get(String(productId)) || { qty: 0, value: 0 }) : null;

  // ---------------------------------------------------------------------
  // WHAT IS STILL OWED, BILL BY BILL
  //
  // v_bill_balances is the whole of it: the bill's amount less every posted
  // payment allocated to it. The app rebuilds the same figure from its own
  // copies of the bills and the allocations - not expensive, but it is a second
  // calculator over money customers owe, which is the balance most likely to be
  // argued about months later.
  //
  // One number per bill is enough: the credit page's totals, the per-customer
  // grouping, the "outstanding / settled" filters and each bill's own line all
  // come from getCreditDue() and getSupplierDue(), so this is where they meet.
  // ---------------------------------------------------------------------
  async function fetchBills() {
    if (_bills) return _bills;
    if (!window.KoshApi || !window.ACTIVE_SHOP_ID) return null;
    try {
      const rows = await window.KoshApi.selectAll('v_bill_balances',
        `shop_id=eq.${window.ACTIVE_SHOP_ID}&select=bill_id,direction,amount,allocated,balance`);
      _bills = new Map((rows || []).map((r) => [String(r.bill_id), {
        direction: r.direction,
        amount: Number(r.amount) || 0,
        allocated: Number(r.allocated) || 0,
        balance: Number(r.balance) || 0
      }]));
      return _bills;
    } catch (e) {
      console.info('Server bill balances unavailable:', e && e.message ? e.message : e);
      return null;
    }
  }

  const billsLoaded = () => !!_bills;
  // Undefined when this bill is not in the answer at all - a settled bill drops
  // out of the view, and "not listed" is not the same as "zero owing".
  const billBalance = (billId) => {
    if (!_bills) return undefined;
    const row = _bills.get(String(billId));
    return row ? row.balance : undefined;
  };

  // ---------------------------------------------------------------------
  // WHAT EACH PRODUCT SOLD
  //
  // One map - quantity, revenue, cost per product - and every breakdown on the
  // sales report is built from it: by product, by category, fast and slow
  // movers, the profitability table. See 42_product_sales.sql.
  // ---------------------------------------------------------------------
  async function fetchProductSales(from, to) {
    const k = key(from, to);
    if (_prodSales.has(k)) return _prodSales.get(k);
    if (!window.KoshApi || !window.ACTIVE_SHOP_ID) return null;
    try {
      const rows = await window.KoshApi.rpc('product_sales_summary', {
        p_shop: window.ACTIVE_SHOP_ID, p_from: from, p_to: to
      });
      const map = new Map((rows || []).map((r) => [String(r.product_id), {
        qty: Number(r.qty) || 0,
        revenue: Number(r.revenue) || 0,
        cost: Number(r.cost) || 0
      }]));
      _prodSales.set(k, map);
      return map;
    } catch (e) {
      console.info('Server product sales unavailable:', e && e.message ? e.message : e);
      _prodSales.set(k, null);
      return null;
    }
  }

  // Whether the answer for this period is already in hand. The calculation
  // bundle is cached, so its key has to change when this flips - otherwise the
  // re-render after the answer arrives would be served the same stale bundle.
  function productSalesLoaded(type, date) {
    const r = periodRange(type, date);
    return !!(r && _prodSales.get(key(r.from, r.to)));
  }

  function productSalesFor(type, date, onArrive) {
    const r = periodRange(type, date);
    if (!r) return null;
    const k = key(r.from, r.to);
    if (_prodSales.has(k)) return _prodSales.get(k);
    fetchProductSales(r.from, r.to).then((m) => {
      if (m && typeof onArrive === 'function') onArrive();
    });
    return null;
  }

  // ---------------------------------------------------------------------
  // THE UNIT A PRODUCT IS BOUGHT IN
  //
  // Stock is counted in the base unit - the one it is sold in - because that is
  // the only unit that never has a remainder. But a shopkeeper who buys by the
  // COIL wants to know how many COILs are on the shelf, so the conversion is
  // read here and the stock screen shows both.
  //
  // product_units is the master record of it (02_master_data.sql). The base
  // unit's own row is always factor 1, so anything above 1 is a container.
  // ---------------------------------------------------------------------
  async function fetchConversions() {
    if (_conv) return _conv;
    if (!window.KoshApi || !window.ACTIVE_SHOP_ID) return null;
    try {
      const shopFilter = `shop_id=eq.${window.ACTIVE_SHOP_ID}`;
      const [rows, units] = await Promise.all([
        window.KoshApi.selectAll('product_units', `${shopFilter}&select=product_id,unit_id,factor`),
        window.KoshApi.selectAll('units', `${shopFilter}&select=id,name`)
      ]);
      const nameOf = new Map((units || []).map((u) => [String(u.id), u.name]));
      _conv = new Map();
      for (const r of (rows || [])) {
        const factor = Number(r.factor) || 0;
        if (factor <= 1) continue;                 // the base unit, or smaller
        const pid = String(r.product_id);
        const held = _conv.get(pid);
        // Largest wins if there are several - the biggest container is the one
        // a shopkeeper counts by.
        if (!held || factor > held.factor) {
          _conv.set(pid, { unit: nameOf.get(String(r.unit_id)) || '', factor });
        }
      }
      return _conv;
    } catch (e) {
      console.info('Server unit conversions unavailable:', e && e.message ? e.message : e);
      return null;
    }
  }

  const conversionOf = (productId) => (_conv ? (_conv.get(String(productId)) || null) : null);

  const num = (v) => Math.round((Number(v) || 0) * 100) / 100;

  // WHAT MAPS TO WHAT
  //
  // One line each, deliberately. Two of these figures are things cash_ledger
  // cannot separate on its own - the carrying cost rides on the purchase's cash
  // row, and a loan repayment is a payment out like any other - so the server
  // splits them from purchases.extra_cost and from the allocations (see
  // 39_cash_summary.sql). Comparing them separately rather than as a sum is the
  // point: a sum that matches can still hide two errors cancelling out.
  //
  // Anything that differs here is a genuine disagreement worth chasing.
  function compare(metrics) {
    const c = metrics && metrics.cash;
    const p = metrics && metrics.purchase;
    const s = metrics && metrics.sales;
    if (!c) return null;
    return [
      ['Opening cash',        num(c.openingCash),        'opening_cash'],
      ['Sale cash in',        num(s && s.saleCashIn),    'sale_cash_in'],
      ['Customer paid in',    num(c.periodPaymentsReceived), 'customer_payment_in'],
      ['Purchase return in',  num(c.purchaseReturnCashIn),   'purchase_return_in'],
      ['Investment in',       num(c.investmentCashIn || c.capitalCashIn), 'investment_in'],
      ['Loan in',             num(c.loanCashIn),         'loan_in'],
      ['Total in',            num(c.cashIn),             'total_in'],
      ['Purchase goods out',  num(p && p.cashPaidAtBuy),     'purchase_goods_out'],
      ['Purchase carrying out', num(p && p.extraCostCashOut), 'purchase_extra_out'],
      ['Sale return out',     num(s && s.saleReturnCashOut), 'sale_return_out'],
      ['Supplier paid out',   num(p && p.supplierDuePaidCashOut), 'supplier_payment_out'],
      ['Loan repaid out',     num(c.loanPaymentCashOut),     'loan_payment_out'],
      ['Expenses out',        num(c.extraExpensesTotal), 'expense_out'],
      ['Withdrawals out',     num(c.cashWithdrawalsTotal), 'withdrawal_out'],
      ['Capital out',         num(c.capitalCashOut),     'capital_out'],
      ['Total out',           num(c.cashOut),            'total_out'],
      ['Cash in hand',        num(c.closingCash),        'cash_in_hand'],
      ['Net change',          num(c.netCashChange),      'net_cash_change']
    ];
  }

  // Stock, product by product. A total that matches can still hide two products
  // wrong in opposite directions, so this compares each one and reports the
  // first few rather than the sum.
  function stockDiffs() {
    if (!_stock || typeof getStock !== 'function') return [];
    const out = [];
    for (const p of (window.data && data.products) || []) {
      if (!p || p.isActive === false) continue;
      const srv = _stock.get(String(p.id));
      if (!srv) continue;
      const localQty = num(getStock(p.id));
      if (Math.abs(localQty - num(srv.qty)) > 0.01) {
        out.push({ label: `Stock qty: ${p.name || p.id}`, browser: localQty,
                   server: num(srv.qty), field: 'qty' });
      }
      if (out.length >= 8) break;
    }
    return out;
  }

  // Each open bill against the server's balance for it. Named by bill, because
  // "the total is 500 out" is not something anyone can act on, and "this
  // customer's bill is 500 out" is.
  function billDiffs() {
    if (!_bills || !window.data) return [];
    const out = [];
    const rows = [].concat(data.credits || [], data.supplierCredits || []);
    for (const c of rows) {
      const srv = _bills.get(String(c.id));
      if (!srv) continue;
      const local = num(c.total) - num(c.paid);
      if (Math.abs(local - num(srv.balance)) > 0.01) {
        out.push({
          label: `Bill due: ${c.billId || c.id} (${c.customerName || c.supplierName || '?'})`,
          browser: local, server: num(srv.balance), field: 'balance'
        });
      }
      if (out.length >= 8) break;
    }
    return out;
  }

  // Product by product, against what the app's own breakdown makes of the same
  // day. Named by product for the same reason the bills are named by bill.
  function productDiffs(server) {
    if (!server || typeof getCentralCalculationBundle !== 'function') return [];
    let agg = null;
    try {
      agg = getCentralCalculationBundle('daily', todayStr()).report.saleReportAgg;
    } catch (e) { return []; }
    if (!agg || !Array.isArray(agg.sorted)) return [];
    const out = [];
    for (const [pid, d] of agg.sorted) {
      const srv = server.get(String(pid));
      if (!srv) continue;
      const name = (typeof getProd === 'function' && getProd(pid)?.name) || pid;
      if (Math.abs(num(d.revenue) - num(srv.revenue)) > 0.01) {
        out.push({ label: `Product revenue: ${name}`, browser: num(d.revenue),
                   server: num(srv.revenue), field: 'revenue' });
      }
      if (Math.abs(num(d.cost) - num(srv.cost)) > 0.01) {
        out.push({ label: `Product cost: ${name}`, browser: num(d.cost),
                   server: num(srv.cost), field: 'cost' });
      }
      if (out.length >= 8) break;
    }
    return out;
  }

  // What was earned, checked the same way.
  function compareProfit(metrics) {
    const s = metrics && metrics.sales;
    if (!s) return [];
    return [
      ['Gross revenue',   num(s.grossRevenue),   'gross_revenue'],
      ['Bill discount',   num(s.billDiscount),   'bill_discount'],
      ['Return revenue',  num(s.returnRevenue),  'sale_return_revenue'],
      ['Net revenue',     num(s.netRevenue),     'net_revenue'],
      ['Adjustment loss', num(s.adjustmentLoss), 'adjustment_loss'],
      ['Profit',          num(s.profit),         'profit']
    ];
  }

  // The standing position, checked the same way as the flow.
  function compareSnapshot(metrics) {
    const b = metrics && metrics.business;
    if (!b) return [];
    return [
      ['Stock value',   num(b.stockValue),      'stock_value'],
      ['Customer due',  num(b.customerDueAll),  'receivable'],
      ['Supplier due',  num(b.supplierDueAll),  'payable'],
      ['Business worth', num(b.netBusinessWorth), 'business_worth']
    ];
  }

  // Fetches everything the screens read, then compares it with what this device
  // works out for itself. Both jobs, in that order - and the order matters.
  //
  // FETCHING IS THE JOB; CHECKING IS THE EXTRA.
  //
  // This used to stop at the first missing answer: if the cash summary was
  // unavailable it returned immediately, and the stock, the bill balances, the
  // conversions, the profit and the per-product figures were never asked for at
  // all. One unavailable function quietly put SIX screens back on this device's
  // own arithmetic - which is why the staleness turned up in places that had
  // nothing to do with cash.
  //
  // It also gave up when the local bundle could not be built yet. That is a
  // reason to skip the COMPARISON, not a reason to leave the screens without
  // the figures they are going to display.
  //
  // So: ask for all of it, together, and let each answer stand or fail on its
  // own. Then compare whatever came back.
  async function refreshFigures() {
    const today = typeof todayStr === 'function' ? todayStr() : null;
    if (!today) return null;

    const [row, snap, earned, prod] = await Promise.all([
      fetchRange(today, today),
      fetchSnapshot(today),
      fetchProfit(today, today),
      fetchProductSales(today, today),
      fetchStock(),
      fetchConversions(),
      fetchBills()
    ]);

    let metrics = null;
    try {
      metrics = getCentralCalculationBundle('daily', today).metrics;
    } catch (e) {
      // Nothing loaded yet, so there is nothing to compare against. The figures
      // above are fetched and cached regardless; that was the point.
      _lastCompare = { date: today, row, diffs: [], checkedAt: Date.now() };
      return _lastCompare;
    }

    const check = (lines, source) => (source ? lines : [])
      .map(([label, browser, field]) => ({ label, browser, server: num(source[field]), field }))
      .filter((d) => Math.abs(d.browser - d.server) > 0.01);

    const diffs = check(compare(metrics) || [], row)
      .concat(check(compareSnapshot(metrics), snap))
      .concat(check(compareProfit(metrics), earned))
      .concat(stockDiffs())
      .concat(billDiffs())
      .concat(productDiffs(prod));

    _lastCompare = { date: today, row, diffs, checkedAt: Date.now() };

    if (diffs.length) {
      // A table, because the useful question is never "is something wrong" but
      // "which line, and by how much".
      /* eslint-disable-next-line no-console */
      console.warn("Cash figures: this device's arithmetic disagrees with the "
                   + 'database for ' + today + '. The screens show the database.');
      console.table(diffs.map((d) => ({
        figure: d.label, thisDevice: d.browser, database: d.server,
        difference: num(d.server - d.browser)
      })));
    } else {
      console.info('Cash figures agree with the database for ' + today + '.');
    }
    return _lastCompare;
  }

  const lastCompare = () => _lastCompare;

  return { forget, fetchRange, get, known, row, periodRange, rowFor,
           fetchSnapshot, snapshotOn, snapshotFor,
           fetchProfit, profitOn, profitFor,
           fetchStock, stockLoaded, stockOf, fetchConversions, conversionOf,
           fetchBills, billsLoaded, billBalance,
           fetchProductSales, productSalesFor, productSalesLoaded,
           refreshFigures, lastCompare };
})();
