const STORAGE_KEY = 'sk-auth';

interface StoredAuth { serverBase: string; token: string; username: string; }

let _token: string | null = $state(null);
let _username: string | null = $state(null);
let _loading: boolean = $state(false);
let _error: string | null = $state(null);

function loadFromStorage(serverBase: string): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as StoredAuth;
      if (stored.serverBase === serverBase) {
        _token    = stored.token;
        _username = stored.username;
        return;
      }
    }
  } catch { /* ignore corrupt storage */ }
  _token    = null;
  _username = null;
}

function saveToStorage(serverBase: string, token: string, username: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ serverBase, token, username } satisfies StoredAuth));
}

function createAuth() {
  return {
    get isLoggedIn() { return _token !== null; },
    get username()   { return _username; },
    get token()      { return _token; },
    get loading()    { return _loading; },
    get error()      { return _error; },

    get authHeaders(): Record<string, string> {
      return (_token && _token !== 'cookie') ? { Authorization: `Bearer ${_token}` } : {};
    },

    /** Call whenever the server URL changes — loads the stored token for that server. */
    async init(serverBase: string): Promise<void> {
      loadFromStorage(serverBase);
      // Probe validate: covers both the cookie (same-origin) and stored-token cases.
      // On success the server may return a fresh token — store it.
      try {
        const headers: Record<string, string> = _token
          ? { Authorization: `Bearer ${_token}` }
          : {};
        const res = await fetch(`${serverBase}/signalk/v1/auth/validate`, {
          method: 'POST',
          headers,
          credentials: 'include', // send browser cookie for same-origin installs
        });
        if (res.ok) {
          const data = await res.json() as { token?: string; login?: { token?: string } };
          const fresh = data.token ?? data.login?.token ?? null;
          if (fresh) {
            // Renew stored token if we have a username, otherwise just mark cookie-authed.
            if (_username) saveToStorage(serverBase, fresh, _username);
            _token = fresh;
          }
          // If we had no token but cookie auth worked, flag as logged in without a username.
          if (!_token && res.ok) {
            _token    = 'cookie';  // sentinel — cookie auth, no JWT to store
            _username = '(session)';
          }
        } else if (res.status === 401) {
          // Stored token expired — clear it.
          _token    = null;
          _username = null;
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch { /* server unreachable — keep whatever we loaded from storage */ }
    },

    async login(serverBase: string, username: string, password: string): Promise<void> {
      _loading = true;
      _error   = null;
      try {
        const res = await fetch(`${serverBase}/signalk/v1/auth/login`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ username, password }),
        });
        if (res.status === 401) { _error = 'Invalid username or password.'; return; }
        if (res.status === 501) { _error = 'This server does not support authentication.'; return; }
        if (!res.ok)            { _error = `Login failed (${res.status}).`; return; }

        const data = await res.json() as { token?: string };
        if (!data.token) { _error = 'Server returned no token.'; return; }

        _token    = data.token;
        _username = username;
        saveToStorage(serverBase, data.token, username);
      } catch (e) {
        _error = `Connection error: ${String(e)}`;
      } finally {
        _loading = false;
      }
    },

    logout(): void {
      _token    = null;
      _username = null;
      _error    = null;
      localStorage.removeItem(STORAGE_KEY);
    },
  };
}

export const auth = createAuth();
