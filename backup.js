// Export / import: per-note exports, full JSON backup, Standard Notes (decrypted) backup import.
// DOM-free so it can be unit tested; HTML->Markdown conversion is injected (Turndown in the app).

import { stripHtml, escapeHtml, uid, bytesToBase64, base64ToBytes, safeFileName } from './util.js';
import { sheetToCSV, parseSheet, evaluateSheet, displayValue, refName } from './sheet.js';

export const BACKUP_APP = 'majhi-notes';
export const BACKUP_VERSION = 1;

// ---------- tasks ----------
export function parseTasks(text) {
  try {
    const d = JSON.parse(text || '');
    if (d && Array.isArray(d.tasks)) return { tasks: d.tasks.map(t => ({ id: t.id || uid(), text: String(t.text || ''), done: !!t.done })) };
  } catch (e) { /* plain text */ }
  const tasks = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (m) tasks.push({ id: uid(), text: m[2], done: m[1] !== ' ' });
    else if (line.trim()) tasks.push({ id: uid(), text: line.trim().replace(/^[-*]\s+/, ''), done: false });
  }
  return { tasks };
}
export function serializeTasks(d) { return JSON.stringify({ tasks: d.tasks }); }

// ---------- conversions ----------
export function sheetToMarkdown(data) {
  const vals = evaluateSheet(data.cells || {});
  let maxR = -1, maxC = -1;
  for (const k of Object.keys(data.cells || {})) {
    const m = /^([A-Z]+)(\d+)$/.exec(k);
    if (m && String(data.cells[k]).trim() !== '') {
      let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
      maxC = Math.max(maxC, c - 1); maxR = Math.max(maxR, parseInt(m[2], 10) - 1);
    }
  }
  if (maxR < 0) return '';
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) row.push(displayValue(vals[refName(c, r)]).replace(/\|/g, '\\|'));
    rows.push('| ' + row.join(' | ') + ' |');
    if (r === 0) rows.push('|' + ' --- |'.repeat(maxC + 1));
  }
  return rows.join('\n');
}

export function noteToPlain(note) {
  switch (note.noteType) {
    case 'super': return stripHtml(note.text);
    case 'sheet': return sheetToCSV(parseSheet(note.text));
    case 'tasks': return parseTasks(note.text).tasks.map(t => `[${t.done ? 'x' : ' '}] ${t.text}`).join('\n');
    default: return String(note.text || '');
  }
}

export function noteToMarkdown(note, htmlToMd) {
  const title = note.title ? `# ${note.title}\n\n` : '';
  switch (note.noteType) {
    case 'super': return title + (htmlToMd ? htmlToMd(note.text || '') : stripHtml(note.text));
    case 'markdown': return title + (note.text || '');
    case 'code': return title + '```' + (note.lang || '') + '\n' + (note.text || '') + '\n```\n';
    case 'sheet': return title + sheetToMarkdown(parseSheet(note.text));
    case 'tasks': return title + parseTasks(note.text).tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n');
    default: return title + (note.text || '');
  }
}

export function noteToHtml(note, mdToHtml) {
  let body;
  switch (note.noteType) {
    case 'super': body = note.text || ''; break;
    case 'markdown': body = mdToHtml ? mdToHtml(note.text || '') : `<pre>${escapeHtml(note.text)}</pre>`; break;
    case 'tasks': body = '<ul>' + parseTasks(note.text).tasks.map(t => `<li>${t.done ? '☑' : '☐'} ${escapeHtml(t.text)}</li>`).join('') + '</ul>'; break;
    case 'sheet': {
      const d = parseSheet(note.text); const v = evaluateSheet(d.cells);
      body = '<table border="1">' + Array.from({ length: d.rows }, (_, r) => '<tr>' + Array.from({ length: d.cols }, (_, c) => `<td>${escapeHtml(displayValue(v[refName(c, r)]))}</td>`).join('') + '</tr>').join('') + '</table>';
      break;
    }
    default: body = `<pre>${escapeHtml(note.text)}</pre>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(note.title)}</title></head><body><h1>${escapeHtml(note.title)}</h1>${body}</body></html>`;
}

// Returns { name, mime, content } for one note export
export function exportNote(note, format, { htmlToMd, mdToHtml } = {}) {
  const base = safeFileName(note.title || 'note');
  switch (format) {
    case 'md': return { name: base + '.md', mime: 'text/markdown', content: noteToMarkdown(note, htmlToMd) };
    case 'html': return { name: base + '.html', mime: 'text/html', content: noteToHtml(note, mdToHtml) };
    case 'csv': return { name: base + '.csv', mime: 'text/csv', content: sheetToCSV(parseSheet(note.text)) };
    case 'json': return { name: base + '.json', mime: 'application/json', content: JSON.stringify(publicItem(note), null, 2) };
    default: return { name: base + '.txt', mime: 'text/plain', content: (note.title ? note.title + '\n\n' : '') + noteToPlain(note) };
  }
}

function publicItem(i) { const o = {}; for (const k of Object.keys(i)) if (k[0] !== '_') o[k] = i[k]; return o; }

// ---------- full backup ----------
export function makeBackup({ items, revisions = [], blobs = [] }, now = Date.now()) {
  return {
    app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(),
    items: items.filter(i => i.type !== 'tombstone').map(publicItem),
    revisions: revisions.map(publicItem),
    blobs: blobs.map(b => ({ id: b.id, mime: b.mime, data: bytesToBase64(new Uint8Array(b.bytes)) })),
  };
}

const KNOWN_TYPES = new Set(['note', 'tag', 'folder', 'file', 'totp']);

// Accepts our backup or a Standard Notes decrypted backup. Returns { items, revisions, blobs, source }.
export function parseBackup(obj) {
  if (typeof obj === 'string') obj = JSON.parse(obj);
  if (!obj || typeof obj !== 'object') throw new Error('not a backup file');
  if (obj.app === BACKUP_APP) {
    const items = (obj.items || []).filter(i => i && typeof i.id === 'string' && KNOWN_TYPES.has(i.type));
    for (const i of items) { if (!i.updatedAt) i.updatedAt = Date.now(); if (!i.createdAt) i.createdAt = i.updatedAt; }
    const revisions = (obj.revisions || []).filter(r => r && r.id && r.noteId);
    const blobs = (obj.blobs || []).filter(b => b && b.id && b.data).map(b => ({ id: b.id, mime: b.mime, bytes: base64ToBytes(b.data).buffer }));
    return { items, revisions, blobs, source: 'majhi' };
  }
  if (Array.isArray(obj.items) && obj.items.some(i => i && i.content_type)) {
    if (obj.items.some(i => typeof i.content === 'string' && /^00[0-9]/.test(i.content))) throw new Error('encrypted Standard Notes backup: export a decrypted backup');
    return { ...importStandardNotes(obj), revisions: [], blobs: [], source: 'standardnotes' };
  }
  throw new Error('unknown backup format');
}

function ts(v, micro) {
  if (micro) return Math.floor(Number(micro) / 1000);
  const t = Date.parse(v); return isFinite(t) ? t : Date.now();
}

const SN_TYPE = {
  'plain-text': 'plain', markdown: 'markdown', code: 'code', spreadsheet: 'sheet', task: 'tasks', 'rich-text': 'super', super: 'super',
};
function snNoteType(c) {
  if (c.noteType && SN_TYPE[c.noteType]) return SN_TYPE[c.noteType];
  const e = String(c.editorIdentifier || '');
  if (/token-vault|authenticator/i.test(e)) return 'authentication';
  if (/markdown|advanced-editor/i.test(e)) return 'markdown';
  if (/code-editor/i.test(e)) return 'code';
  if (/sheets|spreadsheet/i.test(e)) return 'sheet';
  if (/task/i.test(e)) return 'tasks';
  if (/plus-editor|bold-editor|rich/i.test(e)) return 'super';
  if (c.noteType === 'authentication') return 'authentication';
  return 'plain';
}

function snFlag(c, k) {
  if (k in c) return !!c[k];
  const ad = c.appData && c.appData['org.standardnotes.sn'];
  return !!(ad && ad[k]);
}

export function importStandardNotes(obj) {
  const items = [];
  const noteTags = new Map(); // noteId -> [tagIds]
  const tagParents = new Map();
  for (const raw of obj.items) {
    if (!raw || raw.deleted || !raw.content || typeof raw.content !== 'object') continue;
    if (raw.content_type === 'Tag') {
      for (const r of raw.content.references || []) {
        if (r.content_type === 'Note') { if (!noteTags.has(r.uuid)) noteTags.set(r.uuid, []); noteTags.get(r.uuid).push(raw.uuid); }
        if (r.content_type === 'Tag' && (r.reference_type === 'TagToParentTag' || !r.reference_type)) tagParents.set(raw.uuid, r.uuid);
      }
    }
  }
  for (const raw of obj.items) {
    if (!raw || raw.deleted || !raw.content || typeof raw.content !== 'object') continue;
    const c = raw.content;
    const createdAt = ts(raw.created_at, raw.created_at_timestamp);
    const updatedAt = ts(raw.updated_at || raw.created_at, raw.updated_at_timestamp);
    if (raw.content_type === 'Tag') {
      items.push({ id: raw.uuid, type: 'tag', title: c.title || 'Tag', parentId: tagParents.get(raw.uuid) || null, createdAt, updatedAt });
    } else if (raw.content_type === 'Note') {
      const nt = snNoteType(c);
      if (nt === 'authentication') {
        let list = [];
        try { list = JSON.parse(c.text || '[]'); } catch (e) { list = []; }
        for (const e of Array.isArray(list) ? list : []) {
          if (!e || !e.secret) continue;
          items.push({ id: uid(), type: 'totp', issuer: e.service || '', account: e.account || '', secret: String(e.secret).replace(/\s/g, '').toUpperCase(), digits: 6, period: 30, algo: 'SHA1', notes: e.notes || '', createdAt, updatedAt });
        }
        continue;
      }
      let text = c.text || '';
      if (nt === 'super') text = looksLikeLexical(text) ? lexicalToHtml(text) : (/<[a-z][\s\S]*>/i.test(text) ? text : `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`);
      if (nt === 'sheet') text = JSON.stringify(snSheet(text));
      if (nt === 'tasks') text = serializeTasks(parseTasks(text));
      items.push({
        id: raw.uuid, type: 'note', title: c.title || '', text, noteType: nt, tags: noteTags.get(raw.uuid) || [], folderId: null,
        pinned: snFlag(c, 'pinned'), starred: snFlag(c, 'starred'), archived: snFlag(c, 'archived'), trashed: snFlag(c, 'trashed'),
        readOnly: snFlag(c, 'locked'), createdAt, updatedAt,
      });
    }
  }
  return { items };
}

function snSheet(text) {
  const s = { rows: 20, cols: 8, cells: {} };
  try {
    const d = JSON.parse(text);
    const sheet = d && d.sheets && d.sheets[0];
    if (sheet && Array.isArray(sheet.rows)) {
      sheet.rows.forEach((row, ri) => {
        const r = row.index ?? ri;
        (row.cells || []).forEach((cell, ci) => {
          const c = cell.index ?? ci;
          const v = cell.formula ? cell.formula : cell.value;
          if (v != null && v !== '') s.cells[refName(c, r)] = String(v);
          s.cols = Math.max(s.cols, c + 1);
        });
        s.rows = Math.max(s.rows, r + 1);
      });
      return s;
    }
  } catch (e) { /* not JSON */ }
  return parseSheet(text);
}

// ---------- Lexical (Standard Notes "Super") JSON -> HTML ----------
function looksLikeLexical(text) {
  try { const d = JSON.parse(text); return !!(d && d.root && Array.isArray(d.root.children)); } catch (e) { return false; }
}

export function lexicalToHtml(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const FMT = [[1, 'strong'], [2, 'em'], [4, 's'], [8, 'u'], [16, 'code'], [32, 'sub'], [64, 'sup']];
  const kids = n => (n.children || []).map(node).join('');
  function text(n) {
    let s = escapeHtml(n.text || '');
    const f = n.format | 0;
    for (const [bit, tag] of FMT) if (f & bit) s = `<${tag}>${s}</${tag}>`;
    return s;
  }
  function node(n) {
    switch (n.type) {
      case 'text': case 'code-highlight': return text(n);
      case 'linebreak': return '<br>';
      case 'tab': return '\t';
      case 'paragraph': return `<p>${kids(n) || '<br>'}</p>`;
      case 'heading': return `<${/^h[1-6]$/.test(n.tag) ? n.tag : 'h2'}>${kids(n)}</${/^h[1-6]$/.test(n.tag) ? n.tag : 'h2'}>`;
      case 'quote': return `<blockquote>${kids(n)}</blockquote>`;
      case 'code': return `<pre>${kids(n)}</pre>`;
      case 'list': {
        if (n.listType === 'check') return `<ul class="checklist">${kids(n)}</ul>`;
        const tag = n.listType === 'number' ? 'ol' : 'ul';
        return `<${tag}>${kids(n)}</${tag}>`;
      }
      case 'listitem': return n.checked === true ? `<li class="checked">${kids(n)}</li>` : `<li>${kids(n)}</li>`;
      case 'link': case 'autolink': {
        const href = /^(https?:|mailto:)/i.test(n.url || '') ? n.url : '#';
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${kids(n)}</a>`;
      }
      case 'horizontalrule': return '<hr>';
      case 'table': return `<table>${kids(n)}</table>`;
      case 'tablerow': return `<tr>${kids(n)}</tr>`;
      case 'tablecell': return n.headerState ? `<th>${kids(n)}</th>` : `<td>${kids(n)}</td>`;
      case 'collapsible-container': case 'collapsible-content': return kids(n);
      case 'collapsible-title': return `<p><strong>${kids(n)}</strong></p>`;
      default: return kids(n);
    }
  }
  return (d.root.children || []).map(node).join('');
}
