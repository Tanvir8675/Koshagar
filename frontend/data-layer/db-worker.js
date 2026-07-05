// db-worker.js — the on-disk SQLite engine (KoshAgar data layer).
//
// Runs official SQLite-WASM on the OPFS "SAHPool" VFS inside a Worker. This is
// the whole point of the new architecture:
//   * The database is a FILE ON DISK (OPFS) — not held in RAM.
//   * Writes are INCREMENTAL — a single INSERT/UPDATE/DELETE touches one row and
//     SQLite writes just the affected pages. No "export the whole DB" on save.
//   * Runs off the UI thread → the app never freezes, even under heavy load.
//
// Cross-platform (Windows/Android/iOS/iPadOS/macOS): sync file access handles are
// allowed in Workers on every modern browser, so this works everywhere OPFS does.
//
// Message protocol: { id, cmd, arg } in  →  { id, ok, result | error } out.

import sqlite3InitModule from '../vendor/sqlite-wasm/index.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

let db = null;

function reply(id, ok, payload) {
  self.postMessage({ id, ok, ...(ok ? { result: payload } : { error: payload }) });
}

// Apply any migrations newer than the DB's recorded user_version, in one txn each.
function runMigrations() {
  const current = db.selectValue('PRAGMA user_version') || 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
  return db.selectValue('PRAGMA user_version');
}

const HANDLERS = {
  async init() {
    if (db) return { version: db.selectValue('PRAGMA user_version'), reopened: true };
    const sqlite3 = await sqlite3InitModule();
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'koshagar-data' });
    db = new pool.OpfsSAHPoolDb('/koshagar.db');
    db.exec('PRAGMA foreign_keys = ON;');
    const version = runMigrations();
    return { libVersion: sqlite3.version.libVersion, version, schemaVersion: SCHEMA_VERSION };
  },

  // Read: returns array of row objects.
  query({ sql, params }) {
    return db.exec({ sql, bind: params || [], rowMode: 'object', returnValue: 'resultRows' });
  },

  // Read one: first row object or null.
  get({ sql, params }) {
    const rows = db.exec({ sql, bind: params || [], rowMode: 'object', returnValue: 'resultRows' });
    return rows.length ? rows[0] : null;
  },

  // Write one statement. Returns rows changed.
  run({ sql, params }) {
    db.exec({ sql, bind: params || [] });
    return { changes: db.changes() };
  },

  // Atomic multi-statement write: [{ sql, params }, ...] in ONE transaction.
  tx({ steps }) {
    db.exec('BEGIN');
    try {
      let changes = 0;
      for (const s of steps) { db.exec({ sql: s.sql, bind: s.params || [] }); changes += db.changes(); }
      db.exec('COMMIT');
      return { changes };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },

  // Efficient bulk insert: one prepared statement, one transaction. This is the
  // fix for "3,000 products at once" — thousands of incremental row inserts in a
  // single fast transaction instead of N full-DB rewrites.
  bulkInsert({ table, columns, rows }) {
    const placeholders = columns.map(() => '?').join(',');
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`;
    const stmt = db.prepare(sql);
    db.exec('BEGIN');
    try {
      let n = 0;
      for (const row of rows) { stmt.bind(columns.map(c => row[c] ?? null)); stmt.step(); stmt.reset(); n++; }
      db.exec('COMMIT');
      return { inserted: n };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      stmt.finalize();
    }
  }
};

self.onmessage = async (e) => {
  const { id, cmd, arg } = e.data || {};
  const handler = HANDLERS[cmd];
  if (!handler) { reply(id, false, 'Unknown command: ' + cmd); return; }
  try {
    reply(id, true, await handler(arg || {}));
  } catch (err) {
    reply(id, false, (err && err.message) || String(err));
  }
};
