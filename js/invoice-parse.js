// Read invoice text (from OCR or a PDF's own text layer) or a Claude reply into
// SAD form data. A JavaScript port of the desktop app's invoice_scan.py.
// No DOM here, so the tests can run it in Node.

// ── Numbers ──────────────────────────────────────────────────
/** '1,740.00' → 1740; European '1.740,00' and '12,50' are understood too. */
export function parseAmount(value) {
  let s = String(value ?? '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^-?\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
const num = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'string' ? parseAmount(v) : null);
const text = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace(/\s+/g, ' ').trim());
const country = (v) => { const s = text(v).toUpperCase(); return /^[A-Z]{2,3}$/.test(s) ? s : ''; };
export function normalizeHs(v) {
  let s = String(v ?? '').replace(/[\s.\-/]/g, '');
  if (!/^\d+$/.test(s) || /^0+$/.test(s)) return '';
  if ([5, 7, 9, 11].includes(s.length)) s = '0' + s;
  return s;
}

// ── Item rows ────────────────────────────────────────────────
const UNIT_MAP = {
  pc: 'PCS', pcs: 'PCS', piece: 'PCS', pieces: 'PCS', each: 'PCS', ea: 'PCS', unit: 'PCS', units: 'PCS', nos: 'PCS',
  set: 'SET', sets: 'SET', kg: 'KG', kgs: 'KG', l: 'LTR', ltr: 'LTR', ltrs: 'LTR', litre: 'LTR', litres: 'LTR', liter: 'LTR',
  liters: 'LTR', ctn: 'CTN', ctns: 'CTN', carton: 'CTN', cartons: 'CTN', box: 'BOX', boxes: 'BOX', bx: 'BOX', bxs: 'BOX',
  pr: 'PR', prs: 'PR', pair: 'PR', pairs: 'PR', m: 'M', mtr: 'M', mtrs: 'M', meter: 'M', meters: 'M', doz: 'DOZ',
  dozen: 'DOZ', roll: 'ROLL', rolls: 'ROLL', pkt: 'PKT', pkts: 'PKT', pack: 'PKT', packs: 'PKT', bag: 'BAG', bags: 'BAG',
  btl: 'BTL', btls: 'BTL', bottle: 'BTL', bottles: 'BTL', can: 'CAN', cans: 'CAN', drum: 'DRUM', drums: 'DRUM',
  tin: 'TIN', tins: 'TIN', case: 'CASE', cases: 'CASE',
};
const SKIP_RE = /\b(sub\s*-?\s*total|grand\s*total|total|amount\s*due|balance|freight|insurance|tax|vat|gst|discount|invoice\s*(no|number|date)|tel|phone|fax|e-?mail|page\s*\d|bank|account|a\/c|swift|iban|payment|signature|thank|deposit|shipping|handling)\b/i;
const CUR_RE = /^(usd|us\$|eur|sgd|aed|inr|cny|rmb|myr|gbp|thb|lkr|mvr|aud|jpy|\$|€|£)$/i;
const CURRENCIES = 'USD|EUR|SGD|AED|INR|CNY|RMB|MYR|GBP|THB|LKR|AUD|JPY|MVR';

function parseItemLine(line) {
  const toks = line.split(' ');
  const nums = [];
  let unit = null, i = toks.length - 1;
  while (i >= 0) {
    const t = toks[i].replace(/^[$€£]+|[$€£]+$/g, '');
    const bare = t.replace(/[.:]+$/, '').toLowerCase();
    if (/^[\d.,]*\d[\d.,]*$/.test(t)) { const n = parseAmount(t); if (n !== null) nums.unshift(n); i--; continue; }
    if (unit === null && UNIT_MAP[bare]) { unit = UNIT_MAP[bare]; i--; continue; }
    if (CUR_RE.test(bare) || !t) { i--; continue; }
    break;
  }
  const desc = toks.slice(0, i + 1);
  while (desc.length && /^\d{1,3}[.)]?$/.test(desc[0])) desc.shift();
  const description = desc.join(' ').replace(/^[\s\-–:.]+|[\s\-–:.]+$/g, '');
  if (nums.length < 2 || !/[a-z]{3}/i.test(description)) return null;

  const total = nums[nums.length - 1], prev = nums.slice(0, -1);
  let qty = null, price = null;
  outer: for (let a = 0; a < prev.length; a++) {
    for (let b = 0; b < prev.length; b++) {
      if (a !== b && Math.abs(prev[a] * prev[b] - total) <= Math.max(0.02, total * 0.005)) {
        [qty, price] = !Number.isInteger(prev[a]) && Number.isInteger(prev[b]) ? [prev[b], prev[a]] : [prev[a], prev[b]];
        break outer;
      }
    }
  }
  if (qty === null) {
    if (prev.length >= 2) { qty = prev[prev.length - 2]; price = prev[prev.length - 1]; }
    else { qty = prev[0]; price = qty ? Math.round((total / qty) * 1e4) / 1e4 : null; }
  }
  return { description, quantity: qty, unit, unit_price: price, total_price: total };
}

/** Header fields and item rows from OCR / PDF text, in the same shape Claude returns. */
export function parseInvoiceText(src) {
  const raw = String(src || '');
  const items = [];
  for (const line0 of raw.split(/\r?\n/)) {
    const line = line0.replace(/[|¦]/g, ' ').replace(/\s+/g, ' ').trim();
    if (line.length < 6 || SKIP_RE.test(line)) continue;
    const it = parseItemLine(line);
    if (it) items.push(it);
  }
  const flat = raw.replace(/[ \t]+/g, ' ');
  const grab = (re) => { const m = flat.match(re); return m ? m[1].trim() : null; };
  const weight = (label) => {
    const m = flat.match(new RegExp(label + '\\s*(?:weight|wt|mass)\\.?\\s*(?:\\(kgs?\\))?\\s*[:\\-]?\\s*([\\d.,]+)\\s*(kgs?|lbs?)?', 'i'));
    if (!m) return null;
    let n = parseAmount(m[1]);
    if (n !== null && /^lb/i.test(m[2] || '')) n = Math.round(n * 0.45359237 * 100) / 100;
    return n;
  };
  // Letterhead: the first line that reads like a company name, and the line under it.
  let supplierName = null, supplierAddress = null;
  const head = raw.split(/\r?\n/).slice(0, 8).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (let k = 0; k < head.length; k++) {
    const ln = head[k];
    if ((ln.match(/[A-Za-z]/g) || []).length >= 6 && !/\b(invoice|proforma|packing|date|page)\b/i.test(ln) && !/\d{3,}/.test(ln)) {
      supplierName = ln;
      const nxt = head[k + 1] || '';
      if (nxt && !/\b(invoice|proforma|packing)\b/i.test(nxt)) supplierAddress = nxt;
      break;
    }
  }
  let total = null;
  for (const m of flat.matchAll(new RegExp(`(?:grand\\s*total|total\\s*amount|invoice\\s*total|amount\\s*due|total\\s*(?:${CURRENCIES}|value)?)\\s*[:\\-]?\\s*(?:[A-Z]{3}|\\$)?\\s*([\\d.,]*\\d)`, 'gi'))) {
    total = parseAmount(m[1]);
  }
  const cur = grab(new RegExp(`\\b(${CURRENCIES})\\b`));
  const header = {
    supplier_name: supplierName,
    supplier_address: supplierAddress,
    invoice_no: grab(/invoice\s*(?:no|number|#)\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i),
    invoice_date: grab(/(?:invoice\s*)?date\s*[:-]?\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}[\s-]+[A-Za-z]{3,9}[\s\-,]+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i),
    currency: cur ? cur.toUpperCase().replace('RMB', 'CNY') : (flat.includes('$') ? 'USD' : null),
    invoice_total: total,
    incoterm: grab(/\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/),
    bl_awb_no: grab(/(?:B\/L|\bBL|bill of lading|AWB|air ?waybill)\s*(?:no|number|#)?\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{5,})/i),
    vessel_flight: grab(/(?:vessel|flight)\s*(?:name|no)?\.?\s*[:-]\s*([^\n]{3,40}?)(?:\s{2,}|\s+voy|\n|$)/i),
    port_of_loading: grab(/port of loading\s*[:-]?\s*([A-Za-z ,]{3,40})/i),
    total_packages: parseAmount(grab(/(?:total\s*)?(?:no\.?\s*of\s*)?(?:packages|pkgs|cartons|ctns)\s*[:-]?\s*(\d{1,5})/i)),
    gross_weight_kg: weight('gross'),
    net_weight_kg: weight('net'),
    freight: parseAmount(grab(/freight\s*(?:charges?)?\s*[:-]?\s*(?:[A-Z]{3}|\$)?\s*([\d.,]*\d)/i)),
    insurance: parseAmount(grab(/insurance\s*[:-]?\s*(?:[A-Z]{3}|\$)?\s*([\d.,]*\d)/i)),
    discount: parseAmount(grab(/discount\s*[:-]?\s*(?:[A-Z]{3}|\$)?\s*-?([\d.,]*\d)/i)),
  };
  if (/\b(B\/L|bill of lading|vessel)\b/i.test(flat)) header.transport_mode = 'Sea';
  else if (/\b(AWB|air ?waybill|flight)\b/i.test(flat)) header.transport_mode = 'Air';

  const notes = ['Read without AI from the page text. Check every line against the page.'];
  if (!items.length) notes.push('No item rows were recognised. Try a straighter, sharper photo, add an API key, or type the lines in.');
  return { header, items, notes };
}

// ── Claude reply ─────────────────────────────────────────────
/** The JSON value in a model reply: the whole reply, a code fence, or the outermost braces. */
export function extractJson(reply) {
  const s = String(reply || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const braces = s.includes('{') ? s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1) : null;
  for (const c of [s.trim(), fence && fence[1], braces]) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* next */ }
  }
  throw new Error("Claude's answer couldn't be turned into lines. Try again, or scan fewer pages at once.");
}

export const CLAUDE_SHAPE = `{"header":{"supplier_name":null,"supplier_address":null,"supplier_country":null,"consignee_name":null,
"invoice_no":null,"invoice_date":null,"currency":null,"invoice_total":null,"incoterm":null,"transport_mode":null,
"vessel_flight":null,"bl_awb_no":null,"port_of_loading":null,"country_of_export":null,"total_packages":null,
"package_type":null,"gross_weight_kg":null,"net_weight_kg":null,"freight":null,"insurance":null,"other_charges":null,"discount":null},
"items":[{"description":"","brand":null,"model":null,"hs_code":"","hs_confidence":"high|medium|low","origin":null,
"quantity":0,"unit":"PCS","unit_price":0,"total_price":0,"packages":null,"package_type":null,"gross_weight_kg":null,"net_weight_kg":null}],
"notes":[]}`;

export function claudePrompt(fileNames) {
  return `You are preparing a Maldives Customs import declaration (ASYCUDA SAD) from the attached trade documents:
a commercial invoice, and possibly a packing list, proforma, delivery note, bill of lading or airway bill.
The attached files, in order: ${fileNames.map((n, i) => `${i + 1}. ${n}`).join(', ')}

Read the document header and every invoice line item. Rules:
- Never invent values. Use null when a value is not on the documents or is illegible, and mention illegible parts in notes.
- Numbers are plain JSON numbers: no currency symbols, no thousands separators, keep the printed decimals.
- Weights in kilograms. If the documents use lb, convert and say so in notes.
- If a packing list is included, copy its package count, package kind, gross and net weight onto the matching
  invoice lines. Never create extra lines for packing-list rows.
- If weights are only given for the whole shipment, put them in the header and leave line weights null.
- quantity, unit and unit_price as printed; total_price is the line amount as printed.
- unit: short uppercase code (PCS, SET, KG, LTR, CTN, BOX, PR, M, DOZ, ROLL).
- description: the full commercial description including material, size and use. Put brand and model number in
  their own fields when shown.
- hs_code: the most specific Harmonized System code you can justify from the description, at least 6 digits,
  dotted like "8215.20" or "6302.60.10". hs_confidence: "high", "medium" or "low".
- origin and country fields: ISO 3166 alpha-2 codes (CN, SG, IN, AE ...).
- Do not put subtotal, tax, freight, insurance, handling or discount rows in items. Put freight, insurance,
  other charges and discount amounts in the header.
- transport_mode: Sea, Air, Road, Post or Courier. Dates as YYYY-MM-DD.
Reply with only JSON in exactly this shape:
${CLAUDE_SHAPE}`;
}

// ── Mapping onto the SAD fields ──────────────────────────────
const INCOTERMS = new Set(['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']);
const MODES = { sea: '1', ocean: '1', air: '2', courier: '2', post: '2', road: '3', rail: '4' };

/** Map a raw read (Claude or text) onto the SAD field names used by the form and sad-core. */
export function toForm(raw, engine) {
  const h = (raw && raw.header) || {};
  const general = {};
  const put = (k, v) => { if (v !== null && v !== undefined && v !== '') general[k] = v; };
  let exporter = text(h.supplier_name);
  if (exporter && text(h.supplier_address)) exporter += ', ' + text(h.supplier_address);
  put('exporter', exporter);
  put('consignee_name', text(h.consignee_name));
  put('country_of_export', country(h.country_of_export) || country(h.supplier_country));
  put('trading_country', country(h.supplier_country) || country(h.country_of_export));
  put('bl_number', text(h.bl_awb_no));
  put('vessel_name', text(h.vessel_flight));
  const inco = text(h.incoterm).toUpperCase().replace('C&F', 'CFR');
  put('delivery_terms', INCOTERMS.has(inco) ? inco : '');
  put('invoice_amount', num(h.invoice_total));
  const cur = text(h.currency).toUpperCase();
  put('invoice_currency', /^[A-Z]{3}$/.test(cur) ? cur : '');
  put('external_freight', num(h.freight));
  put('insurance', num(h.insurance));
  put('other_costs', num(h.other_charges));
  put('deductions', num(h.discount));
  const pk = num(h.total_packages);
  put('total_packages', pk === null ? null : Math.round(pk));
  put('mode_transport', MODES[text(h.transport_mode).toLowerCase()] || '');
  if (general.invoice_currency) {
    for (const k of ['freight_currency', 'insurance_currency', 'other_costs_currency']) general[k] = general.invoice_currency;
  }

  const items = [];
  for (const it of (raw && raw.items) || []) {
    if (!it || typeof it !== 'object') continue;
    const desc = text(it.description);
    let price = num(it.total_price);
    if (!desc && price === null) continue;
    const qty = num(it.quantity), unitPrice = num(it.unit_price);
    if (price === null && qty !== null && unitPrice !== null) price = Math.round(qty * unitPrice * 100) / 100;
    const pkgs = num(it.packages);
    const row = {
      description: desc,
      hs_code: normalizeHs(it.hs_code),
      hs_confidence: ['high', 'medium', 'low'].includes(it.hs_confidence) ? it.hs_confidence : 'low',
      country_origin: country(it.origin),
      gross_mass: num(it.gross_weight_kg),
      net_mass: num(it.net_weight_kg),
      item_price: price,
      supp_units: qty,
      unit: text(it.unit).toUpperCase(),
      unit_price: unitPrice,
      no_packages: pkgs === null ? null : Math.round(pkgs),
      package_kind: text(it.package_type).toUpperCase(),
      brand: text(it.brand),
      model: text(it.model),
    };
    items.push(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== '')));
  }

  const invoice = {};
  for (const k of ['invoice_no', 'invoice_date', 'gross_weight_kg', 'net_weight_kg', 'port_of_loading']) {
    if (h[k] !== null && h[k] !== undefined && h[k] !== '') invoice[k] = h[k];
  }
  const notes = ((raw && raw.notes) || []).filter(Boolean).map(String);

  // Every SAD item needs a gross mass (box 35): spread a shipment-only total by value.
  const totalGw = num(invoice.gross_weight_kg);
  const value = items.reduce((s, it) => s + (it.item_price || 0), 0);
  if (totalGw && value && items.length && !items.some((it) => it.gross_mass)) {
    for (const it of items) {
      it.gross_mass = Math.round((totalGw * (it.item_price || 0) / value) * 1000) / 1000;
      it.gross_mass_allocated = true;
    }
    notes.push(`Only a shipment gross weight (${totalGw} kg) was given, so it was spread over the lines by value. Replace with real line weights if you have them.`);
  }
  return { engine, general, items, invoice, notes, checks: buildChecks(general, items, invoice) };
}

/** Cross-checks between the lines and the header, as {level, text}. */
export function buildChecks(general, items, invoice) {
  const out = [];
  const add = (level, t) => out.push({ level, text: t });
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!items.length) { add('err', 'No item lines were found.'); return out; }
  const bad = items.map((it, i) => [it, i + 1]).filter(([it]) => it.supp_units != null && it.unit_price != null && it.item_price != null
    && Math.abs(it.supp_units * it.unit_price - it.item_price) > Math.max(0.05, it.item_price * 0.002)).map(([, i]) => i);
  if (bad.length) add('err', `Qty × unit price doesn't match the line total on line(s) ${bad.join(', ')}.`);
  else add('ok', 'Every line total equals qty × unit price.');

  const lines = items.reduce((s, it) => s + (it.item_price || 0), 0);
  const inv = general.invoice_amount;
  if (inv != null) {
    const net = lines - (general.deductions || 0);
    const withCharges = net + (general.external_freight || 0) + (general.insurance || 0) + (general.other_costs || 0);
    if (Math.abs(lines - inv) <= 0.05 || Math.abs(net - inv) <= 0.05) add('ok', `Lines add up to the invoice total (${fmt(inv)}).`);
    else if (Math.abs(withCharges - inv) <= 0.05) add('warn', "The invoice total includes freight/insurance — make sure they aren't counted twice.");
    else add('err', `Lines total ${fmt(lines)} but the invoice says ${fmt(inv)} (difference ${fmt(lines - inv)}).`);
  } else add('warn', "No invoice total was found, so the line sum can't be checked.");

  const gw = num(invoice.gross_weight_kg);
  const lineGw = items.reduce((s, it) => s + (it.gross_mass || 0), 0);
  if (gw && lineGw && Math.abs(lineGw - gw) > 0.5) add('warn', `Line gross weights total ${lineGw.toFixed(1)} kg; the documents say ${gw.toFixed(1)} kg.`);
  const pk = general.total_packages;
  const linePk = items.reduce((s, it) => s + (it.no_packages || 0), 0);
  if (pk && linePk && linePk !== pk) add('warn', `Line packages total ${linePk}; the documents say ${pk}.`);
  if (!general.bl_number) add('warn', 'No B/L or AWB number was found — add it from the transport document.');
  if (!items.some((it) => it.country_origin)) add('warn', 'No country of origin was found (box 34).');
  if (items.some((it) => !it.hs_code)) add('warn', 'Some lines have no HS code — tap 🔎 on the review screen to look them up.');
  return out;
}
