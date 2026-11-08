// Thin promise wrapper around IndexedDB. One database per signed-in Google account.
// Stores: items (notes, tags, folders, files, totp, tombstones), revs (note history),
// blobs (attachment bytes), meta (key/value: sync cursor, folder ids ...).

const VERSION = 1;

function req2p(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export class DB {
  constructor(name) { this.name = name; this.db = null; }

  async open() {
    if (this.db) return this;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open(this.name, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('revs')) { const s = d.createObjectStore('revs', { keyPath: 'id' }); s.createIndex('noteId', 'noteId'); }
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('IndexedDB blocked'));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this;
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }

  _store(name, mode = 'readonly') { return this.db.transaction(name, mode).objectStore(name); }

  get(store, key) { return req2p(this._store(store).get(key)); }
  getAll(store) { return req2p(this._store(store).getAll()); }
  put(store, value) { return req2p(this._store(store, 'readwrite').put(value)); }
  del(store, key) { return req2p(this._store(store, 'readwrite').delete(key)); }
  byIndex(store, index, value) { return req2p(this._store(store).index(index).getAll(value)); }

  async putMany(store, values) {
    if (!values.length) return;
    await new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      for (const v of values) s.put(v);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  }

  async getMeta(k, dflt = null) { const r = await this.get('meta', k); return r ? r.v : dflt; }
  setMeta(k, v) { return this.put('meta', { k, v }); }

  static deleteDatabase(name) {
    return new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res();
    });
  }
}
