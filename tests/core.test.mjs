import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.XLSX = require('xlsx');
const core = await import('../js/sad-core.js');
const { XlsTemplate } = await import('../js/xls-template.js');

const MODEL = new Uint8Array(readFileSync(new URL('../templates/SAD_MODEL.xls', import.meta.url)));

function recordCounts(bytes) {
  const cfb = XLSX.CFB.read(bytes, { type: 'array' });
  const c = XLSX.CFB.find(cfb, 'Workbook').content;
  const s = c instanceof Uint8Array ? c : Uint8Array.from(c);
  const v = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const counts = {};
  for (let i = 0; i + 4 <= s.length;) { const rt = v.getUint16(i, true); counts[rt] = (counts[rt] || 0) + 1; i += 4 + v.getUint16(i + 2, true); }
  return counts;
}

const GENERAL = { bl_number: 'MSKU1234567', vessel_name: 'MV DEMO', invoice_amount: 1500, invoice_currency: 'EUR',
  external_freight: 200, freight_currency: 'EUR', total_packages: 7, country_of_export: 'CN' };
const ITEMS = [
  { hs_code: 603120011, description: 'Fresh carnations', country_origin: 'KE', gross_mass: 12.5, item_price: 1000,
    brand: 'Bloom', no_packages: 4, duty_rate: 25, safta_rate: 10 },
  { hs_code: '8418102000', description: 'X'.repeat(60), item_price: 500, brand: 'B'.repeat(30), ext_freight: 20, no_packages: 3, duty_rate: '20%' },
];

test('normalizeHs / parseRate', () => {
  assert.equal(core.normalizeHs(603120011), '0603120011');
  assert.equal(core.normalizeHs('603120011.0'), '0603120011');
  assert.equal(core.normalizeHs('0603.12.00.11'), '0603120011');
  assert.equal(core.normalizeHs(0), '');
  assert.equal(core.parseRate(' 12.5 % '), 12.5);
  assert.equal(core.parseRate('⏳'), null);
});

test('template reads the model exactly', () => {
  const t = new XlsTemplate(MODEL);
  assert.deepEqual(t.sheetNames, ['General Segment', 'Items']);
  assert.equal(t.value(0, 12, 2), 'UMEED EXPRESS');
  assert.equal(t.value(1, 3, 1), '0603120011');
  assert.equal(t.value(1, 3, 6), 5000);
  assert.equal(t.value(1, 2, 20), 'Commercial Description of Goods');
});

test('fillSadModel keeps dropdowns/comments and writes values', () => {
  const { bytes, warnings } = core.fillSadModel(MODEL, { general: GENERAL, items: ITEMS });
  const before = recordCounts(MODEL), after = recordCounts(bytes);
  for (const rec of [0x1be, 0x1b2, 0x1c, 0x5d, 0xec, 0xe5, 0x7d]) assert.equal(after[rec], before[rec], rec.toString(16));
  const wb = XLSX.read(bytes, { type: 'array' });
  const g = wb.Sheets['General Segment'], it = wb.Sheets['Items'];
  assert.equal(g.C13.v, 'MV DEMO'); assert.equal(g.C24.v, 'MSKU1234567');
  assert.equal(g.C15.v, 1500); assert.equal(g.D15.v, 'EUR'); assert.equal(g.J2.v, '00MP');
  assert.equal(g.C18?.v, undefined); assert.equal(g.D18?.v, undefined);  // no insurance → no currency
  assert.equal(it.A4.v, 1); assert.equal(it.B4.v, '0603120011'); assert.equal(it.U4.v, 'Fresh carnations');
  assert.equal(it.U5.v, 'X'.repeat(49)); assert.equal(it.Z5.v, 'B'.repeat(24));
  assert.equal(it.J5.v, 20); assert.equal(it.K5.v, 'EUR');
  assert.equal(it.U6?.v, undefined);  // sample rows cleared
  assert.equal(warnings.length, 2);
});

test('readWorkbook round-trips the filled model', () => {
  const { bytes } = core.fillSadModel(MODEL, { general: GENERAL, items: ITEMS });
  const back = core.readWorkbook(bytes);
  assert.equal(back.general.bl_number, 'MSKU1234567');
  assert.deepEqual(back.items.map((i) => i.hs_code), ['0603120011', '8418102000']);
  assert.equal(back.items[0].brand, 'Bloom');
  const blank = core.readWorkbook(core.blankSadModel(MODEL));
  assert.deepEqual(blank.items, []);
});

test('generate: duty, analytics, duty sheet, simple template', () => {
  const r = core.generate(MODEL, { general: GENERAL, items: ITEMS }, 'safta');
  assert.match(r.sad.name, /^SAD_MSKU1234567_\d{8}_\d{6}\.xls$/);
  assert.equal(r.duty.name, r.sad.name.replace('.xls', '_duty.xls'));
  assert.equal(r.analytics.totals.duty, 200);          // SAFTA 10% of 1000 + fallback 20% of 500
  assert.equal(r.analytics.cost_breakdown.cif, 1700);
  assert.equal(r.analytics.reconciliation.matches, true);
  const duty = core.readWorkbook(r.duty.bytes);
  assert.equal(duty.items.length, 2);
  assert.equal(duty.items[0].duty_rate, 10);
  const tpl = core.readWorkbook(core.buildSimpleTemplate());
  assert.equal(tpl.general.bl_number, 'BL123456');
  assert.equal(tpl.items[0].hs_code, '0603120011');
});

test('many items', () => {
  const items = Array.from({ length: 1200 }, (_, i) => ({ hs_code: '8418102000', description: `Item ${i + 1}`, item_price: i + 1 }));
  const { bytes } = core.fillSadModel(MODEL, { general: GENERAL, items });
  const it = XLSX.read(bytes, { type: 'array' }).Sheets.Items;
  assert.equal(it.A1203.v, 1200); assert.equal(it.U1203.v, 'Item 1200');
});

test('MVR duty and revenue', () => {
  const d = core.calculateItemDuty({ item_price: 1000, duty_rate: 20 }, 'general', 15.42);
  assert.equal(d.value_mvr, 15420); assert.equal(d.duty_mvr, 3084); assert.equal(d.revenue_mvr, 154.2); assert.equal(d.payable_mvr, 3238.2);
  assert.equal(core.calculateItemDuty({ item_price: 1 }, 'general').duty_mvr, undefined);
  const r = core.generate(MODEL, { general: { bl_number: 'FX', invoice_currency: 'USD' },
    items: [{ hs_code: '6403990099', description: 'Sandals', item_price: 1000, duty_rate: 20 }, { hs_code: '1006300099', description: 'Rice', item_price: 500, duty_rate: 0 }] });
  assert.equal(r.exchange_rate, 15.42);                  // default USD rate
  assert.deepEqual([r.analytics.mvr.duty, r.analytics.mvr.revenue, r.analytics.mvr.payable], [3084, 231.3, 3315.3]);
  const ws = XLSX.read(r.duty.bytes, { type: 'array' }).Sheets.Items;
  assert.equal(ws.AF4.v, 15.42); assert.equal(ws.AH4.v, 3084); assert.equal(ws.AI4.v, 154.2); assert.equal(ws.AJ6.v, 3315.3);
  const r2 = core.generate(MODEL, { general: { invoice_currency: 'EUR' }, items: [{ description: 'x', item_price: 10, duty_rate: 10 }] }, 'general', 16.8);
  assert.equal(r2.analytics.mvr.duty, 16.8);
  const r3 = core.generate(MODEL, { general: { invoice_currency: 'EUR' }, items: [{ description: 'x', item_price: 10 }] });
  assert.equal(r3.analytics.mvr, null); assert.ok(r3.warnings.some((w) => w.includes('exchange rate')));
});
