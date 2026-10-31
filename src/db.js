// Extension-origin IndexedDB (not LinkedIn's origin). Every write resolves only after the transaction commits.

const NAME = 'saved-shelf', VERSION = 1;
let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('transaction aborted'));
});
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function all() {
  const db = await open();
  return wrap(db.transaction('items').objectStore('items').getAll());
}

export async function get(key) {
  const db = await open();
  return wrap(db.transaction('items').objectStore('items').get(key));
}

// fn(storeGet) -> { put: [...], del: [...] } computed inside one readwrite transaction.
export async function update(keys, fn) {
  const db = await open();
  const tx = db.transaction('items', 'readwrite');
  const st = tx.objectStore('items');
  const current = new Map();
  await Promise.all(keys.map(async (k) => current.set(k, await wrap(st.get(k)))));
  const { put = [], del = [] } = await fn(current, st);
  for (const k of del) st.delete(k);
  for (const it of put) st.put(it);
  await done(tx);
  return { put: put.length, del: del.length };
}

export async function putMany(items) {
  const db = await open();
  const tx = db.transaction('items', 'readwrite');
  for (const it of items) tx.objectStore('items').put(it);
  await done(tx);
}

export async function remove(keys) {
  const db = await open();
  const tx = db.transaction('items', 'readwrite');
  for (const k of keys) tx.objectStore('items').delete(k);
  await done(tx);
}

export async function clear() {
  const db = await open();
  const tx = db.transaction(['items', 'meta'], 'readwrite');
  tx.objectStore('items').clear();
  tx.objectStore('meta').clear();
  await done(tx);
}

export async function getMeta(k) {
  const db = await open();
  return wrap(db.transaction('meta').objectStore('meta').get(k));
}

export async function setMeta(k, v) {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(v, k);
  await done(tx);
}
