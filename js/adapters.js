// Adapters (task A-1): seams a different build could fill. E.Store is where
// everything the app keeps lives. No DOM access here.
(function (root) {
  const E = root.Ensemble;
  const DB_NAME = 'ensemble', KV = 'kv';
  const OPEN_TIMEOUT = 4000;
  const SETTINGS_KEY = 'ensemble.settings', APPEARANCE_KEY = 'ensemble.appearance', AUTOSAVE_KEY = 'ensemble.autosave';

  // localStorage can throw or be missing.
  const local = {
    get(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { root.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    remove(k) { try { root.localStorage.removeItem(k); } catch (e) {} },
    keys() {
      try { return Array.from({ length: root.localStorage.length }, (_, i) => root.localStorage.key(i)).filter(Boolean); }
      catch (e) { return []; }
    },
  };

  // ---------- stores ----------
  // A store is async get/set/remove/list(prefix); values are anything
  // IndexedDB can hold (strings today, Blobs with world bundles, task A-5).
  E.memoryStore = function () {
    const data = new Map();
    return {
      async get(k) { return data.has(k) ? data.get(k) : null; },
      async set(k, v) { data.set(k, v); },
      async remove(k) { data.delete(k); },
      async list(prefix = '') { return Array.from(data.keys()).filter((k) => k.startsWith(prefix)); },
    };
  };

  // Writes start their transaction at once and commit, with no await first,
  // so a write made just before the page closes is already on its way.
  function indexedStore(db) {
    const tx = (mode, fn) => new Promise((resolve, reject) => {
      const t = db.transaction(KV, mode);
      const req = fn(t.objectStore(KV));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      if (mode === 'readwrite' && t.commit) t.commit();
    });
    return {
      async get(k) { const v = await tx('readonly', (s) => s.get(k)); return v === undefined ? null : v; },
      set(k, v) { return tx('readwrite', (s) => s.put(v, k)); },
      remove(k) { return tx('readwrite', (s) => s.delete(k)); },
      async list(prefix = '') { return (await tx('readonly', (s) => s.getAllKeys())).filter((k) => String(k).startsWith(prefix)); },
    };
  }

  // → an open store, or rejects (no IndexedDB, blocked, or it never answers).
  function openIndexed() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB did not answer')), OPEN_TIMEOUT);
      const fail = (err) => { clearTimeout(timer); reject(err); };
      try {
        const req = root.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(KV);
        req.onsuccess = () => { clearTimeout(timer); resolve(indexedStore(req.result)); };
        req.onerror = () => fail(req.error);
      } catch (e) { fail(e); }
    });
  }

  // ---------- migration from localStorage ----------
  // Copy each key, read it back, and only then remove the old one, so a move
  // that fails halfway loses nothing and the next run picks it up. What the
  // store already has is newer and stays. With a store that isn't kept
  // (memory) the old keys stay too.
  async function migrate(store, kept) {
    const settings = local.get(SETTINGS_KEY);
    if (settings !== null && local.get(APPEARANCE_KEY) === null) {
      try { local.set(APPEARANCE_KEY, JSON.stringify(JSON.parse(settings).appearance || {})); } catch (e) { /* a broken copy of the settings */ }
    }
    for (const k of local.keys()) {
      if (!k.startsWith('ensemble.') || k === APPEARANCE_KEY) continue;
      try {
        const moved = k === AUTOSAVE_KEY ? await moveAutosave(store) : await moveKey(store, k);
        if (moved && kept) local.remove(k);
      } catch (e) { /* left in localStorage for the next run */ }
    }
  }
  async function moveKey(store, k) {
    if ((await store.get(k)) === null) await store.set(k, local.get(k));
    return (await store.get(k)) !== null;
  }
  // The old single autosave becomes the first save in the list.
  async function moveAutosave(store) {
    const key = 'save.autosave', text = local.get(AUTOSAVE_KEY);
    if ((await store.get(key)) === null) {
      await store.set(key, text);
      await store.set('savemeta.autosave', JSON.stringify(E.Saves.meta('autosave', JSON.parse(text))));
    }
    return (await store.get(key)) !== null && (await store.get('savemeta.autosave')) !== null;
  }

  // ---------- E.Store ----------
  // Pages await E.Store.ready() once at boot. A swapped-in store goes in with
  // use() before that. Reads never throw and give null for a missing key;
  // writes give true or false, and a failed one calls onFail.
  let impl = null, custom = null, starting = null;
  E.Store = {
    kept: true, // false: nothing lasts past this page (a private window)
    onFail: null,
    use(store) { custom = store; impl = null; starting = null; prefs.clear(); prefsReady = false; E.Store.kept = true; },
    ready() {
      if (!starting) starting = start();
      return starting;
    },
    async get(k) {
      try { const v = await (impl || (await ready())).get(k); return v === undefined ? null : v; }
      catch (e) { return null; }
    },
    async set(k, v) {
      try { await (impl || (await ready())).set(k, v); return true; }
      catch (e) { if (E.Store.onFail) E.Store.onFail(e); return false; }
    },
    async remove(k) {
      try { await (impl || (await ready())).remove(k); return true; }
      catch (e) { if (E.Store.onFail) E.Store.onFail(e); return false; }
    },
    async list(prefix) {
      try { return await (impl || (await ready())).list(prefix || ''); }
      catch (e) { return []; }
    },
  };
  const ready = async () => { await E.Store.ready(); return impl; };

  async function start() {
    let store = custom;
    if (!store) {
      try { store = await openIndexed(); }
      catch (e) { store = E.memoryStore(); E.Store.kept = false; }
    }
    await migrate(store, E.Store.kept);
    const keys = await store.list('ensemble.');
    const values = await Promise.all(keys.map((k) => store.get(k)));
    keys.forEach((k, i) => prefs.set(k, values[i]));
    prefsReady = true;
    impl = store;
  }

  // ---------- E.Prefs ----------
  // The small things the pages read on the spot: every "ensemble." key, read
  // into memory at ready() and written through to the store. Saves are not
  // here, so a big game isn't loaded just to open a page.
  const prefs = new Map();
  let prefsReady = false;
  E.Prefs = {
    ready: () => prefsReady,
    get(k) { return prefs.has(k) ? prefs.get(k) : null; },
    set(k, v) { prefs.set(k, v); return E.Store.set(k, v); },
    remove(k) { prefs.delete(k); return E.Store.remove(k); },
    keys: () => Array.from(prefs.keys()),
  };

  // ---------- settings ----------
  // E.settings stays a plain object; only its loading and saving come here.
  E.readSettings = () => (prefsReady ? E.Prefs.get(SETTINGS_KEY) : local.get(SETTINGS_KEY));
  // The theme script runs before first paint and IndexedDB can't answer in
  // time, so a small copy of the appearance stays in localStorage for it.
  E.writeSettings = function (settings) {
    local.set(APPEARANCE_KEY, JSON.stringify(settings.appearance));
    return E.Prefs.set(SETTINGS_KEY, JSON.stringify(settings));
  };

  // ---------- saves ----------
  // One autosaved game per id: save.<id> holds the game as JSON and
  // savemeta.<id> what a list shows, so listing never reads a whole game.
  // Each save has its own keys, so two tabs can't drop each other's from the
  // list. API keys live in settings, never in `state`.
  E.Saves = {
    newId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    meta(id, state) {
      const sc = state.scenario || {};
      const me = (state.characters || {})[state.player] || {};
      return {
        id, world: sc.worldId || sc.id || null, worldTitle: sc.worldTitle || sc.title || null,
        start: sc.startId || null, startTitle: sc.startTitle || null,
        player: me.name || null, turn: state.turn || 0, date: Date.now(),
      };
    },
    async save(id, state) {
      const body = E.Store.set('save.' + id, JSON.stringify(state));
      const meta = E.Store.set('savemeta.' + id, JSON.stringify(E.Saves.meta(id, state)));
      return (await body) && (await meta);
    },
    // A game as saved, or null; Engine.migrate is the caller's next step.
    async load(id) {
      const text = await E.Store.get('save.' + id);
      if (text === null) return null;
      try { return JSON.parse(text); } catch (e) { return null; }
    },
    async remove(id) {
      const meta = await E.Store.remove('savemeta.' + id);
      return (await E.Store.remove('save.' + id)) && meta;
    },
    // Newest first.
    async list() {
      const keys = await E.Store.list('savemeta.');
      const out = [];
      for (const k of keys) {
        try { out.push(JSON.parse(await E.Store.get(k))); } catch (e) { /* a broken entry isn't listed */ }
      }
      return out.filter(Boolean).sort((a, b) => b.date - a.date);
    },
    last: async () => (await E.Saves.list())[0] || null,
  };
})(typeof window !== 'undefined' ? window : globalThis);
