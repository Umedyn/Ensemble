// World loading (spec: docs/WORLDS.md). A world is a folder:
//   scenarios/<folder>/world.json
//   scenarios/<folder>/starts/<id>.json       (one per id in world.starts)
//   scenarios/<folder>/characters/<id>.json   (the character pool, world.characters)
// A legacy folder has scenario.json instead and becomes one world with one
// start, "default" (S.fromLegacy). S.compose turns a world plus a start into
// the flat scenario object Engine.newGame takes.
// Loaded either from a local server (scenarios/index.json lists folders) or
// from a folder picked on disk (works when index.html is opened directly).
(function (root) {
  const E = root.Ensemble;
  const S = (E.Scenario = {});

  // ---------- field lists ----------
  // Start fields that are not world overrides.
  const START_OWN = ['id', 'title', 'summary', 'start', 'player', 'cast', 'opening', 'castLabel'];
  // World fields a start may override (merge rules below).
  const OVERRIDABLE = ['setting', 'rules', 'tags', 'toneNote', 'timeLabel', 'wakeHour', 'skills', 'needs', 'skillPenalties', 'revealPressure', 'tagThresholds', 'factions', 'world',
    'eventRates', 'eventSeeds', 'majorEventDays', 'majorHorizonDays', 'majorSeeds', 'revealSkills', 'facts', 'locations', 'clocks'];
  const WORLD_FIELDS = ['format', 'id', 'title', 'summary', 'characters', 'starts', ...OVERRIDABLE];
  const WORLD_RESERVED = ['regions', 'map', 'lore', 'timeline', 'portraitSet'];
  const START_RESERVED = ['region', 'playerSlot', 'extras', 'standees'];
  const CAST_FIELDS = ['id', 'status', 'needs', 'relations', 'knows', 'want', 'secret', 'guard', 'tags'];
  // Merge rules: lists of {id} objects merge by id, lists of strings are
  // unioned, plain objects merge shallowly; anything else is replaced.
  const ID_LISTS = ['locations', 'clocks', 'factions'];
  const STRING_LISTS = ['rules', 'facts', 'tags'];
  const OBJECTS = ['world', 'eventRates', 'eventSeeds'];

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const castId = (entry) => (typeof entry === 'string' ? entry : entry && entry.id);
  // Plain objects merge recursively; arrays and scalars from b replace a's.
  function deepMerge(a, b) {
    const out = E.clone(a);
    Object.entries(b).forEach(([k, v]) => { out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : E.clone(v); });
    return out;
  }
  function mergeById(a, b) {
    const out = (a || []).map((x) => E.clone(x));
    (b || []).forEach((x) => {
      const i = out.findIndex((y) => y.id === x.id);
      if (i >= 0) out[i] = Object.assign(out[i], E.clone(x));
      else out.push(E.clone(x));
    });
    return out;
  }
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  const dupes = (list) => list.filter((x, i) => x != null && list.indexOf(x) !== i);
  const unknownFields = (obj, known, where) =>
    Object.keys(obj || {}).filter((k) => !known.includes(k)).map((k) => `${where}: unknown field "${k}" (ignored)`);

  // ---------- compose ----------
  // world + start → today's flat scenario shape, plus worldId/startId. Not
  // validated here: run S.validate on the result (S.prepareWorld does both).
  // characters is the pool ({id: data}); folder is the world folder.
  S.compose = function (world, start, characters, folder) {
    const sc = E.clone(world);
    delete sc.format;
    delete sc.starts;
    Object.entries(start).forEach(([k, v]) => {
      if (['id', 'title', 'summary', 'cast'].includes(k)) return;
      if (ID_LISTS.includes(k)) sc[k] = mergeById(sc[k], v);
      else if (STRING_LISTS.includes(k)) sc[k] = union(sc[k], v);
      else if (OBJECTS.includes(k)) sc[k] = Object.assign({}, sc[k], E.clone(v));
      else sc[k] = E.clone(v);
    });
    const cast = start.cast || [];
    sc.characters = cast.map(castId);
    sc.characterData = cast.map((entry) => {
      const id = castId(entry);
      const over = typeof entry === 'string' ? {} : Object.assign({}, entry);
      delete over.id;
      const c = deepMerge(characters[id] || { id }, over);
      // The pool knows people who aren't in this start; feelings about them stay out.
      if (c.relations) Object.keys(c.relations).forEach((k) => { if (!sc.characters.includes(k)) delete c.relations[k]; });
      return c;
    });
    sc.worldId = world.id || folder;
    sc.startId = start.id;
    sc.worldTitle = world.title;
    sc.startTitle = start.title || null;
    sc.title = start.title ? `${world.title}: ${start.title}` : world.title;
    if (folder) sc.folder = folder;
    return sc;
  };

  // ---------- legacy ----------
  // A scenario.json (with characterData loaded) → { world, starts, characters }
  // with one start, "default". The start has no title, so the composed title
  // stays the scenario's own.
  S.fromLegacy = function (legacy) {
    const world = {};
    const start = { id: 'default', cast: (legacy.characters || []).slice() };
    Object.entries(legacy).forEach(([k, v]) => {
      if (k === 'characterData' || k === 'folder') return;
      if (k === 'characters') world.characters = v.slice();
      else if (['start', 'player', 'locations', 'clocks', 'opening', 'castLabel'].includes(k)) start[k] = E.clone(v);
      else world[k] = E.clone(v);
    });
    world.starts = ['default'];
    const characters = {};
    (legacy.characters || []).forEach((id, i) => { if (legacy.characterData && legacy.characterData[i]) characters[id] = legacy.characterData[i]; });
    return { world, starts: { default: start }, characters, legacy: true };
  };

  // ---------- validation ----------
  // Catches mistakes that composing would hide. bundle: { world, starts: {id:
  // start}, characters: {id: data}, legacy } with missing files left out.
  // Throws on problems; returns warnings (unknown fields, which are ignored).
  S.validateWorld = function (bundle) {
    const { world, starts = {}, characters = {} } = bundle;
    const problems = [];
    const warnings = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    if (bundle.legacy) {
      const legacyKnown = [...WORLD_FIELDS, ...START_OWN, ...WORLD_RESERVED, ...START_RESERVED];
      warnings.push(...unknownFields(world, legacyKnown, 'scenario.json'));
    } else {
      req(world.format === 2, '"format" must be 2');
      warnings.push(...unknownFields(world, [...WORLD_FIELDS, ...WORLD_RESERVED], 'world.json'));
    }
    req(world.title, 'missing "title"');
    const pool = world.characters || [];
    const startIds = world.starts || [];
    req(Array.isArray(pool) && pool.length, 'missing "characters" list');
    req(Array.isArray(startIds) && startIds.length, 'missing "starts" list');
    dupes(pool).forEach((id) => problems.push(`character "${id}" is listed twice`));
    dupes(startIds).forEach((id) => problems.push(`start "${id}" is listed twice`));
    ['locations', 'clocks', 'factions'].forEach((k) =>
      dupes((world[k] || []).map((x) => x.id)).forEach((id) => problems.push(`world ${k} has "${id}" twice`)));
    pool.forEach((id) => {
      const c = characters[id];
      if (!c) { problems.push(`missing characters/${id}.json`); return; }
      req(c.id === id, `characters/${id}.json has id "${c.id}"`);
      Object.keys(c.relations || {}).forEach((k) => req(pool.includes(k), `character "${id}" has relation to unknown "${k}"`));
    });
    startIds.forEach((sid) => {
      const st = starts[sid];
      if (!st) { problems.push(`missing starts/${sid}.json`); return; }
      const where = bundle.legacy ? 'scenario.json' : `starts/${sid}.json`;
      req(st.id === sid, `${where} has id "${st.id}"`);
      if (!bundle.legacy) warnings.push(...unknownFields(st, [...START_OWN, ...OVERRIDABLE, ...START_RESERVED], where));
      const cast = (st.cast || []).map(castId);
      req(cast.length, `${where}: missing "cast"`);
      dupes(cast).forEach((id) => problems.push(`${where}: "${id}" is in the cast twice`));
      cast.forEach((id) => req(pool.includes(id), `${where}: cast member "${id}" is not in the world's characters`));
      req(cast.includes(st.player), `${where}: "player" must be in the cast`);
      ['locations', 'clocks', 'factions'].forEach((k) =>
        dupes((st[k] || []).map((x) => x.id)).forEach((id) => problems.push(`${where}: ${k} has "${id}" twice`)));
      (st.cast || []).forEach((entry) => {
        if (typeof entry !== 'string') warnings.push(...unknownFields(entry, CAST_FIELDS, `${where} cast "${entry.id}"`));
      });
    });
    if (problems.length) throw new Error(`World "${world.title || bundle.folder}" has problems:\n- ` + problems.join('\n- '));
    return warnings;
  };

  // ---------- loading ----------
  // Which files a world (or legacy scenario) needs besides its root file.
  S.neededFiles = function (rootJson, legacy) {
    const chars = (rootJson.characters || []).map((id) => `characters/${id}.json`);
    return legacy ? chars : [...(rootJson.starts || []).map((id) => `starts/${id}.json`), ...chars];
  };

  // folder + {relative path: parsed JSON} → a loaded world: { folder, id,
  // title, summary, tags, legacy, defaultStart, warnings, starts: [{ id,
  // title, summary, scenario | error }] }. Every start is composed and
  // validated now, so a broken one shows its error before "New game".
  S.prepareWorld = function (folder, files) {
    let bundle;
    if (files['world.json']) {
      const world = files['world.json'];
      const starts = {};
      const characters = {};
      (world.starts || []).forEach((id) => { if (files[`starts/${id}.json`]) starts[id] = files[`starts/${id}.json`]; });
      (world.characters || []).forEach((id) => { if (files[`characters/${id}.json`]) characters[id] = files[`characters/${id}.json`]; });
      bundle = { world, starts, characters, legacy: false };
    } else if (files['scenario.json']) {
      bundle = S.fromLegacy(Object.assign({}, files['scenario.json'], {
        characterData: (files['scenario.json'].characters || []).map((id) => files[`characters/${id}.json`] || null),
      }));
    } else {
      throw new Error(`${folder}: no world.json or scenario.json`);
    }
    bundle.folder = folder;
    const warnings = S.validateWorld(bundle);
    const w = bundle.world;
    return {
      folder, id: w.id || folder, title: w.title, summary: w.summary || '', tags: w.tags || [],
      legacy: bundle.legacy, defaultStart: w.starts[0], warnings,
      starts: w.starts.map((id) => {
        const st = bundle.starts[id];
        const info = { id, title: st.title || w.title, summary: st.summary || '' };
        try { info.scenario = S.validate(S.compose(w, st, bundle.characters, folder)); }
        catch (err) { info.error = err.message; }
        return info;
      }),
    };
  };

  // A loaded world's start (default: the first) → a fresh scenario copy.
  S.startScenario = function (loaded, startId) {
    const id = startId || loaded.defaultStart;
    const st = loaded.starts.find((s) => s.id === id);
    if (!st) throw new Error(`World "${loaded.title}" has no start "${id}".`);
    if (st.error) throw new Error(st.error);
    return E.clone(st.scenario);
  };

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  S.listServer = async function () {
    const idx = await getJSON('scenarios/index.json');
    return (idx.scenarios || idx).map((x) => (typeof x === 'string' ? { folder: x, title: x } : x));
  };

  // Missing start or character files are left out, so validateWorld names them.
  S.loadWorldServer = async function (folder) {
    const base = `scenarios/${folder}/`;
    const files = {};
    let legacy = false;
    try { files['world.json'] = await getJSON(base + 'world.json'); }
    catch (e) { files['scenario.json'] = await getJSON(base + 'scenario.json'); legacy = true; }
    const rootJson = files['world.json'] || files['scenario.json'];
    await Promise.all(S.neededFiles(rootJson, legacy).map(async (p) => {
      try { files[p] = await getJSON(base + p); } catch (e) { /* reported by validateWorld */ }
    }));
    return S.prepareWorld(folder, files);
  };

  // The default start of a server world, validated (kept for older callers).
  S.loadServer = async function (folder) {
    return S.startScenario(await S.loadWorldServer(folder));
  };

  // FileList from <input webkitdirectory>. Finds every world.json (or legacy
  // scenario.json) in it, so picking either one world folder or the whole
  // scenarios/ folder works.
  S.loadFromFiles = async function (fileList) {
    const files = Array.from(fileList);
    const byPath = new Map(files.map((f) => [f.webkitRelativePath || f.name, f]));
    const readJSON = async (f) => JSON.parse(await f.text());
    const dirs = new Map(); // dir -> root file name; world.json wins over scenario.json
    for (const path of byPath.keys()) {
      const m = /(^|\/)(world|scenario)\.json$/.exec(path);
      if (!m) continue;
      const dir = path.slice(0, path.length - (m[2] + '.json').length);
      if (!dirs.has(dir) || m[2] === 'world') dirs.set(dir, m[2] + '.json');
    }
    const worlds = [];
    const errors = [];
    for (const [dir, rootName] of dirs) {
      try {
        const rootJson = await readJSON(byPath.get(dir + rootName));
        const found = { [rootName]: rootJson };
        for (const p of S.neededFiles(rootJson, rootName === 'scenario.json')) {
          if (byPath.has(dir + p)) found[p] = await readJSON(byPath.get(dir + p));
        }
        const folder = dir.replace(/\/$/, '').split('/').pop() || rootJson.id;
        worlds.push(S.prepareWorld(folder, found));
      } catch (err) {
        errors.push(`${dir || '(root)'}: ${err.message}`);
      }
    }
    if (!worlds.length) {
      throw new Error(errors.length ? errors.join('\n') : 'No world.json or scenario.json found in that folder.');
    }
    return { worlds, errors };
  };

  // Catches authoring mistakes early with readable messages.
  S.validate = function (sc) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    req(sc.title, 'missing "title"');
    req(sc.setting, 'missing "setting"');
    req(Array.isArray(sc.characters) && sc.characters.length, 'missing "characters" list');
    req(sc.characters && sc.characters.includes(sc.player), '"player" must be one of "characters"');
    req(Array.isArray(sc.locations) && sc.locations.length, 'missing "locations"');
    sc.skills = sc.skills || ['physical', 'technical', 'social', 'knowledge', 'stealth'];
    // No needs unless the world lists them (task 1-5: a world without needs plays fine).
    sc.needs = sc.needs || [];
    req(Array.isArray(sc.needs) && sc.needs.every((n) => n && n.id), '"needs" must be a list of {id, label, perHour}');
    const needIds = (Array.isArray(sc.needs) ? sc.needs : []).map((n) => n && n.id);
    if (sc.skillPenalties != null) {
      const sp = sc.skillPenalties;
      req(typeof sp === 'object' && !Array.isArray(sp), '"skillPenalties" must be an object with "health" and/or "needs"');
      Object.entries((sp && sp.health) || {}).forEach(([k, v]) => req(['ok', 'hurt', 'badly_hurt'].includes(k) && typeof v === 'number', `skillPenalties.health.${k} must be ok/hurt/badly_hurt with a number`));
      ((sp && sp.needs) || []).forEach((n) => req(n && needIds.includes(n.need) && typeof n.at === 'number' && typeof n.penalty === 'number', `skillPenalties.needs entry for "${n && n.need}" needs a known need, "at" and "penalty"`));
    }
    Object.entries(sc.tagThresholds || {}).forEach(([k, t]) => req(needIds.includes(k) && t && typeof t.at === 'number' && t.at > 0 && t.at <= 1 && typeof t.tag === 'string' && t.tag.trim(),
      `tagThresholds.${k} needs a known need, "at" between 0 and 1 and a "tag"`));
    (sc.revealPressure || []).forEach((n) => req(needIds.includes(n), `revealPressure "${n}" is not one of the world's needs`));
    const locIds = new Set((sc.locations || []).map((l) => l.id));
    (sc.locations || []).forEach((l) => (l.connects || []).forEach((c) => req(locIds.has(c), `location "${l.id}" connects to unknown "${c}"`)));
    (sc.characterData || []).forEach((c, i) => {
      const expected = sc.characters[i];
      req(c.id === expected, `characters/${expected}.json has id "${c.id}"`);
      req(c.name, `character "${c.id}" missing "name"`);
      req(!c.guard || ['low', 'medium', 'high'].includes(c.guard), `character "${c.id}" guard must be low, medium or high`);
      // Tags (and the older status.conditions) start the game as lasting tags.
      [['tags', c.tags], ['status.conditions', c.status && c.status.conditions]].forEach(([k, v]) =>
        req(v == null || (Array.isArray(v) && v.every((t) => typeof t === 'string' && t.trim() && t.length <= 32)), `character "${c.id}" ${k} must be a list of short phrases (32 characters each)`));
      req(c.status && locIds.has(c.status.location), `character "${c.id}" starts at unknown location "${c.status && c.status.location}"`);
      Object.keys(c.skills || {}).forEach((k) => req(sc.skills.includes(k), `character "${c.id}" has skill "${k}" not in scenario skills`));
      Object.keys(c.relations || {}).forEach((k) => req(sc.characters.includes(k), `character "${c.id}" has relation to unknown "${k}"`));
    });
    req(sc.tags == null || (Array.isArray(sc.tags) && sc.tags.length <= 8 && sc.tags.every((t) => typeof t === 'string' && t.trim() && t.length <= 40)),
      '"tags" must be a list of at most 8 short words or phrases (40 characters each)');
    req(sc.toneNote == null || (typeof sc.toneNote === 'string' && sc.toneNote.length <= 300), '"toneNote" must be text of at most 300 characters');
    Object.entries(sc.eventRates || {}).forEach(([k, v]) => req(['regional', 'world'].includes(k) && typeof v === 'number' && v >= 0, `eventRates.${k} must be regional/world with hours >= 0 (0 turns it off)`));
    (sc.factions || []).forEach((f) => req(f.id && f.name && f.desc && f.stance, `group "${f.id || '?'}" needs id, name, desc and stance`));
    (sc.clocks || []).forEach((c) => {
      req(c.id && c.name && c.max > 0, `clock "${c.id || '?'}" needs id, name and max`);
      Object.keys(c.fireWorld || {}).forEach((k) => req(sc.world && k in sc.world, `clock "${c.id}" fireWorld key "${k}" not in world`));
      (c.then || []).forEach((t) => {
        req(t.id && t.name && t.max > 0, `clock "${c.id}" has a follow-up ("then") without id, name and max`);
        Object.keys(t.fireWorld || {}).forEach((k) => req(sc.world && k in sc.world, `follow-up clock "${t.id}" fireWorld key "${k}" not in world`));
      });
    });
    if (problems.length) throw new Error(`Scenario "${sc.title || sc.folder}" has problems:\n- ` + problems.join('\n- '));
    return sc;
  };
})(typeof window !== 'undefined' ? window : globalThis);
