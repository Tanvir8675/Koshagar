// schema.js — KoshAgar data-layer schema, as versioned migrations.
//
// Framework-agnostic (plain ESM; the React rebuild imports this unchanged).
// Design follows the React rebuild spec §7: normalized, ledger-based, with
// CHECK/FK integrity. Single-shop for now — shop_id defaults to 'default' and is
// kept as a column so multi-shop can be added later without a rewrite.
//
// SCALE HARDENING (the benchmark lesson): hot aggregates are NOT computed by
// scanning history every time. We keep MAINTAINED SUMMARY TABLES (product_stock,
// daily_summary) updated inside the same write transaction as the ledger row, so
// "current stock" / "today's totals" read ONE row, not millions.
//
// This file is the FOUNDATION SLICE: units, products, product_prices + the
// cross-cutting infra (audit_logs, sync_queue, app_meta) + product_stock summary.
// Sales / purchases / inventory_movements / credits / cash_ledger repos and their
// tables land in the next migrations, same pattern.

export const MIGRATIONS = [
  {
    version: 1,
    name: 'core-products',
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS units (
        id              TEXT PRIMARY KEY,
        shop_id         TEXT NOT NULL DEFAULT 'default',
        name            TEXT NOT NULL,
        base_unit_id    TEXT,
        conversion_rate REAL NOT NULL DEFAULT 1 CHECK(conversion_rate > 0),
        active          INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE(shop_id, name)
      );

      CREATE TABLE IF NOT EXISTS products (
        id            TEXT PRIMARY KEY,
        shop_id       TEXT NOT NULL DEFAULT 'default',
        name          TEXT NOT NULL,
        sku           TEXT,
        category      TEXT NOT NULL DEFAULT '',
        spec          TEXT NOT NULL DEFAULT '',
        unit_id       TEXT,
        low_stock_qty REAL NOT NULL DEFAULT 0 CHECK(low_stock_qty >= 0),
        active        INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE(shop_id, name, spec)
      );

      CREATE TABLE IF NOT EXISTS product_prices (
        id            TEXT PRIMARY KEY,
        shop_id       TEXT NOT NULL DEFAULT 'default',
        product_id    TEXT NOT NULL,
        cost_price    REAL NOT NULL DEFAULT 0 CHECK(cost_price >= 0),
        sale_price    REAL NOT NULL DEFAULT 0 CHECK(sale_price >= 0),
        effective_from TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      );

      -- Maintained summary: current stock per product (read 1 row, never scan).
      CREATE TABLE IF NOT EXISTS product_stock (
        shop_id       TEXT NOT NULL DEFAULT 'default',
        product_id    TEXT NOT NULL,
        current_stock REAL NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (shop_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id          TEXT PRIMARY KEY,
        shop_id     TEXT NOT NULL DEFAULT 'default',
        user_id     TEXT,
        action      TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id   TEXT NOT NULL DEFAULT '',
        old_value   TEXT NOT NULL DEFAULT '{}',
        new_value   TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_queue (
        id           TEXT PRIMARY KEY,
        shop_id      TEXT NOT NULL DEFAULT 'default',
        entity_type  TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        operation    TEXT NOT NULL CHECK(operation IN ('create','update','delete')),
        payload      TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','failed')),
        retry_count  INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
        error_message TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL,
        synced_at    TEXT
      );
    `
  },
  {
    version: 2,
    name: 'core-products-indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS ix_products_shop_name     ON products(shop_id, name);
      CREATE INDEX IF NOT EXISTS ix_products_shop_category ON products(shop_id, category);
      CREATE INDEX IF NOT EXISTS ix_prices_product         ON product_prices(product_id);
      CREATE INDEX IF NOT EXISTS ix_audit_shop_created     ON audit_logs(shop_id, created_at);
      CREATE INDEX IF NOT EXISTS ix_sync_status            ON sync_queue(status, created_at);
    `
  },
  {
    version: 3,
    name: 'erp-sales-purchase-ledgers',
    sql: `
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS shops (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL DEFAULT 'KoshAgar',
        address       TEXT NOT NULL DEFAULT '',
        phone         TEXT NOT NULL DEFAULT '',
        currency_code TEXT NOT NULL DEFAULT 'BDT',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      INSERT OR IGNORE INTO shops (id, name, created_at, updated_at)
      VALUES ('default', 'KoshAgar', datetime('now'), datetime('now'));

      CREATE TABLE IF NOT EXISTS product_categories (
        id         TEXT PRIMARY KEY,
        shop_id    TEXT NOT NULL DEFAULT 'default',
        name       TEXT NOT NULL,
        parent_id  TEXT,
        active     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(shop_id, name),
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES product_categories(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS product_units (
        product_id             TEXT NOT NULL,
        unit_id                TEXT NOT NULL,
        factor_to_stock_ppm    INTEGER NOT NULL CHECK(factor_to_stock_ppm > 0),
        is_default_purchase    INTEGER NOT NULL DEFAULT 0 CHECK(is_default_purchase IN (0,1)),
        is_default_sale        INTEGER NOT NULL DEFAULT 0 CHECK(is_default_sale IN (0,1)),
        created_at             TEXT NOT NULL,
        PRIMARY KEY (product_id, unit_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS customers (
        id                  TEXT PRIMARY KEY,
        shop_id             TEXT NOT NULL DEFAULT 'default',
        name                TEXT NOT NULL CHECK(length(trim(name)) > 0),
        phone               TEXT NOT NULL DEFAULT '',
        address             TEXT NOT NULL DEFAULT '',
        opening_due_paisa   INTEGER NOT NULL DEFAULT 0 CHECK(opening_due_paisa >= 0),
        active              INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE(shop_id, phone),
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS suppliers (
        id                  TEXT PRIMARY KEY,
        shop_id             TEXT NOT NULL DEFAULT 'default',
        name                TEXT NOT NULL CHECK(length(trim(name)) > 0),
        phone               TEXT NOT NULL DEFAULT '',
        address             TEXT NOT NULL DEFAULT '',
        opening_due_paisa   INTEGER NOT NULL DEFAULT 0 CHECK(opening_due_paisa >= 0),
        active              INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE(shop_id, phone),
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sales (
        id               TEXT PRIMARY KEY,
        shop_id          TEXT NOT NULL DEFAULT 'default',
        invoice_no       TEXT NOT NULL,
        customer_id      TEXT,
        sale_date        TEXT NOT NULL,
        gross_paisa      INTEGER NOT NULL DEFAULT 0 CHECK(gross_paisa >= 0),
        discount_paisa   INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0),
        net_paisa        INTEGER NOT NULL CHECK(net_paisa >= 0),
        cash_paid_paisa  INTEGER NOT NULL DEFAULT 0 CHECK(cash_paid_paisa >= 0),
        status           TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('draft','posted','void','returned')),
        notes            TEXT NOT NULL DEFAULT '',
        source_ref       TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE(shop_id, invoice_no),
        CHECK(discount_paisa <= gross_paisa),
        CHECK(net_paisa = gross_paisa - discount_paisa),
        CHECK(cash_paid_paisa <= net_paisa),
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS sale_items (
        id                TEXT PRIMARY KEY,
        sale_id           TEXT NOT NULL,
        product_id        TEXT NOT NULL,
        unit_id           TEXT,
        qty_milli         INTEGER NOT NULL CHECK(qty_milli > 0),
        unit_price_paisa  INTEGER NOT NULL CHECK(unit_price_paisa >= 0),
        discount_paisa    INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0),
        line_total_paisa  INTEGER NOT NULL CHECK(line_total_paisa >= 0),
        cogs_unit_paisa   INTEGER NOT NULL DEFAULT 0 CHECK(cogs_unit_paisa >= 0),
        created_at        TEXT NOT NULL,
        CHECK(line_total_paisa = ((qty_milli * unit_price_paisa) / 1000) - discount_paisa),
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
        FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS purchases (
        id                TEXT PRIMARY KEY,
        shop_id           TEXT NOT NULL DEFAULT 'default',
        bill_no           TEXT NOT NULL,
        supplier_id       TEXT,
        purchase_date     TEXT NOT NULL,
        gross_paisa       INTEGER NOT NULL DEFAULT 0 CHECK(gross_paisa >= 0),
        discount_paisa    INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0),
        extra_cost_paisa  INTEGER NOT NULL DEFAULT 0 CHECK(extra_cost_paisa >= 0),
        net_paisa         INTEGER NOT NULL CHECK(net_paisa >= 0),
        cash_paid_paisa   INTEGER NOT NULL DEFAULT 0 CHECK(cash_paid_paisa >= 0),
        status            TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('draft','posted','void','returned')),
        notes             TEXT NOT NULL DEFAULT '',
        source_ref        TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        UNIQUE(shop_id, bill_no),
        CHECK(discount_paisa <= gross_paisa),
        CHECK(net_paisa = gross_paisa - discount_paisa),
        CHECK(cash_paid_paisa <= net_paisa),
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS purchase_items (
        id                  TEXT PRIMARY KEY,
        purchase_id         TEXT NOT NULL,
        product_id          TEXT NOT NULL,
        unit_id             TEXT,
        qty_milli           INTEGER NOT NULL CHECK(qty_milli > 0),
        list_unit_paisa     INTEGER NOT NULL DEFAULT 0 CHECK(list_unit_paisa >= 0),
        net_unit_paisa      INTEGER NOT NULL CHECK(net_unit_paisa >= 0),
        landed_unit_paisa   INTEGER NOT NULL CHECK(landed_unit_paisa >= 0),
        discount_paisa      INTEGER NOT NULL DEFAULT 0 CHECK(discount_paisa >= 0),
        line_total_paisa    INTEGER NOT NULL CHECK(line_total_paisa >= 0),
        created_at          TEXT NOT NULL,
        FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
        FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS inventory_movements (
        id               TEXT PRIMARY KEY,
        shop_id          TEXT NOT NULL DEFAULT 'default',
        product_id       TEXT NOT NULL,
        movement_date    TEXT NOT NULL,
        movement_type    TEXT NOT NULL CHECK(movement_type IN ('opening','purchase','sale','sale_return','purchase_return','adjustment_in','adjustment_out','damage','transfer_in','transfer_out')),
        source_table     TEXT NOT NULL DEFAULT '',
        source_id        TEXT NOT NULL DEFAULT '',
        qty_delta_milli  INTEGER NOT NULL CHECK(qty_delta_milli <> 0),
        unit_cost_paisa  INTEGER NOT NULL DEFAULT 0 CHECK(unit_cost_paisa >= 0),
        created_at       TEXT NOT NULL,
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS customer_credits (
        id                  TEXT PRIMARY KEY,
        shop_id             TEXT NOT NULL DEFAULT 'default',
        customer_id         TEXT NOT NULL,
        sale_id             TEXT,
        credit_date         TEXT NOT NULL,
        total_paisa         INTEGER NOT NULL CHECK(total_paisa > 0),
        initial_paid_paisa  INTEGER NOT NULL DEFAULT 0 CHECK(initial_paid_paisa >= 0),
        status              TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','void')),
        created_at          TEXT NOT NULL,
        CHECK(initial_paid_paisa <= total_paisa),
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS customer_payments (
        id            TEXT PRIMARY KEY,
        credit_id     TEXT NOT NULL,
        payment_date  TEXT NOT NULL,
        amount_paisa  INTEGER NOT NULL CHECK(amount_paisa <> 0),
        method        TEXT NOT NULL DEFAULT 'cash',
        note          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        FOREIGN KEY (credit_id) REFERENCES customer_credits(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS supplier_credits_erp (
        id                  TEXT PRIMARY KEY,
        shop_id             TEXT NOT NULL DEFAULT 'default',
        supplier_id         TEXT NOT NULL,
        purchase_id         TEXT,
        credit_date         TEXT NOT NULL,
        total_paisa         INTEGER NOT NULL CHECK(total_paisa > 0),
        initial_paid_paisa  INTEGER NOT NULL DEFAULT 0 CHECK(initial_paid_paisa >= 0),
        status              TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','void')),
        created_at          TEXT NOT NULL,
        CHECK(initial_paid_paisa <= total_paisa),
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT,
        FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS supplier_payments_erp (
        id            TEXT PRIMARY KEY,
        credit_id     TEXT NOT NULL,
        payment_date  TEXT NOT NULL,
        amount_paisa  INTEGER NOT NULL CHECK(amount_paisa <> 0),
        method        TEXT NOT NULL DEFAULT 'cash',
        note          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        FOREIGN KEY (credit_id) REFERENCES supplier_credits_erp(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS cash_accounts (
        id                     TEXT PRIMARY KEY,
        shop_id                TEXT NOT NULL DEFAULT 'default',
        name                   TEXT NOT NULL,
        type                   TEXT NOT NULL DEFAULT 'cash' CHECK(type IN ('cash','bank','mobile_money','owner')),
        opening_balance_paisa  INTEGER NOT NULL DEFAULT 0,
        active                 INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        UNIQUE(shop_id, name),
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS cash_ledger (
        id            TEXT PRIMARY KEY,
        shop_id       TEXT NOT NULL DEFAULT 'default',
        account_id    TEXT,
        entry_date    TEXT NOT NULL,
        direction     TEXT NOT NULL CHECK(direction IN ('in','out')),
        amount_paisa  INTEGER NOT NULL CHECK(amount_paisa > 0),
        source_table  TEXT NOT NULL DEFAULT '',
        source_id     TEXT NOT NULL DEFAULT '',
        note          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES cash_accounts(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id             TEXT PRIMARY KEY,
        shop_id        TEXT NOT NULL DEFAULT 'default',
        expense_date   TEXT NOT NULL,
        category       TEXT NOT NULL DEFAULT '',
        amount_paisa   INTEGER NOT NULL CHECK(amount_paisa > 0),
        note           TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
      );
    `
  },
  {
    version: 4,
    name: 'erp-indexes-triggers-views',
    sql: `
      CREATE INDEX IF NOT EXISTS ix_customers_shop_phone       ON customers(shop_id, phone);
      CREATE INDEX IF NOT EXISTS ix_suppliers_shop_phone       ON suppliers(shop_id, phone);
      CREATE INDEX IF NOT EXISTS ix_sales_shop_date            ON sales(shop_id, sale_date);
      CREATE INDEX IF NOT EXISTS ix_sale_items_sale            ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS ix_purchases_shop_date        ON purchases(shop_id, purchase_date);
      CREATE INDEX IF NOT EXISTS ix_purchase_items_purchase    ON purchase_items(purchase_id);
      CREATE INDEX IF NOT EXISTS ix_inventory_product_date     ON inventory_movements(shop_id, product_id, movement_date);
      CREATE INDEX IF NOT EXISTS ix_cash_ledger_shop_date      ON cash_ledger(shop_id, entry_date);
      CREATE INDEX IF NOT EXISTS ix_customer_credits_customer  ON customer_credits(customer_id, status);
      CREATE INDEX IF NOT EXISTS ix_supplier_credits_supplier  ON supplier_credits_erp(supplier_id, status);

      CREATE TRIGGER IF NOT EXISTS tr_inventory_no_negative_ins
      BEFORE INSERT ON inventory_movements
      FOR EACH ROW
      WHEN NEW.qty_delta_milli < 0
        AND COALESCE((SELECT current_stock * 1000 FROM product_stock WHERE shop_id = NEW.shop_id AND product_id = NEW.product_id), 0) + NEW.qty_delta_milli < 0
      BEGIN
        SELECT RAISE(ABORT, 'Inventory movement would make stock negative');
      END;

      CREATE TRIGGER IF NOT EXISTS tr_inventory_apply_ins
      AFTER INSERT ON inventory_movements
      FOR EACH ROW
      BEGIN
        INSERT INTO product_stock (shop_id, product_id, current_stock, updated_at)
        VALUES (NEW.shop_id, NEW.product_id, NEW.qty_delta_milli / 1000.0, NEW.created_at)
        ON CONFLICT(shop_id, product_id) DO UPDATE SET
          current_stock = current_stock + (NEW.qty_delta_milli / 1000.0),
          updated_at = NEW.created_at;
      END;

      CREATE TRIGGER IF NOT EXISTS tr_customer_payments_no_overpay_ins
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

      CREATE TRIGGER IF NOT EXISTS tr_supplier_payments_no_overpay_ins
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
      SELECT ps.shop_id, ps.product_id, p.name AS product_name, ps.current_stock
      FROM product_stock ps
      JOIN products p ON p.id = ps.product_id;

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

      CREATE VIEW IF NOT EXISTS v_sales_profit AS
      SELECT s.shop_id, s.id AS sale_id, s.sale_date,
             SUM(si.line_total_paisa) AS revenue_paisa,
             SUM((si.qty_milli * si.cogs_unit_paisa) / 1000) AS cogs_paisa,
             SUM(si.line_total_paisa - ((si.qty_milli * si.cogs_unit_paisa) / 1000)) AS gross_profit_paisa
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.status = 'posted'
      GROUP BY s.shop_id, s.id;

      CREATE VIEW IF NOT EXISTS v_cashbook AS
      SELECT shop_id, entry_date,
             SUM(CASE WHEN direction = 'in' THEN amount_paisa ELSE 0 END) AS cash_in_paisa,
             SUM(CASE WHEN direction = 'out' THEN amount_paisa ELSE 0 END) AS cash_out_paisa,
             SUM(CASE WHEN direction = 'in' THEN amount_paisa ELSE -amount_paisa END) AS net_paisa
      FROM cash_ledger
      GROUP BY shop_id, entry_date;
    `
  }
];

// Highest schema version this build knows how to create.
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
