import * as core from './sad-core.js';
import { history, local } from './store.js';

export const VERSION = '1.1.0';
const $ = (id) => document.getElementById(id);
const XLS_MIME = 'application/vnd.ms-excel';
const TARIFF_URL = 'https://www.customs.gov.mv/eServices/findtariff?hsSearchIn=';

const state = { data: null, source: '', preferential: 'general', result: null, shown: 40, fx: null };
const curOf = () => String((state.data && state.data.general.invoice_currency) || 'USD').toUpperCase();
let modelBytes = null;

// ── Utilities ────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, d = 0) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n, cur = '') => `${num(n, 2)}${cur ? ' ' + esc(cur) : ''}`;
const flag = (cc) => {
  cc = String(cc || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? `<span class="flag">${String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))}</span>` : '';
};
const PALETTE = ['#F97316', '#EC4899', '#8B5CF6', '#3B82F6', '#14B8A6', '#22C55E', '#F59E0B', '#EF4444'];
const BAND = { '0%': '#22C55E', '0–10%': '#14B8A6', '10–20%': '#3B82F6', '20–30%': '#8B5CF6', '>30%': '#EC4899', Unknown: '#94A3B8' };
const GRADS = ['var(--g-warm)', 'var(--g-cool)', 'var(--g-fresh)', 'var(--g-sun)', 'var(--g-berry)', 'var(--g-sea)'];
const rateColor = (r) => (r === null || r === undefined ? BAND.Unknown : r === 0 ? BAND['0%'] : r <= 10 ? BAND['0–10%'] : r <= 20 ? BAND['10–20%'] : r <= 30 ? BAND['20–30%'] : BAND['>30%']);
const pill = (r) => (r === null || r === undefined ? '<span class="muted">—</span>' : `<span class="pill" style="background:${rateColor(r)}">${r}%</span>`);

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function saveBytes(bytes, name) {
  const blob = new Blob([bytes], { type: XLS_MIME });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function shareFiles(files, title) {
  const list = files.map((f) => new File([f.bytes], f.name, { type: XLS_MIME }));
  if (navigator.canShare && navigator.canShare({ files: list })) {
    try { await navigator.share({ files: list, title }); } catch (e) { if (e.name !== 'AbortError') toast('Sharing failed: ' + e.message); }
  } else toast('Sharing files is not supported in this browser — use Download.');
}
const canShareFiles = () => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 't.xls', { type: XLS_MIME })] })); } catch { return false; }
};

async function loadModel() {
  if (modelBytes) return modelBytes;
  const r = await fetch('templates/SAD_MODEL.xls');
  if (!r.ok) throw new Error('Could not load the SAD model template');
  modelBytes = new Uint8Array(await r.arrayBuffer());
  return modelBytes;
}

// ── Navigation ───────────────────────────────────────────────
function go(tab) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.go === tab));
  $('actionBar').hidden = !(tab === 'file' && state.data);
  if (tab === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// ── Theme ────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('themeBtn').textContent = t === 'dark' ? '☀' : '🌙';
  document.querySelector('meta[name="theme-color"]').content = t === 'dark' ? '#0A0F1E' : '#EC4899';
}
applyTheme(local.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; local.set('theme', t); applyTheme(t); };

// ── Review ───────────────────────────────────────────────────
function setData(data, source) {
  state.data = { general: { ...data.general }, items: data.items.map((it) => ({ ...it })) };
  state.source = source; state.shown = 40;
  const cur = curOf();
  const saved = (local.get('fx') || {})[cur];
  state.fx = core.parseNumber(data.general.exchange_rate, null) || saved || core.DEFAULT_RATES[cur] || null;
  $('fxInput').value = state.fx ?? '';
  $('fxHint').textContent = `MVR per 1 ${cur} · ${core.parseNumber(data.general.exchange_rate, null) ? 'from your file' : saved ? 'last used' : state.fx ? 'default — check today\'s rate' : 'enter from Customs'}`;
  $('review').hidden = false;
  $('reviewName').textContent = source;
  renderReview();
  go('file');
  setTimeout(() => $('review').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

function renderReview() {
  const { general: g, items } = state.data;
  const cur = g.invoice_currency || '';
  const warn = core.validate(state.data);
  $('reviewWarnings').innerHTML = !items.length
    ? '<div class="alert bad">⚠ No items found. Check the Items sheet (SAD model: items from row 4; template: headers in row 1).</div>'
    : warn.length ? `<div class="alert warn">⚠ <span>${warn.slice(0, 5).map(esc).join('<br>')}${warn.length > 5 ? `<br>…and ${warn.length - 5} more` : ''}</span></div>` : '';
  $('reviewBl').textContent = g.bl_number ? `BL ${g.bl_number}` : '';
  const kv = [['Vessel', g.vessel_name], ['Exporter', g.exporter], ['Consignee', g.consignee_code],
    ['Export country', g.country_of_export ? flag(g.country_of_export) + esc(g.country_of_export) : '', true],
    ['Terms', g.delivery_terms], ['Invoice', g.invoice_amount ? money(g.invoice_amount, cur) : '', true]]
    .filter(([, v]) => v !== undefined && v !== null && v !== '');
  $('reviewGeneral').innerHTML = kv.length ? kv.map(([l, v, raw]) => `<div class="kv"><div class="kv-l">${l}</div><div class="kv-v">${raw ? v : esc(v)}</div></div>`).join('')
    : '<div class="muted">No header data — defaults from the SAD model will be used.</div>';
  renderDashboard();
  renderItems();
}

function renderDashboard() {
  const { general: g, items } = state.data;
  const cur = g.invoice_currency || '';
  const a = core.buildAnalytics(g, items, state.preferential, state.fx);
  const t = a.totals, cb = a.cost_breakdown, rec = a.reconciliation, m = a.mvr;
  $('actionTotal').textContent = m ? money(m.payable, 'MVR') : money(t.duty, cur);
  $('actionSub').textContent = m ? `payable · duty ${num(m.duty, 0)} + rev. ${num(m.revenue, 0)}` : `duty · ${t.items} item(s) · ${state.preferential.toUpperCase()}`;

  const kpi = (i, l, v, s, gr) => `<div class="kpi" style="background:${gr}"><div class="i">${i}</div><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const mvrKpis = m ? [
    kpi('🇲🇻', 'Duty (MVR)', money(m.duty, 'MVR'), `price × duty% × ${m.exchange_rate}`, 'linear-gradient(135deg,#DC2626,#EC4899)'),
    kpi('🏦', 'Revenue 1% (MVR)', money(m.revenue, 'MVR'), `price × ${m.exchange_rate} × 1%`, 'linear-gradient(135deg,#0EA5E9,#6366F1)'),
    kpi('💳', 'Total payable', money(m.payable, 'MVR'), 'duty + revenue', 'linear-gradient(135deg,#16A34A,#0D9488)'),
    kpi('💱', 'Goods in MVR', money(m.goods, 'MVR'), `${money(t.item_value, cur)} × ${m.exchange_rate}`, 'linear-gradient(135deg,#64748B,#334155)'),
  ].join('') : '';
  const kpis = mvrKpis + [
    kpi('💰', 'Goods value', money(t.item_value, cur), t.value_per_kg ? `${money(t.value_per_kg)} / kg` : `${t.items} item(s)`, GRADS[0]),
    kpi('🏛', 'Customs duty', money(t.duty, cur), `effective ${num(t.effective_rate, 2)}%`, GRADS[4]),
    kpi('🚢', 'CIF value', money(cb.cif, cur), 'incl. freight & insurance', GRADS[5]),
    kpi('🧾', 'Landed', money(cb.landed, cur), 'CIF + duty', GRADS[2]),
    kpi('⚖️', 'Gross mass', `${num(t.gross_mass, 1)} kg`, `${num(t.packages)} pkg${t.declared_packages ? ` · decl. ${num(t.declared_packages)}` : ''}`, GRADS[3]),
    kpi('📦', 'Items', num(t.items), `${t.chapters} chapter(s) · ${t.origins} origin(s)`, GRADS[1]),
  ].join('');

  const parts = [['Goods', cb.goods, PALETTE[0]], ['Ext. freight', cb.external_freight, PALETTE[3]], ['Int. freight', cb.internal_freight, PALETTE[4]],
    ['Insurance', cb.insurance, PALETTE[2]], ['Other', cb.other_costs, PALETTE[6]], ['Duty', cb.duty, PALETTE[1]]].filter((p) => p[1] > 0);
  const sum = parts.reduce((s, p) => s + p[1], 0) || 1;
  const costs = `<div class="panel"><h3>Cost build-up</h3>
    <div class="stackbar">${parts.map((p) => `<div style="width:${(100 * p[1] / sum).toFixed(2)}%;background:${p[2]}"></div>`).join('')}</div>
    <div class="legend">${parts.map((p) => `<span><i style="background:${p[2]}"></i>${p[0]}<b>${money(p[1])}</b></span>`).join('')}</div>
    <div class="total-line"><span>Landed cost</span><b>${money(cb.landed, cur)}</b></div></div>`;

  const src = a.hs_sources, st = (src.manual + src.auto + src.missing) || 1;
  const checks = `<div class="panel"><h3>Checks</h3>
    ${rec.matches === null ? '<span class="badge na">No declared invoice total</span>' : rec.matches ? '<span class="badge ok">✓ Items match the invoice</span>'
      : `<span class="badge bad">⚠ Items differ from invoice by ${money(rec.difference, cur)}</span>`}
    ${t.declared_packages && t.declared_packages !== t.packages ? `<div style="margin-top:8px"><span class="badge bad">⚠ Packages ${num(t.packages)} vs declared ${num(t.declared_packages)}</span></div>` : ''}
    <div class="legend" style="margin-top:10px"><span><i style="background:#22C55E"></i>HS given<b>${src.manual}</b></span>
      <span><i style="background:#EF4444"></i>HS missing<b>${src.missing}</b></span>
      <span><i style="background:#94A3B8"></i>No rate<b>${a.rate_bands.find((b) => b.label === 'Unknown').count}</b></span></div>
    <div class="stackbar" style="height:12px;margin-top:6px"><div style="width:${100 * src.manual / st}%;background:#22C55E"></div><div style="width:${100 * src.missing / st}%;background:#EF4444"></div></div>
  </div>`;

  const useDuty = t.duty > 0;
  const ch = a.by_chapter.map((r, i) => ({ ...r, c: PALETTE[i % PALETTE.length], v: useDuty ? r.duty : r.value }));
  const chTotal = ch.reduce((s, r) => s + r.v, 0);
  const R = 44, C = 2 * Math.PI * R; let off = 0;
  const segs = ch.filter((r) => r.v > 0).map((r) => { const len = chTotal ? (r.v / chTotal) * C : 0;
    const s = `<circle r="${R}" cx="56" cy="56" fill="none" stroke="${r.c}" stroke-width="16" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 56 56)"></circle>`;
    off += len; return s; }).join('');
  const chapters = `<div class="panel"><h3>${useDuty ? 'Duty' : 'Value'} by HS chapter</h3><div class="donut-wrap">
    <svg width="112" height="112" viewBox="0 0 112 112"><circle r="${R}" cx="56" cy="56" fill="none" stroke="var(--track)" stroke-width="16"></circle>${segs}
    <text x="56" y="53" text-anchor="middle" class="dc">${useDuty ? 'duty' : 'value'}</text><text x="56" y="70" text-anchor="middle" class="dn">${esc(num(chTotal, 0))}</text></svg>
    <div class="donut-legend">${ch.map((r) => `<div><i style="background:${r.c}"></i><span>${r.key !== 'other' && r.key !== '??' ? `<b>${r.key}</b> ` : ''}${esc(r.label)}</span><span class="muted">${chTotal ? Math.round(100 * r.v / chTotal) : 0}%</span></div>`).join('')}</div></div></div>`;

  const max = Math.max(1, ...a.by_origin.map((r) => r.value));
  const origins = `<div class="panel"><h3>Value by origin</h3><div class="bars">${a.by_origin.map((r, i) => `
    <div class="bar-row"><div class="bl">${flag(r.key)}${esc(r.label)}</div><div class="bt"><div class="bf" style="width:${(100 * r.value / max).toFixed(1)}%;background:${PALETTE[i % PALETTE.length]}"></div></div>
    <div class="bv">${money(r.value, cur)} · ${r.share}% · ${r.items} item(s)</div></div>`).join('')}</div></div>`;

  const bmax = Math.max(1, ...a.rate_bands.map((b) => b.count));
  const bands = `<div class="panel"><h3>Items by duty rate</h3><div class="hist">${a.rate_bands.map((b) => `<div><div class="hn">${b.count}</div>
    <div class="hb" style="height:${Math.max(3, 80 * b.count / bmax)}px;background:${BAND[b.label]}"></div><div class="hl">${b.label}</div></div>`).join('')}</div></div>`;

  const top = a.top_duty_items.length ? `<div class="panel"><h3>Top duty items</h3><div class="top">${a.top_duty_items.map((r, i) => `<div>
    <div class="rank" style="background:${GRADS[i % GRADS.length]}">${i + 1}</div>
    <div style="min-width:0"><div class="ellipsis" style="font-weight:700">${esc(r.description || '—')}</div><div class="muted"><span class="code">${esc(r.hs_code || '—')}</span> @ ${r.duty_rate}%</div></div>
    <div style="font-weight:800;color:var(--pink)">${money(r.duty)}</div></div>`).join('')}</div></div>` : '';

  $('dash').innerHTML = `<div class="kpis">${kpis}</div>${costs}${checks}${chapters}${origins}${bands}${top}`;
  return a;
}

function renderItems() {
  const { general: g, items } = state.data;
  const cur = g.invoice_currency || '';
  $('itemsCount').textContent = `${items.length} item(s)`;
  const shown = items.slice(0, state.shown);
  const key = { general: 'duty_rate', safta: 'safta_rate', cmfta: 'cmfta_rate' }[state.preferential];
  $('itemsList').innerHTML = shown.map((it, i) => {
    const d = core.calculateItemDuty(it, state.preferential, state.fx);
    const hs = core.normalizeHs(it.hs_code);
    const desc = String(it.description ?? it.commercial_description ?? '');
    const q = encodeURIComponent(hs || desc.slice(0, 40));
    const rateVal = it[key] ?? (state.preferential !== 'general' ? '' : '');
    return `<div class="item" style="--ic:${rateColor(d.duty_rate)}">
      <div class="item-top"><div style="min-width:0"><div class="item-desc">${i + 1}. ${esc(desc || '—')}</div>
        <div class="item-meta">${hs ? `<span class="code">${esc(hs)}</span>` : '<span class="badge bad" style="padding:1px 7px">HS missing</span>'}
          ${it.country_origin ? `<span>${flag(it.country_origin)}${esc(it.country_origin)}</span>` : ''}
          ${it.gross_mass ? `<span>${num(it.gross_mass, 1)} kg</span>` : ''}${it.no_packages ? `<span>${num(it.no_packages)} pkg</span>` : ''}
          ${it.brand ? `<span>${esc(it.brand)}</span>` : ''}</div></div>
        <a class="tariff-link" href="${TARIFF_URL}${q}" target="_blank" rel="noopener" title="Search the customs tariff">🔎</a></div>
      <div class="item-nums">
        <div><label>Price</label><div class="n">${money(it.item_price)}</div></div>
        <div><label>${state.preferential === 'general' ? 'Duty %' : state.preferential.toUpperCase() + ' %'}</label>
          <input class="rate-in" inputmode="decimal" data-i="${i}" value="${esc(rateVal ?? '')}" placeholder="${state.preferential !== 'general' && it.duty_rate != null ? it.duty_rate : '—'}"></div>
        <div style="text-align:right"><label>Duty</label><div class="n" style="color:var(--pink)">${money(d.duty_amount)}</div></div>
      </div>${d.duty_mvr !== undefined ? `<div class="mvr-line"><span>Duty <b>${money(d.duty_mvr, 'MVR')}</b></span><span>Revenue <b>${money(d.revenue_mvr, 'MVR')}</b></span></div>` : ''}</div>`;
  }).join('') + (items.length > state.shown ? `<div class="more-items"><button class="btn ghost" id="showMore">Show ${Math.min(40, items.length - state.shown)} more (${items.length - state.shown} hidden)</button></div>` : '');
  const more = $('showMore');
  if (more) more.onclick = () => { state.shown += 40; renderItems(); };
  document.querySelectorAll('.rate-in').forEach((inp) => inp.addEventListener('change', () => {
    const it = state.data.items[+inp.dataset.i];
    const r = core.parseRate(inp.value);
    if (r === null) delete it[key]; else it[key] = r;
    renderDashboard(); renderItems();
  }));
  void cur;
}

$('fxInput').addEventListener('change', () => {
  const v = core.parseNumber($('fxInput').value, null);
  state.fx = v && v > 0 ? v : null;
  const all = local.get('fx') || {};
  if (state.fx) { all[curOf()] = state.fx; local.set('fx', all); }
  $('fxHint').textContent = `MVR per 1 ${curOf()} · ${state.fx ? 'saved on this phone' : 'enter from Customs'}`;
  if (state.data) { renderDashboard(); renderItems(); }
});

$('prefSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.preferential = b.dataset.pref;
  document.querySelectorAll('#prefSeg button').forEach((x) => x.classList.toggle('active', x === b));
  if (state.data) { renderDashboard(); renderItems(); }
});
$('clearReview').onclick = () => { state.data = null; $('review').hidden = true; $('fileInput').value = ''; go('file'); };

// ── File input ───────────────────────────────────────────────
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = core.readWorkbook(new Uint8Array(await f.arrayBuffer()));
    setData(data, f.name);
    if (!data.items.length) toast('No items found in this file.');
  } catch (err) {
    console.error(err);
    toast('Could not read this file: ' + err.message, 4000);
  }
});

// ── Generate ─────────────────────────────────────────────────
$('generateBtn').onclick = async () => {
  if (!state.data || !state.data.items.length) { toast('Add at least one item first.'); return; }
  const btn = $('generateBtn');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    await new Promise((r) => setTimeout(r, 30)); // let the button repaint
    const model = await loadModel();
    const res = core.generate(model, state.data, state.preferential, state.fx);
    state.result = res;
    const cur = res.general.invoice_currency || '';
    const t = res.analytics.totals;
    await history.add({
      id: res.sad.name, created: Date.now(), name: res.sad.name, duty_name: res.duty.name,
      bl: res.general.bl_number || '', vessel: res.general.vessel_name || '', items: t.items,
      value: t.item_value, duty: t.duty, currency: cur, preferential: res.preferential,
      exchange_rate: res.exchange_rate, payable_mvr: res.analytics.mvr ? res.analytics.mvr.payable : null,
      sad: new Blob([res.sad.bytes], { type: XLS_MIME }), dutySheet: new Blob([res.duty.bytes], { type: XLS_MIME }),
    }).then(() => history.trim(30)).catch((e2) => console.warn('history not saved', e2));
    showResult(res);
    refreshStats();
  } catch (err) {
    console.error(err);
    toast('Could not generate: ' + err.message, 4000);
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Generate SAD';
  }
};

function showResult(res) {
  const cur = res.general.invoice_currency || '';
  const t = res.analytics.totals, cb = res.analytics.cost_breakdown;
  $('resultSub').textContent = `${t.items} item(s) · ${res.preferential.toUpperCase()} tariff · ${res.sad.name}`;
  $('resultWarnings').innerHTML = res.warnings.length
    ? `<div class="alert warn">⚠ <span>${res.warnings.slice(0, 6).map(esc).join('<br>')}${res.warnings.length > 6 ? `<br>…and ${res.warnings.length - 6} more` : ''}</span></div>` : '';
  const m = res.analytics.mvr;
  $('resultKpis').innerHTML = m ? `<div class="kpis mini">
    <div class="kpi" style="background:linear-gradient(135deg,#DC2626,#EC4899)"><div class="l">Duty MVR</div><div class="v">${money(m.duty)}</div></div>
    <div class="kpi" style="background:linear-gradient(135deg,#0EA5E9,#6366F1)"><div class="l">Revenue 1%</div><div class="v">${money(m.revenue)}</div></div>
    <div class="kpi" style="background:linear-gradient(135deg,#16A34A,#0D9488)"><div class="l">Payable MVR</div><div class="v">${money(m.payable)}</div></div></div>
    <div class="result-usd">Goods ${money(t.item_value, cur)} · duty ${money(t.duty, cur)} (${num(t.effective_rate, 2)}%) · rate ${m.exchange_rate} MVR/${esc(cur)}</div>`
    : `<div class="kpis mini">
    <div class="kpi" style="background:var(--g-warm)"><div class="l">Goods</div><div class="v">${money(t.item_value)}</div></div>
    <div class="kpi" style="background:var(--g-berry)"><div class="l">Duty</div><div class="v">${money(t.duty)}</div></div>
    <div class="kpi" style="background:var(--g-fresh)"><div class="l">Landed</div><div class="v">${money(cb.landed)}</div></div></div>
    <div class="result-usd">Amounts in ${esc(cur || 'invoice currency')} — add an MVR rate to see duty and revenue in MVR.</div>`;
  $('shareBtn').hidden = !canShareFiles();
  $('sheet').hidden = false;
}
$('dlSad').onclick = () => state.result && saveBytes(state.result.sad.bytes, state.result.sad.name);
$('dlDuty').onclick = () => state.result && saveBytes(state.result.duty.bytes, state.result.duty.name);
$('shareBtn').onclick = () => state.result && shareFiles([state.result.sad, state.result.duty], state.result.sad.name);
$('closeSheet').onclick = () => { $('sheet').hidden = true; };
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; });

// ── Form ─────────────────────────────────────────────────────
const FORM_MAIN = [
  ['bl_number', 'BL number', 'text', true], ['vessel_name', 'Vessel', 'text', true], ['exporter', 'Exporter', 'text', true],
  ['consignee_code', 'Consignee code', 'text'], ['country_of_export', 'Export country', 'text'], ['trading_country', 'Trading country', 'text'],
  ['delivery_terms', 'Delivery terms', 'text'], ['invoice_amount', 'Invoice total', 'number'], ['invoice_currency', 'Currency', 'text'],
  ['exchange_rate', 'MVR rate (Customs)', 'number'],
];
const FORM_MORE = [
  ['manifest_no', 'Manifest no.', 'text'], ['customs_office', 'Customs office', 'text'], ['office_entry_exit', 'Office of entry', 'text'],
  ['declarant_code', 'Declarant code', 'text'], ['decl_type', 'Decl. type', 'text'], ['decl_subtype', 'Decl. subtype', 'number'],
  ['procedure', 'Procedure', 'text'], ['procedure_add', 'Procedure add.', 'text'], ['external_freight', 'External freight', 'number'],
  ['freight_currency', 'Freight currency', 'text'], ['insurance', 'Insurance', 'number'], ['insurance_currency', 'Insurance currency', 'text'],
  ['other_costs', 'Other costs', 'number'], ['other_costs_currency', 'Other costs currency', 'text'], ['internal_freight', 'Internal freight', 'number'],
  ['deductions', 'Deductions', 'number'], ['location_goods', 'Location of goods', 'text'], ['mode_transport', 'Mode of transport', 'text'],
  ['place_discharge', 'Place of discharge', 'text'], ['carrier_nationality', 'Carrier nationality', 'text'], ['total_packages', 'Total packages', 'number'],
  ['prepayment_code', 'Pre-payment code', 'text'],
];
const ITEM_FIELDS = [
  ['description', 'Description', 'text', true], ['hs_code', 'HS code', 'tel'], ['country_origin', 'Origin', 'text'],
  ['item_price', 'Price', 'number'], ['duty_rate', 'Duty %', 'number'], ['gross_mass', 'Gross kg', 'number'],
  ['no_packages', 'Packages', 'number'], ['brand', 'Brand', 'text'], ['model', 'Model', 'text'],
];
const PLACEHOLDERS = { customs_office: '00MP', decl_type: 'IM', decl_subtype: '4', procedure: '4000', procedure_add: '000', delivery_terms: 'CIF',
  invoice_currency: 'USD', exchange_rate: '15.42', consignee_code: 'C8888', declarant_code: 'C8888', mode_transport: '1', carrier_nationality: 'MV', country_of_export: 'CN', country_origin: 'CN' };

const field = ([k, label, type, wide], val, attr) => `<div class="field${wide ? ' wide' : ''}"><label>${label}</label>
  <input ${attr}="${k}" type="${type === 'number' ? 'text' : type}" ${type === 'number' ? 'inputmode="decimal"' : ''} ${type === 'tel' ? 'inputmode="numeric"' : ''}
    value="${esc(val ?? '')}" placeholder="${esc(PLACEHOLDERS[k] || '')}" autocomplete="off"></div>`;

let form = local.get('form') || { general: {}, items: [{}] };
function renderForm() {
  $('formGeneral').innerHTML = FORM_MAIN.map((f) => field(f, form.general[f[0]], 'data-g')).join('');
  $('formGeneralMore').innerHTML = FORM_MORE.map((f) => field(f, form.general[f[0]], 'data-g')).join('');
  $('formItems').innerHTML = form.items.map((it, i) => `<div class="fitem" style="--ic:${PALETTE[i % PALETTE.length]}">
    <div class="fitem-h"><span>Item ${i + 1}</span><button class="link" data-del="${i}">Remove</button></div>
    <div class="form-grid">${ITEM_FIELDS.map((f) => field(f, it[f[0]], `data-i${i}`)).join('')}</div></div>`).join('');
  $('formItemsCount').textContent = `${form.items.length} item(s)`;
}
function readForm() {
  const g = {};
  document.querySelectorAll('[data-g]').forEach((el) => { if (el.value.trim() !== '') g[el.dataset.g] = el.value.trim(); });
  const items = form.items.map((_, i) => {
    const it = {};
    document.querySelectorAll(`[data-i${i}]`).forEach((el) => { const k = el.getAttribute(`data-i${i}`); if (el.value.trim() !== '') it[k] = el.value.trim(); });
    return it;
  });
  form = { general: g, items: items.length ? items : [{}] };
  local.set('form', form);
}
function toData(f) {
  const numKeys = new Set([...FORM_MAIN, ...FORM_MORE, ...ITEM_FIELDS].filter((x) => x[2] === 'number').map((x) => x[0]));
  const conv = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, numKeys.has(k) && core.parseNumber(v) !== null ? core.parseNumber(v) : v]));
  return { general: conv(f.general), items: f.items.filter((it) => Object.keys(it).length).map(conv) };
}
$('view-form').addEventListener('input', () => readForm());
$('formItems').addEventListener('click', (e) => {
  const d = e.target.closest('[data-del]'); if (!d) return;
  readForm(); form.items.splice(+d.dataset.del, 1); if (!form.items.length) form.items.push({}); local.set('form', form); renderForm();
});
$('addItem').onclick = () => { readForm(); form.items.push({}); local.set('form', form); renderForm();
  const last = $('formItems').lastElementChild; last && last.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
$('formClear').onclick = () => { if (!confirm('Clear the whole form?')) return; form = { general: {}, items: [{}] }; local.set('form', form); renderForm(); };
$('formReview').onclick = () => {
  readForm();
  const data = toData(form);
  if (!data.items.length) { toast('Add at least one item.'); return; }
  setData(data, `Form · ${data.general.bl_number || 'no BL'}`);
};

const SAMPLE = {
  general: { bl_number: 'DEMO-BL-2026-001', vessel_name: 'MV DEMO VOYAGER', exporter: 'SAMPLE TRADING CO', consignee_code: 'C00000',
    country_of_export: 'CN', trading_country: 'CN', delivery_terms: 'CIF', invoice_amount: 24150, invoice_currency: 'USD',
    external_freight: 1600, freight_currency: 'USD', insurance: 120, insurance_currency: 'USD', total_packages: 99, customs_office: '00MP' },
  items: [
    { description: 'Double-door refrigerator 450L', hs_code: '8418102000', country_origin: 'CN', item_price: 9800, duty_rate: 20, safta_rate: 15, cmfta_rate: 5, gross_mass: 820, no_packages: 14, brand: 'FrostLine' },
    { description: 'LED television 55-inch', hs_code: '8528720000', country_origin: 'MY', item_price: 6300, duty_rate: 20, safta_rate: 15, gross_mass: 240, no_packages: 15, brand: 'Vista' },
    { description: 'Leather sandals (men)', hs_code: '6403990099', country_origin: 'IN', item_price: 2900, duty_rate: 25, safta_rate: 10, gross_mass: 180, no_packages: 30, brand: 'WalkMax' },
    { description: 'Basmati rice 5kg', hs_code: '1006300099', country_origin: 'IN', item_price: 3700, duty_rate: 0, safta_rate: 0, gross_mass: 4200, no_packages: 40, brand: 'Golden' },
    { description: 'Skin-care cream 50ml', hs_code: '3304990000', country_origin: 'TH', item_price: 1450, duty_rate: 35, gross_mass: 40, no_packages: 0, brand: 'Glow' },
  ],
};
$('sampleBtn').onclick = () => setData(SAMPLE, 'Sample shipment (demo data)');
$('formSample').onclick = () => { form = JSON.parse(JSON.stringify(SAMPLE)); local.set('form', form); renderForm(); toast('Sample filled — tap “Review & generate”.'); };

// ── History ──────────────────────────────────────────────────
async function renderHistory() {
  let list = [];
  try { list = await history.list(); } catch (e) { $('historyList').innerHTML = `<div class="empty">History is not available in this browser (${esc(e.message)}).</div>`; return; }
  const today = new Date().toDateString();
  const todayN = list.filter((e) => new Date(e.created).toDateString() === today).length;
  const dutySum = list.filter((e) => new Date(e.created).toDateString() === today).reduce((s, e) => s + (e.duty || 0), 0);
  $('historyStats').innerHTML = `<div style="background:var(--g-warm)"><b>${list.length}</b><span>Saved</span></div>
    <div style="background:var(--g-cool)"><b>${todayN}</b><span>Today</span></div>
    <div style="background:var(--g-fresh)"><b>${num(dutySum, 0)}</b><span>Duty today</span></div>`;
  $('historyList').innerHTML = list.length ? list.map((e, i) => `<div class="h-item">
    <div class="h-top"><div class="h-badge" style="background:${GRADS[i % GRADS.length]}">SAD</div>
      <div style="min-width:0"><div class="h-name">${esc(e.name)}</div>
      <div class="h-meta">${new Date(e.created).toLocaleString()} · ${e.items} item(s) · duty ${money(e.duty, e.currency)}${e.payable_mvr != null ? ` · payable ${money(e.payable_mvr, 'MVR')}` : ''} · ${esc((e.preferential || 'general').toUpperCase())}</div></div></div>
    <div class="h-btns"><button class="btn primary" data-h="sad" data-id="${esc(e.id)}">⬇ SAD</button><button class="btn ghost" data-h="duty" data-id="${esc(e.id)}">📊 Duty</button>
      ${canShareFiles() ? `<button class="btn ghost" data-h="share" data-id="${esc(e.id)}">📤</button>` : ''}<button class="btn ghost" data-h="del" data-id="${esc(e.id)}">🗑</button></div></div>`).join('')
    : '<div class="empty"><div class="e">🗂</div>No SAD files yet.<br>Generated files are kept here on this phone.</div>';
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    $('storageInfo').textContent = `Using ${(est.usage / 1048576).toFixed(1)} MB on this phone · the last 30 files are kept`;
  }
}
$('historyList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-h]'); if (!b) return;
  const entry = await history.get(b.dataset.id); if (!entry) return;
  const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
  if (b.dataset.h === 'sad') saveBytes(await bytesOf(entry.sad), entry.name);
  if (b.dataset.h === 'duty') saveBytes(await bytesOf(entry.dutySheet), entry.duty_name);
  if (b.dataset.h === 'share') shareFiles([{ name: entry.name, bytes: await bytesOf(entry.sad) }, { name: entry.duty_name, bytes: await bytesOf(entry.dutySheet) }], entry.name);
  if (b.dataset.h === 'del' && confirm('Delete this SAD from the phone?')) { await history.remove(entry.id); renderHistory(); refreshStats(); }
});

async function refreshStats() {
  try {
    const list = await history.list();
    const today = new Date().toDateString();
    $('statFiles').textContent = list.length;
    $('statToday').textContent = list.filter((e) => new Date(e.created).toDateString() === today).length;
    $('statDuty').textContent = list.length ? num(list[0].duty, 0) : '–';
  } catch { /* ignore */ }
}

// ── Help downloads ───────────────────────────────────────────
document.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', async () => {
  try {
    const model = await loadModel();
    if (b.dataset.dl === 'model') saveBytes(core.blankSadModel(model), 'SAD_MODEL.xls');
    if (b.dataset.dl === 'model-sample') saveBytes(model, 'SAD_MODEL_sample.xls');
    if (b.dataset.dl === 'simple') saveBytes(core.buildSimpleTemplate(), 'SAD_Input_Template.xls');
  } catch (err) { toast(err.message); }
}));

// ── Install / offline ────────────────────────────────────────
let deferredPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('installBtn').hidden = true; };
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e)));
}
addEventListener('online', () => { $('appSub').textContent = 'ASYCUDA SAD generator · works offline'; });
addEventListener('offline', () => { $('appSub').textContent = 'ASYCUDA SAD generator · offline mode'; });

// ── Start ────────────────────────────────────────────────────
$('appSub').textContent = `ASYCUDA SAD generator · ${navigator.onLine ? 'works offline' : 'offline mode'}`;
$('versionInfo').textContent = `SAD Mobile v${VERSION} · runs entirely in your browser`;
renderForm();
refreshStats();
loadModel().catch(() => {}); // warm the cache
window.__sad = { state, core }; // handy for debugging
