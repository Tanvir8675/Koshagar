// data/supabase-api.js — the only thing in this app that talks to the server.
//
// Deliberately dependency-free: plain fetch against Supabase's REST endpoint,
// loaded as a classic script like every other file here. No build step, no npm,
// nothing to go stale in the service worker cache.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE
//
//   1. Every write goes through a database function. There is no insert() or
//      update() helper for sales, stock or cash - RLS refuses those writes
//      anyway, so offering them would only produce confusing failures.
//
//   2. No failure is silent. Every error surfaces with a message the shopkeeper
//      can act on. The old code was full of `catch(_) { return false; }`, which
//      is how months of data went missing without a single visible warning.
//
// Errors raised by the database carry a machine-readable prefix
// (INSUFFICIENT_STOCK, PARTY_REQUIRED, ...). translateError() turns those into
// plain sentences; anything unrecognised is passed through rather than
// swallowed, because an error nobody planned for is exactly the one worth
// seeing verbatim.

window.KoshApi = (function () {
  const URL_BASE = () => String(window.__KOSHAGAR_SUPABASE_URL || '').replace(/\/$/, '');
  const ANON_KEY = () => String(window.__KOSHAGAR_SUPABASE_KEY || '');

  // The signed-in user's access token. Until auth lands this stays null and the
  // anon key is used, which RLS will refuse for real data - deliberately, so
  // the gap is obvious rather than silently returning empty screens.
  let accessToken = null;

  const SESSION_KEY = 'koshagar-session';

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s && s.access_token) { accessToken = s.access_token; return s; }
    } catch (_) { /* a corrupt session is simply no session */ }
    return null;
  }

  function saveSession(session) {
    accessToken = session?.access_token || null;
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) { /* private browsing - the session just will not persist */ }
  }

  function headers(extra) {
    const key = ANON_KEY();
    return {
      apikey: key,
      Authorization: `Bearer ${accessToken || key}`,
      'Content-Type': 'application/json',
      ...(extra || {})
    };
  }

  // ---------------------------------------------------------------------
  // Error translation
  //
  // Keyed on the prefix the database raises. The message the database sends
  // already names the product and the shortfall, so it is used as-is where it
  // is good enough, and replaced where a shopkeeper needs plainer words.
  // ---------------------------------------------------------------------
  const ERROR_TEXT = {
    INSUFFICIENT_STOCK:  (m) => m.replace(/^INSUFFICIENT_STOCK:\s*/, '❌ Not enough stock. '),
    INSUFFICIENT_CASH:   (m) => m.replace(/^INSUFFICIENT_CASH:\s*/, '❌ Not enough cash in the drawer. '),
    PARTY_REQUIRED:      () => '❌ An unpaid bill needs a customer. Add the customer, or take full payment.',
    PARTY_NOT_FOUND:     () => '❌ That customer or supplier does not belong to this shop.',
    UNIT_NOT_DEFINED:    (m) => m.replace(/^UNIT_NOT_DEFINED:\s*/, '❌ Unit not set up. '),
    PRODUCT_NOT_FOUND:   () => '❌ One of the products on this bill no longer exists.',
    CASH_EXCEEDS_TOTAL:  (m) => m.replace(/^CASH_EXCEEDS_TOTAL:\s*/, '❌ Payment is more than the bill. '),
    OVERPAYMENT:         (m) => m.replace(/^OVERPAYMENT:\s*/, '❌ That would overpay the bill. '),
    OVER_ALLOCATION:     (m) => m.replace(/^OVER_ALLOCATION:\s*/, '❌ '),
    DIRECTION_MISMATCH:  () => '❌ A customer payment cannot settle a supplier bill, or the reverse.',
    PERIOD_CLOSED:       (m) => m.replace(/^PERIOD_CLOSED:\s*/, '🔒 '),
    EMPTY_DOCUMENT:      () => '❌ Add at least one item before saving.',
    INVALID_AMOUNT:      (m) => m.replace(/^INVALID_AMOUNT:\s*/, '❌ '),
    RETURN_EXCEEDS_ORIGINAL: (m) => m.replace(/^RETURN_EXCEEDS_ORIGINAL:\s*/, '❌ Too much to return. '),
    ALREADY_REVERSED:    (m) => m.replace(/^ALREADY_REVERSED:\s*/, 'ℹ️ '),
    PURCHASE_PARTLY_SOLD:(m) => m.replace(/^PURCHASE_PARTLY_SOLD:\s*/, '❌ '),
    // Raised by edit_document. Each one names the later document standing in
    // the way, because "cannot edit" on its own leaves nothing to do about it.
    HAS_RETURNS:         (m) => m.replace(/^HAS_RETURNS:\s*/, '❌ '),
    HAS_PAYMENTS:        (m) => m.replace(/^HAS_PAYMENTS:\s*/, '❌ '),
    // The database now names the sale in the way and says what to do about it
    // (43_return_undo_message.sql), so the sentence is passed through whole -
    // only the code and the icon are swapped.
    RETURN_STOCK_SOLD:   (m) => m.replace(/^RETURN_STOCK_SOLD:\s*/, '↩️ '),
    DOCUMENT_NOT_FOUND:  () => '❌ That entry is no longer in the books — reload and try again.',
    INVALID_TYPE:        (m) => m.replace(/^INVALID_TYPE:\s*/, '❌ '),
    INVALID_KIND:        (m) => m.replace(/^INVALID_KIND:\s*/, '❌ '),
    ORIGINAL_LINE_NOT_FOUND: () => '❌ The bill this return belongs to is no longer there.',
    DELETE_FORBIDDEN:    () => '❌ Posted entries cannot be deleted. Use Reverse instead — the original stays in the books.',
    NOT_A_MEMBER:        () => '❌ You do not have access to this shop.',
    NOT_OWNER:           () => '❌ Only the shop owner can do that.',
    NO_CASH_ACCOUNT:     () => '❌ No cash account set up for this shop.',
    LENDER_REQUIRED:     () => '❌ A loan must record who lent the money.'
  };

  function translateError(raw) {
    const msg = String(raw || 'Something went wrong.');
    const code = (msg.match(/^([A-Z_]{4,}):/) || [])[1];
    if (code && ERROR_TEXT[code]) {
      return { code, message: ERROR_TEXT[code](msg), raw: msg };
    }
    // Not one of ours - a network fault, a constraint we did not name, or a bug.
    // Passed through intact: an unplanned error is the one worth reading.
    if (/Failed to fetch|NetworkError|AbortError/i.test(msg)) {
      return { code: 'OFFLINE', message: '📡 No connection. Nothing was saved — check the internet and try again.', raw: msg };
    }
    // Reached only after the refresh above has already failed, so this is a
    // session that cannot be revived - said in words a shopkeeper can act on
    // rather than "JWT expired".
    if (/jwt expired|invalid jwt|token .*expired/i.test(msg)) {
      return { code: 'SESSION_EXPIRED',
               message: '🔐 Your session has expired. Nothing was saved — sign in again and retry.',
               raw: msg };
    }
    return { code: code || 'UNKNOWN', message: `❌ ${msg}`, raw: msg };
  }

  // ---------------------------------------------------------------------
  // KEEPING THE SESSION ALIVE
  //
  // The access token lasts about an hour. It was refreshed once, at startup,
  // and never again - so a shop that left the app open through the morning
  // found that every save failed with "JWT expired" and nothing but a reload
  // fixed it. A shopkeeper does not reload; they conclude the app is broken,
  // and in that moment it is.
  //
  // Two guards, because they fail differently:
  //
  //   BEFORE  every request, refresh if the token is within a minute of
  //           expiring. Costs nothing when it is not - refreshIfNeeded()
  //           returns immediately without a network call.
  //   AFTER   a 401 that names the token, refresh once and try again. Covers
  //           the cases the clock cannot predict: a laptop asleep for two
  //           hours, a device whose clock is wrong, a token revoked early.
  //
  // Single-flight. A page load fires nineteen reads at once; without the shared
  // promise each would start its own refresh, and every one but the first would
  // be spending a refresh token that had already been rotated away.
  let _refreshing = null;

  function keepSessionFresh(force) {
    const auth = window.KoshAuth;
    if (!auth || typeof auth.refreshIfNeeded !== 'function') return Promise.resolve();
    if (!_refreshing) {
      const session = auth.restore();
      // expires_at 0 makes refreshIfNeeded treat it as due, which is how the
      // retry path forces a refresh the clock did not think was needed.
      const arg = (force && session) ? { ...session, expires_at: 0 } : session;
      _refreshing = Promise.resolve(auth.refreshIfNeeded(arg))
        .catch(() => null)
        .then((fresh) => {
          // The refresh token is spent or revoked: this session cannot be
          // revived by anything the app can do on its own.
          //
          // Announced rather than handled here. A transport layer has no
          // business deciding what a screen does; it knows the session is gone
          // and says so, and the app decides that means going back to the
          // login page. See the listener in index.html.
          if (!fresh || !fresh.access_token) {
            try {
              window.dispatchEvent(new CustomEvent('kosh:session-expired'));
            } catch (_) { /* very old browser: the error message still shows */ }
          }
          return fresh;
        })
        .finally(() => { _refreshing = null; });
    }
    return _refreshing;
  }

  const isExpiredToken = (res, detail) =>
    res && res.status === 401 && /jwt|token/i.test(String(detail || ''));

  // ---------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------
  async function request(path, { method = 'GET', body, prefer, timeoutMs = 20000, _retried = false } = {}) {
    if (!URL_BASE()) throw Object.assign(new Error('Supabase URL is not configured.'), { code: 'CONFIG' });

    // Only when there is a session to keep; signed-out calls use the anon key.
    if (accessToken) await keepSessionFresh(false);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(`${URL_BASE()}/rest/v1${path}`, {
        method,
        headers: headers(prefer ? { Prefer: prefer } : null),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal
      });
      text = await res.text();
    } catch (netErr) {
      const t = translateError(netErr && netErr.message);
      throw Object.assign(new Error(t.message), t);
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = text; }

    if (!res.ok) {
      const detail = payload?.message || payload?.hint || payload?.error_description || text || res.statusText;

      // One retry, once. If the refresh itself fails the session is genuinely
      // gone and the error below says so - retrying again would only loop.
      if (!_retried && isExpiredToken(res, detail)) {
        await keepSessionFresh(true);
        if (accessToken) {
          return request(path, { method, body, prefer, timeoutMs, _retried: true });
        }
      }

      const t = translateError(detail);
      throw Object.assign(new Error(t.message), { ...t, status: res.status });
    }
    return payload;
  }

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------
  return {
    // Call a database function. This is how every write happens.
    rpc: (fn, args) => request(`/rpc/${fn}`, { method: 'POST', body: args || {} }),

    // Read a table or view. RLS narrows the rows to the caller's own shop, so
    // there is no shop filter to forget here.
    select(table, query) {
      const q = typeof query === 'string' ? query : new URLSearchParams(query || {}).toString();
      return request(`/${table}${q ? '?' + q : ''}`);
    },

    // Reads above PostgREST's page limit. The importer hit that cap silently
    // once and produced totals from a partial table; pages are explicit here so
    // it cannot happen again.
    async selectAll(table, query, pageSize = 1000) {
      const base = typeof query === 'string' ? query : new URLSearchParams(query || {}).toString();
      const out = [];
      for (let from = 0; ; from += pageSize) {
        const page = await request(`/${table}?${base}${base ? '&' : ''}limit=${pageSize}&offset=${from}`);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < pageSize) break;
      }
      return out;
    },

    // Master data may be written directly - RLS allows an owner to do so, and
    // creating a product has no financial side effects.
    insert: (table, rows) =>
      request(`/${table}`, { method: 'POST', body: rows, prefer: 'return=representation' }),
    update: (table, query, patch) =>
      request(`/${table}?${typeof query === 'string' ? query : new URLSearchParams(query).toString()}`,
              { method: 'PATCH', body: patch, prefer: 'return=representation' }),

    session: { load: loadSession, save: saveSession, get token() { return accessToken; } },
    translateError,
    get isConfigured() { return !!URL_BASE() && !!ANON_KEY(); }
  };
})();
