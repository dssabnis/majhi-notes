// Minimal Google Drive v3 REST client (drive.file scope: the app only sees files it created).
// fetchFn and getToken are injected so tests can run against a mocked Drive.

export class AuthError extends Error { constructor(msg) { super(msg || 'auth'); this.name = 'AuthError'; } }
export class NetError extends Error { constructor(msg) { super(msg || 'network'); this.name = 'NetError'; } }

const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export class Drive {
  constructor({ getToken, fetchFn }) {
    this.getToken = getToken;
    this.fetch = fetchFn || ((...a) => globalThis.fetch(...a));
  }

  async _req(url, opts = {}, kind = 'json') {
    const token = await this.getToken();
    if (!token) throw new AuthError('no token');
    let r;
    try {
      r = await this.fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    } catch (e) { throw new NetError(e && e.message); }
    if (r.status === 401) throw new AuthError('401');
    if (r.status === 403) {
      let txt = ''; try { txt = await r.text(); } catch (e) { /* ignore */ }
      if (/rateLimit|userRateLimit/i.test(txt)) throw new NetError('rate limited');
      throw new AuthError('403 ' + txt.slice(0, 200));
    }
    if (r.status === 204) return null;
    if (!r.ok) {
      let txt = ''; try { txt = await r.text(); } catch (e) { /* ignore */ }
      const err = new NetError(`Drive ${r.status}: ${txt.slice(0, 200)}`); err.status = r.status; throw err;
    }
    if (kind === 'json') return r.json();
    if (kind === 'buffer') return r.arrayBuffer();
    return r.text();
  }

  async list(query, fields = 'id,name,modifiedTime,appProperties') {
    const out = [];
    let pageToken = '';
    do {
      const p = new URLSearchParams({ q: query, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces: 'drive' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await this._req(`${API}/files?${p}`);
      out.push(...(r.files || []));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  async findOrCreateFolder(name, parentId) {
    let query = `name = '${q(name)}' and mimeType = '${FOLDER}' and trashed = false`;
    query += parentId ? ` and '${q(parentId)}' in parents` : ` and 'root' in parents`;
    const found = await this.list(query, 'id,name,createdTime');
    if (found.length) {
      found.sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')));
      return found[0].id;
    }
    const meta = { name, mimeType: FOLDER };
    if (parentId) meta.parents = [parentId];
    const r = await this._req(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta),
    });
    return r.id;
  }

  _multipart(meta, data, mime) {
    const boundary = 'majhi' + Math.random().toString(36).slice(2);
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = new Blob([head, data, tail]);
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }

  async create({ name, parentId, appProperties, data, mime = 'application/json' }) {
    if (data instanceof Blob && data.size > 4 * 1024 * 1024) return this._resumable({ name, parents: [parentId], appProperties, mimeType: mime }, data, mime);
    const { body, contentType } = this._multipart({ name, parents: [parentId], appProperties, mimeType: mime }, data, mime);
    return this._req(`${UP}/files?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  }

  async update(fileId, { appProperties, data, mime = 'application/json' }) {
    const { body, contentType } = this._multipart({ appProperties }, data, mime);
    return this._req(`${UP}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': contentType }, body });
  }

  async _resumable(meta, data, mime) {
    const token = await this.getToken();
    if (!token) throw new AuthError('no token');
    let r;
    try {
      r = await this.fetch(`${UP}/files?uploadType=resumable&fields=id,modifiedTime`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
        body: JSON.stringify(meta),
      });
    } catch (e) { throw new NetError(e && e.message); }
    if (r.status === 401) throw new AuthError('401');
    if (!r.ok) { const err = new NetError('Drive resumable ' + r.status); err.status = r.status; throw err; }
    const loc = r.headers.get('Location');
    if (!loc) throw new NetError('no upload location');
    let r2;
    try { r2 = await this.fetch(loc, { method: 'PUT', headers: { 'Content-Type': mime }, body: data }); }
    catch (e) { throw new NetError(e && e.message); }
    if (!r2.ok) { const err = new NetError('Drive upload ' + r2.status); err.status = r2.status; throw err; }
    return r2.json();
  }

  getJSON(fileId) { return this._req(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {}, 'json'); }
  getBuffer(fileId) { return this._req(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {}, 'buffer'); }
  remove(fileId) { return this._req(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, 'text'); }
}

export const DRIVE_FOLDER_MIME = FOLDER;
