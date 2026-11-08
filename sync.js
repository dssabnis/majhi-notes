// Sync engine: local Store <-> the user's own Google Drive folder "Majhi Notes".
// Layout in Drive:
//   Majhi Notes/            one JSON file per item:  <id>.json  (appProperties: iid, kind=item, upd, t)
//   Majhi Notes/revisions/  one JSON file per history entry     (appProperties: iid, kind=rev, nid)
//   Majhi Notes/files/      attachment bytes                    (appProperties: iid, kind=blob)
// Deletes are tombstone items, so other devices learn about them.
// Conflict rule: newer updatedAt wins; for notes, the losing version is kept as "(conflicted copy)".

import { AuthError } from './drive.js';
import { cleanItem, sameContent } from './store.js';
import { uid } from './util.js';

export const ROOT_FOLDER = 'Majhi Notes';
const OVERLAP_MS = 5 * 60 * 1000;
const FULL_EVERY_MS = 30 * 60 * 1000;

export function resolveConflict(local, remote, now = Date.now(), conflictLabel = '(conflicted copy)') {
  // local is dirty (unsynced edits); remote changed since our last sync.
  if (sameContent(local, remote)) {
    const localNewer = local.updatedAt > remote.updatedAt;
    return { winner: localNewer ? 'local' : 'remote', copy: null };
  }
  const winner = remote.updatedAt >= local.updatedAt ? 'remote' : 'local';
  const loser = winner === 'remote' ? local : remote;
  let copy = null;
  if (loser.type === 'note') {
    copy = {
      ...cleanItem(loser), id: uid(), title: `${loser.title || ''} ${conflictLabel}`.trim(),
      conflictOf: local.id, createdAt: now, updatedAt: now,
    };
  }
  return { winner, copy };
}

export class SyncEngine {
  constructor({ store, drive, now = () => Date.now(), conflictLabel }) {
    this.store = store; this.drive = drive; this.now = now;
    this.conflictLabel = conflictLabel || '(conflicted copy)';
    this.running = null;
    this.folders = null;
    this.lastFull = 0;
  }

  async folderIds() {
    if (this.folders) return this.folders;
    const db = this.store.db;
    let f = await db.getMeta('driveFolders');
    if (!f) {
      const root = await this.drive.findOrCreateFolder(ROOT_FOLDER, null);
      const revs = await this.drive.findOrCreateFolder('revisions', root);
      const files = await this.drive.findOrCreateFolder('files', root);
      f = { root, revs, files };
      await db.setMeta('driveFolders', f);
    }
    this.folders = f;
    return f;
  }

  async resetFolders() { this.folders = null; await this.store.db.setMeta('driveFolders', null); }

  sync(opts = {}) {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      const stats = { pulled: 0, pushed: 0, conflicts: 0 };
      try {
        do {
          this.again = false;
          await this._withFolderRetry(async () => {
            await this.pull(stats, opts);
            await this.push(stats);
          });
        } while (this.again);
        await this.store.db.setMeta('lastSyncAt', this.now());
        return stats;
      } finally { this.running = null; }
    })();
    return this.running;
  }

  async _withFolderRetry(fn) {
    try { return await fn(); }
    catch (e) {
      // The app folder may have been deleted by the user in Drive: rebuild it once.
      if (!(e instanceof AuthError) && e.status === 404) {
        await this.resetFolders();
        await this.store.db.setMeta('cursor', null);
        for (const i of this.store.items.values()) if (i._rid) await this.store.putFromRemote({ ...i, _rid: null, _rupd: 0, _dirty: 1 });
        return fn();
      }
      throw e;
    }
  }

  async pull(stats = {}, { full = false } = {}) {
    const { root } = await this.folderIds();
    const db = this.store.db;
    let cursor = await db.getMeta('cursor');
    const doFull = full || !cursor || this.now() - this.lastFull > FULL_EVERY_MS;
    let query = `'${root}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
    if (!doFull) query += ` and modifiedTime > '${new Date(Date.parse(cursor) - OVERLAP_MS).toISOString()}'`;
    const files = await this.drive.list(query);
    files.sort((a, b) => String(a.modifiedTime).localeCompare(String(b.modifiedTime)));
    let maxMod = cursor;
    // Download changed items in parallel (8 at a time), then apply them in order.
    const need = files.filter(f => {
      const ap = f.appProperties || {};
      if (!ap.iid || (ap.kind && ap.kind !== 'item')) return false;
      const l = this.store.getAny(ap.iid);
      return !(l && l._rid === f.id && Number(ap.upd || 0) <= (l._rupd || 0));
    });
    const pending = new Map();
    let next = 0;
    const worker = async () => {
      while (next < need.length) {
        const f = need[next++];
        const p = this.drive.getJSON(f.id);
        pending.set(f.id, p);
        try { await p; } catch (e) { /* surfaced when applied */ }
      }
    };
    const pool = Promise.all(Array.from({ length: Math.min(8, need.length) }, worker));
    const fetchItem = async (id) => {
      while (!pending.has(id)) { await new Promise(r => setTimeout(r, 0)); if (next >= need.length && !pending.has(id)) break; }
      return pending.has(id) ? pending.get(id) : this.drive.getJSON(id);
    };
    try {
    for (const f of files) {
      if (!maxMod || f.modifiedTime > maxMod) maxMod = f.modifiedTime;
      const ap = f.appProperties || {};
      if (!ap.iid || (ap.kind && ap.kind !== 'item')) continue;
      const upd = Number(ap.upd || 0);
      let local = this.store.getAny(ap.iid);
      if (local && local._rid && local._rid !== f.id) {
        // Two Drive files for one item (rare: two devices created it at once). Keep the newest.
        if (upd <= (local._rupd || 0)) { await this._tryRemove(f.id); continue; }
        await this._tryRemove(local._rid);
      } else if (local && local._rid === f.id && upd <= (local._rupd || 0)) continue;

      const remote = await fetchItem(f.id);
      if (!remote || remote.id !== ap.iid) continue;
      stats.pulled = (stats.pulled || 0) + 1;
      local = this.store.getAny(ap.iid); // may have changed while downloading
      if (!local || !local._dirty) {
        await this.store.putFromRemote({ ...remote, _rid: f.id, _rupd: upd, _dirty: 0 });
        continue;
      }
      const res = resolveConflict(local, remote, this.now(), this.conflictLabel);
      if (res.winner === 'remote') {
        await this.store.putFromRemote({ ...remote, _rid: f.id, _rupd: upd, _dirty: 0 });
      } else {
        await this.store.putFromRemote({ ...local, _rid: f.id, _rupd: upd, _dirty: 1 });
      }
      if (res.copy) {
        stats.conflicts = (stats.conflicts || 0) + 1;
        await this.store.putFromRemote({ ...res.copy, _dirty: 1 });
      }
    }
    } finally { next = need.length; await pool.catch(() => {}); }
    if (doFull) this.lastFull = this.now();
    if (maxMod && maxMod !== cursor) await db.setMeta('cursor', maxMod);
  }

  async push(stats = {}) {
    const { root, revs, files } = await this.folderIds();
    const store = this.store;

    // 1. attachment bytes first, so the file item can carry the Drive id of its bytes
    for (const id of await store.dirtyBlobIds()) {
      const b = await store.getBlobRecord(id);
      const fileItem = store.get(id);
      if (!b || !fileItem) { await store.markBlobSynced(id, null); continue; }
      const r = await this.drive.create({
        name: `${id}.bin`, parentId: files, appProperties: { iid: id, kind: 'blob' },
        data: new Blob([b.bytes], { type: b.mime || 'application/octet-stream' }), mime: b.mime || 'application/octet-stream',
      });
      await store.markBlobSynced(id, r.id);
      await store.update(id, { blobRid: r.id });
      stats.pushed = (stats.pushed || 0) + 1;
    }

    // 2. items (notes, tags, folders, files, authenticator entries, tombstones)
    for (const item of store.dirtyItems()) {
      const payload = JSON.stringify(cleanItem(item));
      const appProperties = { iid: item.id, kind: 'item', upd: String(item.updatedAt), t: item.type };
      let r = null;
      if (item._rid) {
        try { r = await this.drive.update(item._rid, { appProperties, data: payload }); }
        catch (e) { if (e.status !== 404) throw e; r = null; }
      }
      if (!r) r = await this.drive.create({ name: `${item.id}.json`, parentId: root, appProperties, data: payload });
      await store.markSynced(item.id, r.id, item.updatedAt);
      stats.pushed = (stats.pushed || 0) + 1;
      if (item.type === 'tombstone') {
        if (item.blobRid) await this._tryRemove(item.blobRid);
        if (item.was === 'note') {
          try {
            const old = await this.drive.list(`'${revs}' in parents and appProperties has { key='nid' and value='${item.id}' }`, 'id');
            for (const o of old) await this._tryRemove(o.id);
          } catch (e) { if (e instanceof AuthError) throw e; }
        }
      }
    }

    // 3. history entries
    for (const rev of await store.dirtyRevisions()) {
      if (!store.get(rev.noteId)) { await store.markRevSynced(rev.id, null); continue; }
      const r = await this.drive.create({
        name: `${rev.id}.json`, parentId: revs, appProperties: { iid: rev.id, kind: 'rev', nid: rev.noteId },
        data: JSON.stringify(cleanItem(rev)),
      });
      await store.markRevSynced(rev.id, r.id);
      stats.pushed = (stats.pushed || 0) + 1;
    }
  }

  // Fetch history entries saved by other devices for one note.
  async fetchRevisions(noteId) {
    const { revs } = await this.folderIds();
    const list = await this.drive.list(`'${revs}' in parents and trashed = false and appProperties has { key='nid' and value='${noteId}' }`);
    const have = new Set((await this.store.revisions(noteId)).map(r => r.id));
    for (const f of list) {
      const iid = f.appProperties && f.appProperties.iid;
      if (!iid || have.has(iid)) continue;
      const rev = await this.drive.getJSON(f.id);
      if (rev && rev.noteId === noteId) await this.store.putRemoteRevision({ ...rev, _rid: f.id });
    }
    return this.store.revisions(noteId);
  }

  // Attachment bytes: local cache first, then Drive.
  async getBlob(fileItem) {
    const local = await this.store.getBlobRecord(fileItem.id);
    if (local) return local;
    if (!fileItem.blobRid) return null;
    const buf = await this.drive.getBuffer(fileItem.blobRid);
    await this.store.putBlob(fileItem.id, buf, fileItem.mime, 0, fileItem.blobRid);
    return this.store.getBlobRecord(fileItem.id);
  }

  async _tryRemove(fileId) {
    try { await this.drive.remove(fileId); } catch (e) { if (e instanceof AuthError) throw e; }
  }
}
