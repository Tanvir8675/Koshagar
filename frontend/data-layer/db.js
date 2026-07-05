// db.js — main-thread async client for the on-disk SQLite engine.
//
// Framework-agnostic. Repositories (and later the React data providers) call
// these methods; the actual SQLite runs in db-worker.js on the OPFS disk file.
// Every method returns a Promise. No global data array, no full re-serialization.

let worker = null;
let seq = 0;
const pending = new Map();
let initPromise = null;

function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL('./db-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    const err = new Error('DB worker error: ' + (e.message || 'unknown'));
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
}

function call(cmd, arg) {
  ensureWorker();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, arg });
  });
}

export const db = {
  /** Open the on-disk DB and run migrations. Safe to call repeatedly. */
  init() {
    if (!initPromise) initPromise = call('init');
    return initPromise;
  },
  /** Read many → array of row objects. */
  query(sql, params) { return call('query', { sql, params }); },
  /** Read one → row object or null. */
  get(sql, params) { return call('get', { sql, params }); },
  /** Write one statement → { changes }. */
  run(sql, params) { return call('run', { sql, params }); },
  /** Atomic multi-statement write in ONE transaction → { changes }. */
  tx(steps) { return call('tx', { steps }); },
  /** Fast bulk insert (one prepared stmt, one txn) → { inserted }. */
  bulkInsert(table, columns, rows) { return call('bulkInsert', { table, columns, rows }); }
};
