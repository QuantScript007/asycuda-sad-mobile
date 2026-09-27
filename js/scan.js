// Scan tab: pick or photograph invoices, read them (free OCR on the phone, or
// Claude with the user's own API key) and hand the result to the form.
import { parseInvoiceText, toForm, extractJson, claudePrompt } from './invoice-parse.js';
import { local } from './store.js';

const LIBS = {
  pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
};
const DEFAULT_MODEL = 'claude-sonnet-5';
const loaded = {};
function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => { delete loaded[src]; reject(new Error(`Couldn't download the reader from ${new URL(src).host}. Check your internet connection.`)); };
      document.head.appendChild(el);
    });
  }
  return loaded[src];
}
async function loadPdfJs() {
  await loadScript(LIBS.pdfWorker); // defines pdfjsWorker, so pdf.js needs no cross-origin worker
  await loadScript(LIBS.pdf);
  globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
  return globalThis.pdfjsLib;
}

export async function shrinkImage(blob, maxSide = 2000) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  } catch { return blob; }
}

let pageId = 0;
/** Turn picked files into {file, kind, pages:[{id,name,blob,url,text}]} (PDFs rendered page by page). */
export async function prepareFiles(list) {
  const out = [], problems = [];
  for (const file of list) {
    try {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const entry = { file, kind: isPdf ? 'pdf' : 'image', pages: [] };
      if (isPdf) {
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        const n = Math.min(doc.numPages, 20);
        for (let p = 1; p <= n; p++) {
          const page = await doc.getPage(p);
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 2000 / Math.max(base.width, base.height) });
          const c = document.createElement('canvas');
          c.width = Math.round(vp.width); c.height = Math.round(vp.height);
          const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: cx, viewport: vp }).promise;
          const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
          let text = '';
          try {
            const tc = await page.getTextContent();
            text = tc.items.map((t) => t.str + (t.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim();
          } catch { /* scanned page: no text layer */ }
          entry.pages.push({ id: ++pageId, name: `${file.name} · p${p}`, blob, url: URL.createObjectURL(blob), text });
        }
        if (doc.numPages > 20) problems.push(`${file.name}: only the first 20 pages were added.`);
      } else if (/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
        entry.pages.push({ id: ++pageId, name: file.name, blob: file, url: URL.createObjectURL(file), text: '' });
      } else {
        problems.push(`${file.name}: use a photo (JPG/PNG) or PDF. On iPhone, set Camera → Formats → Most Compatible.`);
        continue;
      }
      out.push(entry);
    } catch (e) {
      problems.push(`${file.name}: ${e.message || e}`);
    }
  }
  return { files: out, problems };
}

// ── Settings ─────────────────────────────────────────────────
export const settings = {
  get key() { return String(local.get('scanKey') || '').trim(); },
  set key(v) { local.set('scanKey', String(v || '').trim()); },
  get model() { return String(local.get('scanModel') || '').trim() || DEFAULT_MODEL; },
  set model(v) { local.set('scanModel', String(v || '').trim()); },
};

// ── Reading ──────────────────────────────────────────────────
async function ocrText(files, progress, signal) {
  const pages = files.flatMap((f) => f.pages);
  const texts = [];
  let worker = null;
  try {
    for (let i = 0; i < pages.length; i++) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const p = pages[i];
      if (p.text && p.text.length > 120) { texts.push(p.text); continue; } // digital PDF: its own text
      if (!worker) {
        progress('Downloading the free reader (first time only, about 10 MB)…');
        await loadScript(LIBS.tesseract);
        worker = await globalThis.Tesseract.createWorker('eng', 1, {
          logger: (m) => { if (m.status === 'recognizing text') progress(`Reading page ${i + 1} of ${pages.length} on this phone… ${Math.round(m.progress * 100)}%`); },
        });
        await worker.setParameters({ preserve_interword_spaces: '1' });
      }
      progress(`Reading page ${i + 1} of ${pages.length} on this phone…`);
      const { data } = await worker.recognize(await shrinkImage(p.blob, 2600));
      texts.push(data.text || '');
    }
  } finally {
    if (worker) worker.terminate();
  }
  return texts.join('\n');
}

const b64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function readWithClaude(files, progress, signal) {
  const content = [];
  for (const f of files) {
    if (f.kind === 'pdf') {
      content.push({ type: 'document', title: f.file.name, source: { type: 'base64', media_type: 'application/pdf', data: await b64(f.file) } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await b64(await shrinkImage(f.file)) } });
    }
  }
  content.push({ type: 'text', text: claudePrompt(files.map((f) => f.file.name)) });
  progress(`Claude is reading ${files.length} file(s)… usually 20–90 seconds.`);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: {
        'content-type': 'application/json', 'x-api-key': settings.key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: settings.model, max_tokens: 16000, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error("Couldn't reach the Anthropic API. Check your internet connection, and turn off any ad blocker or VPN.");
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || JSON.stringify(j); } catch { detail = res.statusText; }
    const why = res.status === 401 ? 'The API key was rejected. Check it in Reading settings.'
      : /credit balance/i.test(detail) ? 'Your Anthropic account has no credit. Add credit under Billing at console.anthropic.com.'
        : res.status === 429 ? 'Too many requests right now. Wait a minute and try again.'
          : res.status === 529 ? 'Claude is busy right now. Wait a minute and try again.'
            : res.status === 404 ? `Model not found: ${settings.model}. Change it in Reading settings.`
              : res.status === 413 ? 'The files are too large for one request. Scan fewer pages at once.'
                : "Claude couldn't read the documents.";
    throw new Error(`${why} (HTTP ${res.status}: ${detail})`);
  }
  const out = await res.json();
  const reply = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const data = extractJson(reply);
  if (!data || typeof data !== 'object') throw new Error("Claude's answer wasn't in the expected shape. Try again.");
  return data;
}

/** Read prepared files and return SAD form data ({engine, general, items, invoice, notes, checks}). */
export async function readDocuments(files, { progress = () => {}, signal } = {}) {
  if (settings.key) return toForm(await readWithClaude(files, progress, signal), 'claude');
  const text = await ocrText(files, progress, signal);
  if (!/[a-z]{3}/i.test(text)) throw new Error('No text could be read from these pages. Try a sharper, straighter photo in good light, or add an API key in Reading settings.');
  return toForm(parseInvoiceText(text), 'text');
}
