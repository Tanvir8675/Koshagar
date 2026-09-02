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

window.__KOSHAGAR_SUPABASE_URL = window.KoshAgarConfig.supabaseUrl;
window.__KOSHAGAR_SUPABASE_KEY = window.KoshAgarConfig.supabaseKey;
