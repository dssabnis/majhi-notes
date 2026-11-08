// माझी नोट्स service worker: offline app shell + Android share target.
// When you change app files, bump VERSION so phones fetch the new files.
const VERSION = 'majhi-notes-v1.0.10';
const BASE = new URL('./', self.location).href;
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'app.css',
  'app.js', 'extra.js', 'editors.js', 'ui.js', 'i18n.js', 'util.js', 'db.js', 'store.js',
  'sync.js', 'drive.js', 'auth.js', 'totp.js', 'sheet.js', 'backup.js', 'lock.js',
  'purify.min.js', 'marked.min.js', 'highlight.min.js', 'hljs-light.css', 'hljs-dark.css',
  'turndown.browser.umd.js', 'jszip.min.js', 'jsQR.js',
  'codemirror.js', 'codemirror.css', 'material-darker.css',
  'modes.js', 'addons.js',
  'icon-192.png', 'icon-512.png', 'maskable-512.png', 'favicon.png',
].map(p => new URL(p, BASE).href);

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never stores old files.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k.startsWith('majhi-notes-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

function openShareDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('majhi-share', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('inbox')) r.result.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = [];
    for (const f of form.getAll('files')) {
      if (f && typeof f === 'object' && 'arrayBuffer' in f) files.push({ name: f.name, type: f.type, bytes: await f.arrayBuffer() });
    }
    const entry = { title: String(form.get('title') || ''), text: String(form.get('text') || ''), url: String(form.get('url') || ''), files, at: Date.now() };
    const db = await openShareDB();
    await new Promise((res, rej) => { const tx = db.transaction('inbox', 'readwrite'); tx.objectStore('inbox').add(entry); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (err) { /* fall through to the app; nothing to save */ }
  return Response.redirect(new URL('./?share=1', BASE).href, 303);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.href.startsWith(new URL('share-target', BASE).href)) { e.respondWith(handleShare(req)); return; }
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(BASE)) return;

  // App navigations: network first (fresh app), cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const r = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
        if (r.redirected) return Response.redirect(r.url, 302);
        if (r.ok) { const c = await caches.open(VERSION); c.put(new URL('index.html', BASE).href, r.clone()); }
        return r;
      } catch (err) {
        return (await caches.match(new URL('index.html', BASE).href)) || (await caches.match(BASE)) || Response.error();
      }
    })());
    return;
  }
  // Third-party libraries and icons never change between versions: serve them from the cache.
  const immutable = /\/(purify\.min|marked\.min|highlight\.min|turndown\.browser\.umd|jszip\.min|jsQR|codemirror|modes|addons|material-darker|hljs-(light|dark))\.(js|css)$|\.png$/.test(url.pathname);
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (immutable && cached) return cached;
    try {
      // no-cache: always check GitHub for a newer file (cheap 304 when unchanged).
      const r = await fetch(req, immutable ? undefined : { cache: 'no-cache' });
      if (r.ok) cache.put(req, r.clone());
      return r;
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  })());
});
