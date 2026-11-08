// Note editors. Each mount returns { focus(), insertText(t), flush(), destroy(), refresh?() }.
// Content is reported through opts.onChange(text).
import { t } from './i18n.js';
import { h, sanitizeHtml, renderMarkdown, openMenu, ask, toast } from './ui.js';
import { evaluateSheet, displayValue, parseSheet, refName, colName, sheetToCSV, parseRef } from './sheet.js';
import { parseTasks, serializeTasks } from './backup.js';
import { uid, debounce } from './util.js';

// ---------------------------------------------------------------- plain
export function mountPlain(el, note, opts) {
  const ta = h('textarea', { class: 'ed-plain', spellcheck: 'true', 'aria-label': t('noteBody'), placeholder: t('startWriting') });
  ta.value = note.text || '';
  ta.readOnly = !!opts.readOnly;
  ta.addEventListener('input', () => opts.onChange(ta.value));
  el.append(ta);
  return {
    focus: () => ta.focus(),
    insertText: s => { insertIntoTextarea(ta, s); opts.onChange(ta.value); },
    flush() {}, destroy() {},
  };
}

export function insertIntoTextarea(ta, s) {
  if (ta.readOnly) return;
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.setRangeText(s, a, b, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------- markdown
export function mountMarkdown(el, note, opts) {
  const wide = window.matchMedia('(min-width: 900px)').matches;
  let mode = opts.readOnly ? 'preview' : (wide ? 'split' : 'edit');
  const ta = h('textarea', { class: 'ed-md-src', spellcheck: 'true', 'aria-label': t('noteBody'), placeholder: t('mdPlaceholder') });
  ta.value = note.text || '';
  ta.readOnly = !!opts.readOnly;
  const pv = h('div', { class: 'ed-md-preview prose', 'aria-label': t('preview') });
  const wrap = h('div', { class: 'ed-md' }, ta, pv);
  const render = () => { pv.innerHTML = renderMarkdown(ta.value); opts.resolveImages && opts.resolveImages(pv); };
  const renderSoon = debounce(render, 150);
  const tabs = ['edit', 'split', 'preview'].map(m => h('button', { class: 'chip', 'data-mode': m, type: 'button', onclick: () => setMode(m) }, t('md_' + m)));
  const wrapSel = (pre, post = pre, placeholder = '') => {
    if (ta.readOnly) return;
    const a = ta.selectionStart, b = ta.selectionEnd;
    const sel = ta.value.slice(a, b) || placeholder;
    ta.setRangeText(pre + sel + post, a, b, 'select');
    ta.focus(); ta.dispatchEvent(new Event('input'));
  };
  const linePrefix = (p) => {
    if (ta.readOnly) return;
    const a = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    ta.setRangeText(p, a, a, 'end'); ta.focus(); ta.dispatchEvent(new Event('input'));
  };
  const tools = h('div', { class: 'toolbar', role: 'toolbar' },
    ...tabs,
    h('span', { class: 'sep' }),
    tb('B', t('bold'), () => wrapSel('**', '**', t('text'))),
    tb('I', t('italic'), () => wrapSel('_', '_', t('text'))),
    tb('H', t('heading'), () => linePrefix('## ')),
    tb('•', t('bulletList'), () => linePrefix('- ')),
    tb('☑', t('checklist'), () => linePrefix('- [ ] ')),
    tb('❝', t('quote'), () => linePrefix('> ')),
    tb('</>', t('codeBlock'), () => wrapSel('\n```\n', '\n```\n', 'code')),
    tb('🔗', t('link'), () => wrapSel('[', '](https://)', t('text'))),
    tb('▦', t('table'), () => wrapSel('\n| A | B |\n| --- | --- |\n| ', ' |  |\n', '1')),
  );
  if (opts.readOnly) tools.querySelectorAll('button:not([data-mode])').forEach(b => { b.disabled = true; });
  function setMode(m) {
    mode = m; wrap.dataset.mode = m;
    tabs.forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    if (m !== 'edit') render();
  }
  ta.addEventListener('input', () => { opts.onChange(ta.value); if (mode !== 'edit') renderSoon(); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { // continue lists
      const a = ta.selectionStart;
      const ls = ta.value.lastIndexOf('\n', a - 1) + 1;
      const line = ta.value.slice(ls, a);
      const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)\. )(.*)$/.exec(line);
      if (m) {
        e.preventDefault();
        if (!m[4]) { ta.setRangeText('', ls, a, 'end'); }
        else {
          let marker = m[2];
          if (m[3]) marker = (parseInt(m[3], 10) + 1) + '. ';
          if (/\[[xX]\]/.test(marker)) marker = marker.replace(/\[[xX]\]/, '[ ]');
          ta.setRangeText('\n' + m[1] + marker, a, ta.selectionEnd, 'end');
        }
        ta.dispatchEvent(new Event('input'));
      }
    }
  });
  el.append(tools, wrap);
  setMode(mode);
  return {
    focus: () => ta.focus(),
    insertText: s => insertIntoTextarea(ta, s),
    flush() { renderSoon.flush(); }, destroy() { renderSoon.cancel(); },
  };
}

function tb(label, title, fn, extra = {}) {
  return h('button', {
    type: 'button', class: 'tb', title, 'aria-label': title, ...extra,
    onpointerdown: e => e.preventDefault(), onmousedown: e => e.preventDefault(), onclick: fn,
  }, label);
}

// ---------------------------------------------------------------- code
export const CODE_LANGS = [
  ['javascript', 'JavaScript', 'javascript'], ['typescript', 'TypeScript', 'text/typescript'], ['python', 'Python', 'python'],
  ['html', 'HTML', 'htmlmixed'], ['css', 'CSS', 'css'], ['json', 'JSON', 'application/json'], ['markdown', 'Markdown', 'markdown'],
  ['sql', 'SQL', 'sql'], ['shell', 'Shell', 'shell'], ['java', 'Java', 'text/x-java'], ['c', 'C', 'text/x-csrc'],
  ['cpp', 'C++', 'text/x-c++src'], ['csharp', 'C#', 'text/x-csharp'], ['php', 'PHP', 'application/x-httpd-php'],
  ['go', 'Go', 'go'], ['rust', 'Rust', 'rust'], ['yaml', 'YAML', 'yaml'], ['xml', 'XML', 'xml'], ['text', 'Plain', 'text/plain'],
];

export function mountCode(el, note, opts) {
  const lang = note.lang || 'javascript';
  const sel = h('select', { class: 'sel', 'aria-label': t('language'), disabled: !!opts.readOnly },
    ...CODE_LANGS.map(([v, n]) => h('option', { value: v, selected: v === lang }, n)));
  const wrapChk = h('input', { type: 'checkbox', checked: true });
  const tools = h('div', { class: 'toolbar' }, h('label', { class: 'lbl' }, t('language') + ' '), sel,
    h('label', { class: 'lbl' }, wrapChk, ' ' + t('wrapLines')));
  const host = h('div', { class: 'ed-code' });
  el.append(tools, host);
  const mode = (CODE_LANGS.find(x => x[0] === lang) || CODE_LANGS[0])[2];
  const cm = window.CodeMirror(host, {
    value: note.text || '', mode, lineNumbers: true, lineWrapping: true, indentUnit: 2, tabSize: 2,
    readOnly: opts.readOnly ? 'nocursor' : false, autoCloseBrackets: true, matchBrackets: true,
    theme: document.documentElement.dataset.dark === '1' ? 'material-darker' : 'default',
    inputStyle: 'contenteditable', viewportMargin: 50,
  });
  cm.on('change', () => opts.onChange(cm.getValue()));
  sel.addEventListener('change', () => {
    const m = (CODE_LANGS.find(x => x[0] === sel.value) || CODE_LANGS[0])[2];
    cm.setOption('mode', m);
    opts.onMeta && opts.onMeta({ lang: sel.value });
  });
  wrapChk.addEventListener('change', () => cm.setOption('lineWrapping', wrapChk.checked));
  setTimeout(() => cm.refresh(), 0);
  return {
    focus: () => cm.focus(),
    insertText: s => { if (!opts.readOnly) cm.replaceSelection(s); },
    refresh: () => cm.refresh(),
    flush() {}, destroy() {}, cm,
  };
}

// ---------------------------------------------------------------- super (rich text)
const COLORS = ['#000000', '#c0392b', '#d35400', '#b7950b', '#1e8449', '#1f618d', '#7d3c98', '#808080'];
const HILITES = ['#fff176', '#a5d6a7', '#90caf9', '#f48fb1', '#ffcc80', 'transparent'];

export function mountSuper(el, note, opts) {
  const ed = h('div', {
    class: 'ed-super prose', contenteditable: opts.readOnly ? 'false' : 'true', role: 'textbox', 'aria-multiline': 'true',
    'aria-label': t('noteBody'), 'data-placeholder': t('superPlaceholder'), spellcheck: 'true',
  });
  ed.innerHTML = sanitizeHtml(note.text || '');
  if (!ed.innerHTML.trim()) ed.innerHTML = '<p><br></p>';
  opts.resolveImages && opts.resolveImages(ed);

  const exec = (cmd, val = null) => {
    if (opts.readOnly) return;
    ed.focus();
    try { document.execCommand('styleWithCSS', false, cmd === 'foreColor' || cmd === 'hiliteColor'); } catch (e) { /* ignore */ }
    document.execCommand(cmd, false, val);
    changed();
  };
  const block = tag => exec('formatBlock', tag);
  let savedRange = null;
  const saveSel = () => { const s = getSelection(); if (s.rangeCount && ed.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); };
  const restoreSel = () => { if (savedRange) { ed.focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); } };

  const currentEl = () => { const s = getSelection(); if (!s.rangeCount) return null; let n = s.anchorNode; if (n && n.nodeType === 3) n = n.parentNode; return n && ed.contains(n) ? n : null; };
  const closest = sel => { const n = currentEl(); return n ? n.closest(sel) : null; };

  function checklist() {
    const ul = closest('ul');
    if (ul && ul.classList.contains('checklist')) { exec('insertUnorderedList'); return; }
    if (!ul) exec('insertUnorderedList');
    const u2 = closest('ul');
    if (u2) { u2.classList.add('checklist'); changed(); }
  }
  function insertTable() {
    let rows = '';
    for (let r = 0; r < 3; r++) rows += '<tr>' + '<td><br></td>'.repeat(3) + '</tr>';
    exec('insertHTML', `<table data-new="1"><tbody>${rows}</tbody></table><p><br></p>`);
    const tbl = ed.querySelector('table[data-new]');
    if (tbl) {
      tbl.removeAttribute('data-new');
      const r = document.createRange(); r.setStart(tbl.querySelector('td'), 0); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  }
  function tableOp(op) {
    const td = closest('td,th'); if (!td) { toast(t('placeCaretInTable')); return; }
    const tr = td.parentElement, table = tr.closest('table');
    const idx = [...tr.children].indexOf(td);
    if (op === 'row+') { const n = tr.cloneNode(true); n.querySelectorAll('td,th').forEach(c => { c.innerHTML = '<br>'; }); tr.after(n); }
    if (op === 'row-') { if (table.rows.length > 1) tr.remove(); else table.remove(); }
    if (op === 'col+') [...table.rows].forEach(row => { const c = document.createElement('td'); c.innerHTML = '<br>'; (row.children[idx] || row.lastElementChild).after(c); });
    if (op === 'col-') { if (tr.children.length > 1) [...table.rows].forEach(row => row.children[idx] && row.children[idx].remove()); else table.remove(); }
    changed();
  }
  async function link() {
    saveSel();
    const url = await ask(t('enterLink'), { value: 'https://', inputType: 'url' });
    if (!url) return;
    if (!/^(https?:|mailto:|tel:)/i.test(url)) { toast(t('badLink')); return; }
    restoreSel();
    const s = getSelection();
    if (s.isCollapsed) exec('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">${url.replace(/</g, '&lt;')}</a>&nbsp;`);
    else { exec('createLink', url); const a = closest('a'); if (a) { a.target = '_blank'; a.rel = 'noopener'; } }
  }
  async function image() {
    saveSel();
    const ids = await opts.pickImage();
    if (!ids || !ids.length) return;
    restoreSel();
    exec('insertHTML', ids.map(id => `<img data-file-id="${id}" alt="">`).join('') + '<p><br></p>');
    opts.resolveImages && opts.resolveImages(ed);
  }
  function codeBlock() { const pre = closest('pre'); if (pre) block('p'); else block('pre'); }
  function palette(kind, anchor) {
    saveSel();
    const list = kind === 'fore' ? COLORS : HILITES;
    openMenu(anchor, list.map(c => ({
      label: h('span', { class: 'swatch', style: `background:${c === 'transparent' ? 'repeating-linear-gradient(45deg,#ccc 0 4px,#fff 4px 8px)' : c}` }),
      title: c, onclick: () => { restoreSel(); exec(kind === 'fore' ? 'foreColor' : 'hiliteColor', c); },
    })), { grid: true });
  }

  const COMMANDS = [
    { k: 'h1', label: t('heading1'), run: () => block('h1') },
    { k: 'h2', label: t('heading2'), run: () => block('h2') },
    { k: 'h3', label: t('heading3'), run: () => block('h3') },
    { k: 'p', label: t('paragraph'), run: () => block('p') },
    { k: 'ul', label: t('bulletList'), run: () => exec('insertUnorderedList') },
    { k: 'ol', label: t('numberedList'), run: () => exec('insertOrderedList') },
    { k: 'check', label: t('checklist'), run: checklist },
    { k: 'quote', label: t('quote'), run: () => block('blockquote') },
    { k: 'code', label: t('codeBlock'), run: codeBlock },
    { k: 'table', label: t('table'), run: insertTable },
    { k: 'image', label: t('image'), run: image },
    { k: 'hr', label: t('divider'), run: () => exec('insertHorizontalRule') },
    { k: 'link', label: t('link'), run: link },
    { k: 'date', label: t('insertDate'), run: () => exec('insertText', new Date().toLocaleDateString(document.documentElement.lang === 'mr' ? 'mr-IN' : 'en-IN', { day: 'numeric', month: 'long', year: 'numeric' })) },
  ];

  const tools = h('div', { class: 'toolbar super-tools', role: 'toolbar' },
    tb('↶', t('undo'), () => exec('undo')), tb('↷', t('redo'), () => exec('redo')),
    h('span', { class: 'sep' }),
    tb('H1', t('heading1'), () => block('h1')), tb('H2', t('heading2'), () => block('h2')), tb('H3', t('heading3'), () => block('h3')),
    tb('¶', t('paragraph'), () => block('p')),
    h('span', { class: 'sep' }),
    tb('B', t('bold'), () => exec('bold'), { style: 'font-weight:700' }), tb('I', t('italic'), () => exec('italic'), { style: 'font-style:italic' }),
    tb('U', t('underline'), () => exec('underline'), { style: 'text-decoration:underline' }), tb('S', t('strike'), () => exec('strikeThrough'), { style: 'text-decoration:line-through' }),
    tb('A', t('textColor'), e => palette('fore', e.currentTarget), { style: 'color:#c0392b;font-weight:700' }),
    tb('🖍', t('highlight'), e => palette('hi', e.currentTarget)),
    tb('⌫', t('clearFormat'), () => exec('removeFormat')),
    h('span', { class: 'sep' }),
    tb('•', t('bulletList'), () => exec('insertUnorderedList')), tb('1.', t('numberedList'), () => exec('insertOrderedList')),
    tb('☑', t('checklist'), checklist), tb('❝', t('quote'), () => block('blockquote')), tb('</>', t('codeBlock'), codeBlock),
    tb('🔗', t('link'), link), tb('🖼', t('image'), image), tb('▦', t('table'), insertTable), tb('―', t('divider'), () => exec('insertHorizontalRule')),
    h('span', { class: 'sep' }),
    tb('+⬇', t('rowAdd'), () => tableOp('row+')), tb('−⬇', t('rowDel'), () => tableOp('row-')),
    tb('+➡', t('colAdd'), () => tableOp('col+')), tb('−➡', t('colDel'), () => tableOp('col-')),
  );
  if (opts.readOnly) tools.querySelectorAll('button').forEach(b => { b.disabled = true; });

  // checklist toggling + links
  ed.addEventListener('click', e => {
    const li = e.target.closest && e.target.closest('ul.checklist > li');
    if (li && !opts.readOnly) {
      const r = li.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (x < 30) { li.classList.toggle('checked'); e.preventDefault(); changed(); return; }
    }
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && (opts.readOnly || e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
  });

  // paste: sanitize HTML, attach pasted images
  ed.addEventListener('paste', async e => {
    if (opts.readOnly) return;
    const cd = e.clipboardData; if (!cd) return;
    const files = [...cd.files || []].filter(f => f.type.startsWith('image/'));
    if (files.length && opts.addImageFiles) {
      e.preventDefault();
      const ids = await opts.addImageFiles(files);
      exec('insertHTML', ids.map(id => `<img data-file-id="${id}" alt="">`).join(''));
      opts.resolveImages && opts.resolveImages(ed);
      return;
    }
    const html = cd.getData('text/html');
    if (html) { e.preventDefault(); exec('insertHTML', sanitizeHtml(html, true)); }
  });

  // slash command menu
  let slash = null; // { node, start, el, items, idx }
  function closeSlash() { if (slash) { slash.el.remove(); slash = null; } }
  function updateSlash() {
    const s = getSelection();
    if (!s.isCollapsed || !s.rangeCount) return closeSlash();
    const n = s.anchorNode, off = s.anchorOffset;
    if (!n || n.nodeType !== 3 || !ed.contains(n)) return closeSlash();
    const before = n.data.slice(0, off);
    const m = /(^|[\s\u00a0])\/([^\s/]{0,20})$/.exec(before);
    if (!m) return closeSlash();
    const q = m[2].toLowerCase();
    const items = COMMANDS.filter(c => !q || c.k.startsWith(q) || c.label.toLowerCase().includes(q));
    if (!items.length) return closeSlash();
    const start = off - m[2].length - 1;
    if (!slash) { slash = { el: h('div', { class: 'slash-menu', role: 'listbox' }) }; document.body.append(slash.el); }
    Object.assign(slash, { node: n, start, end: off, items, idx: Math.min(slash.idx || 0, items.length - 1) });
    drawSlash();
    const range = s.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    const top = Math.min(rect.bottom + 6, window.innerHeight - 260);
    slash.el.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + 'px';
    slash.el.style.top = Math.max(8, top) + 'px';
  }
  function drawSlash() {
    slash.el.replaceChildren(...slash.items.map((c, i) => h('div', {
      class: 'slash-item' + (i === slash.idx ? ' on' : ''), role: 'option', 'data-k': c.k,
      onpointerdown: ev => { ev.preventDefault(); slash.idx = i; runSlash(); },
    }, c.label)));
  }
  function runSlash() {
    const c = slash.items[slash.idx];
    const r = document.createRange();
    r.setStart(slash.node, slash.start); r.setEnd(slash.node, slash.end);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('delete');
    closeSlash();
    c.run();
  }
  ed.addEventListener('keydown', e => {
    if (slash) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slash.idx = (slash.idx + 1) % slash.items.length; drawSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slash.idx = (slash.idx - 1 + slash.items.length) % slash.items.length; drawSlash(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); link(); }
  });
  ed.addEventListener('input', () => { changed(); updateSlash(); });
  ed.addEventListener('blur', () => setTimeout(closeSlash, 150));

  function serialize() {
    const c = ed.cloneNode(true);
    c.querySelectorAll('img[data-file-id]').forEach(i => i.removeAttribute('src'));
    return c.innerHTML;
  }
  function changed() { opts.onChange(serialize()); }

  el.append(tools, ed);
  return {
    focus: () => ed.focus(),
    insertText: s => { if (opts.readOnly) return; if (!ed.contains(document.activeElement) && document.activeElement !== ed) { ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(r); } document.execCommand('insertText', false, s); changed(); },
    flush() {}, destroy() { closeSlash(); },
    el: ed, commands: COMMANDS,
  };
}

// ---------------------------------------------------------------- spreadsheet
export function mountSheet(el, note, opts) {
  const data = parseSheet(note.text);
  let values = evaluateSheet(data.cells);
  let active = 'A1';
  const fx = h('input', { class: 'fx', 'aria-label': t('formulaBar'), placeholder: '=SUM(A1:A5)', readOnly: !!opts.readOnly });
  const addr = h('span', { class: 'fx-addr' }, active);
  const table = h('table', { class: 'sheet' });
  const host = h('div', { class: 'sheet-wrap' }, table);
  const save = () => opts.onChange(JSON.stringify(data));

  const DEF_W = 110, DEF_H = 38, MIN_W = 36, MAX_W = 800, MIN_H = 26, MAX_H = 300;
  const colW = c => (data.colW && data.colW[c]) || DEF_W;
  const rowH = r => (data.rowH && data.rowH[r]) || DEF_H;
  function applySize(kind, i, px) {
    const sel = kind === 'c' ? `input.cell[data-c="${i}"]` : `input.cell[data-r="${i}"]`;
    table.querySelectorAll(sel).forEach(inp => { if (kind === 'c') inp.style.width = px + 'px'; else inp.style.height = px + 'px'; });
  }
  function setSize(kind, i, px) {
    const key = kind === 'c' ? 'colW' : 'rowH';
    const def = kind === 'c' ? DEF_W : DEF_H;
    if (!data[key]) data[key] = {};
    if (px === def) delete data[key][i]; else data[key][i] = px;
    if (!Object.keys(data[key]).length) delete data[key];
  }
  // Drag the small handle on a column's right edge / a row's bottom edge (mouse or finger). Double-tap resets.
  function grip(kind, i) {
    const g = h('span', { class: 'grip grip-' + kind, title: t('resizeHint'), 'aria-hidden': 'true' });
    if (opts.readOnly) return g;
    let start = 0, base = 0, size = 0, lastTap = 0;
    g.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      const now = Date.now();
      if (now - lastTap < 350) { lastTap = 0; const d = kind === 'c' ? DEF_W : DEF_H; setSize(kind, i, d); applySize(kind, i, d); save(); return; }
      lastTap = now;
      start = kind === 'c' ? e.clientX : e.clientY; base = kind === 'c' ? colW(i) : rowH(i); size = base;
      try { g.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      g.classList.add('dragging');
      const move = ev => {
        const d = (kind === 'c' ? ev.clientX : ev.clientY) - start;
        size = Math.round(Math.min(kind === 'c' ? MAX_W : MAX_H, Math.max(kind === 'c' ? MIN_W : MIN_H, base + d)));
        applySize(kind, i, size);
      };
      const up = () => {
        g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
        g.classList.remove('dragging');
        if (size !== base) { setSize(kind, i, size); save(); }
      };
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    });
    return g;
  }

  function draw() {
    const head = h('tr', {}, h('th', { class: 'corner' }), ...Array.from({ length: data.cols }, (_, c) => h('th', { class: 'ch' }, colName(c), grip('c', c))));
    const rows = Array.from({ length: data.rows }, (_, r) => h('tr', {}, h('th', { class: 'rh' }, String(r + 1), grip('r', r)),
      ...Array.from({ length: data.cols }, (_, c) => {
        const ref = refName(c, r);
        const inp = h('input', { class: 'cell', 'data-ref': ref, 'data-c': String(c), 'data-r': String(r), 'aria-label': ref, readOnly: !!opts.readOnly });
        if (data.colW && data.colW[c]) inp.style.width = data.colW[c] + 'px';
        if (data.rowH && data.rowH[r]) inp.style.height = data.rowH[r] + 'px';
        inp.value = displayValue(values[ref]);
        if (typeof values[ref] === 'number') inp.classList.add('num');
        if (values[ref] && values[ref].err) inp.classList.add('err');
        return h('td', {}, inp);
      })));
    table.replaceChildren(h('thead', {}, head), h('tbody', {}, ...rows));
  }
  function refreshValues(except) {
    values = evaluateSheet(data.cells);
    table.querySelectorAll('input.cell').forEach(inp => {
      const ref = inp.dataset.ref;
      if (ref === except) return;
      inp.value = displayValue(values[ref]);
      inp.classList.toggle('num', typeof values[ref] === 'number');
      inp.classList.toggle('err', !!(values[ref] && values[ref].err));
    });
  }
  function setRaw(ref, v) {
    if (v === '') delete data.cells[ref]; else data.cells[ref] = v;
    save();
  }
  table.addEventListener('focusin', e => {
    const inp = e.target.closest('input.cell'); if (!inp) return;
    active = inp.dataset.ref; addr.textContent = active;
    inp.value = data.cells[active] ?? ''; fx.value = inp.value;
    inp.classList.remove('err', 'num');
  });
  table.addEventListener('input', e => {
    const inp = e.target.closest('input.cell'); if (!inp) return;
    fx.value = inp.value; setRaw(inp.dataset.ref, inp.value);
  });
  table.addEventListener('focusout', e => {
    const inp = e.target.closest('input.cell'); if (!inp) return;
    refreshValues();
  });
  table.addEventListener('keydown', e => {
    const inp = e.target.closest('input.cell'); if (!inp) return;
    const p = parseRef(inp.dataset.ref);
    let next = null;
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.shiftKey)) next = refName(p.c, Math.min(data.rows - 1, p.r + 1));
    else if (e.key === 'ArrowUp') next = refName(p.c, Math.max(0, p.r - 1));
    if (next) { e.preventDefault(); const n = table.querySelector(`input[data-ref="${next}"]`); n && n.focus(); }
  });
  fx.addEventListener('input', () => {
    if (opts.readOnly) return;
    setRaw(active, fx.value);
    const inp = table.querySelector(`input[data-ref="${active}"]`);
    if (inp && document.activeElement !== inp) { refreshValues(); }
    else if (inp) inp.value = fx.value;
  });
  fx.addEventListener('change', () => refreshValues());

  const btn = (label, fn) => h('button', { type: 'button', class: 'chip', onclick: fn, disabled: !!opts.readOnly && !/CSV/.test(label) }, label);
  const tools = h('div', { class: 'toolbar' },
    btn('+ ' + t('row'), () => { data.rows = Math.min(1000, data.rows + 1); save(); draw(); }),
    btn('− ' + t('row'), () => { if (data.rows > 1) { trim('r'); data.rows--; save(); draw(); } }),
    btn('+ ' + t('column'), () => { data.cols = Math.min(52, data.cols + 1); save(); draw(); }),
    btn('− ' + t('column'), () => { if (data.cols > 1) { trim('c'); data.cols--; save(); draw(); } }),
    h('button', { type: 'button', class: 'chip', onclick: () => opts.download({ name: (note.title || 'sheet') + '.csv', mime: 'text/csv', content: sheetToCSV(data) }) }, t('exportCSV')),
    h('button', { type: 'button', class: 'chip', onclick: () => toast(t('sheetHelp'), 8000) }, '?'),
  );
  function trim(which) {
    for (const k of Object.keys(data.cells)) {
      const p = parseRef(k);
      if (p && ((which === 'r' && p.r === data.rows - 1) || (which === 'c' && p.c === data.cols - 1))) delete data.cells[k];
    }
    if (which === 'c' && data.colW) { delete data.colW[data.cols - 1]; if (!Object.keys(data.colW).length) delete data.colW; }
    if (which === 'r' && data.rowH) { delete data.rowH[data.rows - 1]; if (!Object.keys(data.rowH).length) delete data.rowH; }
    values = evaluateSheet(data.cells);
  }
  el.append(tools, h('div', { class: 'fx-bar' }, addr, fx), host);
  draw();
  return {
    focus: () => { const i = table.querySelector('input.cell'); i && i.focus(); },
    insertText: s => {
      const inp = table.querySelector(`input[data-ref="${active}"]`);
      if (inp && !opts.readOnly) { inp.focus(); insertIntoTextarea(inp, s); }
    },
    flush() {}, destroy() {}, data,
  };
}

// ---------------------------------------------------------------- tasks
export function mountTasks(el, note, opts) {
  const data = parseTasks(note.text);
  let hideDone = false;
  const list = h('ul', { class: 'tasks' });
  const progress = h('div', { class: 'progress' }, h('div', { class: 'bar' }));
  const count = h('span', { class: 'muted' });
  const input = h('input', { class: 'task-new', placeholder: t('newTask'), 'aria-label': t('newTask'), disabled: !!opts.readOnly });
  const save = () => { opts.onChange(serializeTasks(data)); stats(); };
  function stats() {
    const done = data.tasks.filter(x => x.done).length;
    count.textContent = t('tasksDone', { done, total: data.tasks.length });
    progress.firstChild.style.width = (data.tasks.length ? Math.round(100 * done / data.tasks.length) : 0) + '%';
  }
  function draw() {
    list.replaceChildren(...data.tasks.filter(x => !(hideDone && x.done)).map(task => {
      const cb = h('input', { type: 'checkbox', checked: task.done, disabled: !!opts.readOnly, 'aria-label': t('done') });
      const txt = h('input', { class: 'task-text', value: task.text, readOnly: !!opts.readOnly, 'aria-label': t('task') });
      cb.addEventListener('change', () => { task.done = cb.checked; li.classList.toggle('done', task.done); save(); if (hideDone) draw(); });
      txt.addEventListener('input', () => { task.text = txt.value; save(); });
      txt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.focus(); } });
      const del = h('button', { type: 'button', class: 'icon-btn', title: t('delete'), 'aria-label': t('delete'), disabled: !!opts.readOnly, onclick: () => { data.tasks = data.tasks.filter(x => x !== task); save(); draw(); } }, '✕');
      const up = h('button', { type: 'button', class: 'icon-btn', title: t('moveUp'), 'aria-label': t('moveUp'), disabled: !!opts.readOnly, onclick: () => { const i = data.tasks.indexOf(task); if (i > 0) { data.tasks.splice(i, 1); data.tasks.splice(i - 1, 0, task); save(); draw(); } } }, '↑');
      const li = h('li', { class: task.done ? 'done' : '' }, cb, txt, up, del);
      return li;
    }));
    stats();
  }
  function add() {
    const v = input.value.trim(); if (!v) return;
    data.tasks.push({ id: uid(), text: v, done: false }); input.value = ''; save(); draw();
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const hideChk = h('input', { type: 'checkbox' });
  hideChk.addEventListener('change', () => { hideDone = hideChk.checked; draw(); });
  el.append(
    h('div', { class: 'task-add' }, input, h('button', { type: 'button', class: 'btn primary', onclick: add, disabled: !!opts.readOnly }, t('add'))),
    h('div', { class: 'toolbar' }, count, progress, h('label', { class: 'lbl' }, hideChk, ' ' + t('hideCompleted')),
      h('button', { type: 'button', class: 'chip', disabled: !!opts.readOnly, onclick: () => { data.tasks = data.tasks.filter(x => !x.done); save(); draw(); } }, t('clearCompleted'))),
    list);
  draw();
  return {
    focus: () => input.focus(),
    insertText: s => { if (opts.readOnly) return; const a = document.activeElement; if (a && a.classList && (a.classList.contains('task-text') || a === input)) insertIntoTextarea(a, s); else { input.value += s; input.focus(); } },
    flush() {}, destroy() {}, data,
  };
}

export const MOUNTS = { plain: mountPlain, markdown: mountMarkdown, code: mountCode, super: mountSuper, sheet: mountSheet, tasks: mountTasks };
