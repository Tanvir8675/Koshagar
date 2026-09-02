// data/auth.js — sign up, verify, sign in, and everything about passwords.
//
// Talks to Supabase Auth over plain fetch, matching supabase-api.js. No SDK, so
// nothing new enters the service worker cache and there is no build step.
//
// WHAT REPLACES THE OLD PIN
// The previous app hashed a 4-digit PIN and kept it in Firestore. That was the
// whole of its security: anyone who read the PIN could open the books, and a
// forgotten PIN needed a security question. This uses real accounts - a
// password Supabase salts and hashes, an emailed code to prove the address is
// yours, and a reset link that works without anyone knowing your old password.
//
// SIGNING IN WITH A USER ID
// Supabase authenticates by email. resolve_login_identifier() turns a chosen
// user id into the email behind it, and the sign-in proceeds normally. When the
// user id is unknown the sign-in is attempted anyway with a placeholder address,
// so a wrong user id fails exactly like a wrong password - same message, same
// delay. The form never confirms whether an account exists.

window.KoshAuth = (function () {
  const URL_BASE = () => String(window.__KOSHAGAR_SUPABASE_URL || '').replace(/\/$/, '');
  const ANON_KEY = () => String(window.__KOSHAGAR_SUPABASE_KEY || '');

  async function authFetch(path, { method = 'POST', body, token } = {}) {
    const res = await fetch(`${URL_BASE()}/auth/v1${path}`, {
      method,
      headers: {
        apikey: ANON_KEY(),
        Authorization: `Bearer ${token || ANON_KEY()}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!res.ok) {
      const raw = data?.msg || data?.error_description || data?.message || data?.error || text;
      throw Object.assign(new Error(friendly(raw, res.status)), { raw, status: res.status });
    }
    return data;
  }

  // Supabase's wording is aimed at developers. These are the ones a shopkeeper
  // will actually hit.
  function friendly(raw, status) {
    const m = String(raw || '');
    if (/Invalid login credentials/i.test(m))
      return '❌ Wrong user id, email or password.';
    if (/Email not confirmed/i.test(m))
      return '📧 Check your email and enter the code to finish signing up.';
    if (/User already registered|already been registered/i.test(m))
      return '❌ An account already exists for this email. Sign in instead, or use "Forgot password".';
    if (/Password should be at least/i.test(m))
      return '❌ Password must be at least 6 characters.';
    if (/Token has expired|expired/i.test(m))
      return '⏰ That code has expired. Send a new one.';
    if (/Invalid token|otp_expired|Token.*invalid/i.test(m))
      return '❌ That code is not right. Check it and try again.';
    if (/rate limit|too many/i.test(m))
      return '⏳ Too many attempts. Wait a minute and try again.';
    if (/Failed to fetch|NetworkError/i.test(m))
      return '📡 No connection. Check the internet and try again.';
    if (status === 422) return `❌ ${m}`;
    return `❌ ${m || 'Could not complete that. Please try again.'}`;
  }

  // ---------------------------------------------------------------------
  // Sign up
  // ---------------------------------------------------------------------
  async function isUsernameFree(username) {
    const res = await fetch(`${URL_BASE()}/rest/v1/rpc/username_available`, {
      method: 'POST',
      headers: { apikey: ANON_KEY(), Authorization: `Bearer ${ANON_KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_username: String(username || '').toLowerCase().trim() })
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  }

  function validateUsername(username) {
    const v = String(username || '').toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9_.]{2,29}$/.test(v)) {
      return '❌ User id must be 3–30 characters: letters, numbers, underscore or dot, starting with a letter or number.';
    }
    return null;
  }

  async function signUp({ email, username, password, fullName }) {
    const bad = validateUsername(username);
    if (bad) throw new Error(bad);
    if (String(password || '').length < 6) throw new Error('❌ Password must be at least 6 characters.');

    // Checked here so the account is never created with a handle that is taken.
    // The database settles a race by appending a number rather than failing.
    if (!(await isUsernameFree(username))) {
      throw new Error(`❌ The user id "${username}" is already taken. Try another.`);
    }

    return authFetch('/signup', {
      body: {
        email: String(email || '').trim().toLowerCase(),
        password,
        data: {
          username: String(username).toLowerCase().trim(),
          full_name: String(fullName || '').trim()
        }
      }
    });
  }

  // The emailed code. Supabase calls this type 'signup' for a new account and
  // 'email' for a later address change.
  const verifyOtp = ({ email, token, type = 'signup' }) =>
    authFetch('/verify', { body: { email: String(email).trim().toLowerCase(), token: String(token).trim(), type } })
      .then(keep);

  const resendOtp = ({ email, type = 'signup' }) =>
    authFetch('/resend', { body: { email: String(email).trim().toLowerCase(), type } });

  // ---------------------------------------------------------------------
  // Sign in — by email or by user id
  // ---------------------------------------------------------------------
  async function resolveIdentifier(identifier) {
    const v = String(identifier || '').trim().toLowerCase();
    if (!v) return null;
    if (v.includes('@')) return v;
    try {
      const res = await fetch(`${URL_BASE()}/rest/v1/rpc/resolve_login_identifier`, {
        method: 'POST',
        headers: { apikey: ANON_KEY(), Authorization: `Bearer ${ANON_KEY()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_identifier: v })
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  async function signIn({ identifier, password }) {
    const email = await resolveIdentifier(identifier);
    // An unknown user id still attempts a sign-in, so the failure is
    // indistinguishable from a wrong password. Telling the two apart would let
    // someone check which user ids exist.
    const session = await authFetch('/token?grant_type=password', {
      body: { email: email || `unknown-${Date.now()}@invalid.local`, password }
    });
    return keep(session);
  }

  function keep(session) {
    if (session && session.access_token) {
      window.KoshApi?.session?.save(session);
    }
    return session;
  }

  async function signOut() {
    const token = window.KoshApi?.session?.token;
    try { if (token) await authFetch('/logout', { token }); }
    catch (_) { /* the local session is cleared regardless */ }
    window.KoshApi?.session?.save(null);
  }

  // ---------------------------------------------------------------------
  // Passwords
  // ---------------------------------------------------------------------
  // Always resolves. Confirming whether an address is registered would let
  // anyone test emails against the shop.
  async function requestPasswordReset(identifier) {
    const email = await resolveIdentifier(identifier);
    if (email) { try { await authFetch('/recover', { body: { email } }); } catch (_) {} }
    return { ok: true, message: '📧 If that account exists, a reset link has been sent to its email.' };
  }

  const changePassword = (newPassword) => {
    if (String(newPassword || '').length < 6) {
      return Promise.reject(new Error('❌ Password must be at least 6 characters.'));
    }
    const token = window.KoshApi?.session?.token;
    if (!token) return Promise.reject(new Error('❌ Sign in before changing your password.'));
    return authFetch('/user', { method: 'PUT', token, body: { password: newPassword } });
  };

  const changeUsername = (newUsername) => {
    const bad = validateUsername(newUsername);
    if (bad) return Promise.reject(new Error(bad));
    return window.KoshApi.rpc('change_username', { p_new_username: String(newUsername).toLowerCase().trim() });
  };

  // ---------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------
  async function refreshIfNeeded(session) {
    if (!session?.refresh_token) return session;
    const expiresAt = (session.expires_at || 0) * 1000;
    if (expiresAt && expiresAt - Date.now() > 60000) return session;   // still good
    try {
      return keep(await authFetch('/token?grant_type=refresh_token',
                                  { body: { refresh_token: session.refresh_token } }));
    } catch (_) {
      window.KoshApi?.session?.save(null);   // refresh failed: sign in again
      return null;
    }
  }

  async function currentUser() {
    const token = window.KoshApi?.session?.token;
    if (!token) return null;
    try { return await authFetch('/user', { method: 'GET', token }); }
    catch (_) { return null; }
  }

  return {
    signUp, verifyOtp, resendOtp,
    signIn, signOut,
    requestPasswordReset, changePassword, changeUsername,
    isUsernameFree, validateUsername, resolveIdentifier,
    refreshIfNeeded, currentUser,
    restore: () => window.KoshApi?.session?.load() || null
  };
})();
