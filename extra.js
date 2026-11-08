// Secondary features: note menu, tags/folders, lock, history, attachments, moments, files,
// authenticator, voice typing, settings, backup/import, share inbox, app passcode.
import { t, getLang, setLang } from './i18n.js';
import { h, sanitizeHtml, renderMarkdown, toast, modal, ask, confirmDlg, openMenu, download, pickFiles } from './ui.js';
import {
  S, saveSettings, applyTheme, renderApp, renderNav, renderList, renderEditor, setView, openNote, showList, createNote,
  setFlag, toggleFlag, flushSave, leaveNote, convertText, deleteNoteForever, doSync, scheduleSync, formatDateTime, formatDay,
  NOTE_TYPES, TYPE_ICON, dbName, clientId, plainOf, MAX_FILE, APP_VERSION, viewTitle,
} from './app.js';
import { DB } from './db.js';
import { hashPin, verifyPin } from './lock.js';
import { totp, base32Decode, parseOtpauth, secondsLeft } from './totp.js';
import { exportNote, makeBackup, parseBackup, noteToPlain, noteToMarkdown } from './backup.js';
import { dayKey, humanSize, safeFileName, uid } from './util.js';
import { CODE_LANGS } from './editors.js';

// ------------------------------------------------------------------ turndown
let td = null;
export function htmlToMd(html) {
  if (!td) {
    td = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '_' });
    td.addRule('checklist', {
      filter: n => n.nodeName === 'LI' && n.parentNode && n.parentNode.classList && n.parentNode.classList.contains('checklist'),
      replacement: (content, n) => `- [${n.classList.contains('checked') ? 'x' : ' '}] ${content.trim()}\n`,
    });
    td.addRule('strike', { filter: ['s', 'strike', 'del'], replacement: c => `~~${c}~~` });
    td.addRule('attImg', { filter: n => n.nodeName === 'IMG' && n.getAttribute('data-file-id'), replacement: (c, n) => `![${n.getAttribute('alt') || 'image'}](attachment:${n.getAttribute('data-file-id')})` });
    td.keep(['table', 'thead', 'tbody', 'tr', 'td', 'th', 'u', 'mark']);
  }
  return td.turndown(String(html || ''));
}
const mdToHtml = s => renderMarkdown(s);

// ------------------------------------------------------------------ note menu
export function noteMenu(anchor, note) {
  const ro = !!note.trashed;
  openMenu(anchor, [
    { icon: '📌', k: 'pin', label: note.pinned ? t('unpin') : t('pin_'), onclick: () => toggleFlag('pinned'), disabled: ro },
    { icon: '⭐', k: 'star', label: note.starred ? t('unstar') : t('star'), onclick: () => toggleFlag('starred'), disabled: ro },
    { icon: '🗄', k: 'archive', label: note.archived ? t('unarchive') : t('archive'), onclick: () => toggleFlag('archived'), disabled: ro },
    { icon: '🛡', k: 'readonly', label: note.readOnly ? t('allowEdit') : t('readOnly'), onclick: () => toggleFlag('readOnly'), disabled: ro },
    { icon: '🔒', k: 'lock', label: note.lockHash ? t('removeLock') : t('lockNote'), onclick: () => (note.lockHash ? removeLock(note) : lockNote(note)), disabled: ro },
    { sep: true },
    { icon: '🕘', k: 'history', label: t('history'), onclick: () => openHistory(note.id) },
    { icon: '📎', k: 'attach', label: t('attach'), onclick: () => attachToNote(note.id), disabled: ro || note.readOnly },
    { icon: '⧉', k: 'duplicate', label: t('duplicate'), onclick: () => duplicate(note) },
    { icon: '⇩', k: 'export', label: t('export'), onclick: () => exportMenu(anchor, note) },
    { sep: true },
    note.trashed
      ? { icon: '↺', k: 'restore', label: t('restore'), onclick: () => setFlag(note.id, { trashed: false }) }
      : { icon: '🗑', k: 'trash', label: t('moveToTrash'), danger: true, onclick: async () => { flushSave(); await S.store.update(note.id, { trashed: true }, { revision: false }); toast(t('movedToTrash')); S.noteId = null; showList(); renderEditor(); renderNav(); } },
  ]);
}

function exportMenu(anchor, note) {
  flushSave();
  const n = S.store.get(note.id);
  const f = fmt => download(exportNote(n, fmt, { htmlToMd, mdToHtml }));
  const items = [
    { k: 'exp-md', label: 'Markdown (.md)', onclick: () => f('md') },
    { k: 'exp-txt', label: t('plainText') + ' (.txt)', onclick: () => f('txt') },
    { k: 'exp-html', label: 'HTML (.html)', onclick: () => f('html') },
    { k: 'exp-json', label: 'JSON', onclick: () => f('json') },
  ];
  if (n.noteType === 'sheet') items.unshift({ k: 'exp-csv', label: 'CSV (.csv)', onclick: () => f('csv') });
  openMenu(anchor, items);
}

async function duplicate(note) {
  leaveNote();
  const n = S.store.get(note.id);
  const { id, createdAt, updatedAt, lockHash, lockSalt, conflictOf, ...rest } = n;
  const clean = {}; for (const k of Object.keys(rest)) if (k[0] !== '_') clean[k] = rest[k];
  let copy;
  try { copy = await S.store.create('note', { ...clean, title: (n.title || t('untitled')) + ' ' + t('copySuffix'), trashed: false }); } catch (e) { openNote(note.id); throw e; }
  openNote(copy.id); toast(t('duplicated'));
}

export function changeTypeMenu(anchor, note) {
  openMenu(anchor, NOTE_TYPES.filter(x => x !== note.noteType).map(tp => ({
    k: 'to-' + tp, icon: TYPE_ICON[tp], label: t('type_' + tp), onclick: () => changeType(note.id, tp),
  })));
}

async function changeType(id, to) {
  flushSave();
  const note = S.store.get(id);
  const lossy = ['super', 'sheet', 'tasks'].includes(note.noteType) || ['sheet', 'tasks'].includes(to);
  if (lossy && (note.text || '').trim() && !(await confirmDlg(t('convertWarn')))) return;
  await S.store.addRevision(note);
  const text = convertText(note, to, htmlToMd);
  await S.store.update(id, { noteType: to, text }, { revision: false });
  renderEditor(); renderList();
}

// ------------------------------------------------------------------ lock
async function lockNote(note) {
  const p1 = await ask(t('setPin'), { inputType: 'password', help: t('pinHelp') });
  if (!p1) return;
  if (p1.length < 4) { toast(t('pinTooShort')); return; }
  const p2 = await ask(t('confirmPin'), { inputType: 'password' });
  if (p1 !== p2) { toast(t('pinMismatch')); return; }
  const { salt, hash } = await hashPin(p1);
  flushSave();
  await S.store.update(note.id, { lockSalt: salt, lockHash: hash }, { revision: false });
  S.unlocked.add(note.id);
  toast(t('noteLocked')); renderEditor(); renderList();
}
async function removeLock(note) {
  const p = await ask(t('enterPin'), { inputType: 'password' });
  if (!p) return;
  if (!(await verifyPin(p, note.lockSalt, note.lockHash))) { toast(t('wrongPin')); return; }
  await S.store.update(note.id, { lockSalt: null, lockHash: null }, { revision: false });
  toast(t('lockRemoved')); renderEditor(); renderList();
}

// ------------------------------------------------------------------ tags & folders
export function tagPath(tag) {
  const parts = [tag.title]; let p = tag.parentId ? S.store.get(tag.parentId) : null; const seen = new Set([tag.id]);
  while (p && !seen.has(p.id)) { parts.unshift(p.title); seen.add(p.id); p = p.parentId ? S.store.get(p.parentId) : null; }
  return parts.join('/');
}

async function ensureTagPath(path) {
  let parentId = null, tag = null;
  for (const part of path.split('/').map(s => s.trim()).filter(Boolean)) {
    tag = S.store.list('tag').find(x => (x.parentId || null) === parentId && x.title.toLowerCase() === part.toLowerCase());
    if (!tag) tag = await S.store.create('tag', { title: part, parentId });
    parentId = tag.id;
  }
  return tag;
}

export async function addTagToNote(note) {
  const existing = S.store.list('tag').map(tagPath).sort();
  const listId = 'tag-suggest';
  document.getElementById(listId)?.remove();
  document.body.append(h('datalist', { id: listId }, ...existing.map(p => h('option', { value: p }))));
  const v = await ask(t('addTag'), { placeholder: t('tagPh'), help: t('tagHelp') });
  document.getElementById(listId)?.remove();
  if (!v) return;
  const tag = await ensureTagPath(v);
  if (!tag) return;
  const n = S.store.get(note.id);
  if (!(n.tags || []).includes(tag.id)) await S.store.update(n.id, { tags: [...(n.tags || []), tag.id] }, { revision: false });
  renderEditor(); renderNav();
}
// datalist hookup for the ask() input
document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('.modal input.inp') && document.getElementById('tag-suggest')) e.target.setAttribute('list', 'tag-suggest'); });

export async function newTag(parentId) {
  const v = await ask(parentId ? t('newSubTag') : t('newTag'), { placeholder: t('tagPh') });
  if (!v) return;
  if (parentId) await S.store.create('tag', { title: v.trim(), parentId });
  else await ensureTagPath(v);
  renderNav();
}
export async function newFolder(parentId) {
  const v = await ask(parentId ? t('newSubFolder') : t('newFolder'));
  if (!v) return null;
  const f = await S.store.create('folder', { title: v.trim(), parentId: parentId || null });
  renderNav();
  return f;
}

export function treeMenu(anchor, item) {
  const isTag = item.type === 'tag';
  openMenu(anchor, [
    { k: 'rename', icon: '✎', label: t('rename'), onclick: async () => { const v = await ask(t('rename'), { value: item.title }); if (v) { await S.store.update(item.id, { title: v.trim() }); renderNav(); renderList(); renderEditor(); } } },
    { k: 'child', icon: '+', label: isTag ? t('newSubTag') : t('newSubFolder'), onclick: () => (isTag ? newTag(item.id) : newFolder(item.id)) },
    isTag ? { k: 'daily', icon: '📔', label: item.daily ? t('dailyOff') : t('dailyOn'), onclick: async () => { await S.store.update(item.id, { daily: !item.daily }); setView({ kind: 'tag', id: item.id }); } } : null,
    { sep: true },
    { k: 'delete', icon: '🗑', label: t('delete'), danger: true, onclick: () => deleteTreeItem(item) },
  ]);
}

async function deleteTreeItem(item) {
  const isTag = item.type === 'tag';
  if (!(await confirmDlg(isTag ? t('deleteTagConfirm', { name: item.title }) : t('deleteFolderConfirm', { name: item.title }), { danger: true, okText: t('delete') }))) return;
  const ids = [];
  const walk = id => { ids.push(id); for (const c of S.store.list(item.type).filter(x => x.parentId === id)) walk(c.id); };
  walk(item.id);
  for (const n of S.store.notes()) {
    if (isTag && (n.tags || []).some(x => ids.includes(x))) await S.store.update(n.id, { tags: n.tags.filter(x => !ids.includes(x)) }, { revision: false });
    if (!isTag && ids.includes(n.folderId)) await S.store.update(n.id, { folderId: null }, { revision: false });
  }
  for (const id of ids) await S.store.remove(id);
  if ((S.view.kind === 'tag' || S.view.kind === 'folder') && ids.includes(S.view.id)) setView({ kind: 'all' });
  renderNav(); renderList(); renderEditor();
}

function folderPath(f) {
  const parts = [f.title]; let p = f.parentId ? S.store.get(f.parentId) : null; const seen = new Set([f.id]);
  while (p && !seen.has(p.id)) { parts.unshift(p.title); seen.add(p.id); p = p.parentId ? S.store.get(p.parentId) : null; }
  return parts.join(' / ');
}

export function folderMenu(anchor, note) {
  const folders = S.store.list('folder').map(f => ({ f, p: folderPath(f) })).sort((a, b) => a.p.localeCompare(b.p));
  const move = async id => { await S.store.update(note.id, { folderId: id }, { revision: false }); renderEditor(); renderList(); renderNav(); };
  openMenu(anchor, [
    { k: 'no-folder', label: (note.folderId ? '' : '✓ ') + t('noFolder'), onclick: () => move(null) },
    ...folders.map(({ f, p }) => ({ k: 'folder-' + f.id, label: (note.folderId === f.id ? '✓ ' : '') + '📁 ' + p, onclick: () => move(f.id) })),
    { sep: true },
    { k: 'new-folder', label: '+ ' + t('newFolder'), onclick: async () => { const f = await newFolder(null); if (f) move(f.id); } },
  ]);
}

// ------------------------------------------------------------------ smart views
export async function saveSmartView() {
  if (!S.search.trim()) { toast(t('typeSearchFirst')); return; }
  const name = await ask(t('smartViewName'), { value: S.search.trim() });
  if (!name) return;
  const sv = await S.store.create('view', { title: name.trim(), query: S.search.trim(), noteType: '' });
  setView({ kind: 'smart', id: sv.id });
}
export function smartViewMenu(anchor, sv) {
  openMenu(anchor, [
    { k: 'rename', label: t('rename'), onclick: async () => { const v = await ask(t('rename'), { value: sv.title }); if (v) { await S.store.update(sv.id, { title: v }); renderNav(); renderList(); } } },
    { k: 'edit-query', label: t('editSearch'), onclick: async () => { const v = await ask(t('editSearch'), { value: sv.query }); if (v != null) { await S.store.update(sv.id, { query: v }); renderNav(); renderList(); } } },
    { k: 'type-filter', label: t('typeFilter'), onclick: () => openMenu(anchor, [{ label: t('allTypes'), onclick: () => S.store.update(sv.id, { noteType: '' }).then(() => { renderNav(); renderList(); }) },
      ...NOTE_TYPES.map(tp => ({ label: t('type_' + tp), onclick: () => S.store.update(sv.id, { noteType: tp }).then(() => { renderNav(); renderList(); }) }))]) },
    { k: 'delete', label: t('delete'), danger: true, onclick: async () => { if (await confirmDlg(t('deleteViewConfirm'), { danger: true })) { await S.store.remove(sv.id); setView({ kind: 'all' }); } } },
  ]);
}

// ------------------------------------------------------------------ daily notebook
export async function dailyEntry(tag, day) {
  const existing = S.store.notes().find(n => !n.trashed && (n.tags || []).includes(tag.id) && n.day === day);
  if (existing) { openNote(existing.id); return; }
  await createNote(S.settings.defaultType || 'plain', { title: formatDay(day), day, tags: [tag.id] });
}

// ------------------------------------------------------------------ history
export async function openHistory(noteId) {
  flushSave();
  await S.store.checkpoint(noteId);
  const listEl = h('div', { class: 'rev-list', role: 'list' });
  const preview = h('div', { class: 'rev-preview prose' }, h('p', { class: 'muted' }, t('pickRevision')));
  const status = h('p', { class: 'muted small' });
  const m = modal(t('history'), h('div', {}, status, h('div', { class: 'rev-wrap' }, listEl, preview)), [], { wide: true });
  let selected = null;
  const draw = revs => {
    listEl.replaceChildren(...revs.map((r, i) => h('button', {
      type: 'button', class: 'rev-item' + (selected === r.id ? ' on' : ''), 'data-rev': r.id,
      onclick: () => { selected = r.id; draw(revs); show(r); },
    }, h('strong', {}, formatDateTime(r.createdAt)), i === 0 ? h('span', { class: 'muted small' }, ' · ' + t('latest')) : null,
    h('div', { class: 'muted small' }, (r.title || t('untitled')) + ' · ' + t('type_' + (r.noteType || 'plain'))))));
    if (!revs.length) listEl.replaceChildren(h('p', { class: 'muted' }, t('noHistory')));
  };
  const show = r => {
    const n = { ...r, noteType: r.noteType || 'plain' };
    let body;
    if (n.noteType === 'super') { body = h('div'); body.innerHTML = sanitizeHtml(n.text); resolveImages(body); }
    else if (n.noteType === 'markdown') { body = h('div'); body.innerHTML = renderMarkdown(n.text); }
    else body = h('pre', { class: 'rev-pre' }, noteToPlain(n));
    preview.replaceChildren(h('h3', {}, r.title || t('untitled')), body,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', 'data-act': 'restore-rev', onclick: async () => {
        await S.store.restoreRevision(noteId, r.id); m.close(); renderEditor(); renderList(); toast(t('restored'));
      } }, t('restoreThis'))));
  };
  draw(await S.store.revisions(noteId));
  if (navigator.onLine && S.auth.valid()) {
    status.textContent = t('loadingHistory');
    try { draw(await S.sync.fetchRevisions(noteId)); status.textContent = ''; }
    catch (e) { status.textContent = t('historyOfflineOnly'); }
  } else status.textContent = t('historyOfflineOnly');
}

// ------------------------------------------------------------------ attachments
export async function addFiles(files, noteId, { moment = false } = {}) {
  const ids = [];
  for (const f of files) {
    if (f.size > MAX_FILE) { toast(t('fileTooBig', { name: f.name })); continue; }
    const bytes = await f.arrayBuffer();
    const item = await S.store.create('file', { name: f.name || 'file', mime: f.type || 'application/octet-stream', size: f.size, noteId: noteId || null, moment: !!moment });
    await S.store.putBlob(item.id, bytes, item.mime, 1);
    ids.push(item.id);
  }
  scheduleSync(1500);
  if (noteId && noteId === S.noteId) renderAttachments(noteId);
  return ids;
}

export async function attachToNote(noteId) {
  const files = await pickFiles({ accept: 'image/*,application/pdf,audio/*,video/*,*/*', multiple: true });
  if (!files.length) return;
  const ids = await addFiles(files, noteId);
  if (ids.length) toast(t('attached', { n: ids.length }));
}

export async function blobUrl(id) {
  if (S.blobUrls.has(id)) return S.blobUrls.get(id);
  const item = S.store.get(id);
  if (!item) return null;
  let rec = await S.store.getBlobRecord(item.id);
  if (!rec) {
    if (!navigator.onLine || !S.auth.valid()) return null;
    try { rec = await S.sync.getBlob(item); } catch (e) { console.warn('blob', e); return null; }
  }
  if (!rec) return null;
  const url = URL.createObjectURL(new Blob([rec.bytes], { type: item.mime }));
  S.blobUrls.set(id, url);
  return url;
}

export function resolveImages(root) {
  root.querySelectorAll('img[data-file-id]').forEach(async img => {
    if (img.getAttribute('src')) return;
    const url = await blobUrl(img.dataset.fileId);
    if (url) img.src = url; else { img.alt = t('imageUnavailable'); img.classList.add('missing'); }
  });
}

const fileIcon = m => (/^image\//.test(m) ? '🖼' : /pdf/.test(m) ? '📕' : /^audio\//.test(m) ? '🎵' : /^video\//.test(m) ? '🎬' : '📄');

export function renderAttachments(noteId) {
  const el = document.getElementById('attachments'); if (!el) return;
  const files = S.store.list('file').filter(f => f.noteId === noteId).sort((a, b) => a.createdAt - b.createdAt);
  el.replaceChildren(...files.map(f => {
    const thumb = h('span', { class: 'att-icon' }, fileIcon(f.mime));
    if (/^image\//.test(f.mime)) blobUrl(f.id).then(u => { if (u) thumb.replaceChildren(h('img', { src: u, alt: '' })); });
    return h('div', { class: 'att' }, h('button', { type: 'button', class: 'att-open', 'data-file': f.id, onclick: () => previewFile(f) }, thumb, h('span', { class: 'att-name' }, f.name)));
  }));
  el.hidden = !files.length;
}

export async function previewFile(f) {
  const url = await blobUrl(f.id);
  if (!url) { toast(t('fileUnavailable')); return; }
  let body;
  if (/^image\//.test(f.mime)) body = h('img', { src: url, alt: f.name, class: 'preview-img' });
  else if (/pdf/.test(f.mime)) body = h('iframe', { src: url, class: 'preview-pdf', title: f.name });
  else if (/^audio\//.test(f.mime)) body = h('audio', { src: url, controls: true, class: 'preview-audio' });
  else if (/^video\//.test(f.mime)) body = h('video', { src: url, controls: true, class: 'preview-img' });
  else body = h('p', {}, f.name + ' · ' + humanSize(f.size));
  const note = f.noteId ? S.store.get(f.noteId) : null;
  modal(f.name, h('div', { class: 'preview' }, body, h('p', { class: 'muted small' }, humanSize(f.size) + ' · ' + formatDateTime(f.createdAt))), [
    { label: t('download'), onclick: close => { const a = h('a', { href: url, download: f.name }); document.body.append(a); a.click(); a.remove(); } },
    { label: t('openNewTab'), onclick: () => window.open(url, '_blank', 'noopener') },
    note && note.id !== S.noteId ? { label: t('openNote'), onclick: close => { close(); setView({ kind: 'all' }); openNote(note.id); } } : null,
    { label: t('delete'), cls: 'danger', act: 'delete-file', onclick: async close => {
      if (!(await confirmDlg(t('deleteFileConfirm'), { danger: true }))) return;
      close(); await S.store.remove(f.id); S.blobUrls.delete(f.id);
      renderAttachments(S.noteId); if (S.view.kind === 'files' || S.view.kind === 'moments') renderList();
    } },
  ].filter(Boolean), { wide: true });
}

// ------------------------------------------------------------------ files view
export function renderFiles(el) {
  const files = S.store.list('file').sort((a, b) => b.createdAt - a.createdAt);
  el.replaceChildren(
    listHead(t('view_files'), h('button', { type: 'button', class: 'btn small primary', 'data-act': 'upload-file', onclick: async () => {
      const picked = await pickFiles({ accept: 'image/*,application/pdf,audio/*,video/*,*/*', multiple: true });
      if (!picked.length) return;
      const ids = await addFiles(picked, null);
      if (ids.length) { toast(t('attached', { n: ids.length })); renderFiles(el); }
    } }, '＋ ' + t('attach'))),
    h('div', { class: 'wide-body' },
      files.length ? h('div', { class: 'file-list' }, ...files.map(f => {
        const note = f.noteId ? S.store.get(f.noteId) : null;
        return h('button', { type: 'button', class: 'file-row', 'data-file': f.id, onclick: () => previewFile(f) },
          h('span', { class: 'att-icon' }, fileIcon(f.mime)),
          h('span', { class: 'fr-main' }, h('strong', {}, f.name), h('span', { class: 'muted small' }, humanSize(f.size) + ' · ' + formatDateTime(f.createdAt) + (note ? ' · ' + (note.title || t('untitled')) : ''))));
      })) : h('div', { class: 'empty' }, t('noFiles'))));
}

function listHead(title, ...extra) {
  return h('div', { class: 'list-head' },
    h('button', { type: 'button', class: 'icon-btn nav-toggle', 'aria-label': t('menu'), onclick: () => document.body.classList.toggle('nav-open') }, '☰'),
    h('h2', {}, title), ...extra);
}

// ------------------------------------------------------------------ moments
async function momentsTag() {
  let tag = S.store.list('tag').find(x => x.system === 'moments');
  if (!tag) tag = await S.store.create('tag', { title: t('momentsTag'), parentId: null, system: 'moments' });
  return tag;
}

export async function captureMoment() {
  const files = await pickFiles({ accept: 'image/*', multiple: true, capture: 'environment' });
  if (!files.length) return;
  const tag = await momentsTag();
  let last = null;
  for (const f of files) {
    const now = Date.now();
    const stamp = formatDateTime(now);
    const note = await S.store.create('note', { noteType: 'super', title: t('momentTitle') + ' · ' + stamp, text: '', tags: [tag.id], moment: true, day: dayKey(now) });
    const [fid] = await addFiles([f], note.id, { moment: true });
    if (!fid) { await S.store.remove(note.id); continue; }
    await S.store.update(note.id, { text: `<p><img data-file-id="${fid}" alt=""></p><p>🕒 ${stamp}</p><p><br></p>` }, { revision: false });
    last = note;
  }
  if (last) { toast(t('momentSaved')); renderList(); renderNav(); }
  return last;
}

export function renderMoments(el) {
  const notes = S.store.notes().filter(n => n.moment && !n.trashed).sort((a, b) => b.createdAt - a.createdAt);
  const grid = h('div', { class: 'moment-grid' }, ...notes.map(n => {
    const file = S.store.list('file').find(f => f.noteId === n.id && /^image\//.test(f.mime));
    const img = h('img', { alt: n.title, loading: 'lazy' });
    if (file) blobUrl(file.id).then(u => { if (u) img.src = u; });
    return h('button', { type: 'button', class: 'moment', 'data-id': n.id, onclick: () => { setView({ kind: 'all' }); openNote(n.id); } }, img, h('span', { class: 'm-date' }, formatDateTime(n.createdAt)));
  }));
  el.replaceChildren(listHead(t('view_moments'), h('button', { type: 'button', class: 'btn primary', 'data-act': 'new-moment', onclick: async () => { await captureMoment(); } }, '📷 ' + t('newMoment'))),
    h('div', { class: 'wide-body' }, h('p', { class: 'muted' }, t('momentsHelp')), notes.length ? grid : h('div', { class: 'empty' }, t('noMoments'))));
}

// ------------------------------------------------------------------ authenticator
let authTimer = null;
export function stopAuthTicker() { clearInterval(authTimer); authTimer = null; }

export function renderAuthenticator(el) {
  stopAuthTicker();
  const entries = S.store.list('totp').sort((a, b) => (a.issuer || a.account).localeCompare(b.issuer || b.account));
  const search = h('input', { class: 'inp search', type: 'search', placeholder: t('searchPh'), 'aria-label': t('search') });
  const list = h('div', { class: 'otp-list' });
  const cards = entries.map(e => {
    const code = h('span', { class: 'otp-code', 'data-code': e.id }, '······');
    const bar = h('div', { class: 'otp-bar' }, h('div'));
    const card = h('div', { class: 'otp-card', 'data-id': e.id },
      h('div', { class: 'otp-info' }, h('strong', {}, e.issuer || e.account || '—'), h('span', { class: 'muted small' }, e.issuer ? e.account : '')),
      code,
      h('button', { type: 'button', class: 'btn small', 'data-act': 'copy-otp', onclick: async () => { try { await navigator.clipboard.writeText(code.dataset.raw || ''); toast(t('copied')); } catch (err) { toast(code.dataset.raw); } } }, t('copy')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('more'), title: t('more'), onclick: ev => otpMenu(ev.currentTarget, e) }, '⋮'),
      bar);
    card._entry = e; card._code = code; card._bar = bar;
    return card;
  });
  const drawList = () => {
    const q = search.value.toLowerCase();
    list.replaceChildren(...cards.filter(c => !q || ((c._entry.issuer || '') + ' ' + (c._entry.account || '')).toLowerCase().includes(q)));
    if (!entries.length) list.replaceChildren(h('div', { class: 'empty' }, t('noOtp')));
  };
  search.addEventListener('input', drawList);
  el.replaceChildren(listHead(t('view_authenticator'), h('button', { type: 'button', class: 'btn primary', 'data-act': 'add-otp', onclick: addOtpDialog }, '+ ' + t('add'))),
    h('div', { class: 'wide-body' }, h('p', { class: 'muted small' }, t('otpHelp')), search, list));
  drawList();
  let keys = new Map();
  const tick = async () => {
    const now = Date.now();
    for (const c of cards) {
      const e = c._entry;
      try {
        if (!keys.has(e.id)) keys.set(e.id, base32Decode(e.secret));
        const code = await totp(keys.get(e.id), now, { digits: e.digits || 6, period: e.period || 30, algo: e.algo || 'SHA1' });
        c._code.dataset.raw = code;
        c._code.textContent = code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code;
        const left = secondsLeft(now, e.period || 30);
        c._bar.firstChild.style.width = (100 * left / (e.period || 30)) + '%';
        c._bar.classList.toggle('low', left <= 5);
        c._code.title = t('secondsLeft', { n: left });
      } catch (err) { c._code.textContent = t('badSecret'); }
    }
  };
  tick();
  authTimer = setInterval(() => { if (S.view.kind !== 'authenticator') stopAuthTicker(); else tick(); }, 1000);
}

function otpMenu(anchor, e) {
  openMenu(anchor, [
    { k: 'edit', label: t('edit'), onclick: () => addOtpDialog(e) },
    { k: 'delete', label: t('delete'), danger: true, onclick: async () => { if (await confirmDlg(t('deleteOtpConfirm', { name: e.issuer || e.account }), { danger: true })) { await S.store.remove(e.id); renderList(); } } },
  ]);
}

async function decodeQrFile(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), hgt = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, hgt);
  const img = ctx.getImageData(0, 0, w, hgt);
  const r = window.jsQR(img.data, w, hgt, { inversionAttempts: 'attemptBoth' });
  return r ? r.data : null;
}

function addOtpDialog(existing) {
  const ex = existing && existing.id ? existing : null;
  const issuer = h('input', { class: 'inp', 'data-f': 'issuer', value: ex ? ex.issuer : '', placeholder: 'Google, GitHub…' });
  const account = h('input', { class: 'inp', 'data-f': 'account', value: ex ? ex.account : '', placeholder: 'name@example.com' });
  const secret = h('input', { class: 'inp mono', 'data-f': 'secret', value: ex ? ex.secret : '', placeholder: 'JBSWY3DPEHPK3PXP', autocomplete: 'off', spellcheck: 'false' });
  const uri = h('input', { class: 'inp mono', 'data-f': 'uri', placeholder: 'otpauth://totp/…' });
  const adv = { digits: ex ? ex.digits : 6, period: ex ? ex.period : 30, algo: ex ? ex.algo : 'SHA1' };
  const advText = h('p', { class: 'muted small' });
  const showAdv = () => { advText.textContent = `${adv.digits} ${t('digits')} · ${adv.period}s · ${adv.algo}`; };
  showAdv();
  const fill = p => { issuer.value = p.issuer; account.value = p.account; secret.value = p.secret; Object.assign(adv, { digits: p.digits, period: p.period, algo: p.algo }); showAdv(); };
  uri.addEventListener('change', () => { try { fill(parseOtpauth(uri.value)); toast(t('otpUriRead')); } catch (e) { toast(t('otpUriBad')); } });
  const qrBtn = h('button', { type: 'button', class: 'btn', 'data-act': 'qr', onclick: async () => {
    const [file] = await pickFiles({ accept: 'image/*', multiple: false });
    if (!file) return;
    try {
      const data = await decodeQrFile(file);
      if (!data) { toast(t('qrNotFound')); return; }
      fill(parseOtpauth(data)); uri.value = data; toast(t('otpUriRead'));
    } catch (e) { toast(t('otpUriBad')); }
  } }, '📷 ' + t('qrUpload'));
  const body = h('div', { class: 'form' },
    h('label', { class: 'lbl block' }, t('otpUri')), uri,
    h('div', { class: 'row' }, qrBtn),
    h('div', { class: 'or' }, t('orManual')),
    h('label', { class: 'lbl block' }, t('issuer')), issuer,
    h('label', { class: 'lbl block' }, t('account')), account,
    h('label', { class: 'lbl block' }, t('secretKey')), secret, advText);
  modal(ex ? t('edit') : t('addOtp'), body, [
    { label: t('cancel') },
    { label: t('save'), cls: 'primary', act: 'save-otp', onclick: async close => {
      const sec = secret.value.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
      try { if (base32Decode(sec).length < 5) throw new Error('short'); } catch (e) { toast(t('badSecret')); return; }
      if (!issuer.value.trim() && !account.value.trim()) { toast(t('needName')); return; }
      const data = { issuer: issuer.value.trim(), account: account.value.trim(), secret: sec, ...adv };
      if (ex) await S.store.update(ex.id, data); else await S.store.create('totp', data);
      close(); renderList();
    } },
  ]);
}

// ------------------------------------------------------------------ voice typing
let rec = null;
const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
export function voiceButton() {
  if (!SR()) return null;
  const btn = h('button', { type: 'button', class: 'icon-btn mic', id: 'mic', 'data-act': 'voice', title: t('voiceTyping'), 'aria-label': t('voiceTyping'), 'aria-pressed': 'false', onclick: toggleVoice }, '🎤');
  return h('span', { class: 'voice' }, btn, h('button', { type: 'button', class: 'chip tiny', title: t('voiceLang'), onclick: e => {
    S.settings.voiceLang = S.settings.voiceLang === 'mr-IN' ? 'en-IN' : 'mr-IN'; saveSettings(); e.currentTarget.textContent = S.settings.voiceLang === 'mr-IN' ? 'मर' : 'EN';
  } }, S.settings.voiceLang === 'mr-IN' ? 'मर' : 'EN'));
}
export function stopVoice() { if (rec) { try { rec.onend = null; rec.stop(); } catch (e) { /* ignore */ } rec = null; } }
function toggleVoice() {
  const btn = document.getElementById('mic');
  if (rec) { stopVoice(); btn && btn.classList.remove('on'); btn && btn.setAttribute('aria-pressed', 'false'); return; }
  if (!S.editor) return;
  const R = SR();
  rec = new R();
  rec.lang = S.settings.voiceLang || 'mr-IN';
  rec.continuous = true; rec.interimResults = true;
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) S.editor && S.editor.insertText(r[0].transcript.trim() + ' ');
      else interim += r[0].transcript;
    }
    if (interim) toast('🎤 ' + interim, 1500);
  };
  rec.onerror = e => { toast(e.error === 'not-allowed' ? t('micDenied') : t('voiceError')); };
  rec.onend = () => { rec = null; const b = document.getElementById('mic'); if (b) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); } };
  try { rec.start(); btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true'); toast(t('listening')); }
  catch (e) { rec = null; toast(t('voiceError')); }
}

// ------------------------------------------------------------------ app passcode
const pcKey = () => 'mn.passcode.' + (S.account ? S.account.sub : '');
export async function needsPasscode() { return !!localStorage.getItem(pcKey()); }
export function passcodeScreen() {
  return new Promise(resolve => {
    const rec = JSON.parse(localStorage.getItem(pcKey()) || 'null');
    if (!rec) { resolve(); return; }
    const el = document.getElementById('lock-screen');
    const inp = h('input', { class: 'inp pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('passcode'), 'aria-label': t('passcode'), id: 'passcode-input' });
    const go = async () => {
      if (await verifyPin(inp.value, rec.salt, rec.hash)) { el.hidden = true; el.replaceChildren(); resolve(); }
      else { inp.value = ''; toast(t('wrongPin')); inp.focus(); }
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    el.replaceChildren(h('div', { class: 'screen-card' }, h('div', { class: 'big' }, '🔐'), h('h2', {}, t('appLocked')), inp,
      h('button', { type: 'button', class: 'btn primary', 'data-act': 'unlock-app', onclick: go }, t('unlock')),
      h('p', { class: 'muted small' }, S.account ? S.account.email : '')));
    el.hidden = false;
    setTimeout(() => inp.focus(), 50);
  });
}
export async function maybeRelockApp() {
  if (!(await needsPasscode())) return;
  if (S.hiddenAt && Date.now() - S.hiddenAt > 60000 && document.getElementById('lock-screen').hidden) { S.hiddenAt = null; await passcodeScreen(); }
}

async function setPasscode() {
  const p1 = await ask(t('setPasscode'), { inputType: 'password', help: t('passcodeHelp') });
  if (!p1) return;
  if (p1.length < 4) { toast(t('pinTooShort')); return; }
  const p2 = await ask(t('confirmPin'), { inputType: 'password' });
  if (p1 !== p2) { toast(t('pinMismatch')); return; }
  localStorage.setItem(pcKey(), JSON.stringify(await hashPin(p1)));
  toast(t('passcodeSet'));
}
async function removePasscode() {
  const rec = JSON.parse(localStorage.getItem(pcKey()) || 'null');
  const p = await ask(t('enterPin'), { inputType: 'password' });
  if (!p) return;
  if (!(await verifyPin(p, rec.salt, rec.hash))) { toast(t('wrongPin')); return; }
  localStorage.removeItem(pcKey()); toast(t('passcodeRemoved'));
}

// ------------------------------------------------------------------ settings
export async function openSettings() {
  const lastSync = await S.db.getMeta('lastSyncAt');
  const pending = await S.store.hasPending();
  const sel = (key, options, onchange) => {
    const s = h('select', { class: 'sel', 'data-setting': key }, ...options.map(([v, l]) => h('option', { value: v, selected: S.settings[key] === v }, l)));
    s.addEventListener('change', () => { S.settings[key] = s.value; saveSettings(); onchange && onchange(); });
    return s;
  };
  const cid = h('input', { class: 'inp mono', value: localStorage.getItem('mn.clientId') || '', placeholder: clientId() || 'xxxx.apps.googleusercontent.com', 'aria-label': t('clientIdLabel') });
  const hasPc = await needsPasscode();
  const body = h('div', { class: 'settings' },
    h('section', {}, h('h3', {}, t('account')),
      h('p', {}, h('strong', {}, S.account.email)),
      h('p', { class: 'muted small' }, t('dataInDrive')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', 'data-act': 'sync-now', onclick: () => doSync({ full: true }) }, '⟳ ' + t('syncNow')),
        h('button', { type: 'button', class: 'btn danger', 'data-act': 'signout', onclick: () => signOutDialog() }, t('signOut'))),
      h('p', { class: 'muted small' }, t('lastSync') + ': ' + (lastSync ? formatDateTime(lastSync) : '—') + (pending ? ' · ' + t('pendingChanges') : ''))),
    h('section', {}, h('h3', {}, t('appearance')),
      h('label', { class: 'lbl block' }, t('language')), sel('lang', [['mr', 'मराठी'], ['en', 'English']], () => { setLang(S.settings.lang); m.close(); renderApp(); }),
      h('label', { class: 'lbl block' }, t('theme')), sel('theme', [['auto', t('themeAuto')], ['light', t('themeLight')], ['dark', t('themeDark')]], applyTheme),
      h('label', { class: 'lbl block' }, t('defaultType')), sel('defaultType', NOTE_TYPES.map(x => [x, t('type_' + x)])),
      h('label', { class: 'lbl block' }, t('voiceLang')), sel('voiceLang', [['mr-IN', 'मराठी (mr-IN)'], ['en-IN', 'English (en-IN)']])),
    h('section', {}, h('h3', {}, t('security')),
      h('p', { class: 'muted small' }, t('passcodeHelp')),
      h('div', { class: 'row' }, hasPc
        ? h('button', { type: 'button', class: 'btn', onclick: async () => { await removePasscode(); m.close(); } }, t('removePasscode'))
        : h('button', { type: 'button', class: 'btn', 'data-act': 'set-passcode', onclick: async () => { await setPasscode(); m.close(); } }, t('setPasscode')))),
    h('section', {}, h('h3', {}, t('backup')),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn', 'data-act': 'backup-json', onclick: () => backupJSON() }, '⇩ ' + t('backupJson')),
        h('button', { type: 'button', class: 'btn', 'data-act': 'backup-zip', onclick: () => backupZip() }, '⇩ ' + t('backupZip')),
        h('button', { type: 'button', class: 'btn', 'data-act': 'import', onclick: () => importFiles() }, '⇧ ' + t('import'))),
      h('p', { class: 'muted small' }, t('importHelp'))),
    h('section', {}, h('h3', {}, t('googleSetup')),
      h('label', { class: 'lbl block' }, t('clientIdLabel')), cid,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => {
        const v = cid.value.trim();
        if (v && !/\.apps\.googleusercontent\.com$/.test(v)) { toast(t('clientIdInvalid')); return; }
        if (v) localStorage.setItem('mn.clientId', v); else localStorage.removeItem('mn.clientId');
        toast(t('saved')); setTimeout(() => location.reload(), 600);
      } }, t('save')))),
    h('p', { class: 'muted small center' }, t('appName') + ' v' + APP_VERSION));
  const m = modal(t('settings'), body, [], { wide: true });
}

async function signOutDialog() {
  const pending = await S.store.hasPending();
  const chk = h('input', { type: 'checkbox', checked: !pending, id: 'clear-cache' });
  const body = h('div', {},
    h('p', {}, t('signOutMsg')),
    pending ? h('p', { class: 'error' }, t('signOutPending')) : null,
    h('label', { class: 'lbl' }, chk, ' ' + t('clearCache')));
  modal(t('signOut'), body, [
    { label: t('cancel') },
    { label: t('signOut'), cls: 'danger', act: 'confirm-signout', onclick: async close => {
      close();
      flushSave();
      const name = dbName(S.account);
      const sub = S.account.sub;
      S.timers.forEach(clearInterval);
      S.auth.signOut();
      S.db.close();
      if (chk.checked) { await DB.deleteDatabase(name); localStorage.removeItem('mn.passcode.' + sub); }
      location.reload();
    } },
  ]);
}

// ------------------------------------------------------------------ backup / import
function stamp() { return dayKey(); }
async function backupData(includeBlobs = true) {
  flushSave();
  const items = [...S.store.items.values()];
  const revisions = await S.db.getAll('revs');
  const blobs = includeBlobs ? await S.db.getAll('blobs') : [];
  return makeBackup({ items, revisions, blobs });
}
async function backupJSON() {
  const b = await backupData(true);
  download({ name: `majhi-notes-backup-${stamp()}.json`, mime: 'application/json', content: JSON.stringify(b) });
  toast(t('backupDone'));
}
async function backupZip() {
  const zip = new window.JSZip();
  const used = new Set();
  const uniq = name => { let n = name, i = 2; while (used.has(n.toLowerCase())) { n = name.replace(/(\.[^.]+)$/, ` (${i++})$1`); } used.add(n.toLowerCase()); return n; };
  for (const n of S.store.notes()) {
    if (n.lockHash) continue;
    const dir = n.trashed ? 'trash/' : n.archived ? 'archive/' : 'notes/';
    const md = exportNote(n, 'md', { htmlToMd, mdToHtml });
    zip.file(dir + uniq(dir + md.name).slice(dir.length), md.content);
    if (n.noteType === 'sheet') { const c = exportNote(n, 'csv'); zip.file(dir + uniq(dir + c.name).slice(dir.length), c.content); }
  }
  for (const f of S.store.list('file')) {
    const rec = await S.store.getBlobRecord(f.id);
    if (rec) zip.file('files/' + uniq('files/' + safeFileName(f.name)).slice(6), rec.bytes);
  }
  zip.file('backup.json', JSON.stringify(await backupData(false)));
  zip.file('README.txt', t('zipReadme'));
  const blob = await zip.generateAsync({ type: 'blob' });
  download({ name: `majhi-notes-${stamp()}.zip`, blob });
  toast(t('backupDone'));
}

export async function importFiles(files) {
  files = files || await pickFiles({ accept: '.json,.md,.txt,.markdown,application/json,text/plain,text/markdown', multiple: true });
  let count = 0, errors = 0;
  for (const f of files) {
    try {
      const text = await f.text();
      if (/\.json$/i.test(f.name) || f.type === 'application/json') count += await importBackupText(text);
      else {
        const title = f.name.replace(/\.(md|markdown|txt)$/i, '');
        await S.store.create('note', { title, text, noteType: /\.(md|markdown)$/i.test(f.name) ? 'markdown' : 'plain' });
        count++;
      }
    } catch (e) { console.warn('import', e); errors++; toast(t('importFailed', { name: f.name, err: e.message }), 6000); }
  }
  if (count) { toast(t('imported', { n: count }), 4000); renderNav(); renderList(); scheduleSync(1000); }
  return { count, errors };
}

export async function importBackupText(text) {
  const p = parseBackup(text);
  let n = 0;
  for (const it of p.items) {
    const cur = S.store.getAny(it.id);
    if (cur && cur.type !== 'tombstone' && cur.updatedAt >= it.updatedAt) continue;
    const clean = {}; for (const k of Object.keys(it)) if (k[0] !== '_') clean[k] = it[k];
    if (clean.type === 'file') delete clean.blobRid;
    await S.store.putFromRemote({ ...clean, _dirty: 1, _rid: cur ? cur._rid : null, _rupd: cur ? cur._rupd : 0 });
    n++;
  }
  for (const r of p.revisions) {
    if (await S.db.get('revs', r.id)) continue;
    await S.db.put('revs', { ...r, _dirty: 1 });
    await S.store._pending('pendingRevs', r.id, true);
  }
  for (const b of p.blobs) if (S.store.get(b.id)) await S.store.putBlob(b.id, b.bytes, b.mime, 1);
  return n;
}

// ------------------------------------------------------------------ share target inbox
function openShareDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('majhi-share', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('inbox')) r.result.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

export async function processShareInbox() {
  const entries = [];
  const params = new URLSearchParams(location.search);
  if (params.has('text') || params.has('url') || params.has('title')) {
    entries.push({ title: params.get('title') || '', text: params.get('text') || '', url: params.get('url') || '', files: [] });
  }
  try {
    const db = await openShareDB();
    const all = await new Promise((res, rej) => { const r = db.transaction('inbox').objectStore('inbox').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    entries.push(...all);
    if (all.length) await new Promise((res, rej) => { const tx = db.transaction('inbox', 'readwrite'); tx.objectStore('inbox').clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (e) { console.warn('share inbox', e); }
  if (params.has('share') || entries.length) history.replaceState(null, '', location.pathname);
  let last = null;
  for (const e of entries) {
    const files = (e.files || []).map(f => new File([f.bytes], f.name || 'shared', { type: f.type || 'application/octet-stream' }));
    const text = [e.text, e.url && !(e.text || '').includes(e.url) ? e.url : ''].filter(Boolean).join('\n');
    const title = (e.title || text.split('\n')[0] || t('sharedNote')).slice(0, 120);
    const images = files.filter(f => /^image\//.test(f.type));
    const noteType = images.length ? 'super' : 'plain';
    const note = await S.store.create('note', { noteType, title, text: noteType === 'plain' ? text : '' });
    const ids = await addFiles(files, note.id);
    if (noteType === 'super') {
      const imgIds = ids.filter(id => /^image\//.test(S.store.get(id).mime));
      const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const html = text.split('\n').map(l => `<p>${/^https?:\/\//.test(l) ? `<a href="${esc(l)}" target="_blank" rel="noopener">${esc(l)}</a>` : esc(l)}</p>`).join('') + imgIds.map(id => `<p><img data-file-id="${id}" alt=""></p>`).join('');
      await S.store.update(note.id, { text: html || '<p><br></p>' }, { revision: false });
    }
    last = note;
  }
  if (last) { toast(t('sharedSaved')); setView({ kind: 'all' }); openNote(last.id); }
}

export { CODE_LANGS, uid, plainOf, viewTitle, noteToMarkdown };
