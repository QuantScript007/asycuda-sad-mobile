import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseInvoiceText, toForm, extractJson, normalizeHs, claudePrompt } from '../js/invoice-parse.js';

const INVOICE = `HARBOURLINE TRADING PTE LTD
21 Tuas Avenue 8, Singapore 639229
COMMERCIAL INVOICE
Invoice No: HLT-24-0917      Date: 14/09/2026
Currency: USD   Terms: FOB Singapore
B/L No: MSCUSG1234567  Vessel: MSC ANNA
No  Description                         Qty  Unit  Unit Price  Amount
1   Basmati rice 5kg bag                 120  BAG   14.50      1,740.00
2   Leather sandals men                  600  PRS   3.85       2,310.00
3   LED bulb E27 9W warm white           800  pcs   0.95       760.00
Sub Total                                                    4,810.00
Grand Total USD                                              4,810.00
Total packages: 38 cartons   Gross weight: 612.4 KGS   Net weight: 548.0 KGS
Freight: 420.00  Insurance: 32.00
`;

test('parseAmount handles common number formats', () => {
  assert.equal(parseAmount('1,740.00'), 1740);
  assert.equal(parseAmount('1.740,50'), 1740.5);
  assert.equal(parseAmount('12,50'), 12.5);
  assert.equal(parseAmount('$ 3.85'), 3.85);
  assert.equal(parseAmount('—'), null);
  assert.equal(normalizeHs('8215.20'), '821520');
  assert.equal(normalizeHs('603120011'), '0603120011');
});

test('parseInvoiceText reads header and items', () => {
  const raw = parseInvoiceText(INVOICE);
  const h = raw.header;
  assert.equal(h.supplier_name, 'HARBOURLINE TRADING PTE LTD');
  assert.equal(h.supplier_address, '21 Tuas Avenue 8, Singapore 639229');
  assert.equal(h.invoice_no, 'HLT-24-0917');
  assert.equal(h.currency, 'USD');
  assert.equal(h.incoterm, 'FOB');
  assert.equal(h.bl_awb_no, 'MSCUSG1234567');
  assert.equal(h.vessel_flight, 'MSC ANNA');
  assert.equal(h.transport_mode, 'Sea');
  assert.equal(h.invoice_total, 4810);
  assert.equal(h.total_packages, 38);
  assert.equal(h.gross_weight_kg, 612.4);
  assert.equal(h.freight, 420);
  assert.deepEqual(raw.items.map((i) => i.description), ['Basmati rice 5kg bag', 'Leather sandals men', 'LED bulb E27 9W warm white']);
  assert.deepEqual([raw.items[0].quantity, raw.items[0].unit, raw.items[0].unit_price, raw.items[0].total_price], [120, 'BAG', 14.5, 1740]);
  assert.equal(raw.items[1].unit, 'PR');
});

test('toForm maps to SAD fields, spreads gross weight and checks totals', () => {
  const f = toForm(parseInvoiceText(INVOICE), 'text');
  const g = f.general;
  assert.equal(g.exporter, 'HARBOURLINE TRADING PTE LTD, 21 Tuas Avenue 8, Singapore 639229');
  assert.equal(g.bl_number, 'MSCUSG1234567');
  assert.equal(g.delivery_terms, 'FOB');
  assert.equal(g.invoice_amount, 4810);
  assert.equal(g.invoice_currency, 'USD');
  assert.equal(g.freight_currency, 'USD');
  assert.equal(g.external_freight, 420);
  assert.equal(g.mode_transport, '1');
  assert.equal(f.items[0].item_price, 1740);
  assert.equal(f.items[0].supp_units, 120);
  const gm = f.items.reduce((s, i) => s + i.gross_mass, 0);
  assert.ok(Math.abs(gm - 612.4) < 0.01);
  assert.ok(f.items.every((i) => i.gross_mass_allocated));
  const levels = Object.fromEntries(f.checks.map((c) => [c.text.split(' ')[0], c.level]));
  assert.equal(levels.Every, 'ok');
  assert.equal(levels.Lines, 'ok');
});

test('toForm maps a Claude reply', () => {
  const reply = '```json\n' + JSON.stringify({
    header: { supplier_name: 'Harbourline Trading', supplier_address: 'Singapore', supplier_country: 'SG', currency: 'usd',
      invoice_total: 1740, incoterm: 'C&F', transport_mode: 'Air', bl_awb_no: '176-12345675', total_packages: 10, gross_weight_kg: 186 },
    items: [{ description: 'Basmati rice 5kg bag', brand: 'Golden', hs_code: '1006.30.99', hs_confidence: 'high', origin: 'in',
      quantity: 120, unit: 'bag', unit_price: 14.5, total_price: 1740, packages: 10, package_type: 'ctn', gross_weight_kg: 186 }],
    notes: ['Stamp covers part of the date.'],
  }) + '\n```';
  const f = toForm(extractJson(reply), 'claude');
  assert.equal(f.general.exporter, 'Harbourline Trading, Singapore');
  assert.equal(f.general.delivery_terms, 'CFR');
  assert.equal(f.general.mode_transport, '2');
  assert.equal(f.general.invoice_currency, 'USD');
  const it = f.items[0];
  assert.equal(it.hs_code, '10063099');
  assert.equal(it.country_origin, 'IN');
  assert.equal(it.package_kind, 'CTN');
  assert.equal(it.no_packages, 10);
  assert.equal(it.brand, 'Golden');
  assert.equal(it.gross_mass_allocated, undefined);
  assert.deepEqual(f.notes, ['Stamp covers part of the date.']);
});

test('extractJson rejects replies without JSON; prompt lists files', () => {
  assert.throws(() => extractJson('Sorry, I cannot read this.'));
  assert.match(claudePrompt(['a.pdf', 'b.jpg']), /1\. a\.pdf, 2\. b\.jpg/);
});
