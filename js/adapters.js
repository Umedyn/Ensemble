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
    // Reads a key again, when another page may have changed it (Settings).
    async reload(k) {
      const v = await E.Store.get(k);
      if (v === null) prefs.delete(k); else prefs.set(k, v);
      return v;
    },
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
  const SAVES_FORMAT = 'ensemble-saves';
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
      await E.Store.remove('savenotes.' + id);
      return (await E.Store.remove('save.' + id)) && meta;
    },
    // What New game noted for Debug (task A-6: unknown world fields, lore
    // packs, a made character), kept beside the save it started.
    async notes(id) {
      try { return JSON.parse(await E.Store.get('savenotes.' + id)) || []; } catch (e) { return []; }
    },
    setNotes: (id, notes) => E.Store.set('savenotes.' + id, JSON.stringify(notes || [])),
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

    // Every save as one file (Settings › Storage, task A-4): the games as
    // they are kept, newest first. Settings and API keys are never in it.
    async exportAll() {
      const saves = [];
      for (const meta of await E.Saves.list()) {
        const game = await E.Saves.load(meta.id);
        if (game) saves.push({ meta, game });
      }
      return { format: SAVES_FORMAT, version: 1, exported: new Date().toISOString(), saves };
    },
    // → { added, updated, kept, refused }. A save already here keeps
    // whichever copy was played last; anything that isn't a game is refused.
    async importAll(file) {
      if (!file || file.format !== SAVES_FORMAT || !Array.isArray(file.saves)) throw new Error('That file is not an Ensemble saves file.');
      const out = { added: 0, updated: 0, kept: 0, refused: 0 };
      const have = new Map((await E.Saves.list()).map((m) => [m.id, m]));
      for (const s of file.saves) {
        const id = s && s.meta && typeof s.meta.id === 'string' && /^[\w-]{1,64}$/.test(s.meta.id) ? s.meta.id : null;
        const g = s && s.game;
        if (!id || !g || !g.scenario || !g.characters || !g.player) { out.refused++; continue; }
        const mine = have.get(id);
        if (mine && mine.date >= (s.meta.date || 0)) { out.kept++; continue; }
        const meta = Object.assign(E.Saves.meta(id, g), { date: s.meta.date || Date.now() });
        const ok = (await E.Store.set('save.' + id, JSON.stringify(g))) && (await E.Store.set('savemeta.' + id, JSON.stringify(meta)));
        if (!ok) { out.refused++; continue; }
        out[mine ? 'updated' : 'added']++;
      }
      return out;
    },
    // Removes every save, and gives how many went.
    async clearAll() {
      const ids = new Set((await E.Store.list('savemeta.')).map((k) => k.slice(9)).concat((await E.Store.list('save.')).map((k) => k.slice(5))));
      for (const id of ids) await E.Saves.remove(id);
      return ids.size;
    },
  };

  // ---------- test play (task A-6) ----------
  // The creator's Test play: one world and one game at a time, kept apart from
  // the player's saves and library (never listed, never in an export), so the
  // move from New game to the game, and a refresh, keep them. A new test
  // replaces the last one.
  const TEST_WORLD = 'testplay.world', TEST_SAVE = 'testplay.save', TEST_BLOB = 'testplayblob.';
  E.TestPlay = {
    async putWorld(folder, files, assets) {
      for (const k of await E.Store.list(TEST_BLOB)) await E.Store.remove(k);
      await E.Store.remove(TEST_SAVE);
      await E.Store.remove(TEST_SAVE + '.notes');
      const paths = Object.keys(assets || {});
      for (const p of paths) await E.Store.set(TEST_BLOB + p, assets[p]);
      return E.Store.set(TEST_WORLD, JSON.stringify({ folder, files, paths }));
    },
    // → { folder, files, assets } or null
    async world() {
      let w = null;
      try { w = JSON.parse(await E.Store.get(TEST_WORLD)); } catch (e) { /* none */ }
      if (!w) return null;
      const assets = {};
      for (const p of w.paths || []) { const b = await E.Store.get(TEST_BLOB + p); if (b != null) assets[p] = b; }
      return { folder: w.folder, files: w.files, assets };
    },
    save: (state) => E.Store.set(TEST_SAVE, JSON.stringify(state)),
    setNotes: (notes) => E.Store.set(TEST_SAVE + '.notes', JSON.stringify(notes || [])),
    // → { state, notes } or null
    async load() {
      let state = null, notes = [];
      try { state = JSON.parse(await E.Store.get(TEST_SAVE)); } catch (e) { /* none */ }
      try { notes = JSON.parse(await E.Store.get(TEST_SAVE + '.notes')) || []; } catch (e) { /* none */ }
      return state ? { state, notes } : null;
    },
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
  // gives a world's files as they are, for the creator. Worlds and packs
  // opened from a folder or zip are kept (task A-5, the "stored" source);
  // remote lists (A-8) join with addSource.
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
  // ---------- stored bundles (task A-5) ----------
  // A world or lore pack opened from a folder or zip, kept in E.Store so it is
  // on every page and there after a reload:
  //   bundlemeta.<name>  what a list or a card shows, no files
  //   bundle.<name>      { folder, files: {path: JSON}, assets: [paths], hash }
  //   bundleblob.<name>/<path>  each image, a Blob
  //   packbundle.<name>  { folder, files, hash }
  // One copy per name: the same content again writes nothing, changed content
  // replaces it (and its images that went). Meta is written last and removed
  // first, so a half-written bundle is never listed.
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
  const asBlob = (data, path) => {
    if (!root.Blob || data instanceof root.Blob) return data;
    return new root.Blob([data], { type: MIME[String(path).split('.').pop().toLowerCase()] || 'application/octet-stream' });
  };
  const bytesOf = async (data) => (data && typeof data.arrayBuffer === 'function' ? new Uint8Array(await data.arrayBuffer()) : data);
  // Two FNV-1a runs from different seeds: 64 bits, enough to tell copies apart.
  function hasher() {
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    const byte = (x) => { a = Math.imul(a ^ x, 0x01000193) >>> 0; b = Math.imul(b ^ x, 0x01000193) >>> 0; };
    return {
      text(str) { for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); byte(c & 0xff); byte(c >> 8); } byte(0); },
      bytes(arr) { for (let i = 0; i < arr.length; i++) byte(arr[i]); byte(0); },
      hex: () => a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'),
    };
  }
  // files {path: JSON} and assets {path: Blob | bytes} → { hash, size }
  E.bundleHash = async function (files, assets) {
    const h = hasher();
    let size = 0;
    Object.keys(files || {}).sort().forEach((k) => { const t = JSON.stringify(files[k]); h.text(k); h.text(t); size += t.length; });
    for (const k of Object.keys(assets || {}).sort()) {
      const bytes = await bytesOf(assets[k]);
      h.text(k);
      h.bytes(bytes || []);
      size += bytes ? bytes.length : 0;
    }
    return { hash: h.hex(), size };
  };
  const readJSON = async (k) => { try { return JSON.parse(await E.Store.get(k)); } catch (e) { return null; } };

  function storedSource() {
    const worldNames = async () => (await E.Store.list('bundlemeta.')).map((k) => k.slice('bundlemeta.'.length));
    async function blobs(name) {
      const prefix = `bundleblob.${name}/`;
      const out = {};
      for (const k of await E.Store.list(prefix)) out[k.slice(prefix.length)] = await E.Store.get(k);
      return out;
    }
    return {
      id: 'stored',
      async list(kind) {
        if (kind === 'world') {
          const metas = await Promise.all((await worldNames()).map((n) => readJSON('bundlemeta.' + n)));
          return metas.filter(Boolean).sort((x, y) => x.added - y.added)
            .map((m) => Object.assign(entry('world', 'stored', m.folder, m.title), { meta: m }));
        }
        if (kind !== 'pack') return [];
        const packs = await Promise.all((await E.Store.list('packbundle.')).map(readJSON));
        return packs.filter(Boolean).map((p) => entry('pack', 'stored', p.folder, p.title));
      },
      async load(id, opts) {
        const name = nameOf(id);
        if (id.startsWith('pack:')) {
          const p = await readJSON('packbundle.' + name);
          return p && E.Packs.read(p.folder, p.files);
        }
        const b = await readJSON('bundle.' + name);
        if (!b) return null;
        if (opts && opts.raw) return b.files;
        return Object.assign(E.Scenario.prepareWorld(b.folder, b.files), { assets: await blobs(name) });
      },
      // raw: { folder, files, assets? }. → { id, status: 'added' | 'same' | 'updated', world? }
      async keep(kind, raw) {
        const name = String(raw.folder || '').trim();
        if (!name || name.includes('/')) throw new Error('A world or pack needs a folder name.');
        const { hash, size } = await E.bundleHash(raw.files, raw.assets);
        if (kind === 'pack') {
          const pack = E.Packs.read(name, raw.files);
          const old = await readJSON('packbundle.' + name);
          if (old && old.hash === hash) return { id: entry('pack', 'stored', name).id, status: 'same', pack };
          if (!(await E.Store.set('packbundle.' + name, JSON.stringify({ folder: name, title: pack.title, files: raw.files, hash })))) throw new Error('This browser didn\'t keep the pack (is it out of space?).');
          return { id: entry('pack', 'stored', name).id, status: old ? 'updated' : 'added', pack };
        }
        const world = E.Scenario.prepareWorld(name, raw.files);
        const id = entry('world', 'stored', name).id;
        const old = await readJSON('bundlemeta.' + name);
        if (old && old.hash === hash) return { id, status: 'same', world };
        const paths = Object.keys(raw.assets || {});
        const fail = () => { throw new Error(`This browser didn't keep "${world.title}" (is it out of space?).`); };
        for (const p of paths) if (!(await E.Store.set(`bundleblob.${name}/${p}`, asBlob(raw.assets[p], p)))) fail();
        if (!(await E.Store.set('bundle.' + name, JSON.stringify({ folder: name, files: raw.files, assets: paths, hash })))) fail();
        const top = raw.files['world.json'] || raw.files['scenario.json'] || {};
        const meta = {
          folder: name, title: world.title, summary: world.summary, tags: world.tags,
          author: world.author || '', credit: world.credit || '', license: world.license || '', cover: world.cover || '',
          mapImage: (top.map && top.map.image) || '', starts: world.starts.length, generate: world.generate,
          size, hash, added: old ? old.added : Date.now(), updated: Date.now(),
        };
        if (!(await E.Store.set('bundlemeta.' + name, JSON.stringify(meta)))) fail();
        // Pictures the new copy no longer has.
        for (const k of await E.Store.list(`bundleblob.${name}/`)) if (!paths.includes(k.slice(`bundleblob.${name}/`.length))) await E.Store.remove(k);
        return { id, status: old ? 'updated' : 'added', world };
      },
      async remove(id) {
        const name = nameOf(id);
        if (id.startsWith('pack:')) return E.Store.remove('packbundle.' + name);
        await E.Store.remove('bundlemeta.' + name);
        await E.Store.remove('bundle.' + name);
        for (const k of await E.Store.list(`bundleblob.${name}/`)) await E.Store.remove(k);
        return true;
      },
    };
  }

  // What this page opened that isn't kept: a site map library from a folder.
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
  const stored = storedSource();
  let sources = [bundledSource(), stored, opened];
  E.Library = {
    // Replaces every source with this one.
    use(source) { sources = [source]; },
    addSource(source) { sources.push(source); },
    // A source that can't list (no scenarios/index.json) lists nothing, and
    // says why in failed[source id], so the others still show.
    failed: {},
    async list(kind) {
      const lists = await Promise.all(sources.map((s) => Promise.resolve().then(() => s.list(kind)).then(
        (l) => { delete E.Library.failed[s.id]; return l; },
        (e) => { E.Library.failed[s.id] = e.message; return []; })));
      return [].concat(...lists);
    },
    async load(id, opts) {
      const sid = String(id).replace(/^(pack|library|table):/, '').split(':')[0];
      const source = sources.find((s) => s.id === sid);
      if (!source) throw new Error(`Nothing in the library called "${id}".`);
      return source.load(id, opts);
    },
    // Something picked with Open folder that only this page keeps. → its id
    open: (kind, name, title, value) => opened.add(kind, name, title, value),
    // A world or lore pack from a folder or zip, kept for every page (task
    // A-5): raw { folder, files, assets? }. → { id, status, world | pack }
    keep: (kind, raw) => stored.keep(kind, raw),
    // Only what was kept can be removed; saves of a removed world still play.
    remove: (id) => stored.remove(id),
    // Stored on this machine (removable), as opposed to bundled or remote.
    isStored: (id) => /^(pack:)?stored:/.test(String(id)),
  };
})(typeof window !== 'undefined' ? window : globalThis);
