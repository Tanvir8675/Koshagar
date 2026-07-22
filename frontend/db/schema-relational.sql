-- ============================================================================
-- KoshAgar / MyShop — Relational SQLite schema (DDL REFERENCE)
-- ============================================================================
-- This file is human-readable DOCUMENTATION of the schema. It is NOT executed
-- by the app. The single source of truth is db/sqlite.js — the relational DDL
-- there (RELATIONAL_DDL + buildStrictTriggerDDL) is what actually runs in the
-- browser via sql.js (WASM). Keep this file in sync when sqlite.js changes.
--
-- Two helper FUNCTIONS used by the strict triggers below — kosh_json_ok(text)
-- and kosh_is_date(text) — are NOT defined in SQL. They are real JS user-defined
-- functions registered at runtime via sql.js `create_function` (registerFunctions
-- in sqlite.js), because validation needs JSON.parse / regex. SQLite resolves
-- them when a trigger fires. (sql.js export() drops UDFs, so sqlite.js
-- re-registers them after every export.)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- TABLES (each carries a full-row `json` column alongside typed/indexed keys)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS products (
  id       TEXT PRIMARY KEY NOT NULL,
  name     TEXT NOT NULL CHECK(length(trim(COALESCE(name, ''))) > 0),
  unit     TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  json     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY NOT NULL,
  type           TEXT NOT NULL CHECK(type IN ('sale', 'purchase', 'return', 'adjustment', 'capital-in', 'capital-out')),
  date           TEXT NOT NULL,
  productId      TEXT NOT NULL,
  qty            REAL NOT NULL CHECK(qty > 0),
  price          REAL NOT NULL CHECK(price >= 0),
  cost           REAL NOT NULL DEFAULT 0 CHECK(cost >= 0),
  total          REAL NOT NULL CHECK(total >= 0),
  cashPaid       REAL CHECK(cashPaid IS NULL OR cashPaid >= 0),
  returnType     TEXT,
  linkedTxId     TEXT,
  opening        INTEGER NOT NULL DEFAULT 0 CHECK(opening IN (0, 1)),
  adjustmentType TEXT,
  -- Unit conversion, first-class: qty/price/total above are in the BASE (stock)
  -- unit; the columns below record what was entered. entry_factor = base units
  -- per 1 entered unit (1 for simple products / base-unit sales). The invariant
  -- qty ≈ entry_qty × entry_factor is reconciled (soft) by checkIntegrity so a
  -- bad import surfaces instead of being blocked. entry_factor is sanitized on
  -- write, so its CHECK never blocks a restore.
  entry_unit     TEXT NOT NULL DEFAULT '',
  entry_qty      REAL,
  entry_factor   REAL NOT NULL DEFAULT 1 CHECK(entry_factor > 0),
  base_unit      TEXT NOT NULL DEFAULT '',
  json           TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (productId)  REFERENCES products(id)     ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (linkedTxId) REFERENCES transactions(id) ON DELETE SET NULL ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(cashPaid IS NULL OR cashPaid <= total + 0.01)
);

-- Normalized party master. PRIMARY KEY = canonical BD mobile (11 digits,
-- 01[3-9]XXXXXXXX). Phone is the SOLE identity: same phone anywhere = one party.
-- DERIVED — rebuilt from credits + supplier_credits on every persist
-- (buildPartyRows in sqlite.js); the app never edits it directly. Rows whose
-- credit/supplier phone is missing or non-BD contribute no party (kept, flagged
-- by checkIntegrity). Business rule: a CREDIT sale/purchase requires a valid BD
-- phone; full-cash sales/purchases (transactions table) do not.
CREATE TABLE IF NOT EXISTS parties (
  phone TEXT PRIMARY KEY NOT NULL CHECK(phone GLOB '01[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  name  TEXT NOT NULL CHECK(length(trim(COALESCE(name, ''))) > 0),
  type  TEXT NOT NULL CHECK(type IN ('customer', 'supplier', 'both')),
  json  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS credits (
  id            TEXT PRIMARY KEY NOT NULL,
  date          TEXT NOT NULL,
  customerName  TEXT NOT NULL CHECK(length(trim(COALESCE(customerName, ''))) > 0),
  customerPhone TEXT NOT NULL DEFAULT '',
  total         REAL NOT NULL CHECK(total > 0),
  paid          REAL NOT NULL DEFAULT 0 CHECK(paid >= 0),
  party_phone   TEXT,                      -- FK → parties(phone); NULL when no valid BD phone
  json          TEXT NOT NULL DEFAULT '{}',
  CHECK(paid <= total + 0.01),
  FOREIGN KEY (party_phone) REFERENCES parties(phone) ON DELETE SET NULL ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS payments (
  id       TEXT PRIMARY KEY NOT NULL,
  creditId TEXT NOT NULL,
  date     TEXT NOT NULL,
  amount   REAL NOT NULL CHECK(amount > 0),
  json     TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (creditId) REFERENCES credits(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_credits (
  id            TEXT PRIMARY KEY NOT NULL,
  date          TEXT NOT NULL,
  supplierName  TEXT NOT NULL DEFAULT '',
  supplierPhone TEXT NOT NULL DEFAULT '',
  total         REAL NOT NULL CHECK(total > 0),
  paid          REAL NOT NULL DEFAULT 0 CHECK(paid >= 0),
  party_phone   TEXT,                      -- FK → parties(phone); NULL when no valid BD phone
  json          TEXT NOT NULL DEFAULT '{}',
  CHECK(paid <= total + 0.01),
  FOREIGN KEY (party_phone) REFERENCES parties(phone) ON DELETE SET NULL ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id     TEXT PRIMARY KEY NOT NULL,
  scId   TEXT NOT NULL,
  date   TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0),
  json   TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (scId) REFERENCES supplier_credits(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS cash_withdrawals (
  id     TEXT PRIMARY KEY NOT NULL,
  date   TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0),
  reason TEXT NOT NULL DEFAULT '',
  json   TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS extra_expenses (
  id     TEXT PRIMARY KEY NOT NULL,
  date   TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0),
  note   TEXT NOT NULL DEFAULT '',
  json   TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS opening_cash (
  date   TEXT PRIMARY KEY NOT NULL,
  amount REAL NOT NULL CHECK(amount >= 0)
);

CREATE TABLE IF NOT EXISTS units (
  name TEXT PRIMARY KEY NOT NULL CHECK(length(trim(COALESCE(name, ''))) > 0)
);

CREATE TABLE IF NOT EXISTS audit_trail (
  id   TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL DEFAULT '{}'
);

-- key/value store: schemaVersion, shop_settings, closed_months, id counters,
-- savedAt, and '__sync_mode' (set to 'force' during import/migration so the
-- validation triggers below bypass; reset to 'normal' before every commit).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- INDEXES
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_tx_date          ON transactions(date);
CREATE INDEX IF NOT EXISTS ix_tx_type          ON transactions(type);
CREATE INDEX IF NOT EXISTS ix_tx_product       ON transactions(productId);
CREATE INDEX IF NOT EXISTS ix_tx_linked        ON transactions(linkedTxId);
CREATE INDEX IF NOT EXISTS ix_credits_date     ON credits(date);
CREATE INDEX IF NOT EXISTS ix_credits_party    ON credits(party_phone);
CREATE INDEX IF NOT EXISTS ix_payments_credit  ON payments(creditId);
CREATE INDEX IF NOT EXISTS ix_scredits_date    ON supplier_credits(date);
CREATE INDEX IF NOT EXISTS ix_scredits_party   ON supplier_credits(party_phone);
CREATE INDEX IF NOT EXISTS ix_spayments_sc     ON supplier_payments(scId);
CREATE INDEX IF NOT EXISTS ix_withdrawals_date ON cash_withdrawals(date);
CREATE INDEX IF NOT EXISTS ix_expenses_date    ON extra_expenses(date);

-- ----------------------------------------------------------------------------
-- DELETE-PROTECTION TRIGGERS (always active — referential safety)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- OVERPAYMENT TRIGGERS (block SUM(payments) > credit total; bypass on force sync)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- STRICT-VALIDATION TRIGGERS (generated by buildStrictTriggerDDL in sqlite.js)
-- Reject malformed JSON / invalid date on LIVE writes. Bypassed on force sync
-- (import/migration) so a restore is never blocked; checkIntegrity() reports
-- such rows instead. kosh_json_ok / kosh_is_date are JS UDFs (see header).
-- One BEFORE INSERT and one BEFORE UPDATE per table.
-- ----------------------------------------------------------------------------

-- products / audit_trail: JSON validity only.
CREATE TRIGGER IF NOT EXISTS tr_products_strict_ins
BEFORE INSERT ON products FOR EACH ROW
WHEN COALESCE((SELECT value FROM meta WHERE key='__sync_mode'),'normal') <> 'force'
BEGIN
  SELECT CASE WHEN kosh_json_ok(NEW.json)=0 THEN RAISE(ABORT, 'products: invalid JSON') END;
END;
CREATE TRIGGER IF NOT EXISTS tr_products_strict_upd
BEFORE UPDATE ON products FOR EACH ROW
WHEN COALESCE((SELECT value FROM meta WHERE key='__sync_mode'),'normal') <> 'force'
BEGIN
  SELECT CASE WHEN kosh_json_ok(NEW.json)=0 THEN RAISE(ABORT, 'products: invalid JSON') END;
END;

CREATE TRIGGER IF NOT EXISTS tr_audit_trail_strict_ins
BEFORE INSERT ON audit_trail FOR EACH ROW
WHEN COALESCE((SELECT value FROM meta WHERE key='__sync_mode'),'normal') <> 'force'
BEGIN
  SELECT CASE WHEN kosh_json_ok(NEW.json)=0 THEN RAISE(ABORT, 'audit_trail: invalid JSON') END;
END;
CREATE TRIGGER IF NOT EXISTS tr_audit_trail_strict_upd
BEFORE UPDATE ON audit_trail FOR EACH ROW
WHEN COALESCE((SELECT value FROM meta WHERE key='__sync_mode'),'normal') <> 'force'
BEGIN
  SELECT CASE WHEN kosh_json_ok(NEW.json)=0 THEN RAISE(ABORT, 'audit_trail: invalid JSON') END;
END;

-- transactions / credits / payments / supplier_credits / supplier_payments /
-- cash_withdrawals / extra_expenses: JSON validity AND date format. Shown in
-- full for transactions; the other six are identical with the table name and
-- error-message prefix swapped (both BEFORE INSERT and BEFORE UPDATE).
CREATE TRIGGER IF NOT EXISTS tr_transactions_strict_ins
BEFORE INSERT ON transactions FOR EACH ROW
WHEN COALESCE((SELECT value FROM meta WHERE key='__sync_mode'),'normal') <> 'force'
BEGIN
  SELECT CASE
    WHEN kosh_json_ok(NEW.json)=0 THEN RAISE(ABORT, 'transactions: invalid JSON')
    WHEN kosh_is_date(NEW.date)=0 THEN RAISE(ABORT, 'transactions: invalid/empty date')
  END;
END;
CREATE TRIGGER IF NOT EXISTS tr_transactions_strict_upd
BEFORE UPDATE ON transactions FOR EACH ROW
WHEN COALESCE((SELECT value FROM meta WHERE key='__sync_mode'),'normal') <> 'force'
BEGIN
  SELECT CASE
    WHEN kosh_json_ok(NEW.json)=0 THEN RAISE(ABORT, 'transactions: invalid JSON')
    WHEN kosh_is_date(NEW.date)=0 THEN RAISE(ABORT, 'transactions: invalid/empty date')
  END;
END;
-- ... credits, payments, supplier_credits, supplier_payments,
--     cash_withdrawals, extra_expenses follow the same two-trigger pattern.
