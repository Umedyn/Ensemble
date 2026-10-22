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
  const START_OWN = ['id', 'title', 'summary', 'start', 'player', 'cast', 'opening', 'castLabel', 'region'];
  // World fields a start may override (merge rules below).
  const OVERRIDABLE = ['setting', 'rules', 'tags', 'toneNote', 'timeLabel', 'wakeHour', 'skills', 'needs', 'skillPenalties', 'revealPressure', 'tagThresholds', 'portraitSet', 'factions', 'world',
    'eventRates', 'eventSeeds', 'majorEventDays', 'majorHorizonDays', 'majorSeeds', 'revealSkills', 'facts', 'locations', 'clocks', 'tiers', 'extras', 'inventExtras', 'regions', 'standees', 'site', 'localMap'];
  const WORLD_FIELDS = ['format', 'id', 'title', 'summary', 'characters', 'starts', ...OVERRIDABLE];
  const WORLD_RESERVED = ['map', 'lore', 'timeline'];
  const START_RESERVED = ['playerSlot'];
  const CAST_FIELDS = ['id', 'status', 'needs', 'relations', 'knows', 'want', 'secret', 'guard', 'tags', 'tier', 'pinned', 'agenda'];
  // Merge rules: lists of {id} objects merge by id, lists of strings are
  // unioned, plain objects merge shallowly; anything else is replaced.
  const ID_LISTS = ['locations', 'clocks', 'factions', 'extras', 'regions', 'standees'];
  const STRING_LISTS = ['rules', 'facts', 'tags'];
  const OBJECTS = ['world', 'eventRates', 'eventSeeds', 'tiers'];

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
    // Regions (task 3-1): a location without one is in the start's region.
    if (Array.isArray(sc.regions) && sc.regions.length && sc.region != null) {
      (sc.locations || []).forEach((l) => { if (l && l.region == null) l.region = sc.region; });
    }
    S.groupsToStandees(sc);
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

  // ---------- standees (task 3-2) ----------
  // Groups exist only on the local map. A group extra ("group": true, the
  // form before standees) with a room becomes a standee; one with no room is
  // dropped (validateWorld warns), since a group away from the rooms is its
  // faction's business. Counts in words become numbers.
  const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, fifty: 50, couple: 2, pair: 2, few: 3, handful: 4, several: 5, some: 5, dozen: 12, dozens: 24, scores: 50, hundred: 100, hundreds: 100, thousand: 999, thousands: 999 };
  S.parseCount = function (v) {
    if (typeof v === 'number' && v >= 1) return Math.min(999, Math.round(v));
    const t = String(v == null ? '' : v).toLowerCase();
    const n = t.match(/\d+/);
    if (n) return E.clamp(Number(n[0]), 1, 999);
    const w = t.split(/[^a-z]+/).find((x) => COUNT_WORDS[x]);
    return w ? COUNT_WORDS[w] : 10;
  };
  S.groupsToStandees = function (sc) {
    if (!Array.isArray(sc.extras) || !sc.extras.some((x) => x && x.group === true)) return sc;
    const standees = Array.isArray(sc.standees) ? sc.standees : [];
    sc.extras.filter((x) => x && x.group === true && x.location != null).forEach((x) => {
      if (standees.some((st) => st.id === x.id)) return;
      standees.push({ id: x.id, label: x.name, count: S.parseCount(x.count), location: x.location, state: 'calm', note: [x.role, x.note].filter(Boolean).join('; ') });
    });
    sc.extras = sc.extras.filter((x) => !(x && x.group === true));
    sc.standees = standees;
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
      else if (['start', 'player', 'locations', 'clocks', 'opening', 'castLabel', 'region'].includes(k)) start[k] = E.clone(v);
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
    ['locations', 'clocks', 'factions', 'regions'].forEach((k) =>
      dupes((Array.isArray(world[k]) ? world[k] : []).map((x) => x && x.id)).forEach((id) => problems.push(`world ${k} has "${id}" twice`)));
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
      ['locations', 'clocks', 'factions', 'regions'].forEach((k) =>
        dupes((Array.isArray(st[k]) ? st[k] : []).map((x) => x && x.id)).forEach((id) => problems.push(`${where}: ${k} has "${id}" twice`)));
      (st.cast || []).forEach((entry) => {
        if (typeof entry !== 'string') warnings.push(...unknownFields(entry, CAST_FIELDS, `${where} cast "${entry.id}"`));
      });
    });
    // Groups away from the rooms (task 3-2) are dropped when composing.
    [['world.json', world]].concat(startIds.map((sid) => [bundle.legacy ? 'scenario.json' : `starts/${sid}.json`, starts[sid]])).forEach(([where, src]) =>
      ((src && Array.isArray(src.extras)) ? src.extras : []).filter((x) => x && x.group === true && x.location == null).forEach((x) =>
        warnings.push(`${where}: group "${x.id}" is in no room and is left out (groups exist only on the local map; use a faction or a pressure for the rest)`)));
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
        const world = S.prepareWorld(folder, found);
        // Image files in the folder, by path relative to it (the page makes URLs; never saved).
        world.assets = {};
        for (const [p, f] of byPath) if (p.startsWith(dir) && E.isImagePath(p.slice(dir.length))) world.assets[p.slice(dir.length)] = f;
        worlds.push(world);
      } catch (err) {
        errors.push(`${dir || '(root)'}: ${err.message}`);
      }
    }
    if (!worlds.length) {
      throw new Error(errors.length ? errors.join('\n') : 'No world.json or scenario.json found in that folder.');
    }
    return { worlds, errors };
  };

  // One character's sheet: a character file merged with its cast entry, or a
  // promoted extra (task 2-3). castIds: who relations may point at.
  S.characterProblems = function (c, sc, locIds, castIds) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    req(c.name, `character "${c.id}" missing "name"`);
    req(!c.guard || ['low', 'medium', 'high'].includes(c.guard), `character "${c.id}" guard must be low, medium or high`);
    req(c.tier == null || ['local', 'secondary'].includes(c.tier), `character "${c.id}" tier must be local or secondary`);
    req(c.pinned == null || typeof c.pinned === 'boolean', `character "${c.id}" pinned must be true or false`);
    if (c.agenda != null) {
      const a = E.Engine.cleanAgenda(c.agenda);
      req(!a.error, `character "${c.id}": ${a.error}`);
    }
    req(c.portrait == null || E.isImagePath(c.portrait), `character "${c.id}" portrait must be an image path inside the world folder, like "portraits/${c.id}.png"`);
    [['description', 600], ['appearance', 400]].forEach(([k, max]) => req(c[k] == null || (typeof c[k] === 'string' && c[k].length <= max), `character "${c.id}" ${k} must be text of at most ${max} characters`));
    // Tags (and the older status.conditions) start the game as lasting tags.
    [['tags', c.tags], ['status.conditions', c.status && c.status.conditions]].forEach(([k, v]) =>
      req(v == null || (Array.isArray(v) && v.every((t) => typeof t === 'string' && t.trim() && t.length <= 32)), `character "${c.id}" ${k} must be a list of short phrases (32 characters each)`));
    req(c.status && locIds.has(c.status.location), `character "${c.id}" starts at unknown location "${c.status && c.status.location}"`);
    Object.keys(c.skills || {}).forEach((k) => req(sc.skills.includes(k), `character "${c.id}" has skill "${k}" not in scenario skills`));
    Object.keys(c.relations || {}).forEach((k) => req(castIds.includes(k), `character "${c.id}" has relation to unknown "${k}"`));
    return problems;
  };

  // Regions (task 3-1): who holds each part of the map, its tags and status.
  // Neighbour links work both ways, so listing one side is enough; this fills
  // in the other. Locations need a known region once a world has regions.
  S.REGION_TAGS = 6;
  function regionProblems(sc) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    const groupIds = new Set((sc.factions || []).map((f) => f.id));
    const list = sc.regions == null ? [] : Array.isArray(sc.regions) ? sc.regions : [null];
    const ids = new Set(list.filter(isObj).map((r) => r.id));
    const seen = new Set();
    list.forEach((r) => {
      const where = `region "${(r && r.id) || '?'}"`;
      if (!isObj(r)) return problems.push('"regions" must be a list of {id, name, controller, tags, status, neighbours, lore}');
      req(typeof r.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(r.id), `${where}: "id" must be lowercase letters, digits, - or _`);
      req(!seen.has(r.id), `${where} is listed twice`);
      seen.add(r.id);
      req(typeof r.name === 'string' && r.name.trim() && r.name.length <= 40, `${where}: "name" must be text of at most 40 characters`);
      req(r.controller == null || groupIds.has(r.controller), `${where}: controller "${r.controller}" is not one of the groups (use null for no one)`);
      req(r.tags == null || (Array.isArray(r.tags) && r.tags.length <= S.REGION_TAGS && r.tags.every((t) => typeof t === 'string' && t.trim() && t.length <= 30)),
        `${where}: "tags" must be a list of at most ${S.REGION_TAGS} short words or phrases (30 characters each)`);
      req(r.status == null || (typeof r.status === 'string' && r.status.length <= 120), `${where}: "status" must be text of at most 120 characters`);
      req(r.lore == null || (typeof r.lore === 'string' && r.lore.length <= 400), `${where}: "lore" must be text of at most 400 characters`);
      if (r.neighbours != null && !Array.isArray(r.neighbours)) return problems.push(`${where}: "neighbours" must be a list of region ids`);
      (r.neighbours || []).forEach((n) => req(ids.has(n) && n !== r.id, `${where}: unknown neighbour "${n}"`));
    });
    if (!problems.length) {
      const byId = {};
      list.forEach((r) => { r.neighbours = (r.neighbours || []).slice(); byId[r.id] = r; });
      list.forEach((r) => r.neighbours.forEach((n) => { if (!byId[n].neighbours.includes(r.id)) byId[n].neighbours.push(r.id); }));
    }
    if (ids.size) {
      req(ids.has(sc.region), sc.region == null ? 'the start needs a "region" (where the player starts)' : `start region "${sc.region}" is not one of the regions`);
      (sc.locations || []).forEach((l) => req(ids.has(l.region), `location "${l.id}" is in unknown region "${l.region}"`));
    } else {
      req(sc.region == null, `start region "${sc.region}" given, but the world has no "regions"`);
      (sc.locations || []).forEach((l) => req(l.region == null, `location "${l.id}" has a region, but the world has no "regions"`));
    }
    // Event seeds: plain text, or {text, region} for something that happens there.
    Object.entries(sc.eventSeeds || {}).forEach(([k, seeds]) => (Array.isArray(seeds) ? seeds : []).forEach((s) => {
      if (typeof s === 'string') return;
      req(isObj(s) && typeof s.text === 'string' && s.text.trim(), `eventSeeds.${k}: each idea is text or {text, region}`);
      if (isObj(s) && s.region != null) req(ids.has(s.region), `eventSeeds.${k}: "${s.text}" is in unknown region "${s.region}"`);
    }));
    return problems;
  }

  // Standees (task 3-2): unnamed groups on the local map.
  S.STANDEE_STATES = ['calm', 'alert', 'hostile', 'fled', 'down'];
  function standeeProblems(sc, locIds, extraIds) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    const groupIds = new Set((sc.factions || []).map((f) => f.id));
    const seen = new Set();
    const locs = {};
    (sc.locations || []).forEach((l) => (locs[l.id] = l));
    const linked = (a, b) => (locs[a] && (locs[a].connects || []).includes(b)) || (locs[b] && (locs[b].connects || []).includes(a));
    (sc.standees == null ? [] : Array.isArray(sc.standees) ? sc.standees : [null]).forEach((g) => {
      const where = `standee "${(g && g.id) || '?'}"`;
      if (!isObj(g)) return problems.push('"standees" must be a list of {id, label, count, location}');
      req(typeof g.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(g.id), `${where}: "id" must be lowercase letters, digits, - or _`);
      req(!seen.has(g.id), `${where} is listed twice`);
      seen.add(g.id);
      req(!(sc.characters || []).includes(g.id) && !locIds.has(g.id) && !extraIds.has(g.id), `${where}: id is already used by a character, extra or location`);
      req(typeof g.label === 'string' && g.label.trim() && g.label.length <= 40, `${where}: "label" must be text of at most 40 characters`);
      req(Number.isInteger(g.count) && g.count >= 1 && g.count <= 999, `${where}: "count" must be a whole number from 1 to 999`);
      req(locIds.has(g.location), `${where}: unknown location "${g.location}" (groups are always in a room)`);
      req(g.state == null || (S.STANDEE_STATES.includes(g.state) && g.state !== 'fled'), `${where}: "state" must be calm, alert, hostile or down`);
      req(g.faction == null || groupIds.has(g.faction), `${where}: faction "${g.faction}" is not one of the groups`);
      req(g.note == null || (typeof g.note === 'string' && g.note.length <= 200), `${where}: "note" must be text of at most 200 characters`);
      req(g.post == null || g.patrol == null, `${where}: a group holds a "post" or walks a "patrol", not both`);
      req(g.post == null || locIds.has(g.post), `${where}: unknown post "${g.post}"`);
      if (g.patrol != null) {
        const ok = Array.isArray(g.patrol) && g.patrol.length >= 2 && g.patrol.every((l) => locIds.has(l));
        req(ok, `${where}: "patrol" must be a list of at least 2 known rooms`);
        if (ok) g.patrol.forEach((l, i) => { const next = g.patrol[(i + 1) % g.patrol.length]; req(linked(l, next), `${where}: patrol step ${l} → ${next} is not a linked room`); });
        if (ok) req(g.patrol.includes(g.location), `${where}: starts in "${g.location}", which is not on its patrol`);
      }
    });
    return problems;
  }

  // Site layout data (task 3-3), all optional: room size, floor, outside,
  // features, secure, whether the player knows the room yet, and links with a
  // kind. A link is also a connection (added to "connects" here), so links
  // only add how a way through looks. The start's "site" picks the layout
  // style; "localMap" draws a floor-plan image with room hotspots instead.
  S.LINK_KINDS = ['open', 'door', 'locked door', 'vent', 'hatch', 'window', 'stairs'];
  S.ROOM_SIZES = ['small', 'medium', 'large'];
  S.SITE_TYPES = ['generic', 'hall', 'corridor'];
  function siteProblems(sc, locIds) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    const locs = sc.locations || [];
    const byId = {};
    locs.forEach((l) => (byId[l.id] = l));
    locs.forEach((l) => {
      const where = `location "${l.id}"`;
      req(l.size == null || S.ROOM_SIZES.includes(l.size), `${where}: "size" must be small, medium or large`);
      req(l.level == null || (Number.isInteger(l.level) && l.level >= -3 && l.level <= 5), `${where}: "level" must be a whole number from -3 to 5 (0 is the ground floor)`);
      req(l.outside == null || typeof l.outside === 'boolean', `${where}: "outside" must be true or false`);
      req(l.secure == null || typeof l.secure === 'boolean', `${where}: "secure" must be true or false`);
      req(l.seen == null || typeof l.seen === 'boolean', `${where}: "seen" must be true or false`);
      req(l.features == null || (Array.isArray(l.features) && l.features.length <= 6 && l.features.every((f) => typeof f === 'string' && f.trim() && f.length <= 30)),
        `${where}: "features" must be a list of at most 6 short names (30 characters each)`);
      if (l.links == null) return;
      if (!Array.isArray(l.links)) return problems.push(`${where}: "links" must be a list of {to, kind}`);
      l.links.forEach((k) => {
        const ok = k && locIds.has(k.to) && k.to !== l.id;
        req(ok, `${where}: link to unknown room "${k && k.to}"`);
        req(k && S.LINK_KINDS.includes(k.kind), `${where}: link to "${k && k.to}" needs a kind: ${S.LINK_KINDS.join(', ')}`);
        if (ok) { l.connects = l.connects || []; if (!l.connects.includes(k.to)) l.connects.push(k.to); }
      });
    });
    // Secure rooms (vault, cell) have exactly one way in.
    locs.filter((l) => l.secure).forEach((l) => {
      const ways = new Set((l.connects || []).concat(locs.filter((o) => (o.connects || []).includes(l.id)).map((o) => o.id)));
      req(ways.size === 1, `location "${l.id}" is secure, so it needs exactly one way in (it has ${ways.size})`);
    });
    if (sc.site != null) {
      req(isObj(sc.site) && (sc.site.type == null || S.SITE_TYPES.includes(sc.site.type)), `"site" must be {type}, with type ${S.SITE_TYPES.join(', ')}`);
    }
    if (sc.localMap != null) {
      const m = sc.localMap;
      req(isObj(m) && E.isImagePath(m.image) && m.width > 0 && m.height > 0 && isObj(m.rooms), '"localMap" needs an "image" in the world folder, "width", "height" and "rooms"');
      Object.entries((isObj(m) && isObj(m.rooms)) ? m.rooms : {}).forEach(([id, r]) => {
        req(locIds.has(id), `localMap: unknown room "${id}"`);
        req(isObj(r) && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && n >= 0) && r.x + r.w <= m.width && r.y + r.h <= m.height,
          `localMap: room "${id}" needs x, y, w and h inside the image`);
      });
    }
    return problems;
  }

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
    req(sc.portraitSet == null || (Array.isArray(sc.portraitSet) && sc.portraitSet.every(E.isImagePath)), '"portraitSet" must be a list of image paths inside the world folder');
    Object.entries(sc.tagThresholds || {}).forEach(([k, t]) => req(needIds.includes(k) && t && typeof t.at === 'number' && t.at > 0 && t.at <= 1 && typeof t.tag === 'string' && t.tag.trim(),
      `tagThresholds.${k} needs a known need, "at" between 0 and 1 and a "tag"`));
    (sc.revealPressure || []).forEach((n) => req(needIds.includes(n), `revealPressure "${n}" is not one of the world's needs`));
    const locIds = new Set((sc.locations || []).map((l) => l.id));
    (sc.locations || []).forEach((l) => (l.connects || []).forEach((c) => req(locIds.has(c), `location "${l.id}" connects to unknown "${c}"`)));
    problems.push(...siteProblems(sc, locIds));
    (sc.characterData || []).forEach((c, i) => {
      const expected = sc.characters[i];
      req(c.id === expected, `characters/${expected}.json has id "${c.id}"`);
      problems.push(...S.characterProblems(c, sc, locIds, sc.characters));
    });
    // Extras (task 2-3): minor people, or a group as one entity.
    const extraIds = new Set();
    (sc.extras == null ? [] : Array.isArray(sc.extras) ? sc.extras : [null]).forEach((x) => {
      const where = `extra "${(x && x.id) || '?'}"`;
      if (!isObj(x)) return problems.push('"extras" must be a list of {id, name, role, location}');
      req(typeof x.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(x.id), `${where}: "id" must be lowercase letters, digits, - or _`);
      req(!extraIds.has(x.id), `${where} is listed twice`);
      req(!(sc.characters || []).includes(x.id) && !locIds.has(x.id), `${where}: id is already used by a character or location`);
      extraIds.add(x.id);
      req(typeof x.name === 'string' && x.name.trim() && x.name.length <= 40, `${where}: "name" must be text of at most 40 characters`);
      req(typeof x.role === 'string' && x.role.trim() && x.role.length <= 60, `${where}: "role" must be text of at most 60 characters`);
      req(x.location === null || locIds.has(x.location), `${where}: unknown location "${x.location}" (use null for nowhere in particular)`);
      req(x.note == null || (typeof x.note === 'string' && x.note.length <= 200), `${where}: "note" must be text of at most 200 characters`);
      req(x.pronouns == null || (typeof x.pronouns === 'string' && x.pronouns.length <= 20), `${where}: "pronouns" must be short text`);
      req(x.group == null || typeof x.group === 'boolean', `${where}: "group" must be true or false`);
      req(x.count == null || (x.group === true && typeof x.count === 'string' && x.count.length <= 30), `${where}: "count" is a short phrase, for groups only`);
    });
    req(sc.inventExtras == null || typeof sc.inventExtras === 'boolean', '"inventExtras" must be true or false');
    req(sc.tags == null || (Array.isArray(sc.tags) && sc.tags.length <= 8 && sc.tags.every((t) => typeof t === 'string' && t.trim() && t.length <= 40)),
      '"tags" must be a list of at most 8 short words or phrases (40 characters each)');
    if (sc.tiers != null) {
      req(isObj(sc.tiers), '"tiers" must be an object with "demoteAfter" and/or "maxLocal"');
      Object.entries(isObj(sc.tiers) ? sc.tiers : {}).forEach(([k, v]) => req(['demoteAfter', 'maxLocal'].includes(k) && Number.isInteger(v) && v >= 1, `tiers.${k} must be demoteAfter/maxLocal with a whole number of at least 1`));
    }
    req(sc.toneNote == null || (typeof sc.toneNote === 'string' && sc.toneNote.length <= 300), '"toneNote" must be text of at most 300 characters');
    Object.entries(sc.eventRates || {}).forEach(([k, v]) => req(['regional', 'world'].includes(k) && typeof v === 'number' && v >= 0, `eventRates.${k} must be regional/world with hours >= 0 (0 turns it off)`));
    (sc.factions || []).forEach((f) => req(f.id && f.name && f.desc && f.stance, `group "${f.id || '?'}" needs id, name, desc and stance`));
    problems.push(...regionProblems(sc));
    problems.push(...standeeProblems(sc, locIds, extraIds));
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
