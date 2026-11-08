// Google sign-in with Google Identity Services (OAuth 2.0 token model).
// Scope drive.file: the app can only see files it created itself in the user's Drive.

export const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email profile';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_URL = 'https://accounts.google.com/gsi/client';

export function loadGis(timeoutMs = 15000) {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (loadGis.p) return loadGis.p;
  loadGis.p = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = GIS_URL; s.async = true; s.defer = true;
    const timer = setTimeout(() => { loadGis.p = null; rej(new Error('gis-timeout')); }, timeoutMs);
    s.onload = () => { clearTimeout(timer); res(); };
    s.onerror = () => { clearTimeout(timer); loadGis.p = null; s.remove(); rej(new Error('gis-load')); };
    document.head.append(s);
  });
  return loadGis.p;
}

export class Auth {
  constructor(clientId) {
    this.clientId = clientId;
    this.client = null;
    this.account = JSON.parse(localStorage.getItem('mn.account') || 'null');
    this.token = this.account ? JSON.parse(localStorage.getItem('mn.tok.' + this.account.sub) || 'null') : null;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  _emit() { for (const f of this.listeners) f(this.state()); }
  state() { return this.valid() ? 'ok' : (this.account ? 'expired' : 'signedout'); }
  valid() { return !!(this.token && this.token.access_token && this.token.expires_at - 60000 > Date.now()); }
  accessToken() { return this.valid() ? this.token.access_token : null; }

  async _client() {
    await loadGis();
    if (!this.client) {
      this.client = window.google.accounts.oauth2.initTokenClient({
        client_id: this.clientId, scope: SCOPES, callback: () => {},
        error_callback: (err) => { if (this._reject) this._reject(Object.assign(new Error(err && err.type || 'popup'), { type: err && err.type })); },
      });
    }
    return this.client;
  }

  _request(params) {
    return new Promise((resolve, reject) => {
      this._reject = reject;
      this._client().then(c => {
        c.callback = (resp) => {
          if (!resp || resp.error) { reject(Object.assign(new Error(resp && resp.error || 'auth'), { type: resp && resp.error })); return; }
          resolve(resp);
        };
        c.requestAccessToken(params);
      }, reject);
    });
  }

  // Interactive sign in (must run from a click).
  async signIn() {
    const resp = await this._request({ prompt: 'select_account' });
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
      const e = new Error('drive-scope-missing'); e.type = 'scope'; throw e;
    }
    const info = await this._userinfo(resp.access_token);
    this.account = { sub: info.sub, email: info.email, name: info.name || info.email };
    localStorage.setItem('mn.account', JSON.stringify(this.account));
    this._saveToken(resp);
    this._emit();
    return this.account;
  }

  // Quiet refresh: no account chooser; usually a popup that closes by itself. Best from a click.
  async reconnect() {
    const resp = await this._request({ prompt: '', login_hint: this.account ? this.account.email : undefined });
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) { const e = new Error('drive-scope-missing'); e.type = 'scope'; throw e; }
    const info = await this._userinfo(resp.access_token);
    if (this.account && info.sub !== this.account.sub) {
      const e = new Error('different-account'); e.type = 'other-account'; e.email = info.email; throw e;
    }
    this._saveToken(resp);
    this._emit();
  }

  async _userinfo(token) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('userinfo ' + r.status);
    return r.json();
  }

  _saveToken(resp) {
    this.token = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
    localStorage.setItem('mn.tok.' + this.account.sub, JSON.stringify(this.token));
  }

  expire() {
    if (this.token) { this.token.expires_at = 0; if (this.account) localStorage.setItem('mn.tok.' + this.account.sub, JSON.stringify(this.token)); }
    this._emit();
  }

  signOut() {
    const tok = this.token && this.token.access_token;
    if (tok && window.google && window.google.accounts && window.google.accounts.oauth2) {
      try { window.google.accounts.oauth2.revoke(tok, () => {}); } catch (e) { /* ignore */ }
    }
    if (this.account) localStorage.removeItem('mn.tok.' + this.account.sub);
    localStorage.removeItem('mn.account');
    this.account = null; this.token = null;
    this._emit();
  }
}
