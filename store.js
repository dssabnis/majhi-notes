// Local data store: in-memory cache over IndexedDB, change events, revisions, blobs.
// Internal fields start with "_" and never leave the device:
//   _dirty (needs push), _rid (Drive file id), _rupd (updatedAt of the last synced version)

import { uid } from './util.js';

export const REV_INTERVAL = 120000; // a new history entry at most every 2 minutes of editing

export function cleanItem(item) {
  const o = {};
  for (const k of Object.keys(item)) if (k[0] !== '_') o[k] = item[k];
  return o;
}

export function sameContent(a, b) {
  const strip = x => { const o = cleanItem(x); delete o.updatedAt; return JSON.stringify(o, Object.keys(o).sort()); };
  return strip(a) === strip(b);
}

export class Store {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.items = new Map();
    this.listeners = new Set();
    this.dirtyListeners = new Set();
    this.revInfo = new Map(); // noteId -> { at, upd }
  }

  async load() {
    const all = await this.db.getAll('items');
    this.items = new Map(all.map(i => [i.id, i]));
    return this;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onDirty(fn) { this.dirtyListeners.add(fn); return () => this.dirtyListeners.delete(fn); }
  _emit(ids, source) { for (const f of this.listeners) { try { f(ids, source); } catch (e) { console.warn(e); } } }
  _emitDirty() { for (const f of this.dirtyListeners) { try { f(); } catch (e) { console.warn(e); } } }

  get(id) { const i = this.items.get(id); return i && i.type !== 'tombstone' ? i : null; }
  getAny(id) { return this.items.get(id) || null; }
  list(type) { const out = []; for (const i of this.items.values()) if (i.type === type) out.push(i); return out; }
  notes() { return this.list('note'); }
  dirtyItems() { return [...this.items.values()].filter(i => i._dirty); }

  _stamp(prev) {
    const n = this.now();
    return prev && prev.updatedAt >= n ? prev.updatedAt + 1 : n;
  }

  async _write(item, source = 'local') {
    this.items.set(item.id, item);
    await this.db.put('items', item);
    this._emit([item.id], source);
  }

  async create(type, props = {}) {
    const t = this.now();
    const item = { id: uid(), type, createdAt: t, updatedAt: t, ...props, _dirty: 1 };
    if (type === 'note') {
      Object.assign(item, {
        title: props.title ?? '', text: props.text ?? '', noteType: props.noteType || 'plain',
        tags: props.tags || [], folderId: props.folderId ?? null,
        pinned: !!props.pinned, starred: !!props.starred, archived: !!props.archived, trashed: !!props.trashed,
        readOnly: !!props.readOnly,
      });
    }
    await this._write(item);
    if (type === 'note') await this._maybeRevision(item, true);
    this._emitDirty();
    return item;
  }

  async update(id, patch, { revision = true } = {}) {
    const prev = this.items.get(id);
    if (!prev || prev.type === 'tombstone') throw new Error('no such item ' + id);
    const next = { ...prev, ...patch, _dirty: 1 };
    if (sameContent(prev, next)) return prev;
    next.updatedAt = this._stamp(prev);
    await this._write(next);
    if (next.type === 'note' && revision && ('text' in patch || 'title' in patch)) await this._maybeRevision(next, false);
    this._emitDirty();
    return next;
  }

  // Permanently delete: replaced by a tombstone that syncs to other devices.
  async remove(id, extra = {}) {
    const prev = this.items.get(id);
    if (!prev || prev.type === 'tombstone') return;
    const tomb = { id, type: 'tombstone', was: prev.type, deleted: true, createdAt: prev.createdAt, updatedAt: this._stamp(prev), ...extra, _dirty: 1, _rid: prev._rid, _rupd: prev._rupd };
    if (prev.type === 'file' && prev.blobRid) tomb.blobRid = prev.blobRid;
    await this._write(tomb);
    if (prev.type === 'file') { await this.db.del('blobs', id).catch(() => {}); await this._pending('pendingBlobs', id, false); }
    if (prev.type === 'note') {
      const revs = await this.db.byIndex('revs', 'noteId', id);
      for (const r of revs) { await this.db.del('revs', r.id); await this._pending('pendingRevs', r.id, false); }
      this.revInfo.delete(id);
    }
    this._emitDirty();
  }

  // ---- used by sync ----
  async putFromRemote(item) { await this._write(item, 'remote'); }
  async markSynced(id, rid, pushedUpd) {
    const cur = this.items.get(id);
    if (!cur) return;
    const next = { ...cur, _rid: rid, _rupd: pushedUpd };
    if (cur.updatedAt === pushedUpd) next._dirty = 0;
    this.items.set(id, next);
    await this.db.put('items', next);
  }

  // ---- revisions ----
  async _revInfoFor(noteId) {
    if (this.revInfo.has(noteId)) return this.revInfo.get(noteId);
    const revs = await this.db.byIndex('revs', 'noteId', noteId);
    let info = { at: 0, upd: 0 };
    for (const r of revs) if (r.createdAt > info.at) info = { at: r.createdAt, upd: r.noteUpdatedAt || 0 };
    this.revInfo.set(noteId, info);
    return info;
  }

  async _maybeRevision(note, force) {
    const info = await this._revInfoFor(note.id);
    if (force || this.now() - info.at >= REV_INTERVAL) await this.addRevision(note);
  }

  async addRevision(note) {
    const rev = {
      id: uid(), noteId: note.id, createdAt: this.now(), noteUpdatedAt: note.updatedAt,
      title: note.title, text: note.text, noteType: note.noteType, lang: note.lang || null, _dirty: 1,
    };
    await this.db.put('revs', rev);
    await this._pending('pendingRevs', rev.id, true);
    this.revInfo.set(note.id, { at: rev.createdAt, upd: note.updatedAt });
    return rev;
  }

  // Called when the user leaves a note: make sure its final state is in history.
  async checkpoint(noteId) {
    const note = this.get(noteId);
    if (!note || note.type !== 'note') return;
    const info = await this._revInfoFor(noteId);
    if (note.updatedAt > info.upd) { await this.addRevision(note); this._emitDirty(); }
  }

  async revisions(noteId) {
    const revs = await this.db.byIndex('revs', 'noteId', noteId);
    return revs.sort((a, b) => b.createdAt - a.createdAt);
  }
  async dirtyRevisions() {
    const ids = await this.db.getMeta('pendingRevs', []);
    const out = [];
    for (const id of ids) { const r = await this.db.get('revs', id); if (r && r._dirty) out.push(r); else await this._pending('pendingRevs', id, false); }
    return out;
  }
  async markRevSynced(id, rid) {
    const r = await this.db.get('revs', id);
    if (r) await this.db.put('revs', { ...r, _dirty: 0, _rid: rid });
    await this._pending('pendingRevs', id, false);
  }
  async putRemoteRevision(rev) { await this.db.put('revs', { ...rev, _dirty: 0 }); }

  _pending(key, id, add) {
    this._pq = (this._pq || Promise.resolve()).then(() => this._pendingNow(key, id, add)).catch(e => console.warn(e));
    return this._pq;
  }
  async _pendingNow(key, id, add) {
    const cur = await this.db.getMeta(key, []);
    const has = cur.includes(id);
    if (add && !has) await this.db.setMeta(key, [...cur, id]);
    if (!add && has) await this.db.setMeta(key, cur.filter(x => x !== id));
  }

  async restoreRevision(noteId, revId) {
    const rev = await this.db.get('revs', revId);
    if (!rev) throw new Error('revision missing');
    const cur = this.get(noteId);
    if (cur) await this.addRevision(cur);
    return this.update(noteId, { title: rev.title, text: rev.text, noteType: rev.noteType, lang: rev.lang || null }, { revision: false });
  }

  // ---- blobs ----
  async putBlob(id, bytes, mime, dirty = 1, rid = null) {
    await this.db.put('blobs', { id, bytes, mime, _dirty: dirty, _rid: rid });
    if (dirty) await this._pending('pendingBlobs', id, true);
  }
  getBlobRecord(id) { return this.db.get('blobs', id); }
  async dirtyBlobIds() { return this.db.getMeta('pendingBlobs', []); }
  async markBlobSynced(id, rid) {
    const b = await this.db.get('blobs', id);
    if (b) await this.db.put('blobs', { ...b, _dirty: 0, _rid: rid });
    await this._pending('pendingBlobs', id, false);
  }
  async hasPending() {
    return this.dirtyItems().length > 0 || (await this.db.getMeta('pendingRevs', [])).length > 0 || (await this.db.getMeta('pendingBlobs', [])).length > 0;
  }
}
