// config.js — runtime configuration.
//
// The Render backend this file used to point at is gone: it stored to /tmp on a
// free plan, which was erased on every restart, and it held no data by the end.
// Data now lives in Supabase.
//
// The publishable key is safe in the browser - it maps to the `authenticated`
// role, which every RLS policy constrains. The secret key must never appear here.
window.KoshAgarConfig = window.KoshAgarConfig || {};

const __q = new URLSearchParams(window.location.search || '');

window.KoshAgarConfig.supabaseUrl =
  __q.get('supabaseUrl') || window.KoshAgarConfig.supabaseUrl ||
  'https://sgkzccuaeshfjpjisxoh.supabase.co';

window.KoshAgarConfig.supabaseKey =
  __q.get('supabaseKey') || window.KoshAgarConfig.supabaseKey ||
  'sb_publishable_kYb534EuQvxLyhD_De_wcg_s9rHR-uS';

// ---------------------------------------------------------------------------
// SWITCHED OFF, NOT DELETED
//
// Three earlier ways of storing the books are still in the repository. None of
// them runs, and none of them should: two places that answer "what is the cash
// in hand" is how a shop full of stock once read as empty. But they were real
// working code, so they are turned off by a switch rather than thrown away.
//
// Off means off - these are read before anything else happens, and nothing
// reaches the old code paths while they are false.
//
//   localSqlite     frontend/db/sqlite.js - the device's own SQL database.
//                   It is not even loaded: index.html has no <script> tag for
//                   it, so window.KoshDB never exists and every caller
//                   (the scenario suite, the reliability report) skips its
//                   block. To revive it, put the tag back in index.html - the
//                   build reads its file list from the page, so it will be
//                   shipped again with no other change.
//
//   firestoreSync   loadDataFromFirestore / saveDataToFirestore in index.html.
//                   The whole-blob cloud sync from before Supabase.
//
//   ownBackendSync  loadDataFromBackend / saveDataToBackend in index.html.
//                   The self-hosted SQLite backend on localhost:3001.
//
// The browser's own arithmetic in calc/financial.js is NOT in this list, and
// cannot be: the reports, the dashboard and the cashbook still get the shape of
// their figures from it (grouping, sorting, per-period aggregates), and the
// money in it is what the server figures are checked against on every load.
// Switching it off would empty those screens, not simplify them.
window.KoshAgarConfig.legacy = Object.assign({
  localSqlite: false,
  firestoreSync: false,
  ownBackendSync: false
}, window.KoshAgarConfig.legacy || {});

window.KOSH_LEGACY = window.KoshAgarConfig.legacy;

window.__KOSHAGAR_SUPABASE_URL = window.KoshAgarConfig.supabaseUrl;
window.__KOSHAGAR_SUPABASE_KEY = window.KoshAgarConfig.supabaseKey;
