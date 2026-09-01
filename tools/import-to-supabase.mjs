// import-to-supabase.mjs — load the recovered KoshAgar dataset into Postgres.
//
// The import replays your history THROUGH the posting functions rather than
// inserting rows directly. That costs some speed and buys a great deal: FIFO
// lots, COGS, the stock ledger and the cash ledger are all rebuilt by exactly
// the code that will run in production. If the import reconciles, the engine
// is proven on six months of real data.
//
// RESUMABLE. Every document carries an idempotency key derived from its old id,
// so a run that stops halfway can simply be run again - already-imported
// documents return their original result instead of being written twice.
//
// Usage:
//   set SUPABASE_URL=https://xxxx.supabase.co
//   set SUPABASE_SERVICE_KEY=eyJ...            (service role - see note below)
//   node tools/import-to-supabase.mjs --file "C:\...\shop-RECOVERED-CLOUD-FULL...json"
//
//   --shop-id <uuid>   import into an existing shop instead of creating one
//   --dry-run          analyse and report, write nothing
//
// The SERVICE ROLE key is required because only it can create legacy parties
// (those without a phone). Never put this key in the frontend.

import { readFileSync } from 'node:fs';

const URL_BASE = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes('--dry-run');
const FILE = argOf('--file');
let SHOP = argOf('--shop-id');

if (!FILE) fail('--file is required');
if (!DRY && (!URL_BASE || !KEY)) fail('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');

function fail(msg) { console.error(`\n  ERROR: ${msg}\n`); process.exit(1); }
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------
async function api(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const detail = data?.message || data?.hint || text || res.statusText;
    throw new Error(`${res.status} ${path} — ${detail}`);
  }
  return data;
}

const insert = (table, rows) =>
  api(`/${table}`, { method: 'POST', body: rows, prefer: 'return=representation' });
const select = (table, query) => api(`/${table}?${query}`);
const rpc = (fn, payload) =>
  api(`/rpc/${fn}`, { method: 'POST', body: payload });

// ---------------------------------------------------------------------------
// Load and shape the source data
// ---------------------------------------------------------------------------
const raw = JSON.parse(readFileSync(FILE, 'utf8'));
const data = raw.data || raw;
const PHONE = /^01[3-9][0-9]{8}$/;
const norm = (s) => String(s ?? '').trim();
const upper = (s) => norm(s).toUpperCase();

const txs = [...(data.transactions || [])].sort((a, b) =>
  String(a.date).localeCompare(String(b.date)) || Number(a.id) - Number(b.id));

console.log(`\nSource: ${data.products?.length || 0} products, ${txs.length} transactions\n`);

// Group transaction lines into documents, exactly as they were entered.
const docs = new Map();
for (const t of txs) {
  // Type is part of the key: bills 1200000028 and 1200000145 each contain a
  // sale AND a return, and they are different documents.
  const key = t.billId ? `bill:${t.billId}:${t.type}` : `single:${t.id}`;
  if (!docs.has(key)) docs.set(key, []);
  docs.get(key).push(t);
}
const ordered = [...docs.entries()].sort((a, b) =>
  String(a[1][0].date).localeCompare(String(b[1][0].date)) ||
  Number(a[1][0].id) - Number(b[1][0].id));

console.log(`Grouped into ${ordered.length} documents.`);

if (DRY) {
  const kinds = {};
  for (const [, lines] of ordered) kinds[lines[0].type] = (kinds[lines[0].type] || 0) + 1;
  console.log('By type:', kinds);
  console.log('\nDry run — nothing written.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Shop
// ---------------------------------------------------------------------------
if (!SHOP) {
  const [shop] = await insert('shops', [{ name: norm(data.shopName) || 'KoshAgar' }]);
  SHOP = shop.id;
  console.log(`Created shop ${SHOP}`);
} else {
  console.log(`Importing into existing shop ${SHOP}`);
}

// A shop created by an ordinary insert does NOT go through handle_new_user() -
// that trigger fires on auth.users, not on shops - so seed_new_shop() never
// ran and there is no cash drawer. Every money movement needs one.
const accounts = await select('cash_accounts', `shop_id=eq.${SHOP}&select=id,is_default`);
if (!accounts.some((a) => a.is_default)) {
  await insert('cash_accounts', [{ shop_id: SHOP, name: 'Main Counter', kind: 'cash', is_default: true }]);
  console.log('Created default cash account');
}

// Opening cash: the balance the drawer started with. cash_balance_as_of()
// anchors on the most recent opening figure on or before a date, so this must
// exist before any withdrawal is posted.
const openingCash = data.openingCashByDate || {};
for (const [date, amount] of Object.entries(openingCash)) {
  if (!(Number(amount) >= 0)) continue;
  await rpc('set_opening_cash', { p_shop: SHOP, p_payload: {
    business_date: date, amount: Number(amount)
  }});
}
console.log(`Opening cash entries: ${Object.keys(openingCash).length}`);

// ---------------------------------------------------------------------------
// 2. Units — every unit named by a product or used on a line
// ---------------------------------------------------------------------------
const unitNames = new Set();
for (const p of data.products || []) if (upper(p.unit)) unitNames.add(upper(p.unit));
for (const t of txs) if (upper(t.entryUnit)) unitNames.add(upper(t.entryUnit));
for (const u of data.units || []) if (upper(u)) unitNames.add(upper(u));
if (unitNames.size === 0) unitNames.add('PIECE');

const existingUnits = await select('units', `shop_id=eq.${SHOP}&select=id,name`);
const unitId = new Map(existingUnits.map((u) => [u.name, u.id]));
const newUnits = [...unitNames].filter((n) => !unitId.has(n));
if (newUnits.length) {
  const rows = await insert('units', newUnits.map((name) => ({ shop_id: SHOP, name })));
  for (const u of rows) unitId.set(u.name, u.id);
}
console.log(`Units: ${unitId.size}`);

// ---------------------------------------------------------------------------
// 3. Products (skipping the __CAPITAL__ pseudo-product, which is a financial
//    event and now lives in capital_movements)
// ---------------------------------------------------------------------------
const products = (data.products || []).filter((p) => String(p.id) !== '__CAPITAL__');
const existingProducts = await select('products', `shop_id=eq.${SHOP}&select=id,legacy_id,base_unit_id`);
const prodId = new Map(existingProducts.map((p) => [p.legacy_id, p.id]));
const prodBaseUnit = new Map(existingProducts.map((p) => [p.legacy_id, p.base_unit_id]));

const toInsert = products.filter((p) => !prodId.has(String(p.id)));
for (let i = 0; i < toInsert.length; i += 200) {
  const batch = toInsert.slice(i, i + 200).map((p) => {
    const unit = unitId.get(upper(p.unit)) || unitId.get('PIECE') || [...unitId.values()][0];
    return {
      shop_id: SHOP, legacy_id: String(p.id), name: norm(p.name) || String(p.id),
      category: norm(p.category), base_unit_id: unit
    };
  });
  const rows = await insert('products', batch);
  for (const r of rows) { prodId.set(r.legacy_id, r.id); prodBaseUnit.set(r.legacy_id, r.base_unit_id); }
}
console.log(`Products: ${prodId.size}`);

// ---------------------------------------------------------------------------
// 4. Unit conversions actually used by the history.
//    Conversions are master data now, so every (product, unit) a line refers to
//    must exist before that line can be posted.
// ---------------------------------------------------------------------------
const baseUnitNameEarly = (legacyProductId) => {
  const p = (data.products || []).find((x) => String(x.id) === String(legacyProductId));
  return upper(p?.unit);
};
const convSeen = new Map();
for (const t of txs) {
  if (!upper(t.entryUnit) || !t.entryFactor) continue;
  if (upper(t.entryUnit) === baseUnitNameEarly(t.productId)) continue;   // see lineFor()
  const pid = prodId.get(String(t.productId));
  const uid = unitId.get(upper(t.entryUnit));
  if (!pid || !uid) continue;
  const key = `${pid}|${uid}`;
  if (!convSeen.has(key)) convSeen.set(key, { shop_id: SHOP, product_id: pid, unit_id: uid, factor: Number(t.entryFactor) });
}
const existingConv = await select('product_units', `shop_id=eq.${SHOP}&select=product_id,unit_id`);
const haveConv = new Set(existingConv.map((c) => `${c.product_id}|${c.unit_id}`));
const convRows = [...convSeen.entries()].filter(([k]) => !haveConv.has(k)).map(([, v]) => v);
for (let i = 0; i < convRows.length; i += 200) {
  await insert('product_units', convRows.slice(i, i + 200));
}
console.log(`Unit conversions: ${convSeen.size} used by history, ${convRows.length} added`);

// ---------------------------------------------------------------------------
// 5. Parties. A phone makes them identifiable; those without one are flagged
//    is_legacy, which only this service-role import may set.
// ---------------------------------------------------------------------------
const partySeed = new Map();   // key -> {name, phone, kinds:Set}
function noteParty(name, phone, kind) {
  name = norm(name); phone = norm(phone);
  if (!name && !PHONE.test(phone)) return null;
  const key = PHONE.test(phone) ? `p:${phone}` : `n:${name.toLowerCase()}`;
  if (!partySeed.has(key)) partySeed.set(key, { name: name || phone, phone: PHONE.test(phone) ? phone : null, kinds: new Set() });
  partySeed.get(key).kinds.add(kind);
  if (name && !partySeed.get(key).name) partySeed.get(key).name = name;
  return key;
}
for (const t of txs) {
  if (t.type === 'sale')     noteParty(t.customer, t.customerPhone, 'customer');
  if (t.type === 'purchase') noteParty(t.supplier, t.supplierPhone, 'supplier');
}
for (const c of data.credits || [])         noteParty(c.customerName, c.customerPhone, 'customer');
for (const s of data.supplierCredits || []) noteParty(s.supplierName, s.supplierPhone, 'supplier');

const existingParties = await select('parties', `shop_id=eq.${SHOP}&select=id,phone,name`);
const partyId = new Map();
for (const p of existingParties) {
  partyId.set(p.phone ? `p:${p.phone}` : `n:${String(p.name).toLowerCase()}`, p.id);
}
const partyRows = [...partySeed.entries()].filter(([k]) => !partyId.has(k)).map(([, v]) => ({
  shop_id: SHOP, name: v.name, phone: v.phone,
  kind: v.kinds.size > 1 ? 'both' : [...v.kinds][0],
  is_legacy: true
}));
for (let i = 0; i < partyRows.length; i += 200) {
  const rows = await insert('parties', partyRows.slice(i, i + 200));
  for (const r of rows) partyId.set(r.phone ? `p:${r.phone}` : `n:${String(r.name).toLowerCase()}`, r.id);
}
const noPhone = partyRows.filter((p) => !p.phone).length;
console.log(`Parties: ${partyId.size} (${noPhone} without a phone, flagged legacy)`);

// ---------------------------------------------------------------------------
// 5b. Map each document to the credit record the old system raised for it.
//
// Deriving the credit as (total - cash paid) was wrong: the old system kept a
// separate credits / supplierCredits row carrying its OWN party and amount, and
// payments were recorded against that row. Reconstructing it arithmetically
// produced bills against the wrong party, so payments could not allocate and
// the payable stayed high. Those records link back by billId or txId, so the
// authoritative amount and party are used instead.
// ---------------------------------------------------------------------------
const creditForDoc = new Map();
function indexCredits(list, kind) {
  for (const c of list || []) {
    const amount = Number(c.total || 0);
    const entry = { kind, amount, initialPaid: Number(c.paid || 0),
                    name: norm(c.customerName || c.supplierName),
                    phone: norm(c.customerPhone || c.supplierPhone),
                    date: c.date, id: String(c.id) };
    const docType = kind === 'customer' ? 'sale' : 'purchase';
    if (c.billId) creditForDoc.set(`bill:${c.billId}:${docType}`, entry);
    for (const tid of (c.txIds || [c.txId])) if (tid) creditForDoc.set(`single:${tid}`, entry);
  }
}
indexCredits(data.credits, 'customer');
indexCredits(data.supplierCredits, 'supplier');
console.log(`Credit records linked to documents: ${creditForDoc.size}`);

const overpaid = [];
const unattributed = [];
let unknownPartyId = null;

// ---------------------------------------------------------------------------
// 6. Replay every document in date order
// ---------------------------------------------------------------------------
const lineIdCache = new Map();     // old tx id -> new sale_line id
let posted = 0, skipped = 0;
const failures = [];

function baseUnitName(legacyProductId) {
  const p = (data.products || []).find((x) => String(x.id) === String(legacyProductId));
  return upper(p?.unit);
}
function lineFor(t) {
  const pid = prodId.get(String(t.productId));
  const entryUnit = upper(t.entryUnit);
  const isRealConversion = entryUnit && entryUnit !== baseUnitName(t.productId);
  const uid = isRealConversion ? unitId.get(entryUnit) : prodBaseUnit.get(String(t.productId));
  const qtyEntered = isRealConversion && t.entryQty != null ? Number(t.entryQty) : Number(t.qty);
  return {
    product_id: pid, unit_id: uid,
    qty_entered: qtyEntered,
    unit_price: Number(t.price || 0),
    // lineDiscount is NOT subtracted: in the old data `price` is already the net
    // unit price and `total` == qty x price. lineDiscount records how much was
    // taken off the LIST price, so applying it here would discount twice.
    line_discount: 0
  };
}

for (const [key, lines] of ordered) {
  const head = lines[0];
  const type = head.type;
  const date = String(head.date).slice(0, 10);
  const idem = `import:${key}`;

  try {
    if (type === 'capital-in' || type === 'capital-out') {
      for (const l of lines) {
        await rpc('post_capital_movement', { p_shop: SHOP, p_payload: {
          idempotency_key: `import:capital:${l.id}`,
          business_date: date, occurred_at: l.date,
          kind: type === 'capital-in' ? 'in' : 'out',
          amount: Number(l.total || l.cashPaid || 0),
          note: norm(l.reason) || norm(l.capitalSource)
        }});
      }
    } else if (type === 'adjustment') {
      for (const l of lines) {
        await rpc('post_adjustment', { p_shop: SHOP, p_payload: {
          idempotency_key: `import:adj:${l.id}`,
          business_date: date, occurred_at: l.date,
          kind: norm(l.adjustmentType) === 'damage' ? 'damage' : 'correction_out',
          product_id: prodId.get(String(l.productId)),
          qty_entered: Number(l.qty), note: norm(l.reason)
        }});
      }
    } else if (type === 'return') {
      // Returns need the new sale/purchase line they reverse. Resolved lazily
      // because only a handful of documents have any.
      for (const l of lines) {
        const origId = String(l.linkedTxId || '');
        const origLine = lineIdCache.get(origId);
        if (!origLine) { skipped++; failures.push({ key, why: `return ${l.id} has no resolvable original line (${origId})` }); continue; }
        await rpc('post_return', { p_shop: SHOP, p_payload: {
          idempotency_key: `import:ret:${l.id}`,
          business_date: date, occurred_at: l.date,
          kind: l.returnType === 'purchase-return' ? 'purchase_return' : 'sale_return',
          party_id: partyId.get(`p:${norm(l.customerPhone)}`) ?? partyId.get(`n:${norm(l.customer).toLowerCase()}`) ?? null,
          ...(l.returnType === 'purchase-return'
              ? { original_purchase_id: origLine.docId }
              : { original_sale_id: origLine.docId }),
          refund_cash: Number(l.cashPaid || 0),
          lines: [{ original_line_id: origLine.lineId, qty_base: Number(l.qty), unit_price: Number(l.price || 0) }]
        }});
      }
    } else if (type === 'sale' || type === 'purchase') {
      // Compute gross exactly as the database will, so the cap below compares
      // like with like. Some bills carry line totals that are already net of the
      // bill discount, others carry gross - billNetTotal settles which.
      const gross = lines.reduce((s, l) => {
        const price4 = Math.round(Number(l.price || 0) * 10000) / 10000;   // numeric(18,4)
        return s + Math.round(Number(l.qty || 0) * price4 * 100) / 100;
      }, 0);
      const billNet = head.billNetTotal != null ? Number(head.billNetTotal) : gross;
      const discount = Math.max(0, Math.round((gross - billNet) * 100) / 100);
      const paid = head.billPaidTotal != null
        ? Number(head.billPaidTotal)
        : lines.reduce((s, l) => s + Number(l.cashPaid || 0), 0);
      const net = Math.round((gross - discount) * 100) / 100;

      // The credit record, when one exists, is authoritative for both the party
      // and the amount owed.
      const credit = creditForDoc.get(key);
      const partyOf = (name, phone) => partyId.get(
        PHONE.test(norm(phone)) ? `p:${norm(phone)}` : `n:${norm(name).toLowerCase()}`) ?? null;

      const party = credit
        ? partyOf(credit.name, credit.phone)
        : (type === 'sale' ? partyOf(head.customer, head.customerPhone)
                           : partyOf(head.supplier, head.supplierPhone));

      // The RECORDED CASH is authoritative (your decision): money counted at the
      // counter is a hard fact, whereas the old app let the "due" figure drift
      // independently of it - in 40 of 68 credit sales the two did not add up to
      // the bill total. The amount owed is therefore derived as total - cash,
      // which is what the schema requires and what actually happened.
      //
      // The credit record is still used, but only for WHO the party is: that is
      // what fixed the supplier payable mapping.
      let cash = paid;
      if (cash > net + 0.001) {
        overpaid.push({ key, date, type, recorded: cash, bill: net });
        cash = net;
      }
      cash = Math.min(cash, net);
      const stillOwed = net - cash;

      let partyFinal = party;
      if (stillOwed > 0.01 && !partyFinal) {
        // The old app allowed an unpaid sale with no customer at all. Dropping
        // the debt would lose real money, so it is parked against a clearly
        // named legacy party for the owner to reassign.
        if (!unknownPartyId) {
          const [row] = await insert('parties', [{
            shop_id: SHOP, name: 'Unknown (pre-migration)', phone: null,
            kind: 'both', is_legacy: true }]);
          unknownPartyId = row.id;
          console.log('Created "Unknown (pre-migration)" party for unattributed debts');
        }
        partyFinal = unknownPartyId;
        unattributed.push({ key, date, type, amount: stillOwed });
      }

      const payload = {
        idempotency_key: idem,
        business_date: date, occurred_at: head.date,
        party_id: partyFinal,
        bill_discount: discount,
        cash_paid: cash,
        note: norm(head.reason),
        lines: lines.map(lineFor)
      };
      if (type === 'purchase') payload.extra_cost = Number(head.invoiceExtraCost || 0);

      const res = await rpc(type === 'sale' ? 'post_sale' : 'post_purchase', { p_shop: SHOP, p_payload: payload });
      const docId = res.sale_id || res.purchase_id;

      // Remember line ids only when a later return refers to this document.
      if (txs.some((t) => t.type === 'return' && lines.some((l) => String(l.id) === String(t.linkedTxId)))) {
        const tbl = type === 'sale' ? 'sale_lines' : 'purchase_lines';
        const col = type === 'sale' ? 'sale_id' : 'purchase_id';
        const got = await select(tbl, `${col}=eq.${docId}&select=id,line_no&order=line_no`);
        got.forEach((row, i) => { if (lines[i]) lineIdCache.set(String(lines[i].id), { docId, lineId: row.id }); });
      }
    }
    posted++;
    if (posted % 100 === 0) console.log(`  … ${posted}/${ordered.length} documents`);
  } catch (e) {
    failures.push({ key, date, type, why: e.message });
    if (failures.length > 20) {
      console.error('\nToo many failures — stopping so the cause can be fixed.\n');
      break;
    }
  }
}

console.log(`\nDocuments posted: ${posted}, skipped: ${skipped}, failed: ${failures.length}`);
for (const f of failures.slice(0, 20)) console.log(`  ! ${f.date || ''} ${f.type || ''} ${f.key} — ${f.why}`);

// ---------------------------------------------------------------------------
// 7. Expenses and withdrawals
// ---------------------------------------------------------------------------
const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
for (const e of [...(data.extraExpenses || [])].sort(byDate)) {
  try {
    await rpc('post_expense', { p_shop: SHOP, p_payload: {
      idempotency_key: `import:exp:${e.id}`,
      business_date: String(e.date).slice(0, 10), occurred_at: e.date,
      amount: Number(e.amount), note: norm(e.note)
    }});
  } catch (err) { failures.push({ key: `expense:${e.id}`, why: err.message }); }
}
// The owner confirmed these withdrawals really happened, so where the drawer
// cannot cover one the missing half is cash income that was never written down.
// A cash adjustment records exactly that gap, with a reason, before retrying -
// so the money is accounted for rather than quietly absorbed.
const shortfalls = [];
for (const w of [...(data.cashWithdrawals || [])].sort(byDate)) {
  const date = String(w.date).slice(0, 10);
  const payload = {
    idempotency_key: `import:wd:${w.id}`,
    business_date: date, occurred_at: w.date,
    amount: Number(w.amount), reason: norm(w.reason)
  };
  try {
    await rpc('post_cash_withdrawal', { p_shop: SHOP, p_payload: payload });
  } catch (err) {
    const m = /INSUFFICIENT_CASH: the drawer holds (-?[\d.]+)/.exec(err.message);
    if (!m) { failures.push({ key: `withdrawal:${w.id}`, why: err.message }); continue; }
    const held = Number(m[1]);
    const gap = Math.round((Number(w.amount) - held) * 100) / 100;
    try {
      await rpc('post_cash_adjustment', { p_shop: SHOP, p_payload: {
        idempotency_key: `import:cashadj:${w.id}`,
        business_date: date, occurred_at: w.date,
        direction: 'in', amount: gap,
        reason: `Unrecorded cash income before migration - drawer was short ${gap.toFixed(2)} for withdrawal on ${date}`
      }});
      await rpc('post_cash_withdrawal', { p_shop: SHOP, p_payload: payload });
      shortfalls.push({ date, gap, withdrawal: Number(w.amount) });
    } catch (err2) { failures.push({ key: `withdrawal:${w.id}`, why: err2.message }); }
  }
}
if (shortfalls.length) {
  const total = shortfalls.reduce((s, x) => s + x.gap, 0);
  console.log(`
${shortfalls.length} day(s) where the drawer could not cover a real withdrawal:`);
  for (const x of shortfalls) console.log(`  ${x.date}  short ${money(x.gap)} on a withdrawal of ${money(x.withdrawal)}`);
  console.log(`  total recorded as unrecorded cash income: ${money(total)}`);
}
console.log(`Expenses: ${(data.extraExpenses || []).length}, withdrawals: ${(data.cashWithdrawals || []).length}`);

// ---------------------------------------------------------------------------
// 7b. The initial payment held on each credit row.
//
// The old model stored a first payment directly on the credit ("paid"), with
// later payments in a separate table. Only the latter were being imported, so
// every credit looked more outstanding than it was.
// ---------------------------------------------------------------------------
let initialPays = 0;
for (const [list, dir] of [[data.credits, 'in'], [data.supplierCredits, 'out']]) {
  for (const c of list || []) {
    const amt = Number(c.paid || 0);
    if (amt <= 0) continue;
    const name = norm(c.customerName || c.supplierName);
    const phone = norm(c.customerPhone || c.supplierPhone);
    const party = partyId.get(PHONE.test(phone) ? `p:${phone}` : `n:${name.toLowerCase()}`);
    if (!party) { failures.push({ key: `initial:${c.id}`, why: 'no party for initial payment' }); continue; }
    try {
      await rpc('record_payment', { p_shop: SHOP, p_payload: {
        idempotency_key: `import:init:${dir}:${c.id}`,
        business_date: String(c.date).slice(0, 10), occurred_at: c.date,
        party_id: party, direction: dir, amount: amt
      }});
      initialPays++;
    } catch (err) { failures.push({ key: `initial:${c.id}`, why: err.message }); }
  }
}
console.log(`Initial payments held on credit rows: ${initialPays}`);

// ---------------------------------------------------------------------------
// 8. Payments against credit. Allocation is done by record_payment,
//    oldest bill first.
// ---------------------------------------------------------------------------
const creditById = new Map((data.credits || []).map((c) => [String(c.id), c]));
const scById = new Map((data.supplierCredits || []).map((s) => [String(s.id), s]));
let payCount = 0;

for (const p of data.payments || []) {
  const c = creditById.get(String(p.creditId));
  if (!c) continue;
  const key = PHONE.test(norm(c.customerPhone)) ? `p:${norm(c.customerPhone)}` : `n:${norm(c.customerName).toLowerCase()}`;
  const party = partyId.get(key);
  if (!party) { failures.push({ key: `payment:${p.id}`, why: 'no party' }); continue; }
  try {
    await rpc('record_payment', { p_shop: SHOP, p_payload: {
      idempotency_key: `import:pay:${p.id}`,
      business_date: String(p.date).slice(0, 10), occurred_at: p.date,
      party_id: party, direction: 'in', amount: Number(p.amount)
    }});
    payCount++;
  } catch (err) { failures.push({ key: `payment:${p.id}`, why: err.message }); }
}
for (const p of data.supplierPayments || []) {
  const s = scById.get(String(p.scId));
  if (!s) continue;
  const key = PHONE.test(norm(s.supplierPhone)) ? `p:${norm(s.supplierPhone)}` : `n:${norm(s.supplierName).toLowerCase()}`;
  const party = partyId.get(key);
  if (!party) { failures.push({ key: `spayment:${p.id}`, why: 'no party' }); continue; }
  try {
    await rpc('record_payment', { p_shop: SHOP, p_payload: {
      idempotency_key: `import:spay:${p.id}`,
      business_date: String(p.date).slice(0, 10), occurred_at: p.date,
      party_id: party, direction: 'out', amount: Number(p.amount)
    }});
    payCount++;
  } catch (err) { failures.push({ key: `spayment:${p.id}`, why: err.message }); }
}
console.log(`Payments recorded: ${payCount}`);

if (unattributed.length) {
  console.log(`
${unattributed.length} unpaid bill(s) had no customer recorded - parked on "Unknown (pre-migration)":`);
  for (const u of unattributed) console.log(`  ${u.date} ${u.type} ${money(u.amount)}`);
}

if (overpaid.length) {
  console.log(`
${overpaid.length} bill(s) recorded MORE money than was owed - capped at the bill total:`);
  let lost = 0;
  for (const o of overpaid) {
    lost += o.recorded - o.bill;
    console.log(`  ${o.date} ${o.type.padEnd(8)} recorded ${money(o.recorded)} against ${money(o.bill)}  (+${money(o.recorded - o.bill)})`);
  }
  console.log(`  total excess excluded: ${money(lost)} - these were data-entry errors in the old app, which had no constraint.`);
}

// ---------------------------------------------------------------------------
// 9. Reconciliation against the baseline
// ---------------------------------------------------------------------------
console.log('\n============================ RECONCILIATION ============================');
const due    = await select('v_due_totals',  `shop_id=eq.${SHOP}&select=*`);
const stock  = await select('v_product_stock', `shop_id=eq.${SHOP}&select=qty,stock_value`);
const recon  = await select('v_stock_reconciliation', `shop_id=eq.${SHOP}&select=product_id`);
const months = await select('v_monthly_trading', `shop_id=eq.${SHOP}&select=*&order=month`);

const withStock = stock.filter((s) => Math.abs(Number(s.qty)) > 0.001).length;
const negative  = stock.filter((s) => Number(s.qty) < -0.001).length;
const stockValue = stock.reduce((s, r) => s + Number(r.stock_value || 0), 0);

const row = (label, actual, expected) => {
  const ok = expected == null || Math.abs(Number(actual) - Number(expected)) < 0.5;
  console.log(`  ${ok ? 'ok  ' : 'DIFF'} ${label.padEnd(26)} ${String(money(actual)).padStart(14)}` +
              (expected != null ? `   expected ${money(expected)}` : ''));
};
const sumOf = (list, f) => (list || []).reduce((s, x) => s + Number(f(x) || 0), 0);
const expCustomer = sumOf(data.credits, (c) => c.total)
                  - sumOf(data.credits, (c) => c.paid)
                  - sumOf(data.payments, (p) => p.amount);
const expSupplier = sumOf(data.supplierCredits, (c) => c.total)
                  - sumOf(data.supplierCredits, (c) => c.paid)
                  - sumOf(data.supplierPayments, (p) => p.amount);
// Not compared against the old stored figures: those are what we decided NOT to
// trust. Due is now derived as bill total minus cash actually received.
row('customer due (derived)', due[0]?.total_receivable ?? 0, null);
row('supplier due (derived)', due[0]?.total_payable ?? 0, null);
console.log(`       old app reported            ${String(money(Math.round(expCustomer * 100) / 100)).padStart(14)} / ${money(Math.round(expSupplier * 100) / 100)}`);
console.log(`  ${withStock === 288 ? 'ok  ' : 'DIFF'} products holding stock    ${String(withStock).padStart(14)}   expected 288`);
console.log(`  ${negative === 0 ? 'ok  ' : 'DIFF'} negative stock            ${String(negative).padStart(14)}   expected 0`);
console.log(`  ${recon.length === 0 ? 'ok  ' : 'DIFF'} ledger vs lots mismatch   ${String(recon.length).padStart(14)}   expected 0`);
console.log(`       stock value (FIFO)         ${String(money(stockValue)).padStart(14)}`);

console.log('\n  month      net revenue         cogs   gross profit');
for (const m of months) {
  console.log(`  ${String(m.month).slice(0, 7)}  ${money(m.net_revenue).padStart(12)} ${money(m.cogs).padStart(12)} ${money(m.gross_profit).padStart(14)}`);
}
console.log(`\n  shop id: ${SHOP}`);
if (failures.length) {
  console.log('\n  failures:');
  for (const f of failures) console.log(`    ! ${f.key} — ${f.why}`);
}
console.log(failures.length
  ? `\n  ${failures.length} item(s) failed — fix and re-run; imported documents are skipped automatically.\n`
  : '\n  No failures.\n');
