// SAD core — everything that doesn't touch the page: reading input workbooks,
// duty calculation, analytics, filling the ASYCUDA SAD model and building the
// duty worksheet. Mirrors the desktop app (sad_generator/*.py).
//
// Uses SheetJS (globalThis.XLSX) for reading .xls/.xlsx and writing the duty sheet.

import { XlsTemplate } from './xls-template.js';

const X = () => {
  if (!globalThis.XLSX) throw new Error('SheetJS (xlsx.full.min.js) is not loaded');
  return globalThis.XLSX;
};

// ── Helpers ──────────────────────────────────────────────────
export function normalizeHs(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  let s;
  if (typeof value === 'number') {
    if (!isFinite(value) || value <= 0) return '';
    s = Number.isInteger(value) ? String(value) : String(value);
  } else s = String(value).trim();
  if (/^\d+\.0+$/.test(s)) s = s.split('.')[0];
  s = s.replace(/[\s.\-/]/g, '');
  if (!/^\d+$/.test(s)) return s && !/^\d*$/.test(s) ? s : '';
  if (/^0+$/.test(s)) return '';
  if ([5, 7, 9, 11].includes(s.length)) s = '0' + s;
  return s;
}
export const isValidHs = (c) => /^\d{8,}$/.test(c || '');

export function parseNumber(value, dflt = null) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return dflt;
  if (typeof value === 'number') return isFinite(value) ? value : dflt;
  const n = Number(String(value).trim().replace(/,/g, ''));
  return isFinite(n) && String(value).trim() !== '' ? n : dflt;
}

export function parseRate(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const m = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export const safeFilenamePart = (v, fallback = 'unknown') =>
  (String(v ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)) || fallback;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Duty ─────────────────────────────────────────────────────
export const PREFERENTIAL_KEYS = { general: 'duty_rate', safta: 'safta_rate', cmfta: 'cmfta_rate' };

export function calculateItemDuty(item, preferential = 'general') {
  let rate = parseRate(item[PREFERENTIAL_KEYS[preferential] || 'duty_rate']);
  if (rate === null && preferential !== 'general') rate = parseRate(item.duty_rate);
  const price = parseNumber(item.item_price, 0);
  if (rate === null) return { duty_rate: null, duty_amount: 0, total_with_duty: round2(price), preferential };
  const duty = round2(price * rate / 100);
  return { duty_rate: rate, duty_amount: duty, total_with_duty: round2(price + duty), preferential };
}

// ── HS chapters ──────────────────────────────────────────────
export const HS_CHAPTERS = {
  '01': 'Live animals', '02': 'Meat', '03': 'Fish & seafood', '04': 'Dairy, eggs, honey', '05': 'Other animal products',
  '06': 'Plants & flowers', '07': 'Vegetables', '08': 'Fruit & nuts', '09': 'Coffee, tea, spices', '10': 'Cereals',
  '11': 'Milling products', '12': 'Oil seeds', '13': 'Gums & resins', '14': 'Plaiting materials', '15': 'Fats & oils',
  '16': 'Meat & fish preparations', '17': 'Sugars', '18': 'Cocoa', '19': 'Cereal & bakery products',
  '20': 'Vegetable & fruit preparations', '21': 'Misc. food preparations', '22': 'Beverages',
  '23': 'Food residues & animal feed', '24': 'Tobacco', '25': 'Salt, stone, cement', '26': 'Ores',
  '27': 'Mineral fuels & oils', '28': 'Inorganic chemicals', '29': 'Organic chemicals', '30': 'Pharmaceuticals',
  '31': 'Fertilisers', '32': 'Paints & dyes', '33': 'Cosmetics & perfumes', '34': 'Soap & detergents',
  '35': 'Glues & enzymes', '36': 'Explosives & matches', '37': 'Photographic goods', '38': 'Misc. chemicals',
  '39': 'Plastics', '40': 'Rubber', '41': 'Hides & leather', '42': 'Leather goods & bags', '43': 'Furskins',
  '44': 'Wood', '45': 'Cork', '46': 'Basketware', '47': 'Pulp', '48': 'Paper & paperboard', '49': 'Printed matter',
  '50': 'Silk', '51': 'Wool', '52': 'Cotton', '53': 'Other vegetable fibres', '54': 'Man-made filaments',
  '55': 'Man-made staple fibres', '56': 'Wadding & rope', '57': 'Carpets', '58': 'Special woven fabrics',
  '59': 'Coated textiles', '60': 'Knitted fabrics', '61': 'Knitted apparel', '62': 'Woven apparel',
  '63': 'Other textile articles', '64': 'Footwear', '65': 'Headgear', '66': 'Umbrellas',
  '67': 'Feathers & artificial flowers', '68': 'Stone & cement articles', '69': 'Ceramics', '70': 'Glass',
  '71': 'Jewellery & precious metals', '72': 'Iron & steel', '73': 'Iron & steel articles', '74': 'Copper',
  '75': 'Nickel', '76': 'Aluminium', '78': 'Lead', '79': 'Zinc', '80': 'Tin', '81': 'Other base metals',
  '82': 'Tools & cutlery', '83': 'Misc. metal articles', '84': 'Machinery & appliances', '85': 'Electrical equipment',
  '86': 'Railway equipment', '87': 'Vehicles', '88': 'Aircraft', '89': 'Ships & boats',
  '90': 'Optical & medical instruments', '91': 'Clocks & watches', '92': 'Musical instruments', '93': 'Arms',
  '94': 'Furniture & lighting', '95': 'Toys & sports goods', '96': 'Misc. manufactured articles',
  '97': 'Art & antiques', '98': 'Special provisions', '99': 'Special provisions',
};
export const RATE_BANDS = ['0%', '0–10%', '10–20%', '20–30%', '>30%', 'Unknown'];

function band(rate) {
  if (rate === null) return 'Unknown';
  if (rate === 0) return '0%';
  if (rate <= 10) return '0–10%';
  if (rate <= 20) return '10–20%';
  if (rate <= 30) return '20–30%';
  return '>30%';
}

function groupRows(groups, totalValue, limit) {
  let rows = [...groups.values()].sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1));
  for (const r of rows) {
    r.value = round2(r.value); r.duty = round2(r.duty);
    r.share = totalValue ? Math.round(1000 * r.value / totalValue) / 10 : 0;
  }
  if (rows.length > limit) {
    const rest = rows.slice(limit - 1);
    rows = rows.slice(0, limit - 1).concat([{
      key: 'other', label: `Other (${rest.length})`,
      items: rest.reduce((s, r) => s + r.items, 0),
      value: round2(rest.reduce((s, r) => s + r.value, 0)),
      duty: round2(rest.reduce((s, r) => s + r.duty, 0)),
      share: Math.round(10 * rest.reduce((s, r) => s + r.share, 0)) / 10,
    }]);
  }
  return rows;
}

const itemDesc = (it) => String(it.description ?? it.commercial_description ?? '');
const itemOrigin = (it) => String(it.country_origin ?? it.country_of_origin ?? '').trim().toUpperCase();

export function buildAnalytics(general, items, preferential = 'general') {
  const g = general || {};
  const byOrigin = new Map(), byChapter = new Map(), bands = {};
  const sources = { manual: 0, auto: 0, missing: 0 };
  const dutyRows = [];
  let totalValue = 0, totalDuty = 0, totalMass = 0, totalPkgs = 0;

  items.forEach((it, i) => {
    const d = calculateItemDuty(it, preferential);
    const value = parseNumber(it.item_price, 0);
    totalValue += value; totalDuty += d.duty_amount;
    totalMass += parseNumber(it.gross_mass, 0);
    totalPkgs += Math.trunc(parseNumber(it.no_packages ?? it.no_of_packages, 0));
    bands[band(d.duty_rate)] = (bands[band(d.duty_rate)] || 0) + 1;
    const hs = normalizeHs(it.hs_code);
    sources[!hs ? 'missing' : it._hs_looked_up ? 'auto' : 'manual']++;
    const origin = itemOrigin(it) || '??';
    const o = byOrigin.get(origin) || { key: origin, label: origin, items: 0, value: 0, duty: 0 };
    o.items++; o.value += value; o.duty += d.duty_amount; byOrigin.set(origin, o);
    const ch = hs.length >= 2 ? hs.slice(0, 2) : '??';
    const c = byChapter.get(ch) || { key: ch, label: HS_CHAPTERS[ch] || (ch === '??' ? 'Unclassified' : `Chapter ${ch}`), items: 0, value: 0, duty: 0 };
    c.items++; c.value += value; c.duty += d.duty_amount; byChapter.set(ch, c);
    dutyRows.push({ index: i + 1, hs_code: hs, description: itemDesc(it).slice(0, 60), value: round2(value), duty_rate: d.duty_rate, duty: d.duty_amount });
  });

  const invoice = parseNumber(g.invoice_amount, null) || null;
  const ext = parseNumber(g.external_freight, 0), intl = parseNumber(g.internal_freight, 0);
  const ins = parseNumber(g.insurance, 0), other = parseNumber(g.other_costs, 0), ded = parseNumber(g.deductions, 0);
  const goods = invoice ?? totalValue;
  const cif = goods + ext + intl + ins + other - ded;
  const diff = invoice === null ? null : round2(totalValue - invoice);
  const rated = dutyRows.filter((r) => r.duty_rate !== null);
  return {
    totals: {
      items: items.length, item_value: round2(totalValue), duty: round2(totalDuty),
      effective_rate: totalValue ? round2(100 * totalDuty / totalValue) : 0,
      gross_mass: Math.round(totalMass * 1000) / 1000, packages: totalPkgs,
      declared_packages: Math.trunc(parseNumber(g.total_packages, 0)) || null,
      value_per_kg: totalMass ? round2(totalValue / totalMass) : null,
      origins: byOrigin.size, chapters: byChapter.size,
    },
    cost_breakdown: {
      goods: round2(goods), external_freight: round2(ext), internal_freight: round2(intl), insurance: round2(ins),
      other_costs: round2(other), deductions: round2(ded), cif: round2(cif), duty: round2(totalDuty),
      landed: round2(cif + totalDuty),
    },
    reconciliation: { declared_invoice: invoice, sum_of_items: round2(totalValue), difference: diff, matches: diff === null ? null : Math.abs(diff) < 0.01 },
    by_origin: groupRows(byOrigin, totalValue, 6),
    by_chapter: groupRows(byChapter, totalValue, 6),
    rate_bands: RATE_BANDS.map((label) => ({ label, count: bands[label] || 0 })),
    hs_sources: sources,
    top_duty_items: dutyRows.filter((r) => r.duty > 0).sort((a, b) => b.duty - a.duty).slice(0, 5),
    highest_rate_item: rated.length ? rated.reduce((a, b) => (b.duty_rate > a.duty_rate ? b : a)) : null,
  };
}

export function validate(data) {
  const w = [];
  if (!(data.general || {}).bl_number) w.push('BL number is empty (box 40).');
  (data.items || []).forEach((it, i) => {
    if (!itemDesc(it).trim()) w.push(`Item ${i + 1}: description is empty (box 31).`);
    if (it.item_price === undefined || it.item_price === null || it.item_price === '') w.push(`Item ${i + 1}: item price is empty (box 42).`);
  });
  return w;
}

// ── Reading input workbooks ──────────────────────────────────
const NATIVE_GENERAL_DESC_MAP = {
  'customs clearance office': ['customs_office', null], 'manifest no.': ['manifest_no', null],
  'office of entry/exit': ['office_entry_exit', null], 'model of declaration': ['decl_type', 'decl_subtype'],
  'procedure': ['procedure', 'procedure_add'], 'exporter': ['exporter', null], 'consignee': ['consignee_code', null],
  'declarant': ['declarant_code', null], 'sector': ['sector', null], 'financial': ['financial', null],
  'country of export': ['country_of_export', null], 'name of the vessel': ['vessel_name', null],
  'delivery terms': ['delivery_terms', null], 'total amount invoiced': ['invoice_amount', 'invoice_currency'],
  'internal freight': ['internal_freight', null], 'external freight': ['external_freight', 'freight_currency'],
  'insurance': ['insurance', 'insurance_currency'], 'other costs': ['other_costs', 'other_costs_currency'],
  'deductions': ['deductions', null], 'location of goods': ['location_goods', null], 'working mode': ['working_mode', null],
  'pre-payment code': ['prepayment_code', null], 'bl number': ['bl_number', null],
  'mode of transport': ['mode_transport', null], 'place of discharge': ['place_discharge', null],
  'carrier nationality': ['carrier_nationality', null], 'trading country': ['trading_country', null],
  'total no. of package': ['total_packages', null],
};
const NATIVE_ITEMS_COL_MAP = {
  1: 'hs_code', 2: 'supp_units', 3: 'country_origin', 4: 'gross_mass', 5: 'preference', 6: 'item_price',
  7: 'int_freight', 9: 'ext_freight', 11: 'insurance', 13: 'other_costs', 15: 'deductions', 19: 'unit_nos',
  20: 'description', 21: 'packing1', 22: 'packing_code1', 23: 'packing3', 24: 'packing_code2', 25: 'brand',
  26: 'model', 27: 'size', 28: 'package_code', 29: 'no_packages',
};
const GENERATED_ITEMS_COL_MAP = {
  1: 'hs_code', 2: 'supp_units', 3: 'country_origin', 4: 'gross_mass', 5: 'preference', 6: 'item_price',
  7: 'int_freight', 10: 'duty_rate', 16: 'ext_freight', 17: 'insurance', 18: 'other_costs', 19: 'deductions',
  20: 'unit_nos', 21: 'description', 22: 'packing1', 23: 'packing_code1', 24: 'packing3', 25: 'packing_code2',
  26: 'brand', 27: 'model', 28: 'size', 29: 'package_code', 30: 'no_packages',
};
const HEADER_ALIASES = {
  commodity_code: 'hs_code', hs: 'hs_code', hscode: 'hs_code', tariff_code: 'hs_code',
  commercial_description: 'description', description_of_goods: 'description', goods_description: 'description',
  country_of_origin: 'country_origin', origin: 'country_origin', price: 'item_price', value: 'item_price',
  no_of_packages: 'no_packages', packages: 'no_packages', supplementary_units: 'supp_units',
};
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\n/g, '_').replace(/ /g, '_').replace(/-/g, '_');
const itemHeader = (s) => { const h = s === null || s === undefined || s === '' ? '' : norm(s); return HEADER_ALIASES[h] || h; };
const empty = (v) => v === null || v === undefined || v === '';
const cleanVal = (v) => (typeof v === 'string' ? v.trim() : v);

function sheetRows(ws) {
  const XLSX = X();
  let maxR = -1, maxC = -1;
  for (const k of Object.keys(ws)) {
    if (k[0] === '!') continue;
    const cell = ws[k];
    if (cell && cell.v !== undefined && cell.v !== null && cell.v !== '') {
      const a = XLSX.utils.decode_cell(k);
      if (a.r > maxR) maxR = a.r;
      if (a.c > maxC) maxC = a.c;
    }
  }
  if (maxR < 0) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true, range: { s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } } });
}

export function readWorkbook(data) {
  const XLSX = X();
  const wb = XLSX.read(data instanceof Uint8Array ? data : new Uint8Array(data), { type: 'array', cellDates: false });
  const byName = Object.fromEntries(wb.SheetNames.map((n) => [n.toLowerCase(), n]));
  const general = {};
  for (const cand of ['declaration', 'general segment', 'general']) {
    if (!byName[cand]) continue;
    const rows = sheetRows(wb.Sheets[byName[cand]]);
    if (!rows.length) break;
    const first = String(rows[0][0] ?? '').trim().toLowerCase();
    if (first.includes('s.a.d') || first.includes('field nbr')) {
      for (const row of rows.slice(1)) {
        const desc = String(row[1] ?? '').trim().toLowerCase();
        const m = NATIVE_GENERAL_DESC_MAP[desc];
        if (!m) continue;
        if (!empty(row[2])) general[m[0]] = cleanVal(row[2]);
        if (m[1] && !empty(row[3])) general[m[1]] = cleanVal(row[3]);
      }
    } else if (rows.length >= 2) {
      rows[0].forEach((h, i) => { const k = empty(h) ? '' : norm(h); if (k && !empty(rows[1][i])) general[k] = cleanVal(rows[1][i]); });
    }
    break;
  }
  let items = [];
  for (const cand of ['items', 'item']) {
    if (!byName[cand]) continue;
    const rows = sheetRows(wb.Sheets[byName[cand]]);
    const row0Empty = rows.length && rows[0].every(empty);
    if (row0Empty && rows.length >= 4) {
      const headerText = rows.slice(1, 3).flat().filter((v) => !empty(v)).join(' ').toLowerCase();
      const map = headerText.includes('d.aty') || headerText.includes('duty rate') ? GENERATED_ITEMS_COL_MAP : NATIVE_ITEMS_COL_MAP;
      for (const row of rows.slice(3)) {
        if (String(row[0] ?? '').trim().toUpperCase() === 'TOTAL') continue;
        const it = {};
        for (const [col, key] of Object.entries(map)) { const v = row[col]; if (!empty(v)) it[key] = cleanVal(v); }
        if (Object.keys(it).length) items.push(it);
      }
    } else if (rows.length >= 2) {
      const headers = rows[0].map(itemHeader);
      for (const row of rows.slice(1)) {
        const it = {};
        headers.forEach((h, i) => { if (h && !empty(row[i])) it[h] = cleanVal(row[i]); });
        if (Object.keys(it).length) items.push(it);
      }
    }
    break;
  }
  items = items.map((it) => ('hs_code' in it ? { ...it, hs_code: normalizeHs(it.hs_code) } : it));
  return { general, items };
}

// ── SAD model output ─────────────────────────────────────────
const GENERAL_ROWS = {
  1: ['customs_office', '00MP', 'text'], 2: ['manifest_no', '', 'text'], 3: ['office_entry_exit', null, 'text'],
  4: ['decl_type', 'IM', 'text', 'decl_subtype', 4, 'num'], 5: ['procedure', '4000', 'text', 'procedure_add', '000', 'text'],
  6: ['exporter', '', 'text'], 7: ['consignee_code', 'C8888', 'text'], 8: ['declarant_code', 'C8888', 'text'],
  9: ['sector', '', 'text'], 10: ['financial', '', 'text'], 11: ['country_of_export', '', 'text'],
  12: ['vessel_name', '', 'text'], 13: ['delivery_terms', 'CIF', 'text'],
  14: ['invoice_amount', 0, 'num', 'invoice_currency', 'USD', 'currency'], 15: ['internal_freight', '', 'num'],
  16: ['external_freight', '', 'num', 'freight_currency', 'USD', 'currency'],
  17: ['insurance', '', 'num', 'insurance_currency', 'USD', 'currency'],
  18: ['other_costs', '', 'num', 'other_costs_currency', 'USD', 'currency'], 19: ['deductions', '', 'num'],
  20: ['location_goods', '', 'text'], 21: ['working_mode', 0, 'num'], 22: ['prepayment_code', '', 'text'],
  23: ['bl_number', '', 'text'], 24: ['mode_transport', '1', 'text'], 25: ['place_discharge', '', 'text'],
  26: ['carrier_nationality', 'MV', 'text'], 27: ['trading_country', '', 'text'], 28: ['total_packages', 0, 'int'],
};
const GENERAL_ALIASES = { location_goods: ['location_of_goods'], prepayment_code: ['pre_payment_code'], mode_transport: ['mode_of_transport'], place_discharge: ['place_of_discharge'] };
const ITEM_COLUMNS = {
  1: [['hs_code'], 'hs'], 2: [['supp_units', 'supplementary_units'], 'num'], 3: [['country_origin', 'country_of_origin'], 'text'],
  4: [['gross_mass'], 'num'], 5: [['preference'], 'text'], 6: [['item_price'], 'num'], 19: [['unit_nos'], 'num'],
  20: [['description', 'commercial_description'], 'text', 49], 21: [['packing1', 'packing_1st'], 'num'],
  22: [['packing_code1', 'packing_code_1'], 'text', 5], 23: [['packing3', 'packing_3rd'], 'num'],
  24: [['packing_code2', 'packing_code_2'], 'text', 5], 25: [['brand'], 'text', 24], 26: [['model'], 'text', 24],
  27: [['size'], 'text', 24], 28: [['package_code'], 'text'], 29: [['no_packages', 'no_of_packages'], 'int'],
};
const ITEM_COSTS = {
  7: [['int_freight', 'internal_freight'], 'int_freight_currency', 'invoice_currency'],
  9: [['ext_freight', 'external_freight'], 'ext_freight_currency', 'freight_currency'],
  11: [['insurance'], 'insurance_currency', 'insurance_currency'],
  13: [['other_costs'], 'other_costs_currency', 'other_costs_currency'],
  15: [['deductions'], 'deductions_currency', 'invoice_currency'],
};
const FIELD_NAMES = { 20: 'description', 22: 'packing code 1', 24: 'packing code 2', 25: 'brand', 26: 'model', 27: 'size' };

function first(d, keys, dflt = null) {
  for (const k of keys) {
    if (!empty(d[k])) return d[k];
    const alt = k.replace(/_/g, ' ');
    if (!empty(d[alt])) return d[alt];
  }
  return dflt;
}
function convert(value, kind) {
  if (empty(value)) return null;
  if (kind === 'hs') return normalizeHs(value) || null;
  if (kind === 'num' || kind === 'int') {
    const n = parseNumber(value, null);
    if (n === null) return String(value);
    return kind === 'int' ? Math.round(n) : n;
  }
  return String(value).trim();
}

export function fillSadModel(modelBytes, data) {
  const g = data.general || {}, items = data.items || [];
  const warnings = [];
  const tpl = new XlsTemplate(modelBytes);
  const GS = 'General Segment', IT = 'Items', FIRST = 3;
  tpl.clearValues(GS, 1, 29, 2, 4);
  for (const [row, spec] of Object.entries(GENERAL_ROWS)) {
    let [key, dflt, kind, extraKey, extraDflt, extraKind] = spec;
    if (key === 'office_entry_exit') dflt = first(g, ['customs_office'], '00MP');
    const value = convert(first(g, [key, ...(GENERAL_ALIASES[key] || [])], dflt), kind);
    tpl.set(GS, +row, 2, value);
    if (extraKey) {
      if (extraKind === 'currency') tpl.set(GS, +row, 3, empty(value) ? null : convert(first(g, [extraKey], extraDflt), 'text'));
      else tpl.set(GS, +row, 3, convert(first(g, [extraKey], extraDflt), extraKind));
    }
  }
  tpl.clearValues(IT, FIRST, tpl.rowCount(IT));
  items.forEach((it, i) => {
    const r = FIRST + i;
    tpl.set(IT, r, 0, i + 1, FIRST);
    for (const [col, [keys, kind, maxLen]] of Object.entries(ITEM_COLUMNS)) {
      let v = convert(first(it, keys), kind);
      if (maxLen && typeof v === 'string' && v.length > maxLen) {
        warnings.push(`Item ${i + 1}: ${FIELD_NAMES[col] || keys[0]} shortened to ${maxLen} characters (ASYCUDA limit): “${v.slice(0, maxLen)}”`);
        v = v.slice(0, maxLen);
      }
      tpl.set(IT, r, +col, v, FIRST);
    }
    for (const [col, [keys, curKey, genCurKey]] of Object.entries(ITEM_COSTS)) {
      const amount = convert(first(it, keys), 'num');
      tpl.set(IT, r, +col, amount, FIRST);
      const cur = empty(amount) ? null : first(it, [curKey]) || first(g, [genCurKey], 'USD');
      tpl.set(IT, r, +col + 1, convert(cur, 'text'), FIRST);
    }
  });
  return { bytes: tpl.toBytes(), warnings };
}

export function blankSadModel(modelBytes) {
  const tpl = new XlsTemplate(modelBytes);
  tpl.clearValues('General Segment', 1, 29, 2, 4);
  tpl.clearValues('Items', 3, tpl.rowCount('Items'));
  return tpl.toBytes();
}

// ── Duty worksheet (same layout as the desktop app's) ────────
export function buildDutySheet(data, preferential = 'general') {
  const XLSX = X();
  const g = data.general || {}, items = data.items || [];
  const gv = (k, d = '') => (empty(g[k]) ? d : g[k]);
  const num = (v) => { const n = parseNumber(v, null); return n === null ? '' : n; };
  const gen = [
    ['S.A.D Field Nbr', 'Descriptions', 'Values'],
    ['A', 'Customs clearance office', gv('customs_office', '00MP')], ['', 'Manifest No.', gv('manifest_no')],
    [29, 'Office of entry/exit', gv('office_entry_exit', gv('customs_office', '00MP'))],
    [1, 'Model of declaration', gv('decl_type', 'IM'), gv('decl_subtype', 4)],
    [37, 'Procedure', gv('procedure', '4000'), gv('procedure_add', '000')], [2, 'Exporter', gv('exporter')],
    [8, 'Consignee', gv('consignee_code', 'C8888')], [14, 'Declarant', gv('declarant_code', 'C8888')],
    [13, 'Sector', gv('sector')], [9, 'Financial', gv('financial')], [15, 'Country of export', gv('country_of_export')],
    [18, 'Name of the Vessel', gv('vessel_name')], [20, 'Delivery terms', gv('delivery_terms', 'CIF')],
    [22, 'Total amount invoiced', num(gv('invoice_amount', 0)) || 0, gv('invoice_currency', 'USD')],
    ['', 'Internal Freight', num(gv('internal_freight'))],
    ['', 'External Freight', num(gv('external_freight')), gv('freight_currency', 'USD')],
    ['', 'Insurance', num(gv('insurance')), gv('insurance_currency', 'USD')],
    ['', 'Other costs', num(gv('other_costs')), gv('other_costs_currency', 'USD')],
    ['', 'Deductions', gv('deductions')], [30, 'Location of goods', gv('location_goods', gv('location_of_goods'))],
    ['', 'Working mode', num(gv('working_mode', 0)) || 0], ['48', 'Pre-Payment Code', String(gv('prepayment_code'))],
    ['40', 'BL Number', String(gv('bl_number'))], ['25', 'Mode of Transport', String(gv('mode_transport', '1'))],
    ['27', 'Place of Discharge', String(gv('place_discharge'))], ['18', 'Carrier Nationality', gv('carrier_nationality', 'MV')],
    ['11', 'Trading Country', gv('trading_country')], ['6', 'Total No. of Package', num(gv('total_packages', 0)) || 0],
  ];
  const head1 = ['Field Nbr', '33', '41', '34', '35', '36', '42', 'Valuation', '43 V.M.', '43 D.Val', '43 D.aty', '43 NPR',
    '47 Type', '47 Base', '47 Rate', '47 Amount', '', '', '', '', '', '31 Packages and description of goods'];
  const head2 = ['Item\nnumber', 'Commodity\ncode', 'Supplementary\nunits', 'Country\nof origin', 'Gross mass', 'Preference',
    'Item\nprice', 'Internal\nFreight', 'Valuation\nMethod (V.M.)', 'Customs\nValue (D.Val)', 'Duty Rate\n(%) (D.aty)',
    'Duty Amount\n(NPR)', 'Tax Type\n(IPV/RVF)', 'Tax\nBase', 'Tax Rate\n(%)', 'Tax\nAmount', 'External\nFreight', 'Insurance',
    'Other\ncosts', 'Deductions', 'Unit Nos', 'Commercial Description of Goods', 'Packing 1st', 'Packing Code 1',
    'Packing 3rd', 'Packing Code 2', 'Brand', 'Model', 'Size', 'Package Code', 'No. of\nPackages'];
  const rows = [[], head1, head2];
  let totalPrice = 0, totalDuty = 0;
  items.forEach((it, i) => {
    const d = calculateItemDuty(it, preferential);
    const ip = num(it.item_price);
    totalPrice += ip || 0; totalDuty += d.duty_amount;
    const row = new Array(31).fill('');
    Object.assign(row, {
      0: i + 1, 1: normalizeHs(it.hs_code), 2: num(it.supp_units), 3: String(it.country_origin ?? it.country_of_origin ?? ''),
      4: num(it.gross_mass), 5: it.preference ?? '', 6: ip, 7: num(it.int_freight ?? it.internal_freight), 8: '1',
      9: ip, 10: d.duty_rate ?? '', 16: num(it.ext_freight ?? it.external_freight), 17: num(it.insurance),
      18: num(it.other_costs), 19: num(it.deductions), 20: num(it.unit_nos), 21: itemDesc(it), 22: num(it.packing1),
      23: String(it.packing_code1 ?? ''), 24: num(it.packing3), 25: String(it.packing_code2 ?? ''), 26: String(it.brand ?? ''),
      27: String(it.model ?? ''), 28: String(it.size ?? ''), 29: String(it.package_code ?? ''), 30: num(it.no_packages ?? it.no_of_packages),
    });
    if (d.duty_amount > 0) Object.assign(row, { 11: d.duty_amount, 12: 'IPV', 13: ip, 14: d.duty_rate, 15: d.duty_amount });
    rows.push(row);
  });
  const totals = new Array(31).fill('');
  Object.assign(totals, { 0: 'TOTAL', 6: round2(totalPrice), 11: round2(totalDuty), 15: round2(totalDuty) });
  rows.push(totals);
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(gen);
  ws1['!cols'] = [{ wch: 16 }, { wch: 26 }, { wch: 34 }, { wch: 12 }];
  const ws2 = XLSX.utils.aoa_to_sheet(rows);
  ws2['!cols'] = head2.map((_, c) => ({ wch: c === 21 ? 44 : 13 }));
  XLSX.utils.book_append_sheet(wb, ws1, 'General Segment');
  XLSX.utils.book_append_sheet(wb, ws2, 'Items');
  return new Uint8Array(XLSX.write(wb, { bookType: 'biff8', type: 'array' }));
}

export function buildSimpleTemplate() {
  const XLSX = X();
  const decl = [['customs_office', 'manifest_no', 'office_entry_exit', 'decl_type', 'decl_subtype', 'procedure', 'procedure_add',
    'exporter', 'consignee_code', 'declarant_code', 'sector', 'financial', 'country_of_export', 'vessel_name', 'delivery_terms',
    'invoice_amount', 'invoice_currency', 'internal_freight', 'external_freight', 'freight_currency', 'insurance',
    'insurance_currency', 'other_costs', 'other_costs_currency', 'deductions', 'location_goods', 'working_mode',
    'prepayment_code', 'bl_number', 'mode_transport', 'place_discharge', 'carrier_nationality', 'trading_country', 'total_packages'],
  ['00MP', '', '00MP', 'IM', 4, '4000', '000', 'SUPPLIER NAME', 'C8888', 'C8888', '', '', 'CN', 'VESSEL NAME HERE', 'CIF',
    45000, 'USD', 0, 4000, 'USD', 300, 'USD', 130.75, 'USD', 0, 'HBW', 0, '', 'BL123456', '1', 'MLE', 'MV', 'CN', 1]];
  const items = [['hs_code', 'supp_units', 'country_origin', 'gross_mass', 'preference', 'item_price', 'int_freight', 'ext_freight',
    'insurance', 'other_costs', 'deductions', 'unit_nos', 'description', 'packing1', 'packing_code1', 'packing3', 'packing_code2',
    'brand', 'model', 'size', 'package_code', 'no_packages', 'duty_rate', 'safta_rate', 'cmfta_rate'],
  ['0603120011', '', 'CN', 3, '', 5000, 0, 0, 0, 0, 0, 100, 'Rice - Sample Description', 7.514, 'NMB', 2.354, 'NMB', '', '', '',
    '1G', 23, '', '', '']];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(decl), 'Declaration');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(items), 'Items');
  return new Uint8Array(XLSX.write(wb, { bookType: 'biff8', type: 'array' }));
}

// ── One-shot generate ────────────────────────────────────────
export function generate(modelBytes, data, preferential = 'general') {
  const general = { ...(data.general || {}) };
  const items = (data.items || []).map((it) => {
    const x = { ...it, hs_code: normalizeHs(it.hs_code) };
    for (const k of ['duty_rate', 'safta_rate', 'cmfta_rate']) {
      const r = parseRate(x[k]);
      if (r === null) delete x[k]; else x[k] = r;
    }
    return x;
  });
  if (!items.length) throw new Error('No items found.');
  const payload = { general, items };
  const model = fillSadModel(modelBytes, payload);
  const duty = buildDutySheet(payload, preferential);
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const base = `SAD_${safeFilenamePart(general.bl_number, 'manual')}_${stamp}`;
  return {
    general, items,
    sad: { name: `${base}.xls`, bytes: model.bytes },
    duty: { name: `${base}_duty.xls`, bytes: duty },
    warnings: [...validate(payload), ...model.warnings],
    analytics: buildAnalytics(general, items, preferential),
    preferential,
  };
}
