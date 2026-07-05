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
  }
];

// Highest schema version this build knows how to create.
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
