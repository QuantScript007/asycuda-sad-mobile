// On-device storage: generated files in IndexedDB (they can be ~2 MB each,
// too big for localStorage), small things (form draft, theme) in localStorage.

const DB = 'sad-mobile', STORE = 'history', VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const history = {
  async add(entry) { return tx('readwrite', (s) => s.put(entry)); },
  async remove(id) { return tx('readwrite', (s) => s.delete(id)); },
  async get(id) { return tx('readonly', (s) => s.get(id)); },
  async list() {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.created - a.created);
  },
  async trim(keep = 30) {
    const all = await this.list();
    for (const e of all.slice(keep)) await this.remove(e.id);
  },
};

export const local = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / full */ }
  },
};
