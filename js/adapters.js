// Adapters (tasks A-1, A-2): seams a different build could fill. E.Store is
// where everything the app keeps lives, E.Backend how a model request is sent,
// E.Voice who reads the story aloud, E.Library where worlds come from. No DOM
// access here.
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

  // ---------- E.Backend ----------
  // How a request reaches a model server: fetch(b, url, init) → a Response,
  // with b from LLM.backend. Everything above it (streaming, the soft stop,
  // grammar, JSON mode, usage) is in llm.js and doesn't change with it.
  const directBackend = {
    fetch(b, url, init = {}) {
      const headers = Object.assign({}, init.headers);
      if (b && b.key) headers.Authorization = 'Bearer ' + b.key;
      return fetch(url, Object.assign({}, init, { headers }));
    },
  };
  // A proxy that adds its own auth: the player's key never goes to it.
  E.proxyBackend = (proxyUrl) => ({
    fetch(b, url, init = {}) {
      const headers = Object.assign({}, init.headers, { 'X-Ensemble-Target': url });
      return fetch(proxyUrl, Object.assign({}, init, { headers }));
    },
  });
  let backend = directBackend;
  E.Backend = {
    use(impl) { backend = impl || directBackend; },
    fetch: async (b, url, init) => backend.fetch(b, url, init),
  };

  // ---------- E.Voice ----------
  // An empty seam: the Voiced narration block lands behind it. Off speaks
  // nothing, and nothing in the game calls it yet.
  const voiceOff = { available: false, async speak() {}, stop() {} };
  let voice = voiceOff;
  E.Voice = {
    use(impl) { voice = impl || voiceOff; },
    get available() { return !!voice.available; },
    speak: (text, opts) => voice.speak(text, opts),
    stop: () => voice.stop(),
  };

  // ---------- E.Library ----------
  // One list and one load over everything the game can pick from. A source is
  // { id, list(kind) → entries, load(id, opts) }; an entry is
  // { id, kind, source, title, folder }. Kinds: 'world', 'pack', 'library'
  // (the shared site and base maps, whole), and 'table' once T-1 has any.
  // A world's id is "<source>:<name>", as the picker remembers it; the others
  // start with their kind ("pack:server:<folder>"). load(id, { raw: true })
  // gives a world's files as they are, for the creator. Sources for stored
  // bundles (A-5) and remote lists (A-8) join with addSource.
  const fromDisk = () => { try { return location.protocol === 'file:'; } catch (e) { return false; } };
  const entry = (kind, source, name, title) => ({
    id: (kind === 'world' ? '' : kind + ':') + source + ':' + name, kind, source, title: title || name, folder: name,
  });
  const nameOf = (id) => id.replace(/^(pack|library|table):/, '').replace(/^[^:]*:/, '');

  // scenarios/, library/ and packs/ from the server; nothing from disk.
  function bundledSource() {
    let packs = new Map();
    return {
      id: 'server',
      async list(kind) {
        if (fromDisk()) return [];
        if (kind === 'world') return (await E.Scenario.listServer()).map((w) => entry('world', 'server', w.folder, w.title));
        if (kind === 'library') return [entry('library', 'server', 'shared', 'Shared maps')];
        if (kind !== 'pack') return [];
        const found = await E.Packs.listServer();
        packs = new Map(found.map((p) => [p.folder, p]));
        return found.map((p) => entry('pack', 'server', p.folder, p.title));
      },
      async load(id, opts) {
        const name = nameOf(id);
        if (id.startsWith('library:')) return E.Scenario.loadLibraryServer();
        if (id.startsWith('pack:')) return packs.get(name) || null;
        return opts && opts.raw ? E.Scenario.fetchWorldFiles(name) : E.Scenario.loadWorldServer(name);
      },
    };
  }
  // What this page opened from a folder; gone when the page is (A-5 keeps it).
  function openedSource() {
    const items = new Map();
    return {
      id: 'disk',
      async list(kind) { return Array.from(items.values()).filter((x) => x.entry.kind === kind).map((x) => x.entry); },
      async load(id, opts) {
        const item = items.get(id);
        if (!item) return null;
        return opts && opts.raw ? item.value.files : item.value;
      },
      add(kind, name, title, value) {
        const e = entry(kind, 'disk', name, title);
        items.set(e.id, { entry: e, value });
        return e.id;
      },
    };
  }

  const opened = openedSource();
  let sources = [bundledSource(), opened];
  E.Library = {
    // Replaces every source with this one.
    use(source) { sources = [source]; },
    addSource(source) { sources.push(source); },
    async list(kind) {
      const lists = await Promise.all(sources.map((s) => s.list(kind)));
      return [].concat(...lists);
    },
    async load(id, opts) {
      const sid = String(id).replace(/^(pack|library|table):/, '').split(':')[0];
      const source = sources.find((s) => s.id === sid);
      if (!source) throw new Error(`Nothing in the library called "${id}".`);
      return source.load(id, opts);
    },
    // Something picked with Open folder. → its id
    open: (kind, name, title, value) => opened.add(kind, name, title, value),
  };
})(typeof window !== 'undefined' ? window : globalThis);
