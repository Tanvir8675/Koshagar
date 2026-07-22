// backend/server.js — KoshAgar backend.
//
// Phase 1 of the "shift authority to the backend" migration:
//   Storage is now a REAL SQLite database (Node's built-in node:sqlite engine —
//   zero external dependencies, no native build step). It replaces the old
//   single store.json blob, which rewrote the ENTIRE file on every save
//   (corruption risk + doesn't scale).
//
// IMPORTANT — the HTTP API is intentionally UNCHANGED so the frontend keeps
// working exactly as before (offline-first PWA; the browser is still the live
// app). This server is a durable, transactional server-side store/sync target:
//   GET  /api/health
//   POST /api/auth/register   { userId, pinHash, viewerPinHash, securityQuestion, securityAnswerHash }
//   POST /api/auth/login      { userId, pinHash }
//   GET  /api/data/:userId    -> { ok, userId, data, ids }
//   PUT  /api/data/:userId    { data, ids }
//
// Each user's app payload (`data`, `ids`) is stored as JSON in its own row.
// Later phases can normalise those JSON columns into relational tables
// (db/schema-relational.sql) WITHOUT changing this API.

import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ERP_SCHEMA_SQL } from './erp-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KOSHAGAR_DATA_DIR || path.join(__dirname, '.backend');
const DB_FILE = path.join(DATA_DIR, 'koshagar.db');
const LEGACY_STORE_FILE = path.join(DATA_DIR, 'store.json'); // one-time import source
const PORT = Number(process.env.PORT || 3001);

// Default per-user payload created on registration (identical to the old server).
function defaultData() {
  return {
    products: [], transactions: [], credits: [], payments: [],
    supplierCredits: [], supplierPayments: [], openingCashByDate: {},
    extraExpenses: [], cashWithdrawals: [], units: [], auditTrail: []
  };
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');   // durable, allows concurrent reads
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id              TEXT PRIMARY KEY,
    pin_hash             TEXT NOT NULL,
    viewer_pin_hash      TEXT NOT NULL DEFAULT '',
    security_question    TEXT NOT NULL DEFAULT '',
    security_answer_hash TEXT NOT NULL DEFAULT '',
    data_json            TEXT NOT NULL DEFAULT '{}',
    ids_json             TEXT NOT NULL DEFAULT '{}',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  );
`);
db.exec(ERP_SCHEMA_SQL);

// Prepared statements (reused).
const stmtGetUser = db.prepare('SELECT * FROM users WHERE user_id = ?');
const stmtInsertUser = db.prepare(`
  INSERT INTO users
    (user_id, pin_hash, viewer_pin_hash, security_question, security_answer_hash, data_json, ids_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateData = db.prepare('UPDATE users SET data_json = ?, ids_json = ?, updated_at = ? WHERE user_id = ?');
const stmtCountUsers = db.prepare('SELECT COUNT(*) AS n FROM users');
const stmtEnsureShop = db.prepare(`
  INSERT INTO shops (id, name, created_at, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
`);
const stmtEnsureMember = db.prepare(`
  INSERT OR IGNORE INTO user_shop_members (user_id, shop_id, role, created_at)
  VALUES (?, ?, 'owner', ?)
`);

function ensureErpShopForUser(userId, shopName = 'KoshAgar') {
  const uid = normalizeUserId(userId);
  if (!uid) return;
  const now = new Date().toISOString();
  stmtEnsureShop.run(uid, String(shopName || 'KoshAgar'), now, now);
  stmtEnsureMember.run(uid, uid, now);
}

// One-time migration: if a legacy store.json exists and the table is empty,
// import its users so no data is lost when upgrading from the JSON-blob server.
function migrateLegacyStoreIfNeeded() {
  if (stmtCountUsers.get().n > 0) return;
  if (!existsSync(LEGACY_STORE_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(LEGACY_STORE_FILE, 'utf8'));
    const users = (raw && raw.users) || {};
    const now = new Date().toISOString();
    let imported = 0;
    for (const [userId, u] of Object.entries(users)) {
      stmtInsertUser.run(
        userId,
        String(u.pinHash || ''),
        String(u.viewerPinHash || ''),
        String(u.securityQuestion || ''),
        String(u.securityAnswerHash || ''),
        JSON.stringify(u.data || defaultData()),
        JSON.stringify(u.ids || {}),
        String(u.createdAt || now),
        String(u.updatedAt || now)
      );
      imported++;
    }
    if (imported) console.log(`Migrated ${imported} user(s) from legacy store.json into SQLite.`);
  } catch (err) {
    console.warn('Legacy store.json import skipped:', err.message);
  }
}
migrateLegacyStoreIfNeeded();

// ---------------------------------------------------------------------------
// HTTP helpers (unchanged behaviour)
// ---------------------------------------------------------------------------
function normalizeUserId(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 5e6) {   // 5 MB cap (raised from 1 MB — full-account payloads can be large)
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseJsonColumn(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'koshagar-backend', store: 'sqlite' });
    return;
  }

  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const userId = normalizeUserId(body.userId);
      const pinHash = String(body.pinHash || '');
      if (!userId || !pinHash) {
        sendJson(res, 400, { ok: false, error: 'Missing userId or pinHash' });
        return;
      }
      if (stmtGetUser.get(userId)) {
        sendJson(res, 409, { ok: false, error: 'User already exists' });
        return;
      }
      const now = new Date().toISOString();
      stmtInsertUser.run(
        userId,
        pinHash,
        String(body.viewerPinHash || ''),
        String(body.securityQuestion || ''),
        String(body.securityAnswerHash || ''),
        JSON.stringify(defaultData()),
        JSON.stringify({}),
        now,
        now
      );
      ensureErpShopForUser(userId);
      sendJson(res, 200, { ok: true, userId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || 'Registration failed' });
    }
    return;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const userId = normalizeUserId(body.userId);
      const pinHash = String(body.pinHash || '');
      if (!userId || !pinHash) {
        sendJson(res, 400, { ok: false, error: 'Missing userId or pinHash' });
        return;
      }
      const user = stmtGetUser.get(userId);
      if (!user || user.pin_hash !== pinHash) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      ensureErpShopForUser(userId);
      sendJson(res, 200, { ok: true, userId: user.user_id, role: 'owner' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || 'Login failed' });
    }
    return;
  }

  const dataMatch = url.pathname.match(/^\/api\/data\/(.+)$/);
  if (dataMatch && req.method === 'GET') {
    try {
      const userId = normalizeUserId(decodeURIComponent(dataMatch[1]));
      const user = stmtGetUser.get(userId);
      if (!user) {
        sendJson(res, 404, { ok: false, error: 'User not found' });
        return;
      }
      ensureErpShopForUser(userId);
      sendJson(res, 200, {
        ok: true,
        userId,
        data: parseJsonColumn(user.data_json, defaultData()),
        ids: parseJsonColumn(user.ids_json, {}),
        updatedAt: user.updated_at   // lets the client do newer-wins conflict handling
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || 'Load failed' });
    }
    return;
  }

  if (dataMatch && req.method === 'PUT') {
    try {
      const userId = normalizeUserId(decodeURIComponent(dataMatch[1]));
      const body = await readBody(req);
      const user = stmtGetUser.get(userId);
      if (!user) {
        sendJson(res, 404, { ok: false, error: 'User not found' });
        return;
      }
      const dataJson = JSON.stringify(body.data || parseJsonColumn(user.data_json, defaultData()));
      const idsJson = JSON.stringify(body.ids || parseJsonColumn(user.ids_json, {}));
      stmtUpdateData.run(dataJson, idsJson, new Date().toISOString(), userId);
      ensureErpShopForUser(userId, body?.data?.shopName || 'KoshAgar');
      sendJson(res, 200, { ok: true, userId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || 'Save failed' });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}  (store: SQLite @ ${DB_FILE})`);
});
