// Spreadsheet formula engine. Cells: { "A1": "5", "B1": "=A1*2" }.
// Supports numbers, text, + - * / ^, parentheses, unary minus, cell refs (A1, $A$1),
// ranges (A1:B3) and functions SUM AVERAGE MIN MAX COUNT (case-insensitive).

export function colName(i) { // 0 -> A, 25 -> Z, 26 -> AA
  let s = ''; i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
export function colIndex(name) {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function parseRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,5})$/.exec(ref);
  if (!m) return null;
  return { c: colIndex(m[1]), r: parseInt(m[2], 10) - 1 };
}
export function refName(c, r) { return colName(c) + (r + 1); }

class FErr extends Error { constructor(code) { super(code); this.code = code; } }

function tokenize(src) {
  const toks = []; let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FErr('#ERR');
      toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z$]/.test(ch)) {
      const m = /^\$?[A-Za-z]+\$?\d*/.exec(src.slice(i));
      const w = m[0];
      i += w.length;
      if (/^\$?[A-Za-z]{1,3}\$?\d+$/.test(w)) toks.push({ t: 'ref', v: w.toUpperCase().replace(/\$/g, '') });
      else toks.push({ t: 'id', v: w.toUpperCase() });
      continue;
    }
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      if (j < 0) throw new FErr('#ERR');
      toks.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue;
    }
    if ('+-*/^(),:'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    throw new FErr('#ERR');
  }
  return toks;
}

const FUNCS = {
  SUM: a => nums(a).reduce((x, y) => x + y, 0),
  AVERAGE: a => { const n = nums(a); if (!n.length) throw new FErr('#DIV/0!'); return n.reduce((x, y) => x + y, 0) / n.length; },
  AVG: a => FUNCS.AVERAGE(a),
  MIN: a => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  MAX: a => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
  COUNT: a => nums(a).length,
};
function nums(args) {
  const out = [];
  for (const a of args.flat(Infinity)) if (typeof a === 'number' && isFinite(a)) out.push(a);
  return out;
}

export function evaluateSheet(cells) {
  const values = {};
  const state = {}; // ref -> 'busy' | 'done'

  function raw(ref) { return cells[ref] == null ? '' : String(cells[ref]); }

  function valueOf(ref) {
    if (state[ref] === 'done') return values[ref];
    if (state[ref] === 'busy') throw new FErr('#CYCLE!');
    state[ref] = 'busy';
    let v;
    try { v = computeRaw(raw(ref)); }
    catch (e) { v = { err: e.code || '#ERR' }; }
    values[ref] = v; state[ref] = 'done';
    return v;
  }

  function computeRaw(s) {
    const t = s.trim();
    if (t === '') return '';
    if (t[0] !== '=') {
      const n = Number(t.replace(/,/g, ''));
      return (t !== '' && isFinite(n) && /^[-+]?[\d,]*\.?\d+(e[+-]?\d+)?$/i.test(t)) ? n : s;
    }
    const toks = tokenize(t.slice(1));
    let p = 0;
    const peek = () => toks[p];
    const eat = (v) => { const k = toks[p]; if (!k || (v && k.v !== v)) throw new FErr('#ERR'); p++; return k; };

    function cellNum(ref) {
      const v = valueOf(ref);
      if (v && typeof v === 'object' && v.err) throw new FErr(v.err);
      if (v === '') return 0;
      if (typeof v === 'number') return v;
      throw new FErr('#VALUE!');
    }
    function rangeVals(a, b) {
      const A = parseRef(a), B = parseRef(b);
      if (!A || !B) throw new FErr('#REF!');
      const out = [];
      for (let r = Math.min(A.r, B.r); r <= Math.max(A.r, B.r); r++)
        for (let c = Math.min(A.c, B.c); c <= Math.max(A.c, B.c); c++) {
          const v = valueOf(refName(c, r));
          if (v && typeof v === 'object' && v.err) throw new FErr(v.err);
          out.push(v);
        }
      return out;
    }
    function expr() {
      let v = term();
      while (peek() && (peek().v === '+' || peek().v === '-')) {
        const op = eat().v; const r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function term() {
      let v = power();
      while (peek() && (peek().v === '*' || peek().v === '/')) {
        const op = eat().v; const r = power();
        if (op === '/') { if (r === 0) throw new FErr('#DIV/0!'); v = v / r; } else v = v * r;
      }
      return v;
    }
    function power() {
      const b = unary();
      if (peek() && peek().v === '^') { eat(); return Math.pow(b, power()); }
      return b;
    }
    function unary() {
      if (peek() && peek().t === 'op' && (peek().v === '-' || peek().v === '+')) {
        const op = eat().v; const v = unary(); return op === '-' ? -v : v;
      }
      return primary();
    }
    function primary() {
      const k = peek();
      if (!k) throw new FErr('#ERR');
      if (k.t === 'num') { p++; return k.v; }
      if (k.t === 'str') { p++; throw new FErr('#VALUE!'); }
      if (k.t === 'op' && k.v === '(') { eat('('); const v = expr(); eat(')'); return v; }
      if (k.t === 'ref') {
        p++;
        if (peek() && peek().v === ':') throw new FErr('#VALUE!');
        return cellNum(k.v);
      }
      if (k.t === 'id') {
        p++;
        const fn = FUNCS[k.v];
        if (!fn) throw new FErr('#NAME?');
        eat('(');
        const args = [];
        if (peek() && peek().v !== ')') {
          for (;;) {
            const a = peek(), b = toks[p + 1], c = toks[p + 2];
            if (a && a.t === 'ref' && b && b.v === ':' && c && c.t === 'ref') { p += 3; args.push(rangeVals(a.v, c.v)); }
            else args.push(expr());
            if (peek() && peek().v === ',') { p++; continue; }
            break;
          }
        }
        eat(')');
        return fn(args);
      }
      throw new FErr('#ERR');
    }
    const v = expr();
    if (p !== toks.length) throw new FErr('#ERR');
    if (!isFinite(v)) throw new FErr('#NUM!');
    return v;
  }

  for (const ref of Object.keys(cells)) if (parseRef(ref)) valueOf(ref);
  return values;
}

export function displayValue(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'object' && v.err) return v.err;
  if (typeof v === 'number') return String(Math.round(v * 1e10) / 1e10);
  return String(v);
}

function csvCell(s) { return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export function sheetToCSV(data) {
  const vals = evaluateSheet(data.cells || {});
  const lines = [];
  // trim to used area
  let maxR = -1, maxC = -1;
  for (const k of Object.keys(data.cells || {})) {
    const p = parseRef(k);
    if (p && String(data.cells[k]).trim() !== '') { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); }
  }
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) row.push(csvCell(displayValue(vals[refName(c, r)])));
    lines.push(row.join(','));
  }
  return lines.join('\r\n');
}

export function emptySheet(rows = 20, cols = 8) { return { rows, cols, cells: {} }; }

export function parseSheet(text) {
  try {
    const d = JSON.parse(text || '');
    if (d && typeof d === 'object' && d.cells) return { rows: Math.max(1, d.rows | 0 || 20), cols: Math.max(1, d.cols | 0 || 8), cells: d.cells };
  } catch (e) { /* fall through */ }
  // Plain text / CSV fallback: one line per row, comma or tab separated
  const s = emptySheet();
  const lines = String(text || '').split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1);
  lines.forEach((line, r) => line.split(/\t|,/).forEach((v, c) => { if (v !== '') s.cells[refName(c, r)] = v; }));
  s.rows = Math.max(20, lines.length + 5);
  return s;
}
