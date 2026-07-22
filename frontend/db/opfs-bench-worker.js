// opfs-bench-worker.js — Phase A proof: real SQLite-WASM on OPFS, in a Worker.
//
// Running SQLite in a Worker with the OPFS "SAHPool" VFS is the cross-platform
// path (Windows/Android/iOS/iPadOS/macOS): synchronous file access handles are
// allowed in workers on every modern browser, and heavy inserts never block the
// UI thread. This worker is a STANDALONE benchmark — it does NOT touch the app's
// real data. It proves the engine holds millions of rows and does bulk inserts
// smoothly before we rebuild the app on top of it.

import sqlite3InitModule from '../vendor/sqlite-wasm/index.mjs';

let db = null;

function reply(id, ok, payload) { self.postMessage({ id, ok, ...(payload || {}) }); }

self.onmessage = async (e) => {
  const { id, cmd, arg } = e.data || {};
  try {
    if (cmd === 'init') {
      const sqlite3 = await sqlite3InitModule();
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'koshagar-bench' });
      db = new pool.OpfsSAHPoolDb('/koshagar-bench.db');
      db.exec(`
        CREATE TABLE IF NOT EXISTS transactions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT, type TEXT, productId TEXT, qty REAL, price REAL, total REAL);
        CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
        CREATE INDEX IF NOT EXISTS idx_tx_prod ON transactions(productId);
        CREATE TABLE IF NOT EXISTS products(
          id TEXT PRIMARY KEY, name TEXT, unit TEXT, pp REAL, sp REAL);
      `);
      reply(id, true, {
        libVersion: sqlite3.version.libVersion,
        txCount: db.selectValue('SELECT COUNT(*) FROM transactions'),
        pCount: db.selectValue('SELECT COUNT(*) FROM products')
      });
      return;
    }

    if (cmd === 'insertTx') {
      const n = arg | 0;
      const t0 = performance.now();
      db.exec('BEGIN');
      const stmt = db.prepare('INSERT INTO transactions(date,type,productId,qty,price,total) VALUES(?,?,?,?,?,?)');
      try {
        for (let i = 0; i < n; i++) {
          const y = 2020 + (i % 6), m = 1 + (i % 12), d = 1 + (i % 28);
          const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const qty = 1 + (i % 10), price = 10 + (i % 500);
          stmt.bind([date, (i % 3 === 0 ? 'sale' : 'purchase'), 'P-' + (i % 3000), qty, price, qty * price]);
          stmt.step();
          stmt.reset();
        }
      } finally { stmt.finalize(); }
      db.exec('COMMIT');
      reply(id, true, { ms: performance.now() - t0, total: db.selectValue('SELECT COUNT(*) FROM transactions') });
      return;
    }

    if (cmd === 'insertProducts') {
      const n = arg | 0;
      const t0 = performance.now();
      db.exec('BEGIN');
      const stmt = db.prepare('INSERT OR REPLACE INTO products(id,name,unit,pp,sp) VALUES(?,?,?,?,?)');
      try {
        const batch = Date.now();
        for (let i = 0; i < n; i++) {
          stmt.bind([`P-${batch}-${i}`, 'Product ' + i, 'PCS', 10 + (i % 100), 15 + (i % 120)]);
          stmt.step();
          stmt.reset();
        }
      } finally { stmt.finalize(); }
      db.exec('COMMIT');
      reply(id, true, { ms: performance.now() - t0, total: db.selectValue('SELECT COUNT(*) FROM products') });
      return;
    }

    if (cmd === 'aggregate') {
      const t0 = performance.now();
      const rows = db.exec({
        sql: `SELECT date, SUM(total) AS revenue, COUNT(*) AS cnt
              FROM transactions WHERE type='sale'
              GROUP BY date ORDER BY date DESC LIMIT 30`,
        rowMode: 'object', returnValue: 'resultRows'
      });
      reply(id, true, { ms: performance.now() - t0, groups: rows.length, sample: rows.slice(0, 5) });
      return;
    }

    if (cmd === 'prune') {
      // Simulate 12-year retention: delete everything with date before the cutoff.
      // (In the real app this will ARCHIVE + roll forward opening balances first —
      // this benchmark only measures how fast a large bulk delete runs.)
      const cutoff = String(arg || '');
      const t0 = performance.now();
      const before = db.selectValue('SELECT COUNT(*) FROM transactions');
      db.exec({ sql: 'DELETE FROM transactions WHERE date < ?', bind: [cutoff] });
      db.exec('VACUUM');
      const after = db.selectValue('SELECT COUNT(*) FROM transactions');
      reply(id, true, { ms: performance.now() - t0, deleted: before - after, total: after });
      return;
    }

    if (cmd === 'clear') {
      db.exec('DELETE FROM transactions; DELETE FROM products; VACUUM;');
      reply(id, true, { txCount: 0, pCount: 0 });
      return;
    }

    reply(id, false, { error: 'Unknown command: ' + cmd });
  } catch (err) {
    reply(id, false, { error: (err && err.message) || String(err) });
  }
};
