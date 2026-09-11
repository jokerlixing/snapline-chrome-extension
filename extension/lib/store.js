const DATABASE_NAME = 'snapline-local';
const DATABASE_VERSION = 1;
const STORE_NAME = 'items';
let databasePromise;

function database() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('kind', 'kind', { unique: false });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); databasePromise = undefined; };
        resolve(db);
      };
      request.onerror = () => { databasePromise = undefined; reject(request.error); };
      request.onblocked = () => { databasePromise = undefined; reject(new Error('本地记录正在升级，请关闭其他 Snapline 页面后重试。')); };
    });
  }
  return databasePromise;
}

async function transaction(mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('本地记录读写失败。'));
    tx.onabort = () => reject(tx.error || new Error('本地记录读写已中止。'));
    try {
      operation(tx.objectStore(STORE_NAME), value => { result = value; });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

export function putItem(record) {
  if (!record || typeof record.id !== 'string' || !record.id || typeof record.kind !== 'string') {
    return Promise.reject(new Error('记录缺少有效的 id 或 kind。'));
  }
  const item = { ...record, createdAt: record.createdAt ?? Date.now() };
  return transaction('readwrite', (store, done) => {
    store.put(item);
    done(item);
  });
}

export function getItem(id) {
  return transaction('readonly', (store, done) => {
    const request = store.get(id);
    request.onsuccess = () => done(request.result);
  });
}

export function deleteItem(id) {
  return transaction('readwrite', store => { store.delete(id); });
}

export function listItems(kind) {
  return transaction('readonly', (store, done) => {
    const request = kind ? store.index('kind').getAll(kind) : store.getAll();
    request.onsuccess = () => done(request.result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  });
}

export function pruneCaptures(limit = 12) {
  const keep = Number.isInteger(limit) && limit >= 0 ? limit : 12;
  // Read and prune in one transaction so a new capture cannot race with cleanup.
  return transaction('readwrite', (store, done) => {
    const request = store.index('kind').getAll('capture');
    request.onsuccess = () => {
      const records = request.result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const removed = records.slice(keep);
      for (const record of removed) store.delete(record.id);
      done(removed.length);
    };
  });
}
