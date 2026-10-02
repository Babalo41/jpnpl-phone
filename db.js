// What the phone keeps: a key/value store (pairing, the PC snapshot, synced bills)
// and the outbox of bills waiting to reach the PC. IndexedDB, so it survives the app
// being closed, the phone restarting and the PC's link changing.

const NAME = 'jpnpl-phone';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', {keyPath: 'uuid'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kv = {
  get: (key) => run('kv', 'readonly', (s) => s.get(key)),
  set: (key, value) => run('kv', 'readwrite', (s) => s.put(value, key)),
  del: (key) => run('kv', 'readwrite', (s) => s.delete(key)),
};

export const outbox = {
  all: async () => ((await run('outbox', 'readonly', (s) => s.getAll())) || [])
    .sort((a, b) => (a.created || '').localeCompare(b.created || '')),
  put: (bill) => run('outbox', 'readwrite', (s) => s.put(bill)),
  del: (uuid) => run('outbox', 'readwrite', (s) => s.delete(uuid)),
};

// Ask the browser not to clear our data when the phone is short of space.
export async function keepData() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ok */ }
}
