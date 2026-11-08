// माझी नोट्स — main application: boot, sign-in, navigation, note list, editor.
import { t, setLang, getLang } from './i18n.js';
import { h, sanitizeHtml, renderMarkdown, toast, modal, ask, confirmDlg, openMenu, download, pickFiles } from './ui.js';
import { DB } from './db.js';
import { Store } from './store.js';
import { Drive, AuthError } from './drive.js';
import { SyncEngine } from './sync.js';
import { Auth } from './auth.js';
import { MOUNTS } from './editors.js';
import { dayKey, debounce, stripHtml, escapeHtml, humanSize } from './util.js';
import { verifyPin, hashPin } from './lock.js';
import { noteToPlain, noteToMarkdown, parseTasks, serializeTasks, sheetToMarkdown, exportNote } from './backup.js';
import { parseSheet } from './sheet.js';
import * as X from './extra.js';

export const APP_VERSION = '1.0.0';
export const NOTE_TYPES = ['plain', 'super', 'markdown', 'code', 'sheet', 'tasks'];
const MAX_FILE = 50 * 1024 * 1024;

export const S = {
  settings: loadSettings(),
  auth: null, account: null, db: null, store: null, sync: null,
  view: { kind: 'all' }, noteId: null, search: '',
  unlocked: new Set(), editor: null, pendingSave: null,
  syncState: 'idle', timers: [], blobUrls: new Map(), plainCache: new Map(),
};
window.__majhi = S; // handy for debugging and automated tests

function loadSettings() {
  const d = { lang: 'mr', theme: 'auto', defaultType: 'plain', voiceLang: 'mr-IN', sortBy: 'updatedAt', sortDir: 'desc' };
  try { return { ...d, ...JSON.parse(localStorage.getItem('mn.settings') || '{}') }; } catch (e) { return d; }
}
export function saveSettings() { localStorage.setItem('mn.settings', JSON.stringify(S.settings)); }

export function clientId() {
  const local = (localStorage.getItem('mn.clientId') || '').trim();
  const cfg = (window.MAJHI_CONFIG && window.MAJHI_CONFIG.GOOGLE_CLIENT_ID || '').trim();
  const id = local || cfg;
  return id && id !== 'PASTE_CLIENT_ID' ? id : '';
}

// ------------------------------------------------------------------ theme
export function applyTheme() {
  const pref = S.settings.theme;
  const dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.dark = dark ? '1' : '0';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#14181f' : '#2f5d50');
  const hl = document.getElementById('hljs-theme');
  if (hl) hl.href = dark ? 'hljs-dark.css' : 'hljs-light.css';
  if (S.editor && S.editor.cm) S.editor.cm.setOption('theme', dark ? 'material-darker' : 'default');
}

// ------------------------------------------------------------------ boot
async function boot() {
  setLang(S.settings.lang);
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(e => console.warn('sw', e));
  }
  S.auth = new Auth(clientId());
  if (S.auth.account) return openAccount(S.auth.account);
  if (!clientId()) return renderSetup();
  renderSignIn();
}

function screen(...children) {
  document.body.classList.add('screen-mode');
  const el = document.getElementById('screen');
  el.replaceChildren(h('div', { class: 'screen-card' }, ...children));
  el.hidden = false;
}
function hideScreen() { document.body.classList.remove('screen-mode'); const el = document.getElementById('screen'); el.hidden = true; el.replaceChildren(); }

function langToggle() {
  return h('button', { type: 'button', class: 'chip', onclick: () => { S.settings.lang = getLang() === 'mr' ? 'en' : 'mr'; saveSettings(); setLang(S.settings.lang); (S.auth.account ? renderApp : (clientId() ? renderSignIn : renderSetup))(); } }, getLang() === 'mr' ? 'English' : 'मराठी');
}

export function renderSetup() {
  const inp = h('input', { class: 'inp', placeholder: 'xxxxxxxx.apps.googleusercontent.com', 'aria-label': t('clientIdLabel') });
  screen(
    h('div', { class: 'brand' }, h('img', { src: 'icon-192.png', alt: '', width: 72, height: 72 }), h('h1', {}, t('appName'))),
    h('h2', {}, t('setupTitle')),
    h('p', {}, t('setupIntro')),
    h('ol', { class: 'steps' }, ...t('setupSteps').split('\n').map(s => h('li', {}, s))),
    h('label', { class: 'lbl block' }, t('clientIdLabel')), inp,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', 'data-act': 'save-client', onclick: () => {
      const v = inp.value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast(t('clientIdInvalid')); return; }
      localStorage.setItem('mn.clientId', v);
      S.auth = new Auth(v);
      renderSignIn();
    } }, t('save')), langToggle()),
  );
}

export function renderSignIn(errMsg) {
  const btn = h('button', { type: 'button', class: 'btn google', 'data-act': 'signin', onclick: async () => {
    btn.disabled = true;
    try {
      S.auth = S.auth && S.auth.clientId === clientId() ? S.auth : new Auth(clientId());
      const acc = await S.auth.signIn();
      await openAccount(acc);
    } catch (e) {
      console.warn('sign-in', e);
      btn.disabled = false;
      renderSignIn(signInError(e));
    }
  } }, h('span', { class: 'g' }, 'G'), ' ' + t('signInGoogle'));
  screen(
    h('div', { class: 'brand' }, h('img', { src: 'icon-192.png', alt: '', width: 88, height: 88 }), h('h1', {}, t('appName'))),
    h('p', { class: 'lead' }, t('tagline')),
    btn,
    errMsg ? h('p', { class: 'error', role: 'alert' }, errMsg) : null,
    h('p', { class: 'muted small' }, t('signInNote')),
    h('div', { class: 'row' }, langToggle(), h('button', { type: 'button', class: 'chip', onclick: renderSetup }, t('changeClientId'))),
  );
}

function signInError(e) {
  if (!navigator.onLine) return t('errOffline');
  if (e && e.type === 'scope') return t('errScope');
  if (e && (e.type === 'popup_closed' || e.type === 'popup_failed_to_open')) return t('errPopup');
  if (e && /gis/.test(e.message)) return t('errGis');
  return t('errSignIn');
}

// ------------------------------------------------------------------ account
export function dbName(acc) { return 'majhi-notes-' + acc.sub; }

async function openAccount(acc) {
  S.account = acc;
  S.db = await new DB(dbName(acc)).open();
  S.store = await new Store(S.db).load();
  const drive = new Drive({ getToken: async () => S.auth.accessToken() });
  S.sync = new SyncEngine({ store: S.store, drive, conflictLabel: t('conflictedCopy') });
  S.store.on(onStoreChange);
  S.store.onDirty(() => scheduleSync(3000));
  if (await X.needsPasscode()) await X.passcodeScreen();
  hideScreen();
  renderApp();
  wireBackground();
  const wantNew = new URLSearchParams(location.search).get('new') === '1';
  await X.processShareInbox();
  if (wantNew) { history.replaceState(null, '', location.pathname); newNoteDialog(); }
  doSync();
}

function wireBackground() {
  S.timers.forEach(clearInterval);
  S.timers = [setInterval(() => doSync(), 120000)];
  window.addEventListener('online', () => doSync());
  window.addEventListener('offline', () => setSyncState('offline'));
  window.addEventListener('focus', () => doSync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushSave();
      if (S.noteId) S.store.checkpoint(S.noteId);
      S.hiddenAt = Date.now();
      if (S.unlocked.size) { S.unlocked.clear(); S.relockOnShow = true; }
    } else {
      if (S.relockOnShow) { S.relockOnShow = false; renderEditor(); }
      X.maybeRelockApp();
      doSync();
    }
  });
  window.addEventListener('pagehide', () => flushSave());
  window.addEventListener('popstate', () => {
    // Our own history.back() from showList(): if a note was opened again before it landed, re-add its entry.
    if (S.backPending) { S.backPending = false; if (document.body.dataset.pane === 'editor' && !window.matchMedia('(min-width: 900px)').matches) history.pushState({ pane: 'editor' }, ''); return; }
    if (document.body.dataset.pane === 'editor') showList(false);
  });
  // Desktop: after the hour-long token expires, the next click quietly reconnects (popup closes by itself).
  document.addEventListener('pointerdown', e => {
    if (!S.auth || S.auth.valid() || !S.auth.account || !navigator.onLine) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    if (e.target.closest && e.target.closest('textarea,[contenteditable=true],input,.CodeMirror,#banner')) return;
    if (S.autoReconnectAt && Date.now() - S.autoReconnectAt < 10 * 60000) return;
    S.autoReconnectAt = Date.now();
    reconnect(true);
  }, true);
}

// ------------------------------------------------------------------ sync control
let syncTimer = null;
export function scheduleSync(ms = 3000) { clearTimeout(syncTimer); syncTimer = setTimeout(() => doSync(), ms); }

export async function doSync(opts) {
  if (!S.sync) return;
  clearTimeout(syncTimer);
  if (!navigator.onLine) { setSyncState('offline'); return; }
  if (!S.auth.valid()) { setSyncState('auth'); return; }
  setSyncState('syncing');
  try {
    const st = await S.sync.sync(opts);
    setSyncState('ok');
    if (st && st.conflicts) toast(t('conflictsFound', { n: st.conflicts }), 5000);
  } catch (e) {
    if (e instanceof AuthError) { S.auth.expire(); setSyncState('auth'); }
    else { console.warn('sync failed', e); setSyncState(navigator.onLine ? 'error' : 'offline'); scheduleSync(30000); }
  }
}

export async function reconnect(quiet = false) {
  try {
    await S.auth.reconnect();
    setSyncState('idle');
    doSync();
  } catch (e) {
    if (e && e.type === 'other-account') { toast(t('otherAccount', { email: e.email }), 6000); return; }
    if (!quiet) toast(signInError(e), 5000);
    setSyncState('auth');
  }
}

async function setSyncState(st) {
  S.syncState = st;
  const el = document.getElementById('sync-status');
  if (el) {
    const pending = S.store ? await S.store.hasPending() : false;
    const map = { idle: ['•', 'syncIdle'], syncing: ['⟳', 'syncing'], ok: ['✓', 'synced'], offline: ['⚡', 'offline'], auth: ['⚠', 'needReconnect'], error: ['!', 'syncError'] };
    let [icon, key] = map[st] || map.idle;
    if (st === 'ok' && pending) { icon = '•'; key = 'pendingChanges'; }
    el.textContent = icon;
    el.title = t(key);
    el.setAttribute('aria-label', t(key));
    el.dataset.state = st;
  }
  const banner = document.getElementById('banner');
  if (banner) {
    if (st === 'auth' && S.auth && S.auth.account) {
      banner.replaceChildren(h('span', {}, t('reconnectMsg')), h('button', { type: 'button', class: 'btn small primary', 'data-act': 'reconnect', onclick: () => reconnect(false) }, t('reconnect')));
      banner.hidden = false;
    } else if (st === 'offline') {
      banner.replaceChildren(h('span', {}, t('offlineMsg')));
      banner.hidden = false;
    } else banner.hidden = true;
  }
}

// ------------------------------------------------------------------ app shell
export function renderApp() {
  hideScreen();
  document.documentElement.lang = getLang();
  const app = document.getElementById('app');
  app.hidden = false;
  app.replaceChildren(
    h('header', { id: 'topbar' },
      h('button', { type: 'button', class: 'icon-btn nav-toggle', 'aria-label': t('menu'), title: t('menu'), onclick: () => document.body.classList.toggle('nav-open') }, '☰'),
      h('div', { class: 'app-title' }, h('img', { src: 'icon-192.png', alt: '', width: 28, height: 28 }), h('span', {}, t('appName'))),
      h('div', { class: 'grow' }),
      h('button', { type: 'button', id: 'sync-status', class: 'icon-btn', onclick: () => (S.syncState === 'auth' ? reconnect(false) : doSync({ full: true })) }, '•'),
      h('button', { type: 'button', class: 'icon-btn', 'data-act': 'settings', 'aria-label': t('settings'), title: t('settings'), onclick: () => X.openSettings() }, '⚙'),
    ),
    h('div', { id: 'banner', role: 'status', hidden: true }),
    h('main', { id: 'main' },
      h('nav', { id: 'nav', 'aria-label': t('menu') }),
      h('div', { class: 'nav-scrim', onclick: () => document.body.classList.remove('nav-open') }),
      h('section', { id: 'list', 'aria-label': t('notes') }),
      h('section', { id: 'editor', 'aria-label': t('editor') }),
    ),
  );
  if (!document.body.dataset.pane) document.body.dataset.pane = 'list';
  renderNav(); renderList(); renderEditor();
  setSyncState(S.syncState);
}

const listSoon = debounce(() => { renderList(); renderNav(); }, 250);
function onStoreChange(ids, source) {
  for (const id of ids) S.plainCache.delete(id);
  if (source === 'remote' && S.noteId && ids.includes(S.noteId) && !S.pendingSave) {
    const active = document.activeElement;
    const editing = active && document.getElementById('editor')?.contains(active);
    if (!editing) renderEditor();
  }
  if (source === 'remote' && S.noteId && ids.includes(S.noteId) && !S.store.get(S.noteId)) { S.noteId = null; renderEditor(); }
  listSoon();
}

// ------------------------------------------------------------------ nav
const BUILTIN_VIEWS = [
  ['all', '📝'], ['today', '📅'], ['starred', '⭐'], ['pinned', '📌'], ['untagged', '◌'], ['archived', '🗄'], ['trash', '🗑'], ['conflicts', '⚠'],
];
const WIDE_VIEWS = [['files', '📎'], ['moments', '📷'], ['authenticator', '🔐']];

export function setView(v) {
  flushSave();
  S.view = v; S.search = '';
  document.body.classList.remove('nav-open');
  document.body.classList.toggle('wide', ['files', 'moments', 'authenticator'].includes(v.kind));
  if (document.body.classList.contains('wide')) document.body.dataset.pane = 'list';
  X.stopAuthTicker();
  renderNav(); renderList();
}

function navItem(label, icon, active, count, onclick, extra = {}) {
  return h('div', { class: 'nav-row' + (active ? ' active' : ''), ...extra.row },
    h('button', { type: 'button', class: 'nav-item', onclick, 'aria-current': active ? 'page' : null, 'data-view': extra.key || '' },
      h('span', { class: 'ni' }, icon), h('span', { class: 'nl' }, label), count != null ? h('span', { class: 'nc' }, String(count)) : null),
    extra.menu ? h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': t('more'), title: t('more'), onclick: extra.menu, 'data-menu': extra.key || '' }, '⋯') : null);
}

export function renderNav() {
  const nav = document.getElementById('nav'); if (!nav) return;
  const notes = S.store.notes();
  const v = S.view;
  const items = [];
  items.push(h('button', { type: 'button', class: 'btn primary new-note', 'data-act': 'new-note', onclick: () => newNoteDialog() }, '+ ' + t('newNote')));
  items.push(h('div', { class: 'nav-sec' }, t('views')));
  for (const [k, icon] of BUILTIN_VIEWS) {
    const count = notes.filter(viewFilter({ kind: k })).length;
    if (k === 'conflicts' && !count) continue;
    items.push(navItem(t('view_' + k), icon, v.kind === k, count, () => setView({ kind: k }), { key: k }));
  }
  for (const sv of S.store.list('view').sort((a, b) => a.title.localeCompare(b.title))) {
    items.push(navItem(sv.title, '🔖', v.kind === 'smart' && v.id === sv.id, notes.filter(viewFilter({ kind: 'smart', id: sv.id })).length, () => setView({ kind: 'smart', id: sv.id }),
      { key: 'smart-' + sv.id, menu: e => X.smartViewMenu(e.currentTarget, sv) }));
  }
  for (const [k, icon] of WIDE_VIEWS) items.push(navItem(t('view_' + k), icon, v.kind === k, null, () => setView({ kind: k }), { key: k }));

  items.push(h('div', { class: 'nav-sec' }, t('folders'), h('button', { type: 'button', class: 'icon-btn tiny', 'data-act': 'add-folder', title: t('newFolder'), 'aria-label': t('newFolder'), onclick: () => X.newFolder(null) }, '+')));
  items.push(...tree('folder', null, 0, notes));
  items.push(h('div', { class: 'nav-sec' }, t('tags'), h('button', { type: 'button', class: 'icon-btn tiny', 'data-act': 'add-tag', title: t('newTag'), 'aria-label': t('newTag'), onclick: () => X.newTag(null) }, '+')));
  items.push(...tree('tag', null, 0, notes));
  items.push(h('div', { class: 'nav-foot muted small' }, S.account ? S.account.email : ''));
  nav.replaceChildren(...items);
}

function tree(type, parentId, depth, notes, seen = new Set()) {
  const out = [];
  const kids = S.store.list(type).filter(x => (x.parentId || null) === parentId && !seen.has(x.id)).sort((a, b) => a.title.localeCompare(b.title));
  for (const x of kids) {
    seen.add(x.id);
    const kind = type;
    const count = notes.filter(viewFilter({ kind, id: x.id })).length;
    const icon = type === 'folder' ? '📁' : (x.daily ? '📔' : '#');
    const row = navItem(x.title, icon, S.view.kind === kind && S.view.id === x.id, count, () => setView({ kind, id: x.id }),
      { key: kind + '-' + x.id, menu: e => X.treeMenu(e.currentTarget, x) });
    row.style.paddingLeft = (depth * 14) + 'px';
    out.push(row, ...tree(type, x.id, depth + 1, notes, seen));
  }
  return out;
}

// ------------------------------------------------------------------ filtering
export function plainOf(note) {
  const c = S.plainCache.get(note.id);
  if (c && c.u === note.updatedAt) return c.s;
  let s = '';
  try { s = noteToPlain(note); } catch (e) { s = String(note.text || ''); }
  S.plainCache.set(note.id, { u: note.updatedAt, s });
  return s;
}

export function viewFilter(v) {
  const today = dayKey();
  const live = n => !n.trashed && !n.archived;
  const tagIds = new Set(S.store.list('tag').map(x => x.id));
  switch (v.kind) {
    case 'all': return live;
    case 'today': return n => live(n) && (dayKey(n.updatedAt) === today || dayKey(n.createdAt) === today);
    case 'starred': return n => live(n) && n.starred;
    case 'pinned': return n => live(n) && n.pinned;
    case 'untagged': return n => live(n) && !(n.tags || []).some(id => tagIds.has(id));
    case 'archived': return n => n.archived && !n.trashed;
    case 'trash': return n => n.trashed;
    case 'conflicts': return n => live(n) && !!n.conflictOf;
    case 'tag': return n => live(n) && (n.tags || []).includes(v.id);
    case 'folder': return n => live(n) && n.folderId === v.id;
    case 'smart': {
      const sv = S.store.get(v.id);
      if (!sv) return () => false;
      return n => live(n) && (!sv.noteType || n.noteType === sv.noteType) && matches(n, sv.query || '');
    }
    default: return () => false;
  }
}

export function matches(n, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = ((n.title || '') + '\n' + (n.lockHash ? '' : plainOf(n))).toLowerCase();
  return words.every(w => hay.includes(w));
}

function sortNotes(list) {
  const { sortBy, sortDir } = S.settings;
  const dir = sortDir === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    if (S.view.kind !== 'trash' && !!b.pinned - !!a.pinned) return !!b.pinned - !!a.pinned;
    if (sortBy === 'title') return dir * (a.title || '').localeCompare(b.title || '', getLang() === 'mr' ? 'mr' : 'en');
    return dir * ((a[sortBy] || 0) - (b[sortBy] || 0));
  });
}

export function viewTitle(v = S.view) {
  if (v.kind === 'tag' || v.kind === 'folder' || v.kind === 'smart') { const x = S.store.get(v.id); return x ? x.title : t('appName'); }
  return t('view_' + v.kind);
}

// ------------------------------------------------------------------ list
export function renderList() {
  const el = document.getElementById('list'); if (!el) return;
  const v = S.view;
  if (v.kind === 'authenticator') return X.renderAuthenticator(el);
  if (v.kind === 'files') return X.renderFiles(el);
  if (v.kind === 'moments') return X.renderMoments(el);
  if ((v.kind === 'tag' || v.kind === 'folder' || v.kind === 'smart') && !S.store.get(v.id)) { S.view = { kind: 'all' }; }
  const tag = S.view.kind === 'tag' ? S.store.get(S.view.id) : null;
  const daily = !!(tag && tag.daily);
  let notes = S.store.notes().filter(viewFilter(S.view)).filter(n => matches(n, S.search));
  notes = sortNotes(notes);

  const search = h('input', { class: 'inp search', type: 'search', id: 'search', placeholder: t('searchPh'), value: S.search, 'aria-label': t('search') });
  search.addEventListener('input', debounce(() => { S.search = search.value; renderListBody(); }, 150));
  const head = h('div', { class: 'list-head' },
    h('button', { type: 'button', class: 'icon-btn nav-toggle', 'aria-label': t('menu'), onclick: () => document.body.classList.toggle('nav-open') }, '☰'),
    h('h2', {}, viewTitle()),
    h('button', { type: 'button', class: 'icon-btn', 'data-act': 'sort', title: t('sort'), 'aria-label': t('sort'), onclick: e => sortMenu(e.currentTarget) }, '⇅'),
    S.view.kind === 'trash'
      ? h('button', { type: 'button', class: 'chip danger', 'data-act': 'empty-trash', onclick: emptyTrash }, t('emptyTrash'))
      : h('button', { type: 'button', class: 'icon-btn accent', 'data-act': 'new-note-list', title: t('newNote'), 'aria-label': t('newNote'), onclick: () => newNoteDialog() }, '+'),
  );
  const tools = h('div', { class: 'list-tools' }, search,
    h('button', { type: 'button', class: 'icon-btn', 'data-act': 'save-search', title: t('saveSearch'), 'aria-label': t('saveSearch'), onclick: () => X.saveSmartView() }, '🔖'));
  const dailyBar = daily ? h('div', { class: 'daily-bar' },
    h('button', { type: 'button', class: 'btn primary', 'data-act': 'today-entry', onclick: () => X.dailyEntry(tag, dayKey()) }, '✎ ' + t('todayEntry')),
    (() => { const d = h('input', { type: 'date', class: 'inp date', 'aria-label': t('pickDate'), value: dayKey() }); d.addEventListener('change', () => d.value && X.dailyEntry(tag, d.value)); return d; })(),
  ) : null;
  const body = h('div', { id: 'notes', class: 'notes', role: 'list' });
  el.replaceChildren(...[head, tools, dailyBar, body].filter(Boolean));
  renderListBody(notes, daily);

  function renderListBody(pre, isDaily = daily) {
    let list = pre || sortNotes(S.store.notes().filter(viewFilter(S.view)).filter(n => matches(n, S.search)));
    if (isDaily) list = list.sort((a, b) => (b.day || dayKey(b.createdAt)).localeCompare(a.day || dayKey(a.createdAt)) || b.createdAt - a.createdAt);
    const rows = [];
    let lastDay = null;
    for (const n of list.slice(0, 500)) {
      if (isDaily) {
        const d = n.day || dayKey(n.createdAt);
        if (d !== lastDay) { rows.push(h('div', { class: 'day-head' }, formatDay(d))); lastDay = d; }
      }
      rows.push(noteRow(n));
    }
    if (!list.length) rows.push(h('div', { class: 'empty' }, S.search ? t('noResults') : t('emptyList')));
    if (list.length > 500) rows.push(h('div', { class: 'muted small center' }, t('tooMany', { n: list.length })));
    body.replaceChildren(...rows);
  }
}

function noteRow(n) {
  const locked = !!n.lockHash;
  const preview = locked ? '🔒 ' + t('lockedNote') : plainOf(n).slice(0, 140);
  const tags = (n.tags || []).map(id => S.store.get(id)).filter(Boolean);
  return h('div', {
    class: 'note-row' + (n.id === S.noteId ? ' active' : ''), role: 'listitem', tabindex: '0', 'data-id': n.id,
    onclick: () => openNote(n.id), onkeydown: e => { if (e.key === 'Enter') openNote(n.id); },
  },
  h('div', { class: 'nr-top' },
    h('span', { class: 'nr-title' }, n.title || t('untitled')),
    h('span', { class: 'nr-flags' }, n.pinned ? '📌' : '', n.starred ? '⭐' : '', locked ? '🔒' : '', n.readOnly ? '🛡' : '', n.conflictOf ? '⚠' : '')),
  h('div', { class: 'nr-prev' }, preview),
  h('div', { class: 'nr-meta' }, h('span', { class: 'type-badge' }, t('type_' + n.noteType)), ' ', formatTime(n.updatedAt),
    tags.length ? h('span', { class: 'nr-tags' }, ...tags.slice(0, 3).map(tg => h('span', { class: 'tag-mini' }, '#' + tg.title))) : null));
}

function sortMenu(anchor) {
  const set = (by, dir) => { S.settings.sortBy = by; S.settings.sortDir = dir; saveSettings(); renderList(); };
  const cur = (by, dir) => (S.settings.sortBy === by && S.settings.sortDir === dir ? '✓ ' : '');
  openMenu(anchor, [
    { label: cur('updatedAt', 'desc') + t('sortUpdated'), k: 'updated', onclick: () => set('updatedAt', 'desc') },
    { label: cur('createdAt', 'desc') + t('sortCreatedNew'), k: 'created-desc', onclick: () => set('createdAt', 'desc') },
    { label: cur('createdAt', 'asc') + t('sortCreatedOld'), k: 'created-asc', onclick: () => set('createdAt', 'asc') },
    { label: cur('title', 'asc') + t('sortTitleAZ'), k: 'title-asc', onclick: () => set('title', 'asc') },
    { label: cur('title', 'desc') + t('sortTitleZA'), k: 'title-desc', onclick: () => set('title', 'desc') },
  ]);
}

async function emptyTrash() {
  const trashed = S.store.notes().filter(n => n.trashed);
  if (!trashed.length) return;
  if (!(await confirmDlg(t('emptyTrashConfirm', { n: trashed.length }), { danger: true, okText: t('deleteForever') }))) return;
  for (const n of trashed) await deleteNoteForever(n.id, true);
  if (S.noteId && !S.store.get(S.noteId)) S.noteId = null;
  renderEditor(); toast(t('trashEmptied'));
}

export async function deleteNoteForever(id) {
  for (const f of S.store.list('file').filter(f => f.noteId === id)) await S.store.remove(f.id);
  await S.store.remove(id);
}

// ------------------------------------------------------------------ dates
export function formatTime(ts) {
  const loc = getLang() === 'mr' ? 'mr-IN' : 'en-IN';
  const d = new Date(ts);
  const sameDay = dayKey(ts) === dayKey();
  return sameDay ? d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function formatDateTime(ts) {
  const loc = getLang() === 'mr' ? 'mr-IN' : 'en-IN';
  return new Date(ts).toLocaleString(loc, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function formatDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  const loc = getLang() === 'mr' ? 'mr-IN' : 'en-IN';
  return new Date(y, m - 1, d).toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ------------------------------------------------------------------ notes
export async function newNoteDialog() {
  const body = h('div', { class: 'type-grid' }, ...NOTE_TYPES.map(tp => h('button', {
    type: 'button', class: 'type-card', 'data-type': tp, onclick: () => { m.close(); createNote(tp); },
  }, h('span', { class: 'tc-icon' }, TYPE_ICON[tp]), h('span', { class: 'tc-name' }, t('type_' + tp)), h('span', { class: 'tc-desc muted small' }, t('typeDesc_' + tp)))));
  const m = modal(t('newNote'), body, []);
}
export const TYPE_ICON = { plain: '📄', super: '✨', markdown: 'Ⓜ', code: '⌨', sheet: '▦', tasks: '☑' };

// Leave the note that is open now *before* an async step that ends by opening another note
// (creating, duplicating, importing). Its pending edits are saved to that note, and its editor is
// taken off screen at once, so nothing typed during the wait can land in (or be lost from) a
// note the user thinks they have already left.
export function leaveNote() {
  flushSave();
  if (S.noteId) {
    S.store.checkpoint(S.noteId);
    if (S.unlocked.has(S.noteId)) S.unlocked.delete(S.noteId);
  }
  S.noteId = null;
  renderEditor({ busy: true });
}

export async function createNote(noteType, extra = {}) {
  leaveNote();
  const v = S.view;
  const props = { noteType, title: '', text: initialText(noteType), ...extra };
  if (v.kind === 'tag' && !props.tags) props.tags = [v.id];
  if (v.kind === 'folder' && props.folderId === undefined) props.folderId = v.id;
  if (v.kind === 'starred') props.starred = true;
  if (v.kind === 'pinned') props.pinned = true;
  if (['trash', 'archived', 'conflicts', 'files', 'moments', 'authenticator'].includes(v.kind)) setView({ kind: 'all' });
  let n;
  try { n = await S.store.create('note', props); } catch (e) { renderEditor(); throw e; }
  openNote(n.id, { focusTitle: true });
  return n;
}

function initialText(tp) {
  if (tp === 'sheet') return JSON.stringify({ rows: 20, cols: 8, cells: {} });
  if (tp === 'tasks') return serializeTasks({ tasks: [] });
  if (tp === 'super') return '<p><br></p>';
  return '';
}

export function openNote(id, { focusTitle = false } = {}) {
  if (S.noteId && S.noteId !== id) {
    flushSave();
    S.store.checkpoint(S.noteId);
    if (S.unlocked.has(S.noteId)) S.unlocked.delete(S.noteId);
  }
  S.noteId = id;
  const narrow = !window.matchMedia('(min-width: 900px)').matches;
  if (narrow && document.body.dataset.pane !== 'editor' && !S.backPending) { history.pushState({ pane: 'editor' }, ''); }
  document.body.dataset.pane = 'editor';
  document.querySelectorAll('.note-row.active').forEach(r => r.classList.remove('active'));
  document.querySelector(`.note-row[data-id="${CSS.escape(id)}"]`)?.classList.add('active');
  renderEditor();
  if (focusTitle) setTimeout(() => {
    // Do not steal focus if the user already went into the editor (or anywhere else typable).
    const a = document.activeElement;
    if (a && a !== document.body && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if (S.noteId === id) document.getElementById('note-title')?.focus();
  }, 30);
}

export function showList(goBack = true) {
  flushSave();
  if (S.noteId) S.store.checkpoint(S.noteId);
  document.body.dataset.pane = 'list';
  if (goBack && !S.backPending && history.state && history.state.pane === 'editor') { S.backPending = true; history.back(); }
  renderList();
}

// ---- saving
// One pending save at a time, always tagged with the id of the note it was typed into.
// Store.update() puts the change in memory synchronously (IndexedDB follows), so after
// flushSave() returns, S.store already holds the latest text of that note.
const saveText = debounce(() => { writePending(); }, 500);
function writePending() {
  const p = S.pendingSave; S.pendingSave = null;
  if (!p || !S.store || !S.store.get(p.id)) return;
  const job = S.store.update(p.id, p.patch);
  const done = job.catch(e => console.warn('save failed', e));
  S.saving = done;
  done.finally(() => { if (S.saving === done) S.saving = null; if (p.id === S.noteId) updateFooter(); });
}
function queueSave(id, patch) {
  // A change for a different note never replaces (and so drops) the one still waiting: save that first.
  if (S.pendingSave && S.pendingSave.id !== id) { saveText.cancel(); writePending(); }
  S.pendingSave = { id, patch: { ...(S.pendingSave ? S.pendingSave.patch : {}), ...patch } };
  saveText();
}
export function flushSave() { if (S.pendingSave) { saveText.cancel(); writePending(); } }

// ------------------------------------------------------------------ editor
export function renderEditor({ busy = false } = {}) {
  const el = document.getElementById('editor'); if (!el) return;
  // Edits still waiting in the debounce go to their own note first, so a re-mount shows them.
  flushSave();
  if (S.editor) { try { S.editor.flush && S.editor.flush(); S.editor.destroy(); } catch (e) { /* ignore */ } S.editor = null; }
  const gen = S.editorGen = (S.editorGen || 0) + 1;
  X.stopVoice();
  const note = S.noteId ? S.store.get(S.noteId) : null;
  if (busy) { el.replaceChildren(h('div', { class: 'editor-empty', 'aria-busy': 'true' })); return; }
  if (!note || note.type !== 'note') {
    el.replaceChildren(h('div', { class: 'editor-empty' }, h('div', { class: 'big' }, '📝'), h('p', {}, t('pickNote')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => newNoteDialog() }, '+ ' + t('newNote'))));
    return;
  }
  const back = h('button', { type: 'button', class: 'icon-btn back', 'data-act': 'back', 'aria-label': t('back'), title: t('back'), onclick: () => showList() }, '←');
  if (note.lockHash && !S.unlocked.has(note.id)) {
    const pin = h('input', { class: 'inp pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('pin'), 'aria-label': t('pin'), id: 'unlock-pin' });
    const go = async () => {
      if (await verifyPin(pin.value, note.lockSalt, note.lockHash)) { S.unlocked.add(note.id); renderEditor(); }
      else { pin.value = ''; toast(t('wrongPin')); pin.focus(); }
    };
    pin.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    el.replaceChildren(h('div', { class: 'ed-head' }, back, h('div', { class: 'ed-title-static' }, note.title || t('untitled'))),
      h('div', { class: 'locked-panel' }, h('div', { class: 'big' }, '🔒'), h('p', {}, t('noteLockedMsg')), pin,
        h('button', { type: 'button', class: 'btn primary', 'data-act': 'unlock', onclick: go }, t('unlock'))));
    setTimeout(() => pin.focus(), 30);
    return;
  }
  const ro = !!note.readOnly || !!note.trashed;
  const title = h('input', { id: 'note-title', class: 'ed-title', value: note.title || '', placeholder: t('titlePh'), 'aria-label': t('title'), readOnly: ro });
  // Writes are bound to this note's id; once this editor is replaced, it may no longer write at all.
  const live = () => S.editorGen === gen;
  title.addEventListener('input', () => { if (live()) queueSave(note.id, { title: title.value }); });
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); S.editor && S.editor.focus(); } });

  const head = h('div', { class: 'ed-head' }, back, title,
    h('button', { type: 'button', class: 'icon-btn' + (note.starred ? ' on' : ''), 'data-act': 'star', title: t('star'), 'aria-label': t('star'), 'aria-pressed': String(!!note.starred), onclick: () => toggleFlag('starred') }, note.starred ? '★' : '☆'),
    h('button', { type: 'button', class: 'icon-btn', 'data-act': 'note-menu', title: t('more'), 'aria-label': t('more'), onclick: e => X.noteMenu(e.currentTarget, note) }, '⋮'));

  const folder = note.folderId ? S.store.get(note.folderId) : null;
  const meta = h('div', { class: 'ed-meta' },
    h('button', { type: 'button', class: 'chip', 'data-act': 'change-type', disabled: ro, onclick: e => X.changeTypeMenu(e.currentTarget, note) }, TYPE_ICON[note.noteType] + ' ' + t('type_' + note.noteType)),
    h('button', { type: 'button', class: 'chip', 'data-act': 'folder', disabled: ro, onclick: e => X.folderMenu(e.currentTarget, note) }, '📁 ' + (folder ? folder.title : t('noFolder'))),
    ...(note.tags || []).map(id => S.store.get(id)).filter(Boolean).map(tg => h('span', { class: 'chip tag' }, '#' + X.tagPath(tg),
      ro ? null : h('button', { type: 'button', class: 'x', 'aria-label': t('removeTag'), title: t('removeTag'), onclick: () => S.store.update(note.id, { tags: note.tags.filter(x => x !== tg.id) }).then(renderEditor) }, '×'))),
    ro ? null : h('button', { type: 'button', class: 'chip add', 'data-act': 'add-tag-note', onclick: () => X.addTagToNote(note) }, '+ ' + t('tag')));

  const notices = [];
  if (note.trashed) notices.push(h('div', { class: 'notice' }, t('inTrash'),
    h('button', { type: 'button', class: 'btn small', 'data-act': 'restore', onclick: () => setFlag(note.id, { trashed: false }) }, t('restore')),
    h('button', { type: 'button', class: 'btn small danger', 'data-act': 'delete-forever', onclick: async () => { if (await confirmDlg(t('deleteForeverConfirm'), { danger: true, okText: t('deleteForever') })) { await deleteNoteForever(note.id); S.noteId = null; showList(); renderEditor(); } } }, t('deleteForever'))));
  else if (note.readOnly) notices.push(h('div', { class: 'notice' }, '🛡 ' + t('readOnlyMsg'), h('button', { type: 'button', class: 'btn small', onclick: () => toggleFlag('readOnly') }, t('allowEdit'))));
  if (note.archived && !note.trashed) notices.push(h('div', { class: 'notice' }, '🗄 ' + t('archivedMsg'), h('button', { type: 'button', class: 'btn small', onclick: () => toggleFlag('archived') }, t('unarchive'))));
  if (note.conflictOf) notices.push(h('div', { class: 'notice warn' }, '⚠ ' + t('conflictMsg'), h('button', { type: 'button', class: 'btn small', onclick: () => S.store.update(note.id, { conflictOf: null }).then(renderEditor) }, t('keepBoth'))));

  const body = h('div', { class: 'ed-body', 'data-type': note.noteType });
  const atts = h('div', { class: 'attachments', id: 'attachments' });
  const footer = h('div', { class: 'ed-foot' },
    h('span', { id: 'ed-info', class: 'muted small' }),
    h('div', { class: 'grow' }),
    X.voiceButton(),
    h('button', { type: 'button', class: 'icon-btn', 'data-act': 'attach', title: t('attach'), 'aria-label': t('attach'), disabled: ro, onclick: () => X.attachToNote(note.id) }, '📎'),
    h('button', { type: 'button', class: 'icon-btn', 'data-act': 'history', title: t('history'), 'aria-label': t('history'), onclick: () => X.openHistory(note.id) }, '🕘'));

  el.replaceChildren(head, meta, ...notices, body, atts, footer);
  const mount = MOUNTS[note.noteType] || MOUNTS.plain;
  S.editor = mount(body, note, {
    readOnly: ro,
    onChange: text => { if (live()) queueSave(note.id, { text }); },
    onMeta: patch => (live() ? S.store.update(note.id, patch) : Promise.resolve()),
    resolveImages: X.resolveImages,
    pickImage: async () => { const files = await pickFiles({ accept: 'image/*', multiple: true }); return X.addFiles(files, note.id, { inline: true }); },
    addImageFiles: files => X.addFiles(files, note.id, { inline: true }),
    download,
  });
  X.renderAttachments(note.id);
  updateFooter();
}

function updateFooter() {
  const el = document.getElementById('ed-info'); const n = S.noteId && S.store.get(S.noteId);
  if (!el || !n) return;
  const words = (plainOf(n).match(/\S+/g) || []).length;
  el.textContent = t('edited') + ' ' + formatDateTime(n.updatedAt) + ' · ' + t('words', { n: words });
}

export async function toggleFlag(flag) {
  const n = S.store.get(S.noteId); if (!n) return;
  flushSave();
  await setFlag(n.id, { [flag]: !n[flag] });
}
export async function setFlag(id, patch) {
  await S.store.update(id, patch, { revision: false });
  renderEditor(); renderList(); renderNav();
}

// conversions between note types
export function convertText(note, to, htmlToMd) {
  const from = note.noteType, text = note.text || '';
  if (from === to) return text;
  const plainLike = ['plain', 'markdown', 'code'];
  if (to === 'sheet') return JSON.stringify(parseSheet(plainLike.includes(from) ? text : noteToPlain(note)));
  if (to === 'tasks') return serializeTasks(parseTasks(from === 'tasks' ? text : noteToPlain(note)));
  if (to === 'super') {
    let html;
    if (from === 'markdown') html = renderMarkdown(text);
    else if (from === 'sheet') html = renderMarkdown(sheetToMarkdown(parseSheet(text)));
    else if (from === 'tasks') html = '<ul class="checklist">' + parseTasks(text).tasks.map(x => `<li${x.done ? ' class="checked"' : ''}>${escapeHtml(x.text)}</li>`).join('') + '</ul>';
    else html = text.split('\n').map(l => `<p>${escapeHtml(l) || '<br>'}</p>`).join('');
    const box = document.createElement('div'); box.innerHTML = html;
    box.querySelectorAll('li > input[type=checkbox]').forEach(cb => { const li = cb.parentElement; li.parentElement.classList.add('checklist'); if (cb.checked) li.classList.add('checked'); cb.remove(); });
    return sanitizeHtml(box.innerHTML);
  }
  if (to === 'markdown') {
    if (from === 'super') return htmlToMd(text);
    if (from === 'sheet' || from === 'tasks') return noteToMarkdown({ ...note, title: '' }, htmlToMd);
    return text;
  }
  // to plain / code
  if (plainLike.includes(from)) return text;
  return noteToPlain(note);
}

export { stripHtml, humanSize, exportNote, hashPin, MAX_FILE };

boot().catch(e => {
  console.error(e);
  const el = document.getElementById('screen');
  el.hidden = false;
  el.textContent = 'Error: ' + (e && e.message);
});
