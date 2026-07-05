// modules/reliability.js — Reliability & diagnostics layer (checklist Phases 2,3,5,6)
// Phase 3 extraction + new hardening. Classic script sharing index.html's global
// scope; loads before app.js. Additive only — provides utilities, durability
// state, global error handlers, retry, memory/perf monitoring, and a console
// diagnostics dashboard. Does NOT change existing save/load logic (the Phase-1
// durability guards that DO touch save/load live in index.html).

// ===== Durability state (used by saveData/loadData/loadDataFromFirestore) =====
window.__localDataUpdatedAt = window.__localDataUpdatedAt || 0;   // ms of last local save
window.__pendingCloudSave   = false;                              // Firestore save in flight?
window.__lastLocalSaveTime  = window.__lastLocalSaveTime || 0;    // last successful local save
window.__dataIsStale        = false;                              // in-memory differs from disk?
window.__syncLockout        = false;                              // prevent concurrent cloud loads
window.__lastValidDataSnapshot = null;                            // last known-good state

// ===== P2.1: Debounce / Throttle / Batch ====================================
// NOTE: debounceAndSave is provided as a TOOL. It is intentionally NOT used to
// replace the app's awaited saves (runEngineCommand awaits saveData so a save
// can never be lost mid-close). Use only for non-critical, high-frequency saves.
function debounceAndSave(delayMs = 1000) {
  if (window.__saveDebounceTimer) clearTimeout(window.__saveDebounceTimer);
  window.__savePending = true;
  window.__saveDebounceTimer = setTimeout(() => {
    Promise.resolve(typeof saveData === 'function' ? saveData() : null)
      .finally(() => { window.__savePending = false; window.__saveDebounceTimer = null; });
  }, delayMs);
}

function throttle(func, delayMs = 300) {
  let lastRun = 0, scheduled = false, lastArgs = null;
  return function (...args) {
    lastArgs = args;
    const now = Date.now(), since = now - lastRun;
    if (since >= delayMs) { lastRun = now; scheduled = false; func.apply(this, args); }
    else if (!scheduled) {
      scheduled = true;
      setTimeout(() => { lastRun = Date.now(); scheduled = false; func.apply(this, lastArgs); }, delayMs - since);
    }
  };
}

class BatchProcessor {
  constructor(processFn, delayMs = 500) { this.processFn = processFn; this.delayMs = delayMs; this.queue = []; this.timer = null; }
  add(item) { this.queue.push(item); this._schedule(); }
  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      const batch = this.queue; this.queue = []; this.timer = null;
      if (batch.length) this.processFn(batch);
    }, this.delayMs);
  }
}

// Throttled render wrappers (available; safe to use in high-frequency listeners)
const throttledRenderDashboard = () => { if (typeof renderDashboard === 'function') throttle(renderDashboard, 300)(); };

// ===== P5.3: fetchWithRetry (exponential backoff) ===========================
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  const baseDelay = options.retryDelayMs || 1000;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status >= 500 || response.status === 408) { lastError = `HTTP ${response.status}`; }
      else throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) { lastError = err.message; }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  throw new Error(`Fetch failed after ${maxRetries} attempts: ${lastError}`);
}

// ===== P3.1: Memory monitor =================================================
class MemoryMonitor {
  constructor() { this.checkInterval = null; this.maxMemoryMB = 250; this.history = []; }
  start() {
    if (this.checkInterval || !(performance && performance.memory)) return;
    this.checkInterval = setInterval(() => {
      const usedMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(2);
      const limitMB = +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(2);
      // P3.2: reuse sample objects from the ObjectPool instead of allocating each tick.
      const sample = this.pool ? this.pool.acquire() : { time: 0, used: 0, limit: 0 };
      sample.time = Date.now(); sample.used = usedMB; sample.limit = limitMB;
      this.history.push(sample);
      if (usedMB > this.maxMemoryMB) console.warn(`[mem] HIGH: ${usedMB}MB / ${limitMB}MB`);
      if (this.history.length > 100) { const old = this.history.shift(); if (this.pool) this.pool.release(old); }
    }, 30000);
  }
  stop() { if (this.checkInterval) { clearInterval(this.checkInterval); this.checkInterval = null; } }
  getReport() {
    if (!(performance && performance.memory)) return 'performance.memory not available in this browser';
    return {
      current: (performance.memory.usedJSHeapSize / 1048576).toFixed(2) + ' MB',
      limit: (performance.memory.jsHeapSizeLimit / 1048576).toFixed(2) + ' MB',
      samples: this.history.length
    };
  }
}
const memoryMonitor = new MemoryMonitor();

// ===== P3.2: Object pool (infrastructure) ===================================
class ObjectPool {
  constructor(factory, resetFn, initialSize = 10) {
    this.factory = factory; this.resetFn = resetFn; this.available = []; this.inUse = new Set();
    for (let i = 0; i < initialSize; i++) this.available.push(factory());
  }
  acquire() { const o = this.available.pop() || this.factory(); this.inUse.add(o); return o; }
  release(o) { if (this.inUse.has(o)) { this.inUse.delete(o); this.resetFn(o); this.available.push(o); } }
  getStats() { return { available: this.available.length, inUse: this.inUse.size }; }
}

// ===== P3.3: Lazy page loader (the app also uses renderPaged) ===============
class LazyReportLoader {
  constructor(data, pageSize = 100) { this.data = data; this.pageSize = pageSize; this.cache = new Map(); }
  loadPage(pageNum) {
    if (this.cache.has(pageNum)) return this.cache.get(pageNum);
    const start = pageNum * this.pageSize;
    const page = this.data.slice(start, start + this.pageSize);
    this.cache.set(pageNum, page);
    if (this.cache.size > 3) this.cache.delete(Math.min(...this.cache.keys()));
    return page;
  }
  getTotalPages() { return Math.ceil(this.data.length / this.pageSize); }
}

// ===== P3.4: Generic TTL cache (note: calc already has its own memoization) =
class CacheManager {
  constructor() { this.caches = new Map(); this.ttl = 5 * 60 * 1000; }
  set(key, value, ttlMs = this.ttl) { this.caches.set(key, { value, expires: Date.now() + ttlMs }); }
  get(key) {
    const e = this.caches.get(key);
    if (!e) return null;
    if (Date.now() > e.expires) { this.caches.delete(key); return null; }
    return e.value;
  }
  invalidate(pattern) { for (const k of this.caches.keys()) if (String(k).includes(pattern)) this.caches.delete(k); }
  clear() { this.caches.clear(); }
  getStats() { return { total: this.caches.size }; }
}
const cacheManager = new CacheManager();

// ===== P6.1: Performance profiler ===========================================
class PerformanceProfiler {
  constructor() { this.metrics = new Map(); }
  time(label, fn) {
    const t0 = performance.now();
    try { return fn(); }
    finally {
      const d = performance.now() - t0;
      if (!this.metrics.has(label)) this.metrics.set(label, []);
      const arr = this.metrics.get(label); arr.push(d); if (arr.length > 200) arr.shift();
    }
  }
  getStats(label) {
    const t = this.metrics.get(label) || [];
    if (!t.length) return null;
    return { count: t.length, min: +Math.min(...t).toFixed(2), max: +Math.max(...t).toFixed(2), avg: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(2), last: +t[t.length - 1].toFixed(2) };
  }
  report() { const r = {}; for (const k of this.metrics.keys()) r[k] = this.getStats(k); return r; }
}
const profiler = new PerformanceProfiler();

// ===== P5.1: Global error boundary + unhandled rejection ====================
window.addEventListener('unhandledrejection', (event) => {
  console.error('[unhandledrejection]', event.reason);
  try { if (typeof auditLog === 'function') auditLog('unhandled_rejection', { reason: String(event.reason && event.reason.message || event.reason) }); } catch (_) {}
  event.preventDefault(); // avoid console noise / white-screen
});
// (index.html already has a window 'error' boundary; this complements it.)

// ===== P6.2: Diagnostics dashboard (run koshDiagnostics() in console) ========
function koshDiagnostics() {
  const cachedReport = cacheManager.get('diagnostics'); // P3.4: serve cached report (3s TTL)
  if (cachedReport) { console.log('%c KoshAgar diagnostics (cached) ', 'background:#222;color:#0f0'); console.log(cachedReport); return cachedReport; }
  const d = (typeof data !== 'undefined' && data) ? data : {};
  const auditLoader = new LazyReportLoader(d.auditTrail || [], 50); // P3.3: paged audit access
  const report = {
    dataSize: {
      products: (d.products || []).length,
      transactions: (d.transactions || []).length,
      credits: (d.credits || []).length,
      supplierCredits: (d.supplierCredits || []).length,
      payments: (d.payments || []).length,
      totalBytes: JSON.stringify(d).length
    },
    sqlite: (window.KoshDB && KoshDB.available) ? {
      available: true,
      schemaVersion: KoshDB.schemaVersion || 'unknown',
      transactions: KoshDB.rowCount('transactions'),
      products: KoshDB.rowCount('products'),
      lastSyncAt: KoshDB.lastSyncAt,
      integrity: KoshDB.checkIntegrity()
    } : { available: false },
    sync: {
      localDataUpdatedAt: window.__localDataUpdatedAt ? new Date(window.__localDataUpdatedAt).toISOString() : 'never',
      pendingCloudSave: window.__pendingCloudSave,
      lastLocalSaveTime: window.__lastLocalSaveTime ? new Date(window.__lastLocalSaveTime).toISOString() : 'never',
      syncLockout: window.__syncLockout
    },
    memory: memoryMonitor.getReport(),
    perf: profiler.report(),
    cache: cacheManager.getStats(),
    auditTrail: { total: (d.auditTrail || []).length, pages: auditLoader.getTotalPages(), latest: auditLoader.loadPage(0).slice(-5) }
  };
  cacheManager.set('diagnostics', report, 3000);
  console.log('%c KoshAgar diagnostics ', 'background:#222;color:#0f0');
  console.log(report);
  return report;
}
window.koshDiagnostics = koshDiagnostics;

// ===== P2.2 (safe): coalesce cloud saves; flush on background/close =========
// The LOCAL save (IndexedDB/localStorage) stays awaited in saveData() so it can
// never be lost. Only the slower CLOUD (Firestore) save is debounced/coalesced
// here and force-flushed when the app is hidden or closed — so a queued cloud
// save is never dropped, while rapid mutations collapse into a single PATCH.
let __cloudSaveTimer = null, __cloudSaveQueued = false;
function scheduleCloudSave(delayMs = 1500) {
  __cloudSaveQueued = true;
  if (__cloudSaveTimer) clearTimeout(__cloudSaveTimer);
  __cloudSaveTimer = setTimeout(runQueuedCloudSave, delayMs);
}
function runQueuedCloudSave() {
  if (__cloudSaveTimer) { clearTimeout(__cloudSaveTimer); __cloudSaveTimer = null; }
  if (!__cloudSaveQueued || typeof saveDataToFirestore !== 'function') return;
  __cloudSaveQueued = false;
  const t0 = performance.now();
  Promise.resolve(saveDataToFirestore()).catch(() => {}).finally(() => {
    // P6.1: record cloud-save duration in the profiler (shown by koshDiagnostics).
    const a = profiler.metrics.get('cloudSave') || []; a.push(performance.now() - t0); if (a.length > 200) a.shift(); profiler.metrics.set('cloudSave', a);
  });
}
function flushCloudSave() { runQueuedCloudSave(); }
window.scheduleCloudSave = scheduleCloudSave;
window.flushCloudSave = flushCloudSave;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushCloudSave(); });
window.addEventListener('pagehide', flushCloudSave);
window.addEventListener('beforeunload', flushCloudSave);

// Expose instances on window so cross-file code (e.g. saveData's cache
// invalidation) and the console can reach them.
window.cacheManager = cacheManager;
window.profiler = profiler;
window.memoryMonitor = memoryMonitor;

// Wire the ObjectPool into the memory monitor, then start it (P3.1/P3.2).
memoryMonitor.pool = new ObjectPool(() => ({ time: 0, used: 0, limit: 0 }), o => { o.time = 0; o.used = 0; o.limit = 0; }, 8);
try { memoryMonitor.start(); } catch (_) {}
