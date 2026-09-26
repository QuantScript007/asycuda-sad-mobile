// Fill cells of an existing .xls (BIFF8) workbook while keeping everything else
// — dropdown lists, cell comments, drawings, formatting, hidden columns.
// JavaScript port of sad_generator/xls_template.py from the desktop app.
//
// Only rows that are written to are re-encoded; every other record is copied
// byte-for-byte. The shared string table is rebuilt with new strings appended
// (existing indexes unchanged). INDEX/DBCELL/EXTSST lookup records are dropped
// — they are optional hints that Excel, LibreOffice and SheetJS rebuild/ignore.
//
// Needs the SheetJS CFB container library: globalThis.XLSX.CFB (bundled with
// xlsx.full.min.js) or pass it explicitly.

const R = {
  BOF: 0x0809, EOF: 0x000a, BOUNDSHEET: 0x0085, SST: 0x00fc, EXTSST: 0x00ff, CONTINUE: 0x003c,
  INDEX: 0x020b, DBCELL: 0x00d7, DIMENSIONS: 0x0200, ROW: 0x0208, COLINFO: 0x007d, WINDOW2: 0x023e,
  BLANK: 0x0201, NUMBER: 0x0203, LABEL: 0x0204, BOOLERR: 0x0205, RK: 0x027e, MULRK: 0x00bd,
  MULBLANK: 0x00be, LABELSST: 0x00fd, FORMULA: 0x0006, STRING: 0x0207, SHRFMLA: 0x04bc,
  ARRAY: 0x0221, TABLE: 0x0236,
};
const CELL_TABLE = new Set([R.ROW, R.BLANK, R.NUMBER, R.LABEL, R.BOOLERR, R.RK, R.MULRK, R.MULBLANK,
  R.LABELSST, R.FORMULA, R.STRING, R.SHRFMLA, R.ARRAY, R.TABLE, R.DBCELL]);
const FORMULA_FAMILY = new Set([R.FORMULA, R.STRING, R.SHRFMLA, R.ARRAY, R.TABLE]);
const MAX_RECORD = 8224;
const DEFAULT_XF = 0x0f;

export class TemplateError extends Error {}

const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const u16 = (u8, o) => dv(u8).getUint16(o, true);
const u32 = (u8, o) => dv(u8).getUint32(o, true);

function parseRecords(data, start = 0, stopAtEof = false) {
  const out = [];
  const view = dv(data);
  let i = start;
  while (i + 4 <= data.length) {
    const rt = view.getUint16(i, true);
    const len = view.getUint16(i + 2, true);
    out.push({ rt, body: data.subarray(i + 4, i + 4 + len) });
    i += 4 + len;
    if (stopAtEof && rt === R.EOF) break;
  }
  return { records: out, end: i };
}

function pack(rt, body) {
  const out = new Uint8Array(4 + body.length);
  const v = dv(out);
  v.setUint16(0, rt, true);
  v.setUint16(2, body.length, true);
  out.set(body, 4);
  return out;
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function bytes(...fields) {
  // fields: [type, value] with type 'u16' | 'u32' | 'f64'
  let n = 0;
  for (const [t] of fields) n += t === 'u16' ? 2 : t === 'u32' ? 4 : 8;
  const out = new Uint8Array(n);
  const v = dv(out);
  let o = 0;
  for (const [t, x] of fields) {
    if (t === 'u16') { v.setUint16(o, x, true); o += 2; }
    else if (t === 'u32') { v.setUint32(o, x >>> 0, true); o += 4; }
    else { v.setFloat64(o, x, true); o += 8; }
  }
  return out;
}

const utf16 = (s) => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { out[2 * i] = s.charCodeAt(i) & 0xff; out[2 * i + 1] = s.charCodeAt(i) >> 8; }
  return out;
};
const decode16 = (u8) => { let s = ''; for (let i = 0; i + 1 < u8.length; i += 2) s += String.fromCharCode(u8[i] | (u8[i + 1] << 8)); return s; };
const decode8 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };

// ── Shared string table ──────────────────────────────────────
function parseSST(chunks) {
  const strings = [];
  let ci = 0, pos = 8;
  const total = u32(chunks[0], 4);
  const read = (n) => {
    const parts = [];
    while (n) {
      if (pos >= chunks[ci].length) { ci++; pos = 0; }
      const take = Math.min(n, chunks[ci].length - pos);
      parts.push(chunks[ci].subarray(pos, pos + take));
      pos += take; n -= take;
    }
    return concat(parts);
  };
  for (let s = 0; s < total; s++) {
    const cch = u16(read(2), 0);
    const flags = read(1)[0];
    const runs = flags & 0x08 ? u16(read(2), 0) : 0;
    const ext = flags & 0x04 ? u32(read(4), 0) : 0;
    let chars = cch, wide = flags & 0x01, str = '';
    while (chars) {
      if (pos >= chunks[ci].length) { ci++; wide = chunks[ci][0] & 0x01; pos = 1; }
      const width = wide ? 2 : 1;
      const take = Math.min(chars, Math.floor((chunks[ci].length - pos) / width));
      const raw = chunks[ci].subarray(pos, pos + take * width);
      str += wide ? decode16(raw) : decode8(raw);
      pos += take * width; chars -= take;
    }
    read(runs * 4);
    read(ext);
    strings.push(str);
  }
  return strings;
}

function buildSST(strings, totalRefs) {
  const records = [[bytes(['u32', totalRefs], ['u32', strings.length])]];
  const sizes = [8];
  const room = () => MAX_RECORD - sizes[sizes.length - 1];
  const push = (u8) => { records[records.length - 1].push(u8); sizes[sizes.length - 1] += u8.length; };
  const newRecord = (first) => { records.push([]); sizes.push(0); if (first) push(first); };
  for (const s of strings) {
    let data = utf16(s);
    if (room() < 5) newRecord();
    push(new Uint8Array([s.length & 0xff, s.length >> 8, 0x01]));
    while (data.length) {
      const take = Math.min(data.length, Math.floor(room() / 2) * 2);
      if (take === 0) { newRecord(new Uint8Array([0x01])); continue; }
      push(data.subarray(0, take));
      data = data.subarray(take);
    }
  }
  return records.map(concat);
}

// ── Sheets ───────────────────────────────────────────────────
function expand(row) {
  if (row.expanded) return row.expanded;
  const cells = new Map();
  for (const { rt, body } of row.cells) {
    if (FORMULA_FAMILY.has(rt)) throw new TemplateError('rows containing formulas cannot be modified');
    const r = u16(body, 0), c = u16(body, 2);
    if (rt === R.MULBLANK) {
      const last = u16(body, body.length - 2);
      for (let col = c, k = 0; col <= last; col++, k++) {
        cells.set(col, { rt: R.BLANK, body: bytes(['u16', r], ['u16', col], ['u16', u16(body, 4 + 2 * k)]) });
      }
    } else if (rt === R.MULRK) {
      const last = u16(body, body.length - 2);
      for (let col = c, k = 0; col <= last; col++, k++) {
        cells.set(col, { rt: R.RK, body: bytes(['u16', r], ['u16', col], ['u16', u16(body, 4 + 6 * k)], ['u32', u32(body, 6 + 6 * k)]) });
      }
    } else {
      cells.set(c, { rt, body });
    }
  }
  row.expanded = cells;
  return cells;
}

function serializeRowCells(row) {
  if (!row.expanded) return row.cells.map(({ rt, body }) => pack(rt, body));
  const out = [];
  const cols = [...row.expanded.keys()].sort((a, b) => a - b);
  let i = 0;
  while (i < cols.length) {
    const col = cols[i];
    const { rt, body } = row.expanded.get(col);
    if (rt === R.BLANK) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1 && row.expanded.get(cols[j + 1]).rt === R.BLANK) j++;
      if (j > i) {
        const parts = [bytes(['u16', u16(body, 0)], ['u16', col])];
        for (let k = i; k <= j; k++) parts.push(row.expanded.get(cols[k]).body.subarray(4, 6));
        parts.push(bytes(['u16', cols[j]]));
        out.push(pack(R.MULBLANK, concat(parts)));
        i = j + 1;
        continue;
      }
    }
    out.push(pack(rt, body));
    i++;
  }
  return out;
}

function parseSheet(name, recs) {
  let first = recs.findIndex((r) => CELL_TABLE.has(r.rt));
  if (first < 0) first = recs.findIndex((r) => r.rt === R.WINDOW2);
  let last = first;
  while (last < recs.length && CELL_TABLE.has(recs[last].rt)) last++;
  const pre = recs.slice(0, first).filter((r) => r.rt !== R.INDEX);
  const post = recs.slice(last);
  if (post.some((r) => CELL_TABLE.has(r.rt) && r.rt !== R.DBCELL)) {
    throw new TemplateError(`unexpected cell records after the cell table in sheet ${name}`);
  }
  const colXf = new Map();
  for (const { rt, body } of pre) {
    if (rt === R.COLINFO) {
      const c1 = u16(body, 0), c2 = Math.min(u16(body, 2), 255), xf = u16(body, 6);
      for (let c = c1; c <= c2; c++) colXf.set(c, xf);
    }
  }
  const rows = new Map();
  const getRow = (r) => { let row = rows.get(r); if (!row) { row = { record: null, cells: [], expanded: null }; rows.set(r, row); } return row; };
  let current = null;
  for (let k = first; k < last; k++) {
    const { rt, body } = recs[k];
    if (rt === R.DBCELL) continue;
    if (rt === R.ROW) { getRow(u16(body, 0)).record = body; continue; }
    if (rt === R.STRING) {
      if (!current) throw new TemplateError('orphan STRING record');
      current.cells.push({ rt, body });
      continue;
    }
    current = getRow(u16(body, 0));
    current.cells.push({ rt, body });
  }
  return { name, pre, rows, post, colXf, getRow };
}

function serializeSheet(sh) {
  const rows = [...sh.rows.keys()].sort((a, b) => a - b);
  const maxRow = rows.length ? rows[rows.length - 1] + 1 : 0;
  let maxCol = 0;
  const body = [];
  for (let b = 0; b < rows.length; b += 32) {
    const block = rows.slice(b, b + 32);
    for (const r of block) {
      const row = sh.rows.get(r);
      if (!row.record) continue;
      const rec = row.record.slice();
      if (row.expanded && row.expanded.size) {
        const keys = [...row.expanded.keys()];
        const lo = Math.min(...keys), hi = Math.max(...keys) + 1;
        const cMic = u16(rec, 2), cMac = u16(rec, 4);
        dv(rec).setUint16(2, cMac ? Math.min(cMic, lo) : lo, true);
        dv(rec).setUint16(4, Math.max(cMac, hi), true);
      }
      body.push(pack(R.ROW, rec));
      maxCol = Math.max(maxCol, u16(rec, 4));
    }
    for (const r of block) {
      const row = sh.rows.get(r);
      body.push(...serializeRowCells(row));
      if (row.expanded && row.expanded.size) maxCol = Math.max(maxCol, Math.max(...row.expanded.keys()) + 1);
    }
  }
  const pre = sh.pre.map(({ rt, body: b }) => {
    if (rt === R.DIMENSIONS) {
      const out = b.slice();
      const v = dv(out);
      v.setUint32(4, Math.max(v.getUint32(4, true), maxRow), true);
      v.setUint16(10, Math.max(v.getUint16(10, true), maxCol), true);
      return pack(rt, out);
    }
    return pack(rt, b);
  });
  return concat([...pre, ...body, ...sh.post.map(({ rt, body: b }) => pack(rt, b))]);
}

function decodeRK(rk) {
  let v;
  if (rk & 0x02) v = rk >> 2; // signed 30-bit integer
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, rk & 0xfffffffc, true);
    v = buf.getFloat64(0, true);
  }
  return rk & 0x01 ? v / 100 : v;
}

// ── Public API ───────────────────────────────────────────────
export class XlsTemplate {
  constructor(data, CFB = globalThis.XLSX && globalThis.XLSX.CFB) {
    if (!CFB) throw new TemplateError('SheetJS CFB library not loaded');
    this.CFB = CFB;
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const cfb = CFB.read(u8, { type: 'array' });
    const entry = CFB.find(cfb, 'Workbook') || CFB.find(cfb, 'Book');
    if (!entry) throw new TemplateError('not an .xls workbook');
    const stream = entry.content instanceof Uint8Array ? entry.content : new Uint8Array(entry.content);

    const g = parseRecords(stream, 0, true);
    this.globals = g.records;
    const sstAt = this.globals.findIndex((r) => r.rt === R.SST);
    if (sstAt < 0) { this.strings = []; this.sstRefs = 0; this.sstSpan = null; }
    else {
      let end = sstAt + 1;
      while (this.globals[end].rt === R.CONTINUE) end++;
      const chunks = this.globals.slice(sstAt, end).map((r) => r.body);
      this.strings = parseSST(chunks);
      this.sstRefs = u32(chunks[0], 0);
      this.sstSpan = [sstAt, end];
    }
    this.index = new Map();
    this.strings.forEach((s, i) => { if (!this.index.has(s)) this.index.set(s, i); });

    this.sheetNames = [];
    for (const { rt, body } of this.globals) {
      if (rt !== R.BOUNDSHEET) continue;
      const cch = body[6], flag = body[7];
      const raw = body.subarray(8, 8 + cch * (flag & 1 ? 2 : 1));
      this.sheetNames.push(flag & 1 ? decode16(raw) : decode8(raw));
    }
    this.sheets = [];
    let pos = g.end;
    for (const name of this.sheetNames) {
      const s = parseRecords(stream, pos, true);
      pos = s.end;
      this.sheets.push(parseSheet(name, s.records));
    }
  }

  sheetIndex(sheet) {
    if (typeof sheet === 'number') return sheet;
    const i = this.sheetNames.findIndex((n) => n.toLowerCase() === String(sheet).toLowerCase());
    if (i < 0) throw new TemplateError(`no sheet named ${sheet}`);
    return i;
  }

  rowCount(sheet) {
    const rows = this.sheets[this.sheetIndex(sheet)].rows;
    return rows.size ? Math.max(...rows.keys()) + 1 : 0;
  }

  value(sheet, r, c) {
    const row = this.sheets[this.sheetIndex(sheet)].rows.get(r);
    if (!row) return null;
    const cell = expand(row).get(c);
    if (!cell) return null;
    const { rt, body } = cell;
    if (rt === R.LABELSST) return this.strings[u32(body, 6)];
    if (rt === R.NUMBER) return dv(body).getFloat64(6, true);
    if (rt === R.RK) return decodeRK(u32(body, 6));
    if (rt === R.LABEL) return body[8] & 1 ? decode16(body.subarray(9)) : decode8(body.subarray(9));
    return null;
  }

  xfFor(sh, r, c, styleRow) {
    const row = sh.rows.get(r);
    if (row) { const cell = expand(row).get(c); if (cell) return u16(cell.body, 4); }
    if (styleRow != null && sh.rows.has(styleRow)) {
      const cell = expand(sh.rows.get(styleRow)).get(c);
      if (cell) return u16(cell.body, 4);
    }
    return sh.colXf.has(c) ? sh.colXf.get(c) : DEFAULT_XF;
  }

  strIndex(s) {
    let idx = this.index.get(s);
    if (idx === undefined) { idx = this.strings.length; this.strings.push(s); this.index.set(s, idx); }
    this.sstRefs++;
    return idx;
  }

  /** Write a value keeping the cell's style; null/'' clears it. */
  set(sheet, r, c, value, styleRow = null) {
    const sh = this.sheets[this.sheetIndex(sheet)];
    const xf = this.xfFor(sh, r, c, styleRow);
    const row = sh.getRow(r);
    if (!row.record && styleRow != null && sh.rows.get(styleRow) && sh.rows.get(styleRow).record) {
      const rec = sh.rows.get(styleRow).record.slice();
      dv(rec).setUint16(0, r, true);
      row.record = rec;
    }
    const cells = expand(row);
    if (value === null || value === undefined || value === '') {
      cells.set(c, { rt: R.BLANK, body: bytes(['u16', r], ['u16', c], ['u16', xf]) });
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      cells.set(c, { rt: R.NUMBER, body: bytes(['u16', r], ['u16', c], ['u16', xf], ['f64', Number(value)]) });
    } else {
      cells.set(c, { rt: R.LABELSST, body: bytes(['u16', r], ['u16', c], ['u16', xf], ['u32', this.strIndex(String(value))]) });
    }
  }

  /** Blank every non-empty cell in rows [r0, r1) (optionally cols [c0, c1)), keeping styles. */
  clearValues(sheet, r0, r1, c0 = 0, c1 = Infinity) {
    const sh = this.sheets[this.sheetIndex(sheet)];
    for (const [r, row] of sh.rows) {
      if (r < r0 || r >= r1) continue;
      if (!row.expanded && row.cells.every((x) => x.rt === R.BLANK || x.rt === R.MULBLANK)) continue;
      for (const [c, cell] of expand(row)) {
        if (cell.rt !== R.BLANK && c >= c0 && c < c1) {
          row.expanded.set(c, { rt: R.BLANK, body: bytes(['u16', r], ['u16', c], ['u16', u16(cell.body, 4)]) });
        }
      }
    }
  }

  toBytes() {
    const glob = [];
    this.globals.forEach((rec, k) => {
      if (this.sstSpan && k >= this.sstSpan[0] && k < this.sstSpan[1]) {
        if (k === this.sstSpan[0]) {
          const sst = buildSST(this.strings, Math.max(this.sstRefs, this.strings.length));
          glob.push(pack(R.SST, sst[0]));
          for (const c of sst.slice(1)) glob.push(pack(R.CONTINUE, c));
        }
        return;
      }
      if (rec.rt === R.EXTSST) return;
      glob.push(rec);
    });
    const sheets = this.sheets.map(serializeSheet);
    const render = (offsets) => {
      let n = 0;
      return concat(glob.map((item) => {
        if (item instanceof Uint8Array) return item;
        if (item.rt === R.BOUNDSHEET) {
          const b = item.body.slice();
          dv(b).setUint32(0, offsets[n++], true);
          return pack(item.rt, b);
        }
        return pack(item.rt, item.body);
      }));
    };
    const head = render(sheets.map(() => 0));
    const offsets = [];
    let pos = head.length;
    for (const s of sheets) { offsets.push(pos); pos += s.length; }
    const stream = concat([render(offsets), ...sheets]);

    const CFB = this.CFB;
    const out = CFB.utils.cfb_new();
    CFB.utils.cfb_add(out, 'Workbook', stream);
    const data = CFB.write(out, { type: 'array' });
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }
}
