// DOM helpers: element builder, sanitizing, markdown rendering, modals, menus, toasts.
import { t } from './i18n.js';

const PROPS = new Set(['value', 'checked', 'disabled', 'readOnly', 'selected', 'multiple', 'hidden', 'indeterminate']);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false && !PROPS.has(k)) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const PURIFY_CFG = {
  ADD_ATTR: ['target', 'data-file-id'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'script', 'meta', 'link', 'base'],
  FORBID_ATTR: ['contenteditable', 'id'],
  ALLOW_DATA_ATTR: false,
};

// mode: undefined (Super note content), 'paste' (also drops classes), 'md' (keeps task-list checkboxes)
export function sanitizeHtml(html, mode) {
  let cfg = PURIFY_CFG;
  if (mode === 'paste' || mode === true) cfg = { ...PURIFY_CFG, FORBID_ATTR: [...PURIFY_CFG.FORBID_ATTR, 'class'] };
  if (mode === 'md') cfg = { ...PURIFY_CFG, FORBID_TAGS: PURIFY_CFG.FORBID_TAGS.filter(x => x !== 'input') };
  return window.DOMPurify.sanitize(String(html || ''), cfg);
}

let mdReady = false;
export function renderMarkdown(src) {
  if (!mdReady) {
    window.marked.setOptions({ gfm: true, breaks: true });
    mdReady = true;
  }
  const html = sanitizeHtml(window.marked.parse(String(src || '')), 'md');
  const box = document.createElement('div');
  box.innerHTML = html;
  box.querySelectorAll('pre code').forEach(c => { try { window.hljs.highlightElement(c); } catch (e) { /* ignore */ } });
  box.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  box.querySelectorAll('input').forEach(i => { if (i.type !== 'checkbox') i.remove(); else { i.disabled = true; i.setAttribute('disabled', ''); } });
  return box.innerHTML;
}

// ---- toast
let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---- modal
export function modal(title, body, buttons = [], { wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const prevFocus = document.activeElement;
  const close = (val) => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose(val);
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
  const foot = h('div', { class: 'modal-foot' }, ...buttons.map(b => h('button', {
    type: 'button', class: 'btn ' + (b.cls || ''), 'data-act': b.act || '', onclick: () => b.onclick ? b.onclick(close) : close(b.value),
  }, b.label)));
  const dlg = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: () => close(null) }, '✕')),
    h('div', { class: 'modal-body' }, body), buttons.length ? foot : null);
  const back = h('div', { class: 'modal-back', onclick: e => { if (e.target === back) close(null); } }, dlg);
  root.append(back);
  document.addEventListener('keydown', onKey, true);
  // Autofocus the first field, unless the user already started typing somewhere in the dialog.
  setTimeout(() => { if (dlg.contains(document.activeElement)) return; const f = dlg.querySelector('input:not([type=hidden]),textarea,select'); if (f) f.focus(); }, 30);
  return { close, el: dlg };
}

export function ask(title, { value = '', inputType = 'text', placeholder = '', help = '', okText } = {}) {
  return new Promise(res => {
    const inp = h('input', { class: 'inp', type: inputType, value, placeholder, 'aria-label': title, autocomplete: inputType === 'password' ? 'off' : 'on' });
    if (inputType === 'password') inp.setAttribute('inputmode', 'numeric');
    let m;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); m.close(inp.value.trim() === '' ? null : inp.value); } });
    m = modal(title, h('div', {}, help ? h('p', { class: 'muted' }, help) : null, inp), [
      { label: t('cancel'), value: null },
      { label: okText || t('ok'), cls: 'primary', act: 'ok', onclick: close => close(inp.value.trim() === '' ? null : inp.value) },
    ], { onClose: v => res(v ?? null) });
  });
}

export function confirmDlg(message, { okText, danger = false, title } = {}) {
  return new Promise(res => {
    modal(title || t('confirm'), h('p', {}, message), [
      { label: t('cancel'), value: false },
      { label: okText || t('ok'), cls: danger ? 'danger' : 'primary', act: 'ok', value: true },
    ], { onClose: v => res(!!v) });
  });
}

// ---- popup menu anchored to an element
export function openMenu(anchor, items, { grid = false } = {}) {
  document.querySelectorAll('.popmenu').forEach(m => m.remove());
  const menu = h('div', { class: 'popmenu' + (grid ? ' grid' : ''), role: 'menu' });
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { menu.append(h('div', { class: 'menu-sep' })); continue; }
    menu.append(h('button', {
      type: 'button', class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', title: it.title || '', 'data-k': it.k || '',
      disabled: !!it.disabled,
      onpointerdown: e => e.preventDefault(),
      onclick: () => { close(); it.onclick && it.onclick(); },
    }, it.icon ? h('span', { class: 'mi-icon' }, it.icon) : null, it.label));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
  const outside = e => { if (!menu.contains(e.target)) close(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); }, 0);
  const first = menu.querySelector('button'); if (first) first.focus({ preventScroll: true });
  return close;
}

export function download({ name, mime, content, blob }) {
  const b = blob || new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(b);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function pickFiles({ accept = '', multiple = true, capture = null } = {}) {
  return new Promise(res => {
    const inp = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    if (capture) inp.setAttribute('capture', capture);
    inp.addEventListener('change', () => { res([...inp.files]); inp.remove(); });
    inp.addEventListener('cancel', () => { res([]); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}
