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
      // Supabase's own mail service allows only a couple of emails per HOUR on
      // the free plan, and it is meant for testing rather than real use. Saying
      // "wait a minute" would send someone retrying pointlessly for an hour.
      return '⏳ Email limit reached. Supabase sends only 2–3 emails per hour until custom SMTP is set up. Wait an hour, or turn off email confirmation while testing.';
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

  // Where the confirmation link should land. Supabase falls back to the
  // project's Site URL when this is absent, which is why the link was arriving
  // at the app root and showing the old PIN screen. Sending it explicitly means
  // the page that started the signup is the page you come back to, whatever the
  // dashboard is set to.
  const hereUrl = () => location.origin + location.pathname;

  async function signUp({ email, username, password, fullName, redirectTo }) {
    const bad = validateUsername(username);
    if (bad) throw new Error(bad);
    if (String(password || '').length < 6) throw new Error('❌ Password must be at least 6 characters.');

    // Checked here so the account is never created with a handle that is taken.
    // The database settles a race by appending a number rather than failing.
    if (!(await isUsernameFree(username))) {
      throw new Error(`❌ The user id "${username}" is already taken. Try another.`);
    }

    const back = encodeURIComponent(redirectTo || hereUrl());
    return authFetch(`/signup?redirect_to=${back}`, {
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

  const resendOtp = ({ email, type = 'signup', redirectTo }) =>
    authFetch(`/resend?redirect_to=${encodeURIComponent(redirectTo || hereUrl())}`,
              { body: { email: String(email).trim().toLowerCase(), type } });

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
  // SILENT ABOUT WHO EXISTS, NOT ABOUT WHETHER IT WORKED.
  //
  // This used to swallow every error and say "sent" regardless. The reason for
  // the silence is sound - confirming that an address is registered would let
  // anyone test emails against the shop - but it was applied to failures that
  // reveal nothing about the address at all. When the mail service refuses
  // (rate limit, SMTP not configured, provider down) the screen still said the
  // code was on its way, and the person sat waiting for an email that was never
  // going to arrive, then blamed their inbox.
  //
  // Supabase's own email service allows only a couple of messages an hour, so a
  // 429 here is common and is the single likeliest reason a code "never came".
  //
  // The rule that survives: a 400 or 422 can only mean "no such address" or
  // something specific to it, so those keep the vague answer. Anything else -
  // 429, 5xx, no network at all - is about the SERVICE and is said plainly.
  async function requestPasswordReset(identifier) {
    const email = await resolveIdentifier(identifier);
    if (!email) {
      return { ok: true, message: '📧 If that account exists, a code has been sent to its email.' };
    }
    try {
      await authFetch(`/recover?redirect_to=${encodeURIComponent(hereUrl())}`, { body: { email } });
      return { ok: true, message: '📧 If that account exists, a code has been sent to its email.' };
    } catch (err) {
      const status = Number(err && err.status) || 0;
      if (status === 400 || status === 422) {
        return { ok: true, message: '📧 If that account exists, a code has been sent to its email.' };
      }
      if (status === 429) {
        const wait = /after (\d+) seconds?/i.exec(String(err.raw || ''));
        throw new Error(wait
          ? `⏳ Too many requests. Wait ${wait[1]} seconds and try again.`
          : '⏳ Too many reset emails have been sent from this account recently. Wait a few minutes and try again.');
      }
      throw new Error('❌ The email could not be sent right now — this is the mail service, not your account. Try again in a few minutes.');
    }
  }

  // Re-check the signed-in user's password for a sensitive action inside the
  // app (reset, delete-by-date, restore a snapshot, edit a settled payment).
  //
  // Deliberately does NOT call keep(): this is a confirmation, not a login, and
  // the live session must come out of it untouched. It also never says WHICH
  // part was wrong, and returns false rather than throwing, so a caller cannot
  // accidentally treat a network failure as a successful confirmation.
  async function verifyPassword(password) {
    if (!password) return false;
    const user = await currentUser();
    if (!user?.email) return false;
    try {
      await authFetch('/token?grant_type=password', {
        body: { email: user.email, password }
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // The same check, but able to say WHY it failed.
  //
  // verifyPassword() returns a plain false for both "that is not the password"
  // and "the request never arrived", which is exactly right for a confirmation
  // dialog: neither one may let the action through. The idle lock needs the
  // difference, because telling someone their password is wrong when the wifi
  // is off sends them to reset a password that was never the problem.
  //
  // 400/401 is the server refusing the password. Anything else - no status at
  // all, a timeout, a failed fetch - is a question that was never asked.
  async function verifyPasswordDetailed(password) {
    if (!password) return { ok: false, reason: 'empty' };
    const user = await currentUser();
    if (!user?.email) return { ok: false, reason: 'offline' };
    try {
      await authFetch('/token?grant_type=password', { body: { email: user.email, password } });
      return { ok: true, reason: 'ok' };
    } catch (err) {
      const status = Number(err && err.status) || 0;
      if (status === 400 || status === 401) return { ok: false, reason: 'wrong' };
      return { ok: false, reason: 'offline' };
    }
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
  // Arriving back from an emailed link
  // ---------------------------------------------------------------------
  // Supabase appends the session to the URL fragment (#access_token=...). The
  // fragment never reaches a server, which is why the tokens travel there - but
  // it also means they sit in the address bar and in browser history, so they
  // are cleared the moment they have been read.
  //
  // `type` says WHY you are here: 'recovery' means the person clicked a reset
  // link and still has to choose a new password, so the caller must not just
  // wave them into the app - the whole point is that they could not sign in.
  function sessionFromUrl() {
    const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    const clear = () => history.replaceState(null, '', location.pathname + location.search);

    if (h.get('error')) {
      const code = h.get('error_code') || '';
      clear();
      return { error: /expired/i.test(code)
        ? '⏰ That link has expired or was already used. Send a new one below.'
        : `❌ ${h.get('error_description') || 'That link did not work.'}` };
    }
    const access_token = h.get('access_token');
    if (!access_token) return null;
    const session = {
      access_token,
      refresh_token: h.get('refresh_token'),
      expires_at: Number(h.get('expires_at') || 0),
      token_type: h.get('token_type') || 'bearer'
    };
    const type = h.get('type') || '';
    clear();
    keep(session);
    return { session, type, isRecovery: type === 'recovery' };
  }

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
    } catch (err) {
      // WHY THE FAILURE MATTERS MORE THAN THE FAILURE.
      //
      // Two very different things were being treated alike: a server that says
      // "this refresh token is no longer valid" (400/401 - the session really
      // is over) and a request that never arrived at all (a tunnel, a dropped
      // wifi, a phone changing towers).
      //
      // The second was throwing away a perfectly good refresh token, which then
      // signed the shopkeeper out for a hiccup. The token is kept: the next
      // attempt, on the next request or the next load, will use it.
      const status = Number(err && err.status) || 0;
      if (status === 400 || status === 401 || status === 403) {
        window.KoshApi?.session?.save(null);   // genuinely over: sign in again
        return null;
      }
      return session;                          // could not ask - not the same as refused
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
    requestPasswordReset, changePassword, changeUsername, verifyPassword, verifyPasswordDetailed,
    isUsernameFree, validateUsername, resolveIdentifier,
    refreshIfNeeded, currentUser, sessionFromUrl,
    restore: () => window.KoshApi?.session?.load() || null
  };
})();
