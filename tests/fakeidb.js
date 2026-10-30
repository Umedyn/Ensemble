// A small IndexedDB for the Node VM tests: one database, one object store,
// and only the calls js/adapters.js makes. It keeps its data between opens,
// so a test can stand for a second visit by handing it to a new engine.
function fakeIndexedDB() {
  const data = new Map();
  const db = {
    createObjectStore() {},
    transaction() {
      const t = {};
      let pending = 0;
      const request = (fn) => {
        const req = {};
        pending++;
        setTimeout(() => {
          req.result = fn();
          pending--;
          if (req.onsuccess) req.onsuccess();
          if (!pending) setTimeout(() => t.oncomplete && t.oncomplete());
        });
        return req;
      };
      t.objectStore = () => ({
        get: (k) => request(() => data.get(k)),
        put: (v, k) => request(() => { data.set(k, v); return k; }),
        delete: (k) => request(() => { data.delete(k); }),
        getAllKeys: () => request(() => Array.from(data.keys())),
      });
      return t;
    },
  };
  return {
    data,
    open() {
      const req = { result: db };
      setTimeout(() => { if (req.onupgradeneeded) req.onupgradeneeded(); req.onsuccess(); });
      return req;
    },
  };
}

// A localStorage over a plain object, with the calls the app makes.
function fakeLocalStorage(items = {}) {
  return {
    items,
    getItem: (k) => (k in items ? items[k] : null),
    setItem: (k, v) => { items[k] = String(v); },
    removeItem: (k) => { delete items[k]; },
    key: (i) => Object.keys(items)[i] ?? null,
    get length() { return Object.keys(items).length; },
  };
}

module.exports = { fakeIndexedDB, fakeLocalStorage };
