
// db/sqlite.js — Relational SQLite (sql.js / WASM) — SOURCE OF TRUTH for KoshAgar
// ---------------------------------------------------------------------------
// v2: PRIMARY KEY, FOREIGN KEY, CHECK constraints, delete-protection triggers.
// The in-memory `data` object remains the working cache for calc/UI; every save
// must pass through KoshDB.persistFromData() BEFORE the JSON backup is written.
// Stock is still derived from transactions in JS (FIFO) — no stored stock column.
//
// Requires a served origin (not file://) and sql.js WASM on first load.

window.KoshDB = (function () {
  // Self-hosted sql.js (was a cdnjs URL). Served from ./vendor/ so the relational
  // SQLite engine works fully offline — no internet needed after the app is cached.
  const CDN_BASE = './vendor/';
  const IDB_STORE = 'data';
  const IDB_KEY = 'SQLITE_DB';
  const SCHEMA_VERSION = '6';

  let SQL = null;
  let sdb = null;
  let _initPromise = null;
  let _lastSyncSig = null;

  const api = {
    available: false,
    lastError: null,
    lastSyncAt: null,
    schemaVersion: SCHEMA_VERSION
  };

  const RELATIONAL_DDL = `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL CHECK(length(trim(COALESCE(name, ''))) > 0),
      unit TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('sale', 'purchase', 'return', 'adjustment', 'capital-in', 'capital-out')),
      date TEXT NOT NULL,
      local_date TEXT NOT NULL DEFAULT '',
      productId TEXT NOT NULL,
      qty REAL NOT NULL CHECK(qty > 0),
      price REAL NOT NULL CHECK(price >= 0),
      cost REAL NOT NULL DEFAULT 0 CHECK(cost >= 0),
      total REAL NOT NULL CHECK(total >= 0),
      cashPaid REAL CHECK(cashPaid IS NULL OR cashPaid >= 0),
      returnType TEXT,
      linkedTxId TEXT,
      opening INTEGER NOT NULL DEFAULT 0 CHECK(opening IN (0, 1)),
      adjustmentType TEXT,
      -- Unit conversion made first-class: qty/price/total above are in the product's
      -- BASE (stock) unit; these record what was actually entered. Invariant
      -- qty ≈ entry_qty × entry_factor is checked (soft) by checkIntegrity so a bad
      -- import surfaces instead of being blocked. entry_factor = base units per 1
      -- entered unit (1 for simple products / sales in the base unit).
      entry_unit TEXT NOT NULL DEFAULT '',
      entry_qty REAL,
      entry_factor REAL NOT NULL DEFAULT 1 CHECK(entry_factor > 0),
      base_unit TEXT NOT NULL DEFAULT '',
      json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (productId) REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      FOREIGN KEY (linkedTxId) REFERENCES transactions(id) ON DELETE SET NULL ON UPDATE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
      CHECK(cashPaid IS NULL OR cashPaid <= total + 0.01)
    );

    -- Normalized party master. PRIMARY KEY is the canonical BD mobile number
    -- (11 digits, 01[3-9]XXXXXXXX) — phone is the sole identity, so the same
    -- phone anywhere = one party. Derived/rebuilt from credits + supplier_credits
    -- on every persist (see buildPartyRows); never edited directly by the app.
    CREATE TABLE IF NOT EXISTS parties (
      phone TEXT PRIMARY KEY NOT NULL CHECK(phone GLOB '01[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
      name  TEXT NOT NULL CHECK(length(trim(COALESCE(name, ''))) > 0),
      type  TEXT NOT NULL CHECK(type IN ('customer', 'supplier', 'both')),
      json  TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS credits (
      id TEXT PRIMARY KEY NOT NULL,
      date TEXT NOT NULL,
      local_date TEXT NOT NULL DEFAULT '',
      customerName TEXT NOT NULL CHECK(length(trim(COALESCE(customerName, ''))) > 0),
      customerPhone TEXT NOT NULL DEFAULT '',
      total REAL NOT NULL CHECK(total > 0),
      paid REAL NOT NULL DEFAULT 0 CHECK(paid >= 0),
      party_phone TEXT,
      json TEXT NOT NULL DEFAULT '{}',
      CHECK(paid <= total + 0.01),
      FOREIGN KEY (party_phone) REFERENCES parties(phone) ON DELETE SET NULL ON UPDATE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY NOT NULL,
      creditId TEXT NOT NULL,
      date TEXT NOT NULL,
      local_date TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL CHECK(amount > 0),
      json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (creditId) REFERENCES credits(id) ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS supplier_credits (
      id TEXT PRIMARY KEY NOT NULL,
      date TEXT NOT NULL,
      local_date TEXT NOT NULL DEFAULT '',
      supplierName TEXT NOT NULL DEFAULT '',
      supplierPhone TEXT NOT NULL DEFAULT '',
      total REAL NOT NULL CHECK(total > 0),
      paid REAL NOT NULL DEFAULT 0 CHECK(paid >= 0),
      party_phone TEXT,
      json TEXT NOT NULL DEFAULT '{}',
      CHECK(paid <= total + 0.01),
      FOREIGN KEY (party_phone) REFERENCES parties(phone) ON DELETE SET NULL ON UPDATE CASCADE
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id TEXT PRIMARY KEY NOT NULL,
      scId TEXT NOT NULL,
      date TEXT NOT NULL,
      local_date TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL CHECK(amount > 0),
      json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (scId) REFERENCES supplier_credits(id) ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS loan_payments (
      id TEXT PRIMARY KEY NOT NULL,
      loanTxId TEXT NOT NULL,
      date TEXT NOT NULL,
      local_date TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL CHECK(amount > 0),
      note TEXT NOT NULL DEFAULT '',
      json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (loanTxId) REFERENCES transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cash_withdrawals (
      id TEXT PRIMARY KEY NOT NULL,
      date TEXT NOT NULL,
      local_date TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL CHECK(amount > 0),
      reason TEXT NOT NULL DEFAULT '',
      json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS extra_expenses (
      id TEXT PRIMARY KEY NOT NULL,
      date TEXT NOT NULL,
      local_date TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL CHECK(amount > 0),
      note TEXT NOT NULL DEFAULT '',
      json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS opening_cash (
      date TEXT PRIMARY KEY NOT NULL,
      amount REAL NOT NULL CHECK(amount >= 0)
    );

    CREATE TABLE IF NOT EXISTS units (
      name TEXT PRIMARY KEY NOT NULL CHECK(length(trim(COALESCE(name, ''))) > 0)
    );

    CREATE TABLE IF NOT EXISTS audit_trail (
      id TEXT PRIMARY KEY NOT NULL,
      json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS ix_tx_local_date ON transactions(local_date);
    CREATE INDEX IF NOT EXISTS ix_tx_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS ix_tx_type_local_date ON transactions(type, local_date);
    CREATE INDEX IF NOT EXISTS ix_tx_type_date ON transactions(type, date);
    CREATE INDEX IF NOT EXISTS ix_tx_product ON transactions(productId);
    CREATE INDEX IF NOT EXISTS ix_tx_linked ON transactions(linkedTxId);
    CREATE INDEX IF NOT EXISTS ix_credits_date ON credits(date);
    CREATE INDEX IF NOT EXISTS ix_credits_local_date ON credits(local_date);
    CREATE INDEX IF NOT EXISTS ix_credits_party ON credits(party_phone);
    CREATE INDEX IF NOT EXISTS ix_payments_credit ON payments(creditId);
    CREATE INDEX IF NOT EXISTS ix_payments_date ON payments(date);
    CREATE INDEX IF NOT EXISTS ix_payments_local_date ON payments(local_date);
    CREATE INDEX IF NOT EXISTS ix_scredits_date ON supplier_credits(date);
    CREATE INDEX IF NOT EXISTS ix_scredits_local_date ON supplier_credits(local_date);
    CREATE INDEX IF NOT EXISTS ix_scredits_party ON supplier_credits(party_phone);
    CREATE INDEX IF NOT EXISTS ix_spayments_sc ON supplier_payments(scId);
    CREATE INDEX IF NOT EXISTS ix_spayments_date ON supplier_payments(date);
    CREATE INDEX IF NOT EXISTS ix_spayments_local_date ON supplier_payments(local_date);
    CREATE INDEX IF NOT EXISTS ix_loan_payments_loan ON loan_payments(loanTxId);
    CREATE INDEX IF NOT EXISTS ix_loan_payments_date ON loan_payments(date);
    CREATE INDEX IF NOT EXISTS ix_loan_payments_local_date ON loan_payments(local_date);
    CREATE INDEX IF NOT EXISTS ix_withdrawals_date ON cash_withdrawals(date);
    CREATE INDEX IF NOT EXISTS ix_withdrawals_local_date ON cash_withdrawals(local_date);
    CREATE INDEX IF NOT EXISTS ix_expenses_date ON extra_expenses(date);
    CREATE INDEX IF NOT EXISTS ix_expenses_local_date ON extra_expenses(local_date);

    CREATE TRIGGER IF NOT EXISTS tr_products_no_delete_with_tx
    BEFORE DELETE ON products
    FOR EACH ROW
    WHEN OLD.id != '__CAPITAL__'
      AND (SELECT COUNT(*) FROM transactions WHERE productId = OLD.id) > 0
    BEGIN
      SELECT RAISE(ABORT, 'Cannot delete product: transactions exist');
    END;

    CREATE TRIGGER IF NOT EXISTS tr_credits_no_delete_with_payments
    BEFORE DELETE ON credits
    FOR EACH ROW
    WHEN (SELECT COUNT(*) FROM payments WHERE creditId = OLD.id) > 0
    BEGIN
      SELECT RAISE(ABORT, 'Cannot delete credit: payments exist');
    END;

    CREATE TRIGGER IF NOT EXISTS tr_supplier_credits_no_delete_with_payments
    BEFORE DELETE ON supplier_credits
    FOR EACH ROW
    WHEN (SELECT COUNT(*) FROM supplier_payments WHERE scId = OLD.id) > 0
    BEGIN
      SELECT RAISE(ABORT, 'Cannot delete supplier credit: payments exist');
    END;

    -- Non-destructive validation triggers: block impossible states without
    -- ever rewriting data. They reinforce the app's own rule (payments are
    -- capped at the outstanding balance, payments.js) so SUM(payments) can
    -- never exceed the credit total. Bypassed during force/bulk sync (import,
    -- migration, autoRepair) via meta '__sync_mode' so they can't misfire mid-load.
    CREATE TRIGGER IF NOT EXISTS tr_payments_no_overpay_ins
    BEFORE INSERT ON payments
    FOR EACH ROW
    WHEN COALESCE((SELECT value FROM meta WHERE key = '__sync_mode'), 'normal') <> 'force'
      AND (SELECT total FROM credits WHERE id = NEW.creditId) IS NOT NULL
      AND COALESCE((SELECT SUM(amount) FROM payments WHERE creditId = NEW.creditId), 0) + NEW.amount
          > (SELECT total FROM credits WHERE id = NEW.creditId) + 0.011
    BEGIN
      SELECT RAISE(ABORT, 'Customer payments exceed credit total');
    END;

    CREATE TRIGGER IF NOT EXISTS tr_payments_no_overpay_upd
    BEFORE UPDATE OF amount ON payments
    FOR EACH ROW
    WHEN COALESCE((SELECT value FROM meta WHERE key = '__sync_mode'), 'normal') <> 'force'
      AND (SELECT total FROM credits WHERE id = NEW.creditId) IS NOT NULL
      AND COALESCE((SELECT SUM(amount) FROM payments WHERE creditId = NEW.creditId AND id <> OLD.id), 0) + NEW.amount
          > (SELECT total FROM credits WHERE id = NEW.creditId) + 0.011
    BEGIN
      SELECT RAISE(ABORT, 'Customer payments exceed credit total');
    END;

    CREATE TRIGGER IF NOT EXISTS tr_spayments_no_overpay_ins
    BEFORE INSERT ON supplier_payments
    FOR EACH ROW
    WHEN COALESCE((SELECT value FROM meta WHERE key = '__sync_mode'), 'normal') <> 'force'
      AND (SELECT total FROM supplier_credits WHERE id = NEW.scId) IS NOT NULL
      AND COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE scId = NEW.scId), 0) + NEW.amount
          > (SELECT total FROM supplier_credits WHERE id = NEW.scId) + 0.011
    BEGIN
      SELECT RAISE(ABORT, 'Supplier payments exceed credit total');
    END;

    CREATE TRIGGER IF NOT EXISTS tr_spayments_no_overpay_upd
    BEFORE UPDATE OF amount ON supplier_payments
    FOR EACH ROW
    WHEN COALESCE((SELECT value FROM meta WHERE key = '__sync_mode'), 'normal') <> 'force'
      AND (SELECT total FROM supplier_credits WHERE id = NEW.scId) IS NOT NULL
      AND COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE scId = NEW.scId AND id <> OLD.id), 0) + NEW.amount
          > (SELECT total FROM supplier_credits WHERE id = NEW.scId) + 0.011
    BEGIN
      SELECT RAISE(ABORT, 'Supplier payments exceed credit total');
    END;
  `;

  const ERP_DDL = `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL DEFAULT 'KoshAgar',
      address TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      currency_code TEXT NOT NULL DEFAULT 'BDT',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO shops (id, name, created_at, updated_at)
    VALUES ('default', 'KoshAgar', datetime('now'), datetime('now'));

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      opening_due_paisa INTEGER NOT NULL DEFAULT 0 CHECK(opening_due_paisa >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, phone),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      opening_due_paisa INTEGER NOT NULL DEFAULT 0 CHECK(opening_due_paisa >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, phone),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      invoice_no TEXT NOT NULL,
      customer_id TEXT,
      sale_date TEXT NOT NULL,
      gross_paisa INTEGER NOT NULL DEFAULT 0 CHECK(gross_paisa >= 0),
      discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0),
      net_paisa INTEGER NOT NULL CHECK(net_paisa >= 0),
      cash_paid_paisa INTEGER NOT NULL DEFAULT 0 CHECK(cash_paid_paisa >= 0),
      status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('draft','posted','void','returned')),
      notes TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, invoice_no),
      CHECK(discount_paisa <= gross_paisa),
      CHECK(net_paisa = gross_paisa - discount_paisa),
      CHECK(cash_paid_paisa <= net_paisa),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY NOT NULL,
      sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      unit_name TEXT NOT NULL DEFAULT '',
      qty_milli INTEGER NOT NULL CHECK(qty_milli > 0),
      unit_price_paisa INTEGER NOT NULL CHECK(unit_price_paisa >= 0),
      discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0),
      line_total_paisa INTEGER NOT NULL CHECK(line_total_paisa >= 0),
      cogs_unit_paisa INTEGER NOT NULL DEFAULT 0 CHECK(cogs_unit_paisa >= 0),
      created_at TEXT NOT NULL,
      CHECK(line_total_paisa = ((qty_milli * unit_price_paisa) / 1000) - discount_paisa),
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      bill_no TEXT NOT NULL,
      supplier_id TEXT,
      purchase_date TEXT NOT NULL,
      gross_paisa INTEGER NOT NULL DEFAULT 0 CHECK(gross_paisa >= 0),
      discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0),
      extra_cost_paisa INTEGER NOT NULL DEFAULT 0 CHECK(extra_cost_paisa >= 0),
      net_paisa INTEGER NOT NULL CHECK(net_paisa >= 0),
      cash_paid_paisa INTEGER NOT NULL DEFAULT 0 CHECK(cash_paid_paisa >= 0),
      status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('draft','posted','void','returned')),
      notes TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, bill_no),
      CHECK(discount_paisa <= gross_paisa),
      CHECK(net_paisa = gross_paisa - discount_paisa),
      CHECK(cash_paid_paisa <= net_paisa),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id TEXT PRIMARY KEY NOT NULL,
      purchase_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      unit_name TEXT NOT NULL DEFAULT '',
      qty_milli INTEGER NOT NULL CHECK(qty_milli > 0),
      list_unit_paisa INTEGER NOT NULL DEFAULT 0 CHECK(list_unit_paisa >= 0),
      net_unit_paisa INTEGER NOT NULL CHECK(net_unit_paisa >= 0),
      landed_unit_paisa INTEGER NOT NULL CHECK(landed_unit_paisa >= 0),
      discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0),
      line_total_paisa INTEGER NOT NULL CHECK(line_total_paisa >= 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      product_id TEXT NOT NULL,
      movement_date TEXT NOT NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN ('opening','purchase','sale','sale_return','purchase_return','adjustment_in','adjustment_out','damage','transfer_in','transfer_out')),
      source_table TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      qty_delta_milli INTEGER NOT NULL CHECK(qty_delta_milli <> 0),
      unit_cost_paisa INTEGER NOT NULL DEFAULT 0 CHECK(unit_cost_paisa >= 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stock_levels (
      shop_id TEXT NOT NULL DEFAULT 'default',
      product_id TEXT NOT NULL,
      qty_milli INTEGER NOT NULL DEFAULT 0,
      value_paisa INTEGER NOT NULL DEFAULT 0 CHECK(value_paisa >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, product_id),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS customer_credits (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      customer_id TEXT NOT NULL,
      sale_id TEXT,
      credit_date TEXT NOT NULL,
      total_paisa INTEGER NOT NULL CHECK(total_paisa > 0),
      initial_paid_paisa INTEGER NOT NULL DEFAULT 0 CHECK(initial_paid_paisa >= 0),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','void')),
      created_at TEXT NOT NULL,
      CHECK(initial_paid_paisa <= total_paisa),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS customer_payments (
      id TEXT PRIMARY KEY NOT NULL,
      credit_id TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      amount_paisa INTEGER NOT NULL CHECK(amount_paisa <> 0),
      method TEXT NOT NULL DEFAULT 'cash',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (credit_id) REFERENCES customer_credits(id) ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS supplier_credits_erp (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      supplier_id TEXT NOT NULL,
      purchase_id TEXT,
      credit_date TEXT NOT NULL,
      total_paisa INTEGER NOT NULL CHECK(total_paisa > 0),
      initial_paid_paisa INTEGER NOT NULL DEFAULT 0 CHECK(initial_paid_paisa >= 0),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','void')),
      created_at TEXT NOT NULL,
      CHECK(initial_paid_paisa <= total_paisa),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE SET NULL ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS supplier_payments_erp (
      id TEXT PRIMARY KEY NOT NULL,
      credit_id TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      amount_paisa INTEGER NOT NULL CHECK(amount_paisa <> 0),
      method TEXT NOT NULL DEFAULT 'cash',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (credit_id) REFERENCES supplier_credits_erp(id) ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cash_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cash' CHECK(type IN ('cash','bank','mobile_money','owner')),
      opening_balance_paisa INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, name),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cash_ledger (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL DEFAULT 'default',
      account_id TEXT,
      entry_date TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      amount_paisa INTEGER NOT NULL CHECK(amount_paisa > 0),
      source_table TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (account_id) REFERENCES cash_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE
    );

    CREATE INDEX IF NOT EXISTS ix_sales_shop_date ON sales(shop_id, sale_date);
    CREATE INDEX IF NOT EXISTS ix_sale_items_sale ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS ix_purchases_shop_date ON purchases(shop_id, purchase_date);
    CREATE INDEX IF NOT EXISTS ix_inventory_product_date ON inventory_movements(shop_id, product_id, movement_date);
    CREATE INDEX IF NOT EXISTS ix_cash_ledger_shop_date ON cash_ledger(shop_id, entry_date);

    DROP TRIGGER IF EXISTS tr_erp_inventory_no_negative_ins;
    CREATE TRIGGER IF NOT EXISTS tr_erp_inventory_no_negative_ins
    BEFORE INSERT ON inventory_movements
    FOR EACH ROW
    WHEN COALESCE((SELECT value FROM meta WHERE key='__sync_mode'),'normal') <> 'force'
      AND NEW.qty_delta_milli < 0
      AND COALESCE((SELECT qty_milli FROM stock_levels WHERE shop_id = NEW.shop_id AND product_id = NEW.product_id), 0) + NEW.qty_delta_milli < 0
    BEGIN
      SELECT RAISE(ABORT, 'Inventory movement would make stock negative');
    END;

    CREATE TRIGGER IF NOT EXISTS tr_erp_inventory_apply_ins
    AFTER INSERT ON inventory_movements
    FOR EACH ROW
    BEGIN
      INSERT INTO stock_levels (shop_id, product_id, qty_milli, value_paisa, updated_at)
      VALUES (
        NEW.shop_id,
        NEW.product_id,
        NEW.qty_delta_milli,
        CASE WHEN NEW.qty_delta_milli > 0 THEN (NEW.qty_delta_milli * NEW.unit_cost_paisa) / 1000 ELSE 0 END,
        NEW.created_at
      )
      ON CONFLICT(shop_id, product_id) DO UPDATE SET
        qty_milli = qty_milli + NEW.qty_delta_milli,
        value_paisa = CASE
          WHEN NEW.qty_delta_milli > 0 THEN value_paisa + ((NEW.qty_delta_milli * NEW.unit_cost_paisa) / 1000)
          ELSE MAX(0, value_paisa - ((ABS(NEW.qty_delta_milli) * COALESCE(NEW.unit_cost_paisa, 0)) / 1000))
        END,
        updated_at = NEW.created_at;
    END;

    CREATE TRIGGER IF NOT EXISTS tr_erp_customer_payments_no_overpay_ins
    BEFORE INSERT ON customer_payments
    FOR EACH ROW
    WHEN (
      COALESCE((SELECT SUM(amount_paisa) FROM customer_payments WHERE credit_id = NEW.credit_id), 0)
      + NEW.amount_paisa
    ) > (
      SELECT total_paisa - initial_paid_paisa FROM customer_credits WHERE id = NEW.credit_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Customer payment exceeds due');
    END;

    CREATE TRIGGER IF NOT EXISTS tr_erp_supplier_payments_no_overpay_ins
    BEFORE INSERT ON supplier_payments_erp
    FOR EACH ROW
    WHEN (
      COALESCE((SELECT SUM(amount_paisa) FROM supplier_payments_erp WHERE credit_id = NEW.credit_id), 0)
      + NEW.amount_paisa
    ) > (
      SELECT total_paisa - initial_paid_paisa FROM supplier_credits_erp WHERE id = NEW.credit_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Supplier payment exceeds due');
    END;

    CREATE VIEW IF NOT EXISTS v_stock_on_hand AS
    SELECT sl.shop_id, sl.product_id, p.name AS product_name, sl.qty_milli, sl.qty_milli / 1000.0 AS qty,
           sl.value_paisa, sl.value_paisa / 100.0 AS stock_value
    FROM stock_levels sl
    JOIN products p ON p.id = sl.product_id;

    CREATE VIEW IF NOT EXISTS v_customer_due AS
    SELECT cc.shop_id, cc.customer_id, c.name AS customer_name, c.phone AS customer_phone,
           SUM(cc.total_paisa - cc.initial_paid_paisa - COALESCE(pay.paid_paisa, 0)) AS due_paisa
    FROM customer_credits cc
    JOIN customers c ON c.id = cc.customer_id
    LEFT JOIN (
      SELECT credit_id, SUM(amount_paisa) AS paid_paisa
      FROM customer_payments
      GROUP BY credit_id
    ) pay ON pay.credit_id = cc.id
    WHERE cc.status = 'open'
    GROUP BY cc.shop_id, cc.customer_id;

    CREATE VIEW IF NOT EXISTS v_supplier_due AS
    SELECT sc.shop_id, sc.supplier_id, s.name AS supplier_name, s.phone AS supplier_phone,
           SUM(sc.total_paisa - sc.initial_paid_paisa - COALESCE(pay.paid_paisa, 0)) AS due_paisa
    FROM supplier_credits_erp sc
    JOIN suppliers s ON s.id = sc.supplier_id
    LEFT JOIN (
      SELECT credit_id, SUM(amount_paisa) AS paid_paisa
      FROM supplier_payments_erp
      GROUP BY credit_id
    ) pay ON pay.credit_id = sc.id
    WHERE sc.status = 'open'
    GROUP BY sc.shop_id, sc.supplier_id;
  `;

  function loadBytes() {
    return new Promise((resolve) => {
      try {
        if (typeof db === 'undefined' || !db) return resolve(null);
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => {
          const row = req.result;
          const val = row && row.value;
          resolve(val instanceof Uint8Array ? val : (val ? new Uint8Array(val) : null));
        };
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  function saveBytes(bytes) {
    return new Promise((resolve) => {
      try {
        if (typeof db === 'undefined' || !db) return resolve(false);
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ key: IDB_KEY, value: bytes });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (_) { resolve(false); }
    });
  }

  function enableForeignKeys() {
    if (!sdb) return;
    sdb.run('PRAGMA foreign_keys = ON');
  }

  // Real SQLite user-defined functions, used by the strict-validation triggers.
  // Must be re-registered on every sdb we open (they're runtime, not stored in
  // the DB file — only the triggers that call them are persisted).
  function registerFunctions() {
    if (!sdb || typeof sdb.create_function !== 'function') return;
    try {
      // 1 if the text parses as JSON, else 0. Guarantees the `json` column can
      // never hold a malformed blob via a live write.
      sdb.create_function('kosh_json_ok', function (s) {
        if (s === null || s === undefined) return 0;
        try { JSON.parse(String(s)); return 1; } catch (_) { return 0; }
      });
      // 1 if the text starts with an ISO date (YYYY-MM-DD), else 0. Matches both
      // 'YYYY-MM-DD' and full 'YYYY-MM-DDTHH:MM:SS' timestamps the app writes.
      sdb.create_function('kosh_is_date', function (s) {
        return /^\d{4}-\d{2}-\d{2}/.test(String(s === null || s === undefined ? '' : s)) ? 1 : 0;
      });
    } catch (e) {
      console.warn('[KoshDB] create_function failed:', e);
    }
  }

  // sql.js export() closes/reopens the underlying connection, which DROPS all
  // runtime-registered UDFs — so the strict triggers would fail with
  // "no such function" on the next write. Always re-register after exporting.
  function exportBytes() {
    const bytes = sdb.export();
    registerFunctions();
    return bytes;
  }

  // Per-table strict-validation triggers (BEFORE INSERT + BEFORE UPDATE).
  // Built in JS to stay DRY. Each rejects a write whose row violates an
  // invariant the column CHECKs can't express. Bypassed during force/bulk
  // sync (import, migration, autoRepair) via meta '__sync_mode' so a restore
  // is never blocked — checkIntegrity() reports such rows instead.
  function buildStrictTriggerDDL() {
    const guard = "COALESCE((SELECT value FROM meta WHERE key='__sync_mode'),'normal') <> 'force'";
    const jsonRule = (t) => ['kosh_json_ok(NEW.json)=0', t + ': invalid JSON'];
    const dateRule = (t) => ['kosh_is_date(NEW.date)=0', t + ': invalid/empty date'];
    const specs = {
      products:          [jsonRule('products')],
      transactions:      [jsonRule('transactions'), dateRule('transactions')],
      credits:           [jsonRule('credits'), dateRule('credits')],
      payments:          [jsonRule('payments'), dateRule('payments')],
      supplier_credits:  [jsonRule('supplier_credits'), dateRule('supplier_credits')],
      supplier_payments: [jsonRule('supplier_payments'), dateRule('supplier_payments')],
      loan_payments:     [jsonRule('loan_payments'), dateRule('loan_payments')],
      cash_withdrawals:  [jsonRule('cash_withdrawals'), dateRule('cash_withdrawals')],
      extra_expenses:    [jsonRule('extra_expenses'), dateRule('extra_expenses')],
      audit_trail:       [jsonRule('audit_trail')]
    };
    let ddl = '';
    for (const table of Object.keys(specs)) {
      const cases = specs[table]
        .map(([cond, msg]) => `WHEN ${cond} THEN RAISE(ABORT, '${msg}')`)
        .join('\n          ');
      for (const op of ['INSERT', 'UPDATE']) {
        const name = `tr_${table}_strict_${op === 'INSERT' ? 'ins' : 'upd'}`;
        ddl += `
    CREATE TRIGGER IF NOT EXISTS ${name}
    BEFORE ${op} ON ${table}
    FOR EACH ROW
    WHEN ${guard}
    BEGIN
      SELECT CASE
          ${cases}
      END;
    END;`;
      }
    }
    return ddl;
  }

  function metaGet(key) {
    try {
      const stmt = sdb.prepare('SELECT value FROM meta WHERE key = ?');
      stmt.bind([key]);
      const val = stmt.step() ? stmt.getAsObject().value : null;
      stmt.free();
      return val;
    } catch (_) { return null; }
  }

  function metaSet(key, value) {
    sdb.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)]);
  }

  function ensureRelationalSchema() {
    enableForeignKeys();
    registerFunctions();
    sdb.exec(RELATIONAL_DDL);
    sdb.exec(ERP_DDL);
    sdb.exec(buildStrictTriggerDDL());
    seedSystemProduct();
    metaSet('schemaVersion', SCHEMA_VERSION);
  }

  function seedSystemProduct() {
    sdb.run(
      `INSERT OR IGNORE INTO products (id, name, unit, category, json) VALUES (?, ?, ?, ?, ?)`,
      ['__CAPITAL__', 'Capital Adjustment', '', 'System', JSON.stringify({ id: '__CAPITAL__', name: 'Capital Adjustment', unit: '', category: 'System' })]
    );
  }

  function num(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function str(v) {
    if (v === undefined || v === null) return null;
    return String(v);
  }

  function J(o) {
    return JSON.stringify(o);
  }

  // --- BD phone identity ------------------------------------------------------
  // Canonicalize any input to a BD mobile number: 11 digits, 01[3-9]XXXXXXXX.
  // Handles +880 / 880 / 00880 prefixes, a missing leading 0, Bengali digits,
  // and stray spaces/dashes/parens. Returns '' when it cannot be canonicalized.
  const BN_DIGITS = { '০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9' };
  function normalizeBdPhone(raw) {
    if (raw === undefined || raw === null) return '';
    let s = String(raw).replace(/[০-৯]/g, d => BN_DIGITS[d] || d); // Bengali → ASCII
    s = s.replace(/[^\d+]/g, '');       // strip spaces, dashes, parens, etc.
    s = s.replace(/^\+/, '');           // drop leading +
    s = s.replace(/^00/, '');           // drop international 00 prefix
    s = s.replace(/^880/, '0');         // country code 880 → local 0
    if (/^1[3-9]\d{8}$/.test(s)) s = '0' + s; // 10-digit form missing leading 0
    return s;
  }
  // A canonical BD mobile number: 11 digits, starts 013–019.
  function isValidBdPhone(canonical) {
    return /^01[3-9]\d{8}$/.test(canonical);
  }
  // party_phone value for a credit/supplier_credit row: canonical phone if valid,
  // else null (row is kept but stays unlinked — flagged by checkIntegrity).
  function partyPhoneOf(rawPhone) {
    const p = normalizeBdPhone(rawPhone);
    return isValidBdPhone(p) ? p : null;
  }

  // Derive the normalized party master from credits + supplier_credits. Phone is
  // the identity: rows sharing a canonical phone collapse to one party (canonical
  // name = most frequent spelling, ties → longest). Rows without a valid BD phone
  // contribute no party. type is 'customer' | 'supplier' | 'both'.
  function buildPartyRows(d) {
    const map = new Map(); // phone -> { phone, nameCounts:Map, types:Set }
    const add = (rawName, rawPhone, type) => {
      const phone = normalizeBdPhone(rawPhone);
      if (!isValidBdPhone(phone)) return;
      const name = String(rawName === undefined || rawName === null ? '' : rawName).trim() || 'Unknown';
      let e = map.get(phone);
      if (!e) { e = { phone, nameCounts: new Map(), types: new Set() }; map.set(phone, e); }
      e.nameCounts.set(name, (e.nameCounts.get(name) || 0) + 1);
      e.types.add(type);
    };
    for (const c of (d.credits || [])) add(c.customerName, c.customerPhone, 'customer');
    for (const sc of (d.supplierCredits || [])) add(sc.supplierName, sc.supplierPhone, 'supplier');
    const rows = [];
    for (const e of map.values()) {
      let bestName = 'Unknown', bestCount = -1;
      for (const [nm, cnt] of e.nameCounts) {
        if (cnt > bestCount || (cnt === bestCount && nm.length > bestName.length)) { bestName = nm; bestCount = cnt; }
      }
      const type = e.types.has('customer') && e.types.has('supplier')
        ? 'both' : (e.types.has('customer') ? 'customer' : 'supplier');
      rows.push({ phone: e.phone, name: bestName, type, json: J({ phone: e.phone, name: bestName, type }) });
    }
    return rows;
  }

  // Typed unit-conversion columns for a transaction row → [entry_unit, entry_qty,
  // entry_factor, base_unit]. Sanitized so the hard CHECK(entry_factor > 0) can
  // never block an import; any qty ≈ entry_qty × entry_factor mismatch is surfaced
  // by checkIntegrity instead. base_unit is derived when the row JSON omits it
  // (single-entry saves store entryUnit/Factor/Qty but not baseUnit).
  function txUnitCols(t) {
    const ef = num(t.entryFactor);
    const entryFactor = (ef && ef > 0) ? ef : 1;
    const eq = num(t.entryQty);
    const entryQty = (eq && eq > 0) ? eq : null;
    const entryUnit = str(t.entryUnit) || '';
    const baseUnit = str(t.baseUnit) || (entryFactor === 1 ? entryUnit : '');
    return [entryUnit, entryQty, entryFactor, baseUnit];
  }

  function toPaisa(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }

  function toMilli(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n * 1000)) : 0;
  }

  function ymd(v) {
    const s = String(v || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
  }

  function localDateOf(row) {
    return ymd(row && row.date);
  }

  function stableKey(raw, prefix) {
    const s = String(raw || prefix || 'row').trim() || prefix || 'row';
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return String(prefix || 'id') + ':' + h.toString(16);
  }

  function linePriceAndDiscount(totalPaisa, qtyMilli) {
    const q = Math.max(1, Number(qtyMilli) || 1);
    const total = Math.max(0, Number(totalPaisa) || 0);
    const unit = Math.ceil((total * 1000) / q);
    const gross = Math.floor((q * unit) / 1000);
    return { unit, discount: Math.max(0, gross - total) };
  }

  function billKeyFor(tx, fallbackPrefix) {
    return String(tx.billId || tx.sourceBillId || tx.returnGroupId || tx.linkedTxId || tx.id || stableKey(JSON.stringify(tx), fallbackPrefix));
  }

  function groupRows(rows, keyFn) {
    const m = new Map();
    for (const row of rows || []) {
      const key = keyFn(row);
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(row);
    }
    return m;
  }

  const ERP_CLEAR_ORDER = [
    'cash_ledger',
    'customer_payments', 'supplier_payments_erp',
    'customer_credits', 'supplier_credits_erp',
    'sale_items', 'purchase_items',
    'sales', 'purchases',
    'inventory_movements', 'stock_levels',
    'customers', 'suppliers'
  ];

  function clearNormalizedErpTables() {
    for (const table of ERP_CLEAR_ORDER) sdb.run('DELETE FROM ' + table);
  }

  function upsertPerson(table, id, name, phone, nowIso) {
    const stmt = table === 'customers'
      ? sdb.prepare(`INSERT INTO customers (id, shop_id, name, phone, address, active, created_at, updated_at)
          VALUES (?, 'default', ?, ?, '', 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, active=1, updated_at=excluded.updated_at`)
      : sdb.prepare(`INSERT INTO suppliers (id, shop_id, name, phone, address, active, created_at, updated_at)
          VALUES (?, 'default', ?, ?, '', 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, active=1, updated_at=excluded.updated_at`);
    stmt.run([id, String(name || 'Unknown').trim() || 'Unknown', String(phone || ''), nowIso, nowIso]);
    stmt.free();
    return id;
  }

  function rebuildNormalizedErpTables(d) {
    const nowIso = new Date().toISOString();
    clearNormalizedErpTables();
    sdb.run(`INSERT OR IGNORE INTO cash_accounts (id, shop_id, name, type, opening_balance_paisa, active, created_at, updated_at)
      VALUES ('cash:main', 'default', 'Cash', 'cash', 0, 1, ?, ?)`, [nowIso, nowIso]);

    const customerIds = new Map();
    const supplierIds = new Map();
    const getCustomerId = (name, phone) => {
      const p = normalizeBdPhone(phone);
      const key = p || stableKey(name || 'cash-customer', 'customer');
      if (!customerIds.has(key)) {
        customerIds.set(key, 'cust:' + key.replace(/[^a-zA-Z0-9:_-]/g, ''));
        upsertPerson('customers', customerIds.get(key), name || 'Cash Customer', p || ('no-phone-' + customerIds.size), nowIso);
      }
      return customerIds.get(key);
    };
    const getSupplierId = (name, phone) => {
      const p = normalizeBdPhone(phone);
      const key = p || stableKey(name || 'cash-supplier', 'supplier');
      if (!supplierIds.has(key)) {
        supplierIds.set(key, 'supp:' + key.replace(/[^a-zA-Z0-9:_-]/g, ''));
        upsertPerson('suppliers', supplierIds.get(key), name || 'Cash Supplier', p || ('no-phone-' + supplierIds.size), nowIso);
      }
      return supplierIds.get(key);
    };

    const saleByBill = groupRows((d.transactions || []).filter(t => t.type === 'sale'), t => billKeyFor(t, 'sale'));
    const saleIns = sdb.prepare(`INSERT INTO sales
      (id, shop_id, invoice_no, customer_id, sale_date, gross_paisa, discount_paisa, net_paisa, cash_paid_paisa, status, notes, source_ref, created_at, updated_at)
      VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, 'posted', '', ?, ?, ?)`);
    const saleItemIns = sdb.prepare(`INSERT INTO sale_items
      (id, sale_id, product_id, unit_name, qty_milli, unit_price_paisa, discount_paisa, line_total_paisa, cogs_unit_paisa, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [key, rows] of saleByBill) {
      const first = rows[0] || {};
      const saleId = 'sale:' + key;
      const gross = rows.reduce((s, t) => s + toPaisa(Number(t.grossAmount) || Number(t.total) || 0), 0);
      const net = rows.reduce((s, t) => s + toPaisa(t.total), 0);
      const cash = rows.reduce((s, t) => s + toPaisa(t.cashPaid !== undefined ? t.cashPaid : t.total), 0);
      const custId = getCustomerId(first.customer || 'Cash Customer', first.customerPhone || '');
      saleIns.run([saleId, String(first.billId || key), custId, ymd(first.date), Math.max(gross, net), Math.max(0, Math.max(gross, net) - net), net, Math.min(cash, net), key, nowIso, nowIso]);
      rows.forEach((t, idx) => {
        const qtyM = Math.max(1, toMilli(t.qty));
        const totalP = toPaisa(t.total);
        const pd = linePriceAndDiscount(totalP, qtyM);
        saleItemIns.run([saleId + ':item:' + idx + ':' + t.id, saleId, String(t.productId), String(t.entryUnit || t.unit || ''), qtyM, pd.unit, pd.discount, totalP, toPaisa(t.cost), nowIso]);
      });
    }
    saleIns.free();
    saleItemIns.free();

    const purchByBill = groupRows((d.transactions || []).filter(t => t.type === 'purchase' && !t.opening), t => billKeyFor(t, 'purchase'));
    const purchIns = sdb.prepare(`INSERT INTO purchases
      (id, shop_id, bill_no, supplier_id, purchase_date, gross_paisa, discount_paisa, extra_cost_paisa, net_paisa, cash_paid_paisa, status, notes, source_ref, created_at, updated_at)
      VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, 'posted', '', ?, ?, ?)`);
    const purchItemIns = sdb.prepare(`INSERT INTO purchase_items
      (id, purchase_id, product_id, unit_name, qty_milli, list_unit_paisa, net_unit_paisa, landed_unit_paisa, discount_paisa, line_total_paisa, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [key, rows] of purchByBill) {
      const first = rows[0] || {};
      const purchaseId = 'purchase:' + key;
      const gross = rows.reduce((s, t) => s + toPaisa(Number(t.grossAmount) || Number(t.total) || 0), 0);
      const net = rows.reduce((s, t) => s + toPaisa(t.total), 0);
      const extra = rows.reduce((s, t) => s + toPaisa(t.lineExtraCost), 0);
      const cash = rows.reduce((s, t) => s + toPaisa(t.cashPaid !== undefined ? t.cashPaid : t.total), 0);
      const supplierId = getSupplierId(first.supplier || 'Cash Supplier', first.supplierPhone || '');
      purchIns.run([purchaseId, String(first.billId || key), supplierId, ymd(first.date), Math.max(gross, net), Math.max(0, Math.max(gross, net) - net), extra, net, Math.min(cash, net), key, nowIso, nowIso]);
      rows.forEach((t, idx) => {
        const qtyM = Math.max(1, toMilli(t.qty));
        const totalP = toPaisa(t.total);
        const grossP = toPaisa(Number(t.grossAmount) || Number(t.total) || 0);
        const netUnit = linePriceAndDiscount(totalP, qtyM).unit;
        const listUnit = linePriceAndDiscount(Math.max(grossP, totalP), qtyM).unit;
        const landedUnit = linePriceAndDiscount(totalP + toPaisa(t.lineExtraCost), qtyM).unit;
        purchItemIns.run([purchaseId + ':item:' + idx + ':' + t.id, purchaseId, String(t.productId), String(t.entryUnit || t.unit || ''), qtyM, listUnit, netUnit, landedUnit, Math.max(0, grossP - totalP), totalP, nowIso]);
      });
    }
    purchIns.free();
    purchItemIns.free();

    const movIns = sdb.prepare(`INSERT INTO inventory_movements
      (id, shop_id, product_id, movement_date, movement_type, source_table, source_id, qty_delta_milli, unit_cost_paisa, created_at)
      VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?)`);
    const sortedTx = sortTransactionsForInsert(d.transactions || []);
    sortedTx.forEach((t, idx) => {
      if (!t.productId || t.productId === '__CAPITAL__') return;
      const qtyM = Math.max(1, toMilli(t.qty));
      let type = '', delta = 0;
      if (t.type === 'purchase') { type = t.opening ? 'opening' : 'purchase'; delta = qtyM; }
      else if (t.type === 'sale') { type = 'sale'; delta = -qtyM; }
      else if (t.type === 'return' && t.returnType === 'purchase-return') { type = 'purchase_return'; delta = -qtyM; }
      else if (t.type === 'return') { type = 'sale_return'; delta = qtyM; }
      else if (t.type === 'adjustment') {
        const adj = String(t.adjustmentType || '').toLowerCase();
        type = adj.includes('damage') || adj.includes('loss') ? 'damage' : (Number(t.qty) < 0 ? 'adjustment_out' : 'adjustment_in');
        delta = adj.includes('out') || adj.includes('damage') || adj.includes('loss') ? -qtyM : qtyM;
      }
      if (!type || !delta) return;
      movIns.run(['mov:' + idx + ':' + t.id, String(t.productId), ymd(t.date), type, 'transactions', String(t.id), delta, toPaisa(t.cost || t.price || 0), nowIso]);
    });
    movIns.free();

    const custCreditIns = sdb.prepare(`INSERT INTO customer_credits
      (id, shop_id, customer_id, sale_id, credit_date, total_paisa, initial_paid_paisa, status, created_at)
      VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of (d.credits || [])) {
      const customerId = getCustomerId(c.customerName || 'Unknown Customer', c.customerPhone || '');
      const totalP = toPaisa(c.total);
      if (totalP <= 0) continue;
      custCreditIns.run([String(c.id), customerId, c.billId ? 'sale:' + c.billId : (c.txId ? 'sale:' + c.txId : null), ymd(c.date), totalP, Math.min(toPaisa(c.paid), totalP), 'open', nowIso]);
    }
    custCreditIns.free();

    const custPayIns = sdb.prepare(`INSERT INTO customer_payments (id, credit_id, payment_date, amount_paisa, method, note, created_at)
      VALUES (?, ?, ?, ?, 'cash', ?, ?)`);
    for (const p of (d.payments || [])) {
      const amt = toPaisa(p.amount);
      if (!p.creditId || !amt) continue;
      custPayIns.run([String(p.id), String(p.creditId), ymd(p.date), amt, String(p.note || ''), nowIso]);
    }
    custPayIns.free();

    const suppCreditIns = sdb.prepare(`INSERT INTO supplier_credits_erp
      (id, shop_id, supplier_id, purchase_id, credit_date, total_paisa, initial_paid_paisa, status, created_at)
      VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)`);
    for (const sc of (d.supplierCredits || [])) {
      const supplierId = getSupplierId(sc.supplierName || 'Unknown Supplier', sc.supplierPhone || '');
      const totalP = toPaisa(sc.total);
      if (totalP <= 0) continue;
      suppCreditIns.run([String(sc.id), supplierId, sc.billId ? 'purchase:' + sc.billId : (sc.txId ? 'purchase:' + sc.txId : null), ymd(sc.date), totalP, Math.min(toPaisa(sc.paid), totalP), 'open', nowIso]);
    }
    suppCreditIns.free();

    const suppPayIns = sdb.prepare(`INSERT INTO supplier_payments_erp (id, credit_id, payment_date, amount_paisa, method, note, created_at)
      VALUES (?, ?, ?, ?, 'cash', ?, ?)`);
    for (const sp of (d.supplierPayments || [])) {
      const amt = toPaisa(sp.amount);
      if (!sp.scId || !amt) continue;
      suppPayIns.run([String(sp.id), String(sp.scId), ymd(sp.date), amt, String(sp.note || ''), nowIso]);
    }
    suppPayIns.free();

    const cashIns = sdb.prepare(`INSERT INTO cash_ledger
      (id, shop_id, account_id, entry_date, direction, amount_paisa, source_table, source_id, note, created_at)
      VALUES (?, 'default', 'cash:main', ?, ?, ?, ?, ?, ?, ?)`);
    const addCash = (id, date, direction, amount, sourceTable, sourceId, note) => {
      const amt = toPaisa(amount);
      if (amt <= 0) return;
      cashIns.run([id, ymd(date), direction, amt, sourceTable, String(sourceId || ''), String(note || ''), nowIso]);
    };
    (d.transactions || []).forEach(t => {
      if (t.type === 'sale') addCash('cash:tx:' + t.id, t.date, 'in', t.cashPaid !== undefined ? t.cashPaid : t.total, 'transactions', t.id, 'sale cash');
      else if (t.type === 'purchase') addCash('cash:tx:' + t.id, t.date, 'out', (Number(t.cashPaid !== undefined ? t.cashPaid : t.total) || 0) + (Number(t.lineExtraCost) || 0), 'transactions', t.id, 'purchase cash');
      else if (t.type === 'return' && t.returnType === 'purchase-return') addCash('cash:tx:' + t.id, t.date, 'in', t.cashPaid !== undefined ? t.cashPaid : t.total, 'transactions', t.id, 'purchase return');
      else if (t.type === 'return') addCash('cash:tx:' + t.id, t.date, 'out', t.cashPaid !== undefined ? t.cashPaid : t.total, 'transactions', t.id, 'sale return');
      else if (t.type === 'capital-in') addCash('cash:tx:' + t.id, t.date, 'in', t.total || t.cashPaid, 'transactions', t.id, 'capital in');
      else if (t.type === 'capital-out') addCash('cash:tx:' + t.id, t.date, 'out', t.total || t.cashPaid, 'transactions', t.id, 'capital out');
    });
    (d.payments || []).forEach(p => addCash('cash:pay:' + p.id, p.date, 'in', p.amount, 'payments', p.id, 'customer payment'));
    (d.supplierPayments || []).forEach(sp => addCash('cash:suppay:' + sp.id, sp.date, 'out', sp.amount, 'supplier_payments', sp.id, 'supplier payment'));
    (d.loanPayments || []).forEach(lp => addCash('cash:loanpay:' + lp.id, lp.date, 'out', lp.amount, 'loan_payments', lp.id, 'loan repayment'));
    (d.extraExpenses || []).forEach(e => addCash('cash:expense:' + e.id, e.date, 'out', e.amount, 'extra_expenses', e.id, e.note || 'extra expense'));
    (d.cashWithdrawals || []).forEach(w => addCash('cash:withdraw:' + w.id, w.date, 'out', w.amount, 'cash_withdrawals', w.id, w.reason || 'withdrawal'));
    cashIns.free();
  }

  function scalar(sql, params) {
    try {
      const stmt = sdb.prepare(sql);
      if (params) stmt.bind(params);
      const val = stmt.step() ? stmt.get()[0] : 0;
      stmt.free();
      return Number(val) || 0;
    } catch (_) { return 0; }
  }

  function rowsJson(table) {
    const out = [];
    const res = sdb.exec('SELECT json FROM ' + table);
    if (res[0]) {
      for (const r of res[0].values) {
        try { out.push(JSON.parse(r[0])); } catch (_) {}
      }
    }
    return out;
  }

  function fullDataSignature(d) {
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
    const arr = (rows) => { const a = rows || []; feed(a.length); for (const r of a) feed(JSON.stringify(r)); };
    arr(d.products);
    arr(d.transactions);
    arr(d.credits);
    arr(d.payments);
    arr(d.supplierCredits);
    arr(d.supplierPayments);
    arr(d.cashWithdrawals);
    arr(d.extraExpenses);
    arr(d.auditTrail);
    arr(d.units);
    feed(JSON.stringify(d.openingCashByDate || {}));
    feed(JSON.stringify({
      shopName: d.shopName,
      shopAddress: d.shopAddress,
      shopMobile: d.shopMobile,
      closedMonths: d.closedMonths || {}
    }));
    return (h1 >>> 0).toString(16) + ':' + (h2 >>> 0).toString(16);
  }

  function sortTransactionsForInsert(txs) {
    return [...(txs || [])].sort((a, b) => {
      const aRet = a && a.type === 'return' ? 1 : 0;
      const bRet = b && b.type === 'return' ? 1 : 0;
      if (aRet !== bRet) return aRet - bRet;
      const da = new Date(a?.date || 0).getTime();
      const db = new Date(b?.date || 0).getTime();
      if (da !== db) return da - db;
      return (Number(a?.id) || 0) - (Number(b?.id) || 0);
    });
  }

  // --- Incremental diff-sync config ------------------------------------------
  // The old strategy DELETE'd every table and re-INSERTed all rows on every
  // save, so the DB blindly mirrored in-memory `data` — a partial/corrupted
  // in-memory state would silently wipe the persisted DB down to it. We now
  // apply only the rows that actually changed (INSERT / UPSERT / DELETE) and
  // REFUSE a non-forced save that would delete a large share of an established
  // table, so accidental data loss can't cascade into persistence.
  const GUARD_MIN_EXISTING = 10;      // only guard tables that actually hold data
  const GUARD_DELETE_FRACTION = 0.5;  // refuse if >50% of such a table would vanish
  const GUARDED_TABLES = new Set([
    'transactions', 'products', 'credits', 'payments',
    'supplier_credits', 'supplier_payments', 'loan_payments', 'cash_withdrawals', 'extra_expenses'
  ]);
  // Deletes run child-first so FK RESTRICT / delete-protection triggers don't
  // abort on a parent whose children are being removed in the same save.
  const DELETE_ORDER = [
    'payments', 'supplier_payments', 'loan_payments', 'transactions', 'audit_trail',
    'cash_withdrawals', 'extra_expenses', 'credits', 'supplier_credits', 'products'
  ];

  function readJsonMap(table) {
    const m = new Map();
    try {
      const res = sdb.exec('SELECT id, json FROM ' + table);
      if (res[0]) for (const r of res[0].values) m.set(String(r[0]), r[1]);
    } catch (_) {}
    return m;
  }

  // Real products plus stub rows for any productId referenced by a transaction
  // but missing from data (keeps the transactions FK satisfiable).
  function buildProductRows(d) {
    const real = [...(d.products || [])].filter(p => p && str(p.id) !== '__CAPITAL__');
    const ids = new Set(real.map(p => str(p.id)));
    ids.add('__CAPITAL__');
    const stubs = [];
    const seen = new Set();
    for (const t of (d.transactions || [])) {
      const pid = str(t.productId);
      if (!pid || ids.has(pid) || seen.has(pid)) continue;
      seen.add(pid);
      stubs.push({ id: pid, name: 'Unknown Product', unit: '', category: 'Uncategorized' });
    }
    return real.concat(stubs);
  }

  // One spec per surrogate-id JSON table, in parent→child order (upsert order).
  function jsonTableSpecs(d) {
    return [
      {
        table: 'products',
        rows: buildProductRows(d),
        keepIds: ['__CAPITAL__'],
        idOf: p => str(p.id),
        jsonOf: p => J(p),
        upsertSql: `INSERT INTO products (id, name, unit, category, json) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, unit=excluded.unit, category=excluded.category, json=excluded.json`,
        paramsOf: (p, j) => [str(p.id), str(p.name) || 'Unknown', str(p.unit) || '', str(p.category) || '', j]
      },
      {
        table: 'transactions',
        rows: sortTransactionsForInsert(d.transactions),
        idOf: t => str(t.id),
        jsonOf: t => J(t),
        upsertSql: `INSERT INTO transactions
            (id, type, date, local_date, productId, qty, price, cost, total, cashPaid, returnType, linkedTxId, opening, adjustmentType, entry_unit, entry_qty, entry_factor, base_unit, json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            type=excluded.type, date=excluded.date, local_date=excluded.local_date, productId=excluded.productId, qty=excluded.qty,
            price=excluded.price, cost=excluded.cost, total=excluded.total, cashPaid=excluded.cashPaid,
            returnType=excluded.returnType, linkedTxId=excluded.linkedTxId, opening=excluded.opening,
            adjustmentType=excluded.adjustmentType, entry_unit=excluded.entry_unit, entry_qty=excluded.entry_qty,
            entry_factor=excluded.entry_factor, base_unit=excluded.base_unit, json=excluded.json`,
        paramsOf: (t, j) => [
          str(t.id), str(t.type), str(t.date), localDateOf(t), str(t.productId),
          num(t.qty), num(t.price), num(t.cost), num(t.total), num(t.cashPaid),
          str(t.returnType),
          (t.linkedTxId !== undefined && t.linkedTxId !== null && String(t.linkedTxId) !== '') ? str(t.linkedTxId) : null,
          t.opening ? 1 : 0, str(t.adjustmentType), ...txUnitCols(t), j
        ]
      },
      {
        table: 'credits',
        rows: d.credits || [],
        idOf: c => str(c.id),
        jsonOf: c => J(c),
        upsertSql: `INSERT INTO credits (id, date, local_date, customerName, customerPhone, total, paid, party_phone, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET date=excluded.date, local_date=excluded.local_date, customerName=excluded.customerName,
            customerPhone=excluded.customerPhone, total=excluded.total, paid=excluded.paid,
            party_phone=excluded.party_phone, json=excluded.json`,
        paramsOf: (c, j) => [str(c.id), str(c.date), localDateOf(c), str(c.customerName) || 'Unknown Customer', str(c.customerPhone) || '', num(c.total), num(c.paid) || 0, partyPhoneOf(c.customerPhone), j]
      },
      {
        table: 'payments',
        rows: d.payments || [],
        idOf: p => str(p.id),
        jsonOf: p => J(p),
        upsertSql: `INSERT INTO payments (id, creditId, date, local_date, amount, json) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET creditId=excluded.creditId, date=excluded.date, local_date=excluded.local_date, amount=excluded.amount, json=excluded.json`,
        paramsOf: (p, j) => [str(p.id), str(p.creditId), str(p.date), localDateOf(p), num(p.amount), j]
      },
      {
        table: 'supplier_credits',
        rows: d.supplierCredits || [],
        idOf: sc => str(sc.id),
        jsonOf: sc => J(sc),
        upsertSql: `INSERT INTO supplier_credits (id, date, local_date, supplierName, supplierPhone, total, paid, party_phone, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET date=excluded.date, local_date=excluded.local_date, supplierName=excluded.supplierName,
            supplierPhone=excluded.supplierPhone, total=excluded.total, paid=excluded.paid,
            party_phone=excluded.party_phone, json=excluded.json`,
        paramsOf: (sc, j) => [str(sc.id), str(sc.date), localDateOf(sc), str(sc.supplierName) || '', str(sc.supplierPhone) || '', num(sc.total), num(sc.paid) || 0, partyPhoneOf(sc.supplierPhone), j]
      },
      {
        table: 'supplier_payments',
        rows: d.supplierPayments || [],
        idOf: sp => str(sp.id),
        jsonOf: sp => J(sp),
        upsertSql: `INSERT INTO supplier_payments (id, scId, date, local_date, amount, json) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET scId=excluded.scId, date=excluded.date, local_date=excluded.local_date, amount=excluded.amount, json=excluded.json`,
        paramsOf: (sp, j) => [str(sp.id), str(sp.scId), str(sp.date), localDateOf(sp), num(sp.amount), j]
      },
      {
        table: 'loan_payments',
        rows: d.loanPayments || [],
        idOf: lp => str(lp.id),
        jsonOf: lp => J(lp),
        upsertSql: `INSERT INTO loan_payments (id, loanTxId, date, local_date, amount, note, json) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET loanTxId=excluded.loanTxId, date=excluded.date, local_date=excluded.local_date, amount=excluded.amount, note=excluded.note, json=excluded.json`,
        paramsOf: (lp, j) => [str(lp.id), str(lp.loanTxId), str(lp.date), localDateOf(lp), num(lp.amount), str(lp.note) || '', j]
      },
      {
        table: 'cash_withdrawals',
        rows: d.cashWithdrawals || [],
        idOf: w => str(w.id),
        jsonOf: w => J(w),
        upsertSql: `INSERT INTO cash_withdrawals (id, date, local_date, amount, reason, json) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET date=excluded.date, local_date=excluded.local_date, amount=excluded.amount, reason=excluded.reason, json=excluded.json`,
        paramsOf: (w, j) => [str(w.id), str(w.date), localDateOf(w), num(w.amount), str(w.reason) || '', j]
      },
      {
        table: 'extra_expenses',
        rows: d.extraExpenses || [],
        idOf: e => str(e.id),
        jsonOf: e => J(e),
        upsertSql: `INSERT INTO extra_expenses (id, date, local_date, amount, note, json) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET date=excluded.date, local_date=excluded.local_date, amount=excluded.amount, note=excluded.note, json=excluded.json`,
        paramsOf: (e, j) => [str(e.id), str(e.date), localDateOf(e), num(e.amount), str(e.note) || '', j]
      },
      {
        table: 'audit_trail',
        rows: d.auditTrail || [],
        idOf: a => str(a.id),
        jsonOf: a => J(a),
        upsertSql: `INSERT INTO audit_trail (id, json) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET json=excluded.json`,
        paramsOf: (a, j) => [str(a.id), j]
      }
    ];
  }

  function validId(id) {
    return id && id !== 'null' && id !== 'undefined';
  }

  // Incremental sync. Returns { ok:true } on commit, or { guard:{...} } (no
  // writes performed) when a non-forced save would delete too much.
  function persistFromDataInternal(d, idsSnapshot, force) {
    enableForeignKeys();

    // Phase A — compute the diff read-only (no writes, so we can bail safely).
    const specs = jsonTableSpecs(d);
    const existingMaps = {};
    const deletePlan = {};
    for (const spec of specs) {
      const existing = readJsonMap(spec.table);
      existingMaps[spec.table] = existing;
      const keep = new Set((spec.keepIds || []).map(String));
      const desired = new Set();
      for (const row of spec.rows) {
        if (!row) continue;
        const id = String(spec.idOf(row));
        if (validId(id)) desired.add(id);
      }
      const toDel = [];
      for (const id of existing.keys()) {
        if (!desired.has(id) && !keep.has(id)) toDel.push(id);
      }
      deletePlan[spec.table] = toDel;
      if (!force && GUARDED_TABLES.has(spec.table)) {
        const existingCount = existing.size;
        if (existingCount >= GUARD_MIN_EXISTING && toDel.length > existingCount * GUARD_DELETE_FRACTION) {
          return { guard: { table: spec.table, deleting: toDel.length, of: existingCount } };
        }
      }
    }

    // Phase B — apply everything in one transaction.
    sdb.run('BEGIN IMMEDIATE');
    try {
      // Lets the validation triggers bypass during force/bulk sync; read by
      // their WHEN clauses within this same transaction.
      metaSet('__sync_mode', force ? 'force' : 'normal');
      if (force) {
        // Reset/import/date-wipe rebuild both the JSON mirror and normalized ERP
        // tables from one app snapshot. Clear ERP children first so product/party
        // mirror rows can be removed without stale FK references blocking the save.
        try { sdb.run('PRAGMA defer_foreign_keys = ON'); } catch (_) {}
        clearNormalizedErpTables();
      }
      seedSystemProduct();

      // Deletes first, child-first.
      for (const table of DELETE_ORDER) {
        const ids = deletePlan[table];
        if (!ids || !ids.length) continue;
        const del = sdb.prepare('DELETE FROM ' + table + ' WHERE id = ?');
        for (const id of ids) del.run([id]);
        del.free();
      }

      // parties (derived; natural key = canonical BD phone). Rebuilt each persist
      // from credits + supplier_credits so it always reflects current rows. Synced
      // before the credit upserts below so their party_phone FK resolves (the FK is
      // also DEFERRABLE, so intra-transaction order is not load-bearing).
      const desiredParties = buildPartyRows(d);
      const desiredPartyPhones = new Set(desiredParties.map(p => p.phone));
      const existingPartyPhones = new Set();
      try {
        const pr = sdb.exec('SELECT phone FROM parties');
        if (pr[0]) for (const r of pr[0].values) existingPartyPhones.add(String(r[0]));
      } catch (_) {}
      const pup = sdb.prepare(`INSERT INTO parties (phone, name, type, json) VALUES (?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET name=excluded.name, type=excluded.type, json=excluded.json`);
      for (const p of desiredParties) pup.run([p.phone, p.name, p.type, p.json]);
      pup.free();
      const pdel = sdb.prepare('DELETE FROM parties WHERE phone = ?');
      for (const ph of existingPartyPhones) if (!desiredPartyPhones.has(ph)) pdel.run([ph]);
      pdel.free();

      // Upserts, parent→child (specs order). Unchanged rows are skipped.
      for (const spec of specs) {
        const existing = existingMaps[spec.table];
        const ups = sdb.prepare(spec.upsertSql);
        for (const row of spec.rows) {
          if (!row) continue;
          const id = String(spec.idOf(row));
          if (!validId(id)) continue;
          const j = spec.jsonOf(row);
          if (existing.get(id) === j) continue;
          ups.run(spec.paramsOf(row, j));
        }
        ups.free();
      }

      // units (natural key: name)
      const desiredUnits = new Set((d.units || []).map(u => str(u)).filter(Boolean));
      const existingUnits = new Set();
      try {
        const ur = sdb.exec('SELECT name FROM units');
        if (ur[0]) for (const r of ur[0].values) existingUnits.add(String(r[0]));
      } catch (_) {}
      const uins = sdb.prepare('INSERT OR IGNORE INTO units (name) VALUES (?)');
      for (const n of desiredUnits) if (!existingUnits.has(n)) uins.run([n]);
      uins.free();
      const udel = sdb.prepare('DELETE FROM units WHERE name = ?');
      for (const n of existingUnits) if (!desiredUnits.has(n)) udel.run([n]);
      udel.free();

      // opening_cash (natural key: date)
      const oc = d.openingCashByDate || {};
      const desiredOc = new Map();
      Object.keys(oc).forEach(k => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(k))) desiredOc.set(String(k), num(oc[k]) || 0);
      });
      const existingOc = new Map();
      try {
        const ocr = sdb.exec('SELECT date, amount FROM opening_cash');
        if (ocr[0]) for (const r of ocr[0].values) existingOc.set(String(r[0]), Number(r[1]));
      } catch (_) {}
      const ocup = sdb.prepare('INSERT INTO opening_cash (date, amount) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET amount=excluded.amount');
      for (const [k, v] of desiredOc) if (existingOc.get(k) !== v) ocup.run([k, v]);
      ocup.free();
      const ocdel = sdb.prepare('DELETE FROM opening_cash WHERE date = ?');
      for (const k of existingOc.keys()) if (!desiredOc.has(k)) ocdel.run([k]);
      ocdel.free();

      rebuildNormalizedErpTables(d);

      // meta (settings + id counters) — upserted, never wiped.
      metaSet('schemaVersion', SCHEMA_VERSION);
      metaSet('shop_settings', J({
        shopName: d.shopName || 'KoshAgar',
        shopAddress: d.shopAddress || '',
        shopMobile: d.shopMobile || ''
      }));
      metaSet('closed_months', J(d.closedMonths && typeof d.closedMonths === 'object' && !Array.isArray(d.closedMonths) ? d.closedMonths : {}));
      if (idsSnapshot && typeof idsSnapshot === 'object') {
        Object.keys(idsSnapshot).forEach(k => {
          if (idsSnapshot[k] !== null && idsSnapshot[k] !== undefined) metaSet(k, idsSnapshot[k]);
        });
      }
      metaSet('savedAt', new Date().toISOString());

      // Leave the DB strict at rest: the force bypass is scoped to this
      // transaction's writes only, never to whatever writes come next.
      metaSet('__sync_mode', 'normal');

      sdb.run('COMMIT');
      return { ok: true };
    } catch (err) {
      try { sdb.run('ROLLBACK'); } catch (_) {}
      throw err;
    }
  }

  function loadLegacyMirrorIntoObject() {
    const oc = {};
    try {
      const ocRes = sdb.exec('SELECT date, amount FROM opening_cash');
      if (ocRes[0]) for (const r of ocRes[0].values) oc[r[0]] = Number(r[1]);
    } catch (_) {}
    const units = [];
    try {
      const uRes = sdb.exec('SELECT name FROM units');
      if (uRes[0]) for (const r of uRes[0].values) units.push(r[0]);
    } catch (_) {}
    return {
      products: rowsJson('products').filter(p => p.id !== '__CAPITAL__'),
      transactions: rowsJson('transactions'),
      credits: rowsJson('credits'),
      payments: rowsJson('payments'),
      supplierCredits: rowsJson('supplier_credits'),
      supplierPayments: rowsJson('supplier_payments'),
      loanPayments: rowsJson('loan_payments'),
      cashWithdrawals: rowsJson('cash_withdrawals'),
      extraExpenses: rowsJson('extra_expenses'),
      auditTrail: rowsJson('audit_trail'),
      openingCashByDate: oc,
      units
    };
  }

  // priorVer MUST be captured before ensureRelationalSchema() runs — that call
  // stamps schemaVersion to the current value, so reading it here would always
  // look up-to-date and the rebuild would never fire.
  function migrateSchemaIfNeeded(priorVer) {
    enableForeignKeys();
    if (priorVer === SCHEMA_VERSION) return false;

    // Snapshot from the row JSON columns (present in every schema version) BEFORE
    // touching structure, so we never read a not-yet-added typed column. On a
    // fresh/empty or un-stamped DB the tables may not exist → snapshot is empty.
    let snapshot = null;
    try { snapshot = loadLegacyMirrorIntoObject(); } catch (_) {}
    const hasRows = snapshot && (
      (snapshot.transactions || []).length > 0 ||
      (snapshot.products || []).length > 0
    );

    // Always rebuild into a FRESH DB so new columns/tables/indexes (e.g. parties +
    // party_phone, transactions.entry_*) are created cleanly. Running the current
    // DDL on the OLD tables would fail (e.g. CREATE INDEX on a missing column).
    // Data is re-derived from the snapshot's row JSON.
    sdb.close();
    sdb = new SQL.Database();
    registerFunctions();
    ensureRelationalSchema();
    if (hasRows) persistFromDataInternal(snapshot, null, true);
    return true;
  }

  api.init = function () {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      try {
        if (typeof initSqlJs !== 'function') {
          throw new Error('sql.js not loaded — serve over http:// (not file://)');
        }
        SQL = await initSqlJs({ locateFile: (f) => CDN_BASE + f });
        const bytes = await loadBytes();
        sdb = bytes ? new SQL.Database(bytes) : new SQL.Database();
        enableForeignKeys();
        registerFunctions();
        // Read the stored schema version FIRST. If it isn't the current version
        // (an older DB, or an un-stamped legacy one), migrate — snapshot from the
        // row JSON, then rebuild a FRESH DB — BEFORE running the current DDL.
        // Running the new DDL on old tables throws (e.g. CREATE INDEX on a column
        // the old table lacks, like party_phone), which would disable SQLite.
        try {
          let priorVer = null;
          try { priorVer = metaGet('schemaVersion'); } catch (_) {}
          let migrated = false;
          if (priorVer !== SCHEMA_VERSION) {
            migrated = migrateSchemaIfNeeded(priorVer);
          }
          if (!migrated) ensureRelationalSchema();   // only when already current-version
          if (migrated) await saveBytes(exportBytes());
        } catch (schemaErr) {
          // Self-heal: ANY schema/migration failure (e.g. a half-applied older
          // schema whose tables lack a newly-added column like party_phone) must
          // NOT permanently disable SQLite. Snapshot from the row JSON (present in
          // every version), rebuild a FRESH DB, re-derive, and persist.
          console.warn('[KoshDB] schema setup failed — rebuilding fresh:', String(schemaErr && schemaErr.message || schemaErr));
          let snapshot = null;
          try { snapshot = loadLegacyMirrorIntoObject(); } catch (_) {}
          try { sdb.close(); } catch (_) {}
          sdb = new SQL.Database();
          enableForeignKeys();
          registerFunctions();
          ensureRelationalSchema();
          const hasRows = snapshot && ((snapshot.transactions || []).length > 0 || (snapshot.products || []).length > 0);
          if (hasRows) persistFromDataInternal(snapshot, null, true);
          await saveBytes(exportBytes());
        }
        api.available = true;
        api.lastError = null;
        return true;
      } catch (err) {
        api.available = false;
        api.lastError = String(err && err.message || err);
        console.warn('[KoshDB] SQLite unavailable:', api.lastError);
        return false;
      }
    })();
    return _initPromise;
  };

  /** Primary write — must succeed before JSON backup. Returns { ok, error?, issues? } */
  api.persistFromData = async function (dataObj, idsSnapshot, force) {
    if (!api.available || !sdb) {
      return { ok: false, error: 'SQLite unavailable' };
    }
    const d = dataObj || (typeof data !== 'undefined' ? data : null);
    if (!d) return { ok: false, error: 'No data object' };

    const sig = fullDataSignature(d);
    if (!force && sig === _lastSyncSig) return { ok: true };

    try {
      const res = persistFromDataInternal(d, idsSnapshot, !!force);
      if (res && res.guard) {
        const g = res.guard;
        api.lastError = `mass-delete guard: refusing to remove ${g.deleting} of ${g.of} rows from "${g.table}" — likely a partial/corrupt state. Not saved.`;
        console.error('[KoshDB] ' + api.lastError);
        return { ok: false, error: api.lastError, guard: g };
      }
      await saveBytes(exportBytes());
      api.lastSyncAt = new Date().toISOString();
      _lastSyncSig = sig;
      return { ok: true };
    } catch (err) {
      try { sdb.run('ROLLBACK'); } catch (_) {}
      api.lastError = String(err && err.message || err);
      console.error('[KoshDB] persistFromData failed:', api.lastError);
      return { ok: false, error: api.lastError };
    }
  };

  /** Backward-compatible alias */
  api.syncFromData = api.persistFromData;

  /** Load authoritative state from SQLite into a plain data object */
  api.loadPrimary = function () {
    if (!api.available || !sdb) return null;
    try {
      enableForeignKeys();
      const loaded = loadLegacyMirrorIntoObject();
      if (!loaded) return null;

      try {
        const shopRaw = metaGet('shop_settings');
        if (shopRaw) {
          const shop = JSON.parse(shopRaw);
          loaded.shopName = shop.shopName || 'KoshAgar';
          loaded.shopAddress = shop.shopAddress || '';
          loaded.shopMobile = shop.shopMobile || '';
        }
      } catch (_) {
        loaded.shopName = 'KoshAgar';
        loaded.shopAddress = '';
        loaded.shopMobile = '';
      }

      try {
        const cmRaw = metaGet('closed_months');
        loaded.closedMonths = cmRaw ? JSON.parse(cmRaw) : {};
      } catch (_) {
        loaded.closedMonths = {};
      }

      return loaded;
    } catch (err) {
      console.warn('[KoshDB] loadPrimary failed:', err);
      return null;
    }
  };

  api.loadIdsSnapshot = function () {
    if (!api.available || !sdb) return null;
    const keys = ['nextPid', 'nextTid', 'nextCid', 'nextScid', 'nextBillId', 'nextReturnGroupId', 'nextPayId', 'nextSupPayId', 'nextAuditId'];
    const out = {};
    keys.forEach(k => {
      const v = metaGet(k);
      if (v !== null && v !== undefined && v !== '') out[k] = Number(v) || v;
    });
    return Object.keys(out).length ? out : null;
  };

  api.getSavedAt = function () {
    if (!api.available || !sdb) return null;
    return metaGet('savedAt') || null;
  };

  api.hasBusinessData = function () {
    if (!api.available || !sdb) return false;
    return scalar('SELECT COUNT(*) FROM transactions') > 0 ||
      scalar('SELECT COUNT(*) FROM products WHERE id != ?', ['__CAPITAL__']) > 0;
  };

  api.checkIntegrity = function () {
    if (!api.available || !sdb) return { ok: false, error: 'SQLite unavailable' };
    enableForeignKeys();
    const issues = [];

    const dupTx = scalar('SELECT COUNT(*) FROM (SELECT id FROM transactions GROUP BY id HAVING COUNT(*) > 1)');
    if (dupTx > 0) issues.push(`${dupTx} duplicate transaction id(s)`);

    const dupProd = scalar('SELECT COUNT(*) FROM (SELECT id FROM products GROUP BY id HAVING COUNT(*) > 1)');
    if (dupProd > 0) issues.push(`${dupProd} duplicate product id(s)`);

    const orphanPay = scalar('SELECT COUNT(*) FROM payments WHERE creditId NOT IN (SELECT id FROM credits)');
    if (orphanPay > 0) issues.push(`${orphanPay} payment(s) with no matching credit`);

    const orphanSupPay = scalar('SELECT COUNT(*) FROM supplier_payments WHERE scId NOT IN (SELECT id FROM supplier_credits)');
    if (orphanSupPay > 0) issues.push(`${orphanSupPay} supplier payment(s) with no matching supplier credit`);

    const orphanLoanPay = scalar(`SELECT COUNT(*) FROM loan_payments
      WHERE loanTxId NOT IN (SELECT id FROM transactions WHERE type = 'capital-in')`);
    if (orphanLoanPay > 0) issues.push(`${orphanLoanPay} loan payment(s) with no matching loan`);

    const orphanTxProd = scalar(`SELECT COUNT(*) FROM transactions t
      WHERE t.productId NOT IN (SELECT id FROM products)`);
    if (orphanTxProd > 0) issues.push(`${orphanTxProd} transaction(s) reference missing product`);

    const badTotals = scalar('SELECT COUNT(*) FROM transactions WHERE total IS NULL OR qty <= 0');
    if (badTotals > 0) issues.push(`${badTotals} transaction(s) with invalid qty/total`);

    const overpaidCredits = scalar('SELECT COUNT(*) FROM credits WHERE paid > total + 0.01');
    if (overpaidCredits > 0) issues.push(`${overpaidCredits} customer credit(s) with paid > total`);

    const overpaidSupplier = scalar('SELECT COUNT(*) FROM supplier_credits WHERE paid > total + 0.01');
    if (overpaidSupplier > 0) issues.push(`${overpaidSupplier} supplier credit(s) with paid > total`);

    const overpayByRows = scalar(`SELECT COUNT(*) FROM credits c
      WHERE COALESCE(c.paid, 0) + COALESCE((SELECT SUM(amount) FROM payments WHERE creditId = c.id), 0) > c.total + 0.011`);
    if (overpayByRows > 0) issues.push(`${overpayByRows} customer credit(s) whose initial paid + payment rows exceed total`);

    const overpaySupByRows = scalar(`SELECT COUNT(*) FROM supplier_credits sc
      WHERE COALESCE(sc.paid, 0) + COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE scId = sc.id), 0) > sc.total + 0.011`);
    if (overpaySupByRows > 0) issues.push(`${overpaySupByRows} supplier credit(s) whose initial paid + payment rows exceed total`);

    const overpayLoanByRows = scalar(`SELECT COUNT(*) FROM transactions t
      WHERE t.type = 'capital-in' AND COALESCE(json_extract(t.json, '$.capitalSource'), '') = 'loan'
        AND COALESCE((SELECT SUM(amount) FROM loan_payments WHERE loanTxId = t.id), 0) > t.total + 0.011`);
    if (overpayLoanByRows > 0) issues.push(`${overpayLoanByRows} loan(s) whose payment rows exceed total`);

    // Party / BD-phone reconciliation.
    // Rule: a CREDIT sale/purchase requires a valid BD phone (full-cash entries
    // live in `transactions` and are exempt). Rows without one are kept but stay
    // unlinked to any party — reported here for cleanup, never dropped.
    const custNoPhone = scalar('SELECT COUNT(*) FROM credits WHERE party_phone IS NULL');
    if (custNoPhone > 0) issues.push(`${custNoPhone} customer credit(s) without a valid BD phone (mandatory for credit) — not linked to a party`);

    const supNoPhone = scalar('SELECT COUNT(*) FROM supplier_credits WHERE party_phone IS NULL');
    if (supNoPhone > 0) issues.push(`${supNoPhone} supplier credit(s) without a valid BD phone (mandatory for credit) — not linked to a party`);

    const badPartyPhone = scalar(`SELECT COUNT(*) FROM parties
      WHERE phone NOT GLOB '01[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'`);
    if (badPartyPhone > 0) issues.push(`${badPartyPhone} party row(s) with a non-BD phone`);

    const orphanCreditParty = scalar('SELECT COUNT(*) FROM credits WHERE party_phone IS NOT NULL AND party_phone NOT IN (SELECT phone FROM parties)');
    if (orphanCreditParty > 0) issues.push(`${orphanCreditParty} customer credit(s) pointing to a missing party`);

    const orphanSupParty = scalar('SELECT COUNT(*) FROM supplier_credits WHERE party_phone IS NOT NULL AND party_phone NOT IN (SELECT phone FROM parties)');
    if (orphanSupParty > 0) issues.push(`${orphanSupParty} supplier credit(s) pointing to a missing party`);

    // Informational: one name spread across different phones = likely duplicate
    // people entered under variant numbers. Not an error (phone is the identity),
    // but surfaced so the shopkeeper can reconcile them.
    const nameSpread = scalar(`SELECT COUNT(*) FROM (
      SELECT lower(trim(name)) nm FROM parties GROUP BY nm HAVING COUNT(DISTINCT phone) > 1)`);
    if (nameSpread > 0) issues.push(`${nameSpread} party name(s) appear under more than one phone — possible duplicates to review`);

    // Unit-conversion reconciliation: the stock (base-unit) qty must equal the
    // entered qty × the unit factor. Flags any row where the conversion drifted.
    const unitMismatch = scalar(`SELECT COUNT(*) FROM transactions
      WHERE entry_qty IS NOT NULL AND ABS(qty - entry_qty * entry_factor) > 0.01`);
    if (unitMismatch > 0) issues.push(`${unitMismatch} transaction(s) whose stock qty ≠ entered qty × unit factor`);

    // Strict-rule reporting (these can slip in only via a permissive import).
    const badJson = scalar(`SELECT
      (SELECT COUNT(*) FROM products WHERE kosh_json_ok(json)=0) +
      (SELECT COUNT(*) FROM transactions WHERE kosh_json_ok(json)=0) +
      (SELECT COUNT(*) FROM credits WHERE kosh_json_ok(json)=0) +
      (SELECT COUNT(*) FROM payments WHERE kosh_json_ok(json)=0) +
      (SELECT COUNT(*) FROM supplier_credits WHERE kosh_json_ok(json)=0) +
      (SELECT COUNT(*) FROM supplier_payments WHERE kosh_json_ok(json)=0) +
      (SELECT COUNT(*) FROM cash_withdrawals WHERE kosh_json_ok(json)=0) +
      (SELECT COUNT(*) FROM extra_expenses WHERE kosh_json_ok(json)=0) +
      (SELECT COUNT(*) FROM audit_trail WHERE kosh_json_ok(json)=0)`);
    if (badJson > 0) issues.push(`${badJson} row(s) with invalid JSON`);

    const badDate = scalar(`SELECT
      (SELECT COUNT(*) FROM transactions WHERE kosh_is_date(date)=0) +
      (SELECT COUNT(*) FROM credits WHERE kosh_is_date(date)=0) +
      (SELECT COUNT(*) FROM payments WHERE kosh_is_date(date)=0) +
      (SELECT COUNT(*) FROM supplier_credits WHERE kosh_is_date(date)=0) +
      (SELECT COUNT(*) FROM supplier_payments WHERE kosh_is_date(date)=0) +
      (SELECT COUNT(*) FROM cash_withdrawals WHERE kosh_is_date(date)=0) +
      (SELECT COUNT(*) FROM extra_expenses WHERE kosh_is_date(date)=0)`);
    if (badDate > 0) issues.push(`${badDate} row(s) with invalid/empty date`);

    try {
      const fk = sdb.exec('PRAGMA foreign_key_check');
      if (fk[0] && fk[0].values && fk[0].values.length) {
        issues.push(`${fk[0].values.length} foreign key violation(s)`);
      }
    } catch (_) {}

    return { ok: issues.length === 0, issues };
  };

  api.autoRepair = async function () {
    if (!api.available || !sdb) return false;
    try {
      const src = typeof data !== 'undefined' ? data : null;
      const result = await api.persistFromData(src, typeof getIdsSnapshot === 'function' ? getIdsSnapshot() : null, true);
      if (result.ok) console.log('[KoshDB] autoRepair: rebuilt from in-memory data');
      return result.ok;
    } catch (err) {
      console.warn('[KoshDB] autoRepair failed:', err);
      return false;
    }
  };

  api.optimize = async function () {
    if (!api.available || !sdb) return { ok: false, error: 'SQLite unavailable' };
    try {
      const src = typeof data !== 'undefined' ? data : null;
      const beforeBytes = exportBytes().length;
      const sync = await api.persistFromData(src, typeof getIdsSnapshot === 'function' ? getIdsSnapshot() : null, true);
      if (!sync.ok) return sync;
      try { sdb.run('PRAGMA optimize'); } catch (_) {}
      try { sdb.run('VACUUM'); } catch (_) {}
      const bytes = exportBytes();
      await saveBytes(bytes);
      api.lastSyncAt = new Date().toISOString();
      return { ok: true, beforeBytes, afterBytes: bytes.length };
    } catch (err) {
      api.lastError = String(err && err.message || err);
      console.warn('[KoshDB] optimize failed:', api.lastError);
      return { ok: false, error: api.lastError };
    }
  };

  api.loadIntoDataObject = api.loadPrimary;

  api.rowCount = function (table) {
    if (!api.available || !sdb) return 0;
    try {
      const r = sdb.exec('SELECT COUNT(*) FROM ' + table);
      return r[0] ? Number(r[0].values[0][0]) : 0;
    } catch (_) { return 0; }
  };

  api.query = function (sql, params) {
    if (!api.available || !sdb) return null;
    try {
      enableForeignKeys();
      return sdb.exec(sql, params);
    } catch (err) {
      console.warn('[KoshDB] query error:', err);
      return null;
    }
  };

  /** Import JSON backup into relational SQLite (Settings → Import path) */
  api.importFromData = async function (dataObj, idsSnapshot) {
    return api.persistFromData(dataObj, idsSnapshot, true);
  };

  return api;
})();
