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
  const START_OWN = ['id', 'title', 'summary', 'start', 'player', 'cast', 'opening', 'castLabel', 'region', 'playerSlot', 'generated'];
  // World fields a start may override (merge rules below).
  const OVERRIDABLE = ['setting', 'rules', 'tags', 'toneNote', 'timeLabel', 'wakeHour', 'skills', 'needs', 'skillPenalties', 'revealPressure', 'tagThresholds', 'portraitSet', 'factions', 'world',
    'eventRates', 'eventSeeds', 'majorEventDays', 'majorHorizonDays', 'majorSeeds', 'revealSkills', 'facts', 'locations', 'clocks', 'tiers', 'extras', 'inventExtras', 'regions', 'regionLabels', 'routeKinds', 'standees', 'site', 'localMap', 'map', 'entrances', 'lore', 'timeline', 'projectTimeline'];
  const WORLD_FIELDS = ['format', 'id', 'title', 'summary', 'date', 'characters', 'starts', 'generatedStarts', 'generatedSites', 'sites', ...OVERRIDABLE];
  const WORLD_RESERVED = [];
  const START_RESERVED = [];
  const CAST_FIELDS = ['id', 'status', 'needs', 'relations', 'knows', 'want', 'secret', 'guard', 'tags', 'tier', 'pinned', 'agenda'];
  // Merge rules: lists of {id} objects merge by id, lists of strings are
  // unioned, plain objects merge shallowly; anything else is replaced.
  const ID_LISTS = ['locations', 'clocks', 'factions', 'extras', 'regions', 'standees', 'lore', 'timeline'];
  const STRING_LISTS = ['rules', 'facts', 'tags'];
  const OBJECTS = ['world', 'eventRates', 'eventSeeds', 'tiers', 'routeKinds'];

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
  // siteMaps: the world's library maps ({id: data}, task 4-4), carried in the
  // scenario so saves keep them.
  S.compose = function (world, start, characters, folder, siteMaps) {
    const sc = E.clone(world);
    delete sc.format;
    delete sc.starts;
    // The world's date (R-0) is the date of a start that gives none.
    if (sc.date != null && start.start == null) sc.start = sc.date;
    delete sc.date;
    // Neighbours become border routes (R-2), so the engine reads one list.
    S.deriveRoutes(sc.regions);
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
    // World-level extras and groups may stand in rooms only some starts have
    // (Mrs. Albee at the holdout's dock). In a start without that room, an
    // extra is nowhere in particular and a group is left out (validateWorld
    // checks the room exists somewhere, so a typo still fails).
    const own = new Set([].concat(start.extras || [], start.standees || []).map((x) => x && x.id));
    const rooms = new Set((sc.locations || []).map((l) => l && l.id));
    (sc.extras || []).forEach((x) => { if (x && !own.has(x.id) && x.location != null && !rooms.has(x.location)) x.location = null; });
    if (Array.isArray(sc.standees)) sc.standees = sc.standees.filter((g) => !g || own.has(g.id) || rooms.has(g.location));
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
    if (siteMaps && Object.keys(siteMaps).length) sc.siteMaps = E.clone(siteMaps);
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
      else if (['start', 'player', 'locations', 'clocks', 'opening', 'castLabel', 'region', 'playerSlot'].includes(k)) start[k] = E.clone(v);
      else world[k] = E.clone(v);
    });
    world.starts = ['default'];
    const characters = {};
    (legacy.characters || []).forEach((id, i) => { if (legacy.characterData && legacy.characterData[i]) characters[id] = legacy.characterData[i]; });
    return { world, starts: { default: start }, characters, legacy: true };
  };

  // ---------- lore (task 5-1) ----------
  // The lore/ files among a world's files ({ "lore/<id>.json": data }).
  S.loreFiles = (files) => Object.fromEntries(Object.entries(files || {}).filter(([p]) => /^lore\/[^/]+\.json$/.test(p)));
  // Lore across the world and its starts: missing files, the shape of every
  // entry, refs to a region, room or person that exists somewhere in the
  // world, and no entry that gives away someone's secret.
  function loreWorldProblems(bundle, startIds, warnings) {
    const { world, starts = {}, characters = {} } = bundle;
    const { entries, problems } = E.Lore.resolve(world.lore, bundle.loreFiles);
    const rootName = bundle.legacy ? 'scenario.json' : 'world.json';
    problems.push(...E.Lore.problems(entries, rootName));
    const sources = [[rootName, entries]].concat(startIds.filter((sid) => starts[sid] && starts[sid].lore != null).map((sid) => {
      const where = `starts/${sid}.json`;
      if (!Array.isArray(starts[sid].lore)) { problems.push(`${where}: "lore" must be a list of entries`); return [where, []]; }
      problems.push(...E.Lore.problems(starts[sid].lore, where));
      return [where, starts[sid].lore];
    }));
    if (sources.every(([, list]) => !list.length)) return problems;
    const ofStarts = (k) => [].concat(world[k] || [], ...startIds.map((sid) => (starts[sid] && starts[sid][k]) || [])).map((x) => x && x.id);
    const known = { region: new Set(ofStarts('regions')), location: new Set(ofStarts('locations')), character: new Set(world.characters || []) };
    // Secrets: the pool's, and any a start gives its cast.
    const people = Object.values(characters).concat(...startIds.map((sid) => ((starts[sid] && starts[sid].cast) || []).filter(isObj)
      .map((c) => Object.assign({}, characters[c.id], c))));
    sources.forEach(([where, list]) => list.filter(isObj).forEach((e) => {
      if (!E.Lore.REF_LEVELS.includes(e.level) || typeof e.ref !== 'string' || known[e.level].has(e.ref)) { /* fine */ }
      // Generated starts and sites make rooms of their own, so a room no
      // authored start has is only a warning.
      else if (e.level === 'location') warnings.push(`${where}: lore "${e.id}" is about "${e.ref}", a room no start has (it comes up only by its keywords until one does)`);
      else problems.push(`${where}: lore "${e.id}" is about unknown ${e.level} "${e.ref}"`);
      const who = E.Lore.leak(e, people);
      if (who) problems.push(`${where}: lore "${e.id}" gives away ${who.name || who.id}'s secret (lore is public; keep secrets in the character's "secret")`);
    }));
    return problems;
  }

  // ---------- the canon timeline (task 5-2) ----------
  // Timeline events across the world and its starts: shape, ids that exist
  // somewhere in the world, and no public event that gives away a secret.
  function timelineWorldProblems(bundle, startIds, warnings) {
    const { world, starts = {}, characters = {} } = bundle;
    const lists = [['world.json', world.timeline]].concat(startIds.filter((sid) => starts[sid] && starts[sid].timeline != null).map((sid) => [`starts/${sid}.json`, starts[sid].timeline]));
    if (lists.every(([, l]) => l == null)) return [];
    const ofAll = (k) => new Set([].concat(world[k] || [], ...startIds.map((sid) => (starts[sid] && starts[sid][k]) || [])).map((x) => x && x.id));
    const clockIds = new Set();
    const addClocks = (cs) => (cs || []).forEach((c) => { if (c && c.id) { clockIds.add(c.id); addClocks(c.then); } });
    addClocks(world.clocks);
    startIds.forEach((sid) => addClocks(starts[sid] && starts[sid].clocks));
    const first = startIds[0] && starts[startIds[0]] && starts[startIds[0]].start;
    const refs = {
      regions: ofAll('regions'), groups: ofAll('factions'), clocks: clockIds, characters: new Set(world.characters || []),
      effectKeys: Object.keys(E.Engine.EFFECTS), start: first ? E.Timeline.at({ day: first.day ?? 1, hour: first.hour ?? 8 }) : null,
    };
    const problems = [];
    const people = Object.values(characters).concat(...startIds.map((sid) => ((starts[sid] && starts[sid].cast) || []).filter(isObj)
      .map((c) => Object.assign({}, characters[c.id], c))));
    lists.forEach(([where, list]) => {
      problems.push(...E.Timeline.problems(list, where, refs, warnings));
      (Array.isArray(list) ? list : []).filter((ev) => isObj(ev) && ev.visibility !== 'hidden').forEach((ev) => {
        const who = E.Lore.leak({ text: ev.text }, people);
        if (who) problems.push(`${where}: timeline "${ev.id}" gives away ${who.name || who.id}'s secret (public events reach the narrator; make it hidden, or keep the secret in the character's "secret")`);
      });
    });
    return problems;
  }
  function projectProblems(v) {
    if (v == null || v === false || v === true) return [];
    const ok = isObj(v) && Object.entries(v).every(([k, n]) => (k === 'days' && Number.isInteger(n) && n >= 1 && n <= 14) || (k === 'max' && Number.isInteger(n) && n >= 1 && n <= 5));
    return ok ? [] : ['"projectTimeline" must be false, or {days: 1–14, max: 1–5}'];
  }

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
      req(world.format == null || world.format === 2, '"format" must be 2');
      warnings.push(...unknownFields(world, [...WORLD_FIELDS, ...WORLD_RESERVED], 'world.json'));
    }
    req(world.title, 'missing "title"');
    // Open worlds (R-0): no character pool and no starts are fine; a world
    // with no starts gets generated ones (S.openWorld).
    req(world.characters == null || Array.isArray(world.characters), '"characters" must be a list of character ids');
    req(world.starts == null || Array.isArray(world.starts), '"starts" must be a list of start ids');
    const pool = Array.isArray(world.characters) ? world.characters : [];
    const startIds = Array.isArray(world.starts) ? world.starts : [];
    req(world.date == null || (isObj(world.date) && Number.isFinite(world.date.day) && Number.isFinite(world.date.hour)), '"date" must be {day, hour}');
    if (world.generatedStarts != null || !startIds.length) problems.push(...E.StartGen.configProblems(world));
    // Generated sites and library maps (task 4-4).
    problems.push(...E.Sites.configProblems(world));
    if (world.sites != null && !Array.isArray(world.sites)) problems.push('"sites" must be a list of site map ids (files in sites/)');
    (Array.isArray(world.sites) ? world.sites : []).forEach((id) => {
      const m = (bundle.siteMaps || {})[id];
      if (!m) problems.push(`missing sites/${id}.json`);
      else { problems.push(...E.Sites.mapProblems(m, id)); warnings.push(...E.Sites.mapWarnings(m, id)); }
    });
    problems.push(...loreWorldProblems(bundle, startIds, warnings));
    problems.push(...timelineWorldProblems(bundle, startIds, warnings));
    problems.push(...projectProblems(world.projectTimeline));
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
      if (st.player != null || !st.playerSlot) req(cast.includes(st.player), `${where}: "player" must be in the cast${st.playerSlot ? '' : ' (or give the start a "playerSlot" so players make their own)'}`);
      ['locations', 'clocks', 'factions', 'regions'].forEach((k) =>
        dupes((Array.isArray(st[k]) ? st[k] : []).map((x) => x && x.id)).forEach((id) => problems.push(`${where}: ${k} has "${id}" twice`)));
      (st.cast || []).forEach((entry) => {
        if (typeof entry !== 'string') warnings.push(...unknownFields(entry, CAST_FIELDS, `${where} cast "${entry.id}"`));
      });
    });
    // Rooms placed on the world map must exist in the world or some start.
    if (isObj(world.map) && isObj(world.map.locations)) {
      const rooms = new Set([].concat(world.locations || [], ...startIds.map((sid) => (starts[sid] && starts[sid].locations) || [])).map((l) => l && l.id));
      Object.keys(world.map.locations).forEach((id) => req(rooms.has(id), `map: unknown location "${id}"`));
    }
    // Regions the world map leaves out get an automatic point (task 3-4).
    // A region with regions inside it needs no shape: its children stand for it (R-1).
    if (isObj(world.map) && Array.isArray(world.regions)) world.regions.forEach((r) => {
      if (r && r.id && !world.regions.some((c) => c && c.parent === r.id) && !(isObj(world.map.regions) && world.map.regions[r.id])) warnings.push
(`world.json: region "${r.id}" is not on the map; it gets a point placed automatically`);
    });
    // World-level extras and groups stand in a room of the world or of some start.
    const anyRoom = new Set([].concat(world.locations || [], ...startIds.map((sid) => (starts[sid] && starts[sid].locations) || [])).map((l) => l && l.id));
    [].concat(Array.isArray(world.extras) ? world.extras : [], Array.isArray(world.standees) ? world.standees : []).forEach((x) => {
      if (x && x.location != null && !anyRoom.has(x.location)) problems.push(`world.json: "${x.id}" stands in "${x.location}", which is not a room of the world or of any start`);
    });
    // Groups away from the rooms (task 3-2) are dropped when composing.
    [['world.json', world]].concat(startIds.map((sid) => [bundle.legacy ? 'scenario.json' : `starts/${sid}.json`, starts[sid]])).forEach(([where, src]) =>
      ((src && Array.isArray(src.extras)) ? src.extras : []).filter((x) => x && x.group === true && x.location == null).forEach((x) =>
        warnings.push(`${where}: group "${x.id}" is in no room and is left out (groups exist only on the local map; use a faction or a pressure for the rest)`)));
    if (problems.length) throw new Error(`World "${world.title || bundle.folder}" has problems:\n- ` + problems.join('\n- '));
    return warnings;
  };

  // ---------- the shared site map library (task 6-3) ----------
  // library/index.json: { "sites": [{ id, name, type, tags, setting, rooms }] },
  // with the maps in library/sites/<id>.json and their images beside them.
  // The page sets S.library once ({ maps: {id: map}, assets: {path: File},
  // errors }); a world that asks for it (generatedSites.library: setting
  // tags) gets the maps whose "setting" overlaps, marked library: true, after
  // its own (a world map with the same id wins).
  S.library = { maps: {}, assets: {}, errors: [] };
  S.libraryFor = function (world, own) {
    const lib = world.generatedSites && world.generatedSites.library;
    const want = new Set((Array.isArray(lib) ? lib : []).map((t) => String(t).toLowerCase()));
    const out = {};
    if (!want.size) return out;
    Object.values(S.library.maps || {}).forEach((m) => {
      if ((own && own[m.id]) || !(m.setting || []).some((t) => want.has(String(t).toLowerCase()))) return;
      out[m.id] = Object.assign(E.clone(m), { library: true });
    });
    return out;
  };
  // An index and its maps → { maps, errors }: each map checked, listed and
  // matching its index entry.
  S.buildLibrary = function (index, mapsById) {
    const maps = {};
    const errors = [];
    const list = index && Array.isArray(index.sites) ? index.sites : null;
    if (!list) return { maps, errors: ['the library index needs a "sites" list'] };
    list.forEach((entry) => {
      const id = entry && entry.id;
      const m = mapsById[id];
      if (!m) return errors.push(`library: missing sites/${id}.json`);
      const p = E.Sites.mapProblems(m, id);
      if (p.length) return errors.push(...p.map((x) => `library: ${x}`));
      maps[id] = m;
    });
    return { maps, errors };
  };
  // The index entry for a map (what the library's index.json lists).
  S.libraryEntry = (m) => ({ id: m.id, name: m.name || m.id, type: m.type, tags: m.tags || [], setting: m.setting || [], rooms: (m.rooms || []).length });
  S.loadLibraryServer = async function () {
    const index = await getJSON('library/index.json');
    const mapsById = {};
    await Promise.all((index.sites || []).map(async (e) => { try { mapsById[e.id] = await getJSON(`library/sites/${e.id}.json`); } catch (err) { /* reported below */ } }));
    // Base maps (task 4-5): library/maps/<id>/map.json and its picture.
    const baseMaps = {};
    await Promise.all((index.maps || []).map(async (e) => { try { baseMaps[e.id] = Object.assign(await getJSON(`library/maps/${e.id}/map.json`), { dir: `library/maps/${e.id}/` }); } catch (err) { /* left out */ } }));
    return Object.assign(S.buildLibrary(index, mapsById), { assets: {}, baseMaps });
  };
  // A picked folder that is a library (index.json with "sites", and no
  // world.json) → { maps, assets, errors }, or null when it isn't one.
  S.readLibraryFiles = async function (fileList) {
    const files = Array.from(fileList);
    const byPath = new Map(files.map((f) => [f.webkitRelativePath || f.name, f]));
    if ([...byPath.keys()].some((p) => /(^|\/)(world|scenario)\.json$/.test(p))) return null;
    const idxPath = [...byPath.keys()].find((p) => /(^|\/)index\.json$/.test(p));
    if (!idxPath) return null;
    let index;
    try { index = JSON.parse(await byPath.get(idxPath).text()); } catch (e) { return null; }
    if (!index || !Array.isArray(index.sites)) return null;
    const dir = idxPath.slice(0, idxPath.length - 'index.json'.length);
    const mapsById = {};
    const assets = {};
    for (const [p, f] of byPath) {
      if (!p.startsWith(dir)) continue;
      const rel = p.slice(dir.length);
      const m = /^sites\/([^/]+)\.json$/.exec(rel);
      if (m) { try { mapsById[m[1]] = JSON.parse(await f.text()); } catch (e) { /* reported as missing */ } }
      else if (E.isImagePath(rel)) assets[rel] = f;
    }
    return Object.assign(S.buildLibrary(index, mapsById), { assets });
  };

  // ---------- loading ----------
  // Which files a world (or legacy scenario) needs besides its root file.
  S.neededFiles = function (rootJson, legacy) {
    const chars = (rootJson.characters || []).map((id) => `characters/${id}.json`);
    const sites = (Array.isArray(rootJson.sites) ? rootJson.sites : []).map((id) => `sites/${id}.json`);
    const lore = (Array.isArray(rootJson.lore) ? rootJson.lore : []).filter((x) => typeof x === 'string').map((id) => `lore/${id}.json`);
    return legacy ? chars.concat(sites, lore) : [...(rootJson.starts || []).map((id) => `starts/${id}.json`), ...chars, ...sites, ...lore];
  };

  // Everything beyond a title and a setting is optional (R-0): a world.json
  // with no format, pool or starts gets them, and one with no starts gets
  // generated starts ("Make my own"), as if it had "generatedStarts": {}.
  S.openWorld = function (world) {
    const w = Object.assign({}, world);
    if (w.format == null) w.format = 2;
    if (w.characters == null) w.characters = [];
    if (w.starts == null) w.starts = [];
    if (Array.isArray(w.starts) && !w.starts.length && w.generatedStarts == null) w.generatedStarts = {};
    return w;
  };

  // folder + {relative path: parsed JSON} → a loaded world: { folder, id,
  // title, summary, tags, legacy, defaultStart, warnings, starts: [{ id,
  // title, summary, scenario | error }] }. Every start is composed and
  // validated now, so a broken one shows its error before "New game".
  S.prepareWorld = function (folder, files) {
    let bundle;
    if (files['world.json']) {
      const world = S.openWorld(files['world.json']);
      const starts = {};
      const characters = {};
      (world.starts || []).forEach((id) => { if (files[`starts/${id}.json`]) starts[id] = files[`starts/${id}.json`]; });
      (world.characters || []).forEach((id) => { if (files[`characters/${id}.json`]) characters[id] = files[`characters/${id}.json`]; });
      const siteMaps = {};
      (Array.isArray(world.sites) ? world.sites : []).forEach((id) => { if (files[`sites/${id}.json`]) siteMaps[id] = files[`sites/${id}.json`]; });
      // Shared maps for the world's setting (task 6-3), after its own.
      Object.assign(siteMaps, S.libraryFor(world, siteMaps));
      bundle = { world, starts, characters, siteMaps, legacy: false };
    } else if (files['scenario.json']) {
      bundle = S.fromLegacy(Object.assign({}, files['scenario.json'], {
        characterData: (files['scenario.json'].characters || []).map((id) => files[`characters/${id}.json`] || null),
      }));
    } else {
      throw new Error(`${folder}: no world.json or scenario.json`);
    }
    bundle.folder = folder;
    bundle.loreFiles = S.loreFiles(files);
    const warnings = S.validateWorld(bundle);
    // Lore file ids become their entries, so composing needs no files.
    if (bundle.world.lore != null) bundle.world = Object.assign({}, bundle.world, { lore: E.Lore.resolve(bundle.world.lore, bundle.loreFiles).entries });
    const w = bundle.world;
    return {
      folder, id: w.id || folder, title: w.title, summary: w.summary || '', tags: w.tags || [],
      legacy: bundle.legacy, defaultStart: w.starts[0], warnings,
      // Generated starts (task 4-2) compose from the raw files.
      generate: w.generatedStarts != null, bundle: { world: w, characters: bundle.characters, starts: bundle.starts, siteMaps: bundle.siteMaps || {} },
      starts: w.starts.map((id) => {
        const st = bundle.starts[id];
        const info = { id, title: st.title || w.title, summary: st.summary || '' };
        try {
          info.scenario = S.validate(S.compose(w, st, bundle.characters, folder, bundle.siteMaps));
          // Character creator (task 4-1): who you can play, and a sample made
          // character, so a slot that can't produce a playable game shows here.
          const sc = info.scenario;
          info.defaultPlayer = sc.player != null ? sc.characterData[sc.characters.indexOf(sc.player)].name : null;
          if (sc.playerSlot) {
            E.CharMaker.withPlayer(sc, E.CharMaker.sample(sc));
            info.slot = true;
            if (sc.playerSlot.summary) info.slotSummary = sc.playerSlot.summary;
          }
        } catch (err) { info.error = err.message; }
        return info;
      }),
    };
  };

  // A loaded world's start (default: the first) → a fresh scenario copy. With
  // a character from the creator (task 4-1), that character is the player.
  S.startScenario = function (loaded, startId, character) {
    const id = startId || loaded.defaultStart;
    const st = loaded.starts.find((s) => s.id === id);
    if (!st) throw new Error(`World "${loaded.title}" has no start "${id}".`);
    if (st.error) throw new Error(st.error);
    if (character) return E.CharMaker.withPlayer(st.scenario, character);
    if (st.scenario.player == null) throw new Error(`"${st.title}" has no character of its own: choose Make my own.`);
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
  // A server world's raw files, { relative path: parsed JSON }, not yet
  // composed (the creator edits these; task 3-5).
  S.fetchWorldFiles = async function (folder) {
    const base = `scenarios/${folder}/`;
    const files = {};
    let legacy = false;
    try { files['world.json'] = await getJSON(base + 'world.json'); }
    catch (e) { files['scenario.json'] = await getJSON(base + 'scenario.json'); legacy = true; }
    const rootJson = files['world.json'] || files['scenario.json'];
    await Promise.all(S.neededFiles(rootJson, legacy).map(async (p) => {
      try { files[p] = await getJSON(base + p); } catch (e) { /* reported by validateWorld */ }
    }));
    return files;
  };
  S.loadWorldServer = async function (folder) {
    return S.prepareWorld(folder, await S.fetchWorldFiles(folder));
  };

  // The default start of a server world, validated (kept for older callers).
  S.loadServer = async function (folder) {
    return S.startScenario(await S.loadWorldServer(folder));
  };

  // FileList from <input webkitdirectory>. Finds every world.json (or legacy
  // scenario.json) in it, so picking either one world folder or the whole
  // scenarios/ folder works.
  // The raw files of every world in a picked folder: [{ folder, files, assets }]
  // (assets: image files by path relative to the world folder). Unreadable
  // ones are reported in errors.
  S.readFolderFiles = async function (fileList) {
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
        const assets = {};
        for (const [p, f] of byPath) if (p.startsWith(dir) && E.isImagePath(p.slice(dir.length))) assets[p.slice(dir.length)] = f;
        worlds.push({ folder: dir.replace(/\/$/, '').split('/').pop() || rootJson.id, files: found, assets });
      } catch (err) {
        errors.push(`${dir || '(root)'}: ${err.message}`);
      }
    }
    return { worlds, errors };
  };
  S.loadFromFiles = async function (fileList) {
    const raw = await S.readFolderFiles(fileList);
    const worlds = [];
    const errors = raw.errors.slice();
    raw.worlds.forEach((w) => {
      try {
        const world = S.prepareWorld(w.folder, w.files);
        // Image files in the folder, by path relative to it (the page makes URLs; never saved).
        world.assets = w.assets;
        worlds.push(world);
      } catch (err) {
        errors.push(`${w.folder}: ${err.message}`);
      }
    });
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
    req(c.portrait == null || c.portrait === false || E.isImagePath(c.portrait), `character "${c.id}" portrait must be an image path inside the world folder, like "portraits/${c.id}.png" (or false for initials only)`);
    req(c.people == null || (typeof c.people === 'string' && c.people.trim() && c.people.length <= 60), `character "${c.id}" people must be text of at most 60 characters`);
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

  // ---------- the region tree (R-1) ----------
  // A region's optional "parent" puts it inside another; regions without one
  // sit under the world. Depth varies by branch, up to S.REGION_DEPTH levels.
  // Pure helpers over a list of region definitions, shared by validation, the
  // engine (Eng.regionChain and friends) and the prompts.
  S.REGION_DEPTH = 6;
  S.REGION_NEAR = 8;
  // Built on every call: the creator edits regions in place.
  function tree(list) {
    const regions = Array.isArray(list) ? list : [];
    const byId = new Map();
    const kids = new Map([[null, []]]);
    regions.forEach((r) => { if (isObj(r) && r.id != null && !byId.has(r.id)) { byId.set(r.id, r); kids.set(r.id, []); } });
    byId.forEach((r) => (kids.get(r.parent != null && byId.has(r.parent) ? r.parent : null) || kids.get(null)).push(r.id));
    return { byId, kids };
  }
  // The region and its ancestors, nearest first (stops at a loop).
  S.regionChainIn = function (list, id) {
    const { byId } = tree(list);
    const out = [];
    for (let r = byId.get(id); r && !out.includes(r.id); r = r.parent != null ? byId.get(r.parent) : null) out.push(r.id);
    return out;
  };
  // The regions directly inside one (null: the top level).
  S.regionChildrenIn = (list, id) => (tree(list).kids.get(id == null ? null : id) || []).slice();
  // What's near a region: where its routes go (R-2; neighbours, and routes
  // to it that aren't one-way), then its siblings (only under a
  // real parent: the top level of a 200-country map isn't "near"), then its
  // children; never itself or its chain. Capped, so a big tree doesn't grow
  // the prompts.
  S.regionNearIn = function (list, id, cap) {
    const { byId } = tree(list);
    const r = byId.get(id);
    if (!r) return [];
    const chain = S.regionChainIn(list, id);
    const out = [];
    const add = (x) => { if (byId.has(x) && !chain.includes(x) && !out.includes(x)) out.push(x); };
    (Array.isArray(r.routes) ? r.routes : []).forEach((x) => x && add(x.to));
    (r.neighbours || []).forEach(add);
    byId.forEach((o) => (Array.isArray(o.routes) ? o.routes : []).forEach((x) => { if (x && x.to === id && x.oneWay !== true) add(o.id); }));
    if (r.parent != null && byId.has(r.parent)) S.regionChildrenIn(list, r.parent).forEach(add);
    S.regionChildrenIn(list, id).forEach(add);
    return out.slice(0, cap == null ? S.REGION_NEAR : cap);
  };
  // ---------- routes (R-2) ----------
  // How people get from one region to another: [{to, kind, time, requires,
  // oneWay, risky, skill, failHarm}] on a region, everything but "to"
  // optional. Kinds have default times (a border is part of a move, as
  // before routes); a world's routeKinds overrides them. Times are "45m",
  // "4h", "2d", "1h30m" or a number of hours.
  S.ROUTE_KINDS = {
    border: { time: 0 }, checkpoint: { time: 0 }, portal: { time: 0 },
    road: { time: 2 }, rail: { time: 2 }, air: { time: 6 }, sea: { time: 24 }, hyperlane: { time: 48 },
  };
  S.ROUTE_HOURS = 1; // a kind the table doesn't know
  S.ROUTE_FIELDS = ['to', 'kind', 'time', 'requires', 'oneWay', 'risky', 'skill', 'failHarm', 'derived'];
  S.parseHours = function (v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
    const m = /^\s*(?:(\d+(?:\.\d+)?)\s*d)?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*$/i.exec(String(v == null ? '' : v));
    if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
    return Number(m[1] || 0) * 24 + Number(m[2] || 0) + Number(m[3] || 0) / 60;
  };
  // "45m", "4h", "1h30m", "2d", "2d 6h".
  S.sayHours = function (h) {
    if (!(h > 0)) return '';
    const mins = Math.round(h * 60);
    const d = Math.floor(mins / 1440), hh = Math.floor((mins % 1440) / 60), mm = mins % 60;
    return [d ? `${d}d` : '', hh ? `${hh}h` : '', mm ? `${mm}m` : ''].filter(Boolean).join(' ');
  };
  // Neighbours become border routes, on the list given (a composed copy).
  // A neighbour with a route of its own either way stays that route (the
  // junction's road to Ridge isn't undercut by Ridge's border back).
  S.deriveRoutes = function (regions) {
    const list = (Array.isArray(regions) ? regions : []).filter(isObj);
    const own = new Map(list.map((r) => [r.id, (Array.isArray(r.routes) ? r.routes : []).filter((x) => isObj(x) && !x.derived).map((x) => x.to)]));
    list.forEach((r) => {
      const routes = Array.isArray(r.routes) ? r.routes.filter(isObj).map((x) => Object.assign({}, x)) : [];
      (Array.isArray(r.neighbours) ? r.neighbours : []).forEach((n) => {
        if (routes.some((x) => x.to === n) || (own.get(n) || []).includes(r.id)) return;
        routes.push({ to: n, kind: 'border', derived: true });
      });
      if (routes.length || r.routes != null) r.routes = routes;
    });
    return regions;
  };
  // A route with its kind's defaults filled in: { to, kind, hours, requires,
  // oneWay, risky, skill, failHarm }.
  S.routeOf = function (sc, route) {
    const kind = typeof route.kind === 'string' && route.kind.trim() ? route.kind.trim() : 'border';
    const base = Object.assign({}, S.ROUTE_KINDS[kind] || { time: S.ROUTE_HOURS }, isObj(sc.routeKinds) && isObj(sc.routeKinds[kind]) ? sc.routeKinds[kind] : {});
    const pick = (k) => (route[k] != null ? route[k] : base[k]);
    const hours = S.parseHours(pick('time'));
    const skills = sc.skills || E.DEFAULT_SKILLS;
    return {
      to: route.to, kind, hours: hours == null ? S.ROUTE_HOURS : hours, requires: pick('requires') || null,
      oneWay: route.oneWay === true, risky: pick('risky') === true, failHarm: pick('failHarm') === true,
      skill: pick('skill') || (skills.includes('stealth') ? 'stealth' : skills[0]),
    };
  };
  // Problems in one route or route-kind setting, in words.
  function routeProblems(sc, r, where, refs, ids) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(`${where}: ${msg}`); };
    if (ids) {
      Object.keys(r).filter((k) => !S.ROUTE_FIELDS.includes(k)).forEach((k) => req(false, `unknown field "${k}"`));
      req(ids.has(r.to), r.to == null ? 'needs "to" (the region it goes to)' : `goes to "${r.to}", which isn't one of the regions`);
      req(r.kind == null || (typeof r.kind === 'string' && r.kind.trim() && r.kind.length <= 30), '"kind" must be a short word, such as road, rail or sea');
    }
    req(r.time == null || S.parseHours(r.time) != null, `"time" must be like "45m", "4h", "1h30m" or "2d" (got ${JSON.stringify(r.time)})`);
    ['oneWay', 'risky', 'failHarm'].forEach((k) => req(r[k] == null || typeof r[k] === 'boolean', `"${k}" must be true or false`));
    req(r.skill == null || (sc.skills || E.DEFAULT_SKILLS).includes(r.skill), `"skill" must be one of the world's skills (got "${r.skill}")`);
    if (r.requires != null) problems.push(...E.Timeline.preconditionProblems(r.requires, `${where}: "requires"`, refs));
    return problems;
  }

  // The display word for a region: its own label, else the world's for its depth.
  S.regionLabel = function (sc, id) {
    const r = tree(sc.regions).byId.get(id);
    if (!r) return null;
    if (typeof r.label === 'string' && r.label.trim()) return r.label;
    const labels = Array.isArray(sc.regionLabels) ? sc.regionLabels : [];
    return labels[S.regionChainIn(sc.regions, id).length - 1] || null;
  };

  function regionProblems(sc) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    const groupIds = new Set((sc.factions || []).map((f) => f.id));
    const list = sc.regions == null ? [] : Array.isArray(sc.regions) ? sc.regions : [null];
    const ids = new Set(list.filter(isObj).map((r) => r.id));
    const byId = new Map(list.filter(isObj).map((r) => [r.id, r]));
    const nameOf = (r) => (r && typeof r.name === 'string' && r.name.trim() ? r.name : `"${r && r.id}"`);
    const seen = new Set();
    const routeRefs = { regions: ids, groups: groupIds, clocks: new Set((sc.clocks || []).map((c) => c && c.id)), characters: new Set(sc.characters || []) };
    if (sc.routeKinds != null) {
      if (!isObj(sc.routeKinds)) problems.push('"routeKinds" must be an object: {kind: {time, requires, risky}}');
      else Object.entries(sc.routeKinds).forEach(([k, v]) => {
        if (!isObj(v)) return problems.push(`routeKinds.${k} must be {time, requires, risky, skill, failHarm}`);
        Object.keys(v).filter((f) => !['time', 'requires', 'risky', 'skill', 'failHarm'].includes(f)).forEach((f) => problems.push(`routeKinds.${k}: unknown field "${f}"`));
        problems.push(...routeProblems(sc, v, `routeKinds.${k}`, routeRefs, null));
      });
    }
    req(sc.regionLabels == null || (Array.isArray(sc.regionLabels) && sc.regionLabels.length <= S.REGION_DEPTH && sc.regionLabels.every((t) => typeof t === 'string' && t.trim() && t.length <= 30)),
      `"regionLabels" must be a list of at most ${S.REGION_DEPTH} short words, one per level from the top (such as ["nation", "province", "city"])`);
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
      req(r.startable == null || typeof r.startable === 'boolean', `${where}: "startable" must be true or false`);
      req(r.notable == null || typeof r.notable === 'boolean', `${where}: "notable" must be true or false`);
      req(r.wiki == null || (isObj(r.wiki) && [r.wiki.title, r.wiki.wikidata].every((v) => v == null || (typeof v === 'string' && v.trim()))), `${where}: "wiki" must be {title, wikidata}`);
      req(r.label == null || (typeof r.label === 'string' && r.label.trim() && r.label.length <= 30), `${where}: "label" must be a short word (30 characters at most), such as "province"`);
      if (r.parent != null) req(ids.has(r.parent), `${nameOf(r)} is inside "${r.parent}", which isn't one of the regions`);
      if (r.routes != null && !Array.isArray(r.routes)) problems.push(`${where}: "routes" must be a list of {to, kind, time, requires}`);
      (Array.isArray(r.routes) ? r.routes : []).forEach((x, i) => {
        if (!isObj(x)) return problems.push(`${where}: route ${i + 1} must be {to, kind, time, requires}`);
        problems.push(...routeProblems(sc, x, `${nameOf(r)}'s route to ${byId.has(x.to) ? nameOf(byId.get(x.to)) : `"${x.to}"`}`, routeRefs, ids));
        req(x.to !== r.id, `${nameOf(r)} has a route to itself`);
      });
      if (r.neighbours != null && !Array.isArray(r.neighbours)) return problems.push(`${where}: "neighbours" must be a list of region ids`);
      (r.neighbours || []).forEach((n) => req(ids.has(n) && n !== r.id, `${where}: unknown neighbour "${n}"`));
    });
    // The tree (R-1): no loops, at most S.REGION_DEPTH levels, in plain words.
    const looped = new Set();
    list.filter(isObj).forEach((r) => {
      const path = [r];
      for (let p = byId.get(r.parent); p; p = byId.get(p.parent)) {
        if (p === r) {
          // "Paris is inside Lyon, which is inside Paris"
          if (!path.some((x) => looped.has(x.id))) problems.push(`${nameOf(r)} is inside ${path.slice(1).concat(r).map(nameOf).join(', which is inside ')}`);
          path.forEach((x) => looped.add(x.id));
          return;
        }
        if (path.includes(p)) return; // a loop further up, reported from there
        path.push(p);
      }
      if (path.length > S.REGION_DEPTH) problems.push(`${nameOf(r)} is ${path.length} levels deep (inside ${path.slice(1).map(nameOf).join(' › ')}); ${S.REGION_DEPTH} is the most`);
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
      // A feature is a short name, or { name, state } for one the engine tracks (task 3-6).
      const featOk = (f) => (typeof f === 'string' && f.trim() && f.length <= 30) || (isObj(f) && typeof f.name === 'string' && f.name.trim() && f.name.length <= 30 && (f.state == null || (typeof f.state === 'string' && f.state.length <= 20)));
      req(l.features == null || (Array.isArray(l.features) && l.features.length <= 6 && l.features.every(featOk)),
        `${where}: "features" must be a list of at most 6 short names (30 characters each), or {name, state}`);
      if (l.links == null) return;
      if (!Array.isArray(l.links)) return problems.push(`${where}: "links" must be a list of {to, kind}`);
      l.links.forEach((k) => {
        const ok = k && locIds.has(k.to) && k.to !== l.id;
        req(ok, `${where}: link to unknown room "${k && k.to}"`);
        req(k && S.LINK_KINDS.includes(k.kind), `${where}: link to "${k && k.to}" needs a kind: ${S.LINK_KINDS.join(', ')}`);
        // Who holds the key to a locked door (task 3-6): characters in this start.
        req(!k || k.key == null || (Array.isArray(k.key) && k.key.every((id) => (sc.characters || []).includes(id))), `${where}: link to "${k && k.to}" has a "key" for someone not in the cast`);
        if (ok) { l.connects = l.connects || []; if (!l.connects.includes(k.to)) l.connects.push(k.to); }
      });
    });
    // Secure rooms (vault, cell) have exactly one way in.
    locs.filter((l) => l.secure).forEach((l) => {
      const ways = new Set((l.connects || []).concat(locs.filter((o) => (o.connects || []).includes(l.id)).map((o) => o.id)));
      req(ways.size === 1, `location "${l.id}" is secure, so it needs exactly one way in (it has ${ways.size})`);
    });
    // Ways in from outside (task 3-6); watched ones count when sneaking.
    (sc.entrances == null ? [] : Array.isArray(sc.entrances) ? sc.entrances : [null]).forEach((e) => {
      if (!isObj(e)) return problems.push('"entrances" must be a list of {room, kind, watched}');
      req(locIds.has(e.room), `entrance in unknown room "${e.room}"`);
      req(e.kind == null || (typeof e.kind === 'string' && e.kind.length <= 30), `entrance in "${e.room}": "kind" must be a short phrase`);
      req(e.watched == null || typeof e.watched === 'boolean', `entrance in "${e.room}": "watched" must be true or false`);
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

  // The world map (task 3-4): an image with a polygon or a point per region,
  // and optional points for rooms, all in image pixels. Regions it leaves out
  // get a point placed automatically (validateWorld warns).
  S.FACTION_COLORS = 8;
  S.PLACE_KINDS = ['capital', 'city', 'town', 'place'];
  function mapProblems(sc, locIds) {
    if (sc.map == null) return [];
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    const m = sc.map;
    if (!isObj(m) || !E.isImagePath(m.image) || !(m.width > 0) || !(m.height > 0)) return ['"map" needs an "image" in the world folder, a "width" and a "height"'];
    const regionIds = new Set((Array.isArray(sc.regions) ? sc.regions : []).map((r) => r && r.id));
    const inside = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number') && p[0] >= 0 && p[1] >= 0 && p[0] <= m.width && p[1] <= m.height;
    Object.entries(isObj(m.regions) ? m.regions : {}).forEach(([id, shape]) => {
      req(regionIds.has(id), `map: unknown region "${id}"`);
      if (isObj(shape) && shape.polygon != null) {
        req(Array.isArray(shape.polygon) && shape.polygon.length >= 3, `map: region "${id}" polygon needs at least 3 points`);
        req(Array.isArray(shape.polygon) && shape.polygon.every(inside), `map: region "${id}" polygon has a point outside the image`);
      } else if (isObj(shape) && shape.polygons != null) {
        // A region in several pieces (islands; task 4-5).
        const ok = Array.isArray(shape.polygons) && shape.polygons.length && shape.polygons.every((r) => Array.isArray(r) && r.length >= 3);
        req(ok, `map: region "${id}" "polygons" must be a list of pieces, each of at least 3 points`);
        if (ok) req(shape.polygons.every((r) => r.every(inside)), `map: region "${id}" has a point outside the image`);
      } else if (isObj(shape) && shape.point != null) {
        req(inside(shape.point), `map: region "${id}" point is outside the image`);
      } else problems.push(`map: region "${id}" needs a "polygon", "polygons" or a "point"`);
    });
    // Where the image is on the globe (task 4-5), and named places on it:
    // capitals and cities with no rooms, which the story knows by name.
    problems.push(...E.Geo.projectionProblems(m));
    req(m.base == null || (typeof m.base === 'string' && m.base.trim()), 'map: "base" must be the id of the base map it was cut from');
    ['credit', 'license'].forEach((k) => req(m[k] == null || typeof m[k] === 'string', `map: "${k}" must be text`));
    if (m.places != null && !Array.isArray(m.places)) problems.push('map: "places" must be a list of {id, name, kind, at, region}');
    const placeIds = new Set();
    (Array.isArray(m.places) ? m.places : []).forEach((pl) => {
      const where = `map: place "${(pl && pl.id) || '?'}"`;
      if (!isObj(pl)) return problems.push('map: "places" must be a list of {id, name, kind, at, region}');
      req(typeof pl.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(pl.id), `${where}: "id" must be lowercase letters, digits, - or _`);
      req(!placeIds.has(pl.id), `${where} is listed twice`);
      placeIds.add(pl.id);
      req(!regionIds.has(pl.id) && !locIds.has(pl.id), `${where}: id is already a region or a room`);
      req(typeof pl.name === 'string' && pl.name.trim() && pl.name.length <= 60, `${where}: "name" must be text of at most 60 characters`);
      req(S.PLACE_KINDS.includes(pl.kind || 'place'), `${where}: "kind" must be one of ${S.PLACE_KINDS.join(', ')}`);
      req(inside(pl.at), `${where}: "at" must be a point inside the image`);
      req(pl.region == null || regionIds.has(pl.region), `${where}: unknown region "${pl.region}"`);
      req(pl.notable == null || typeof pl.notable === 'boolean', `${where}: "notable" must be true or false`);
    });
    // Rooms may belong to another start (the map is the world's); unknown ids
    // are checked once against every start in validateWorld.
    Object.entries(isObj(m.locations) ? m.locations : {}).forEach(([id, p]) => req(inside(p), `map: location "${id}" is outside the image`));
    return problems;
  }

  // Catches authoring mistakes early with readable messages.
  S.validate = function (sc) {
    const problems = [];
    const req = (cond, msg) => { if (!cond) problems.push(msg); };
    req(sc.title, 'missing "title"');
    req(sc.setting, 'missing "setting"');
    req(Array.isArray(sc.characters) && sc.characters.length, 'missing "characters" list');
    // A start with a playerSlot may leave the player to the character creator (task 4-1).
    if (sc.player != null || !sc.playerSlot) req(sc.characters && sc.characters.includes(sc.player), '"player" must be one of "characters"');
    req(Array.isArray(sc.locations) && sc.locations.length, 'missing "locations"');
    sc.skills = sc.skills || E.DEFAULT_SKILLS.slice();
    // No needs unless the world lists them (task 1-5: a world without needs plays fine).
    sc.needs = sc.needs || [];
    req(Array.isArray(sc.needs) && sc.needs.every((n) => n && n.id), '"needs" must be a list of {id, label, perHour}');
    const needIds = (Array.isArray(sc.needs) ? sc.needs : []).map((n) => n && n.id);
    // What happens to a player who goes without it too long (playtest-coffee-bystander).
    (Array.isArray(sc.needs) ? sc.needs : []).forEach((n) => {
      const l = n && n.limit;
      if (l == null) return;
      const where = `need "${n.id}" limit`;
      req(isObj(l), `${where} must be an object`);
      if (!isObj(l)) return;
      req(l.relief == null || (Array.isArray(l.relief) && l.relief.length && l.relief.every((w) => typeof w === 'string' && w.trim())), `${where}: "relief" must be a list of words`);
      ['missing', 'text'].forEach((k) => req(l[k] == null || (typeof l[k] === 'string' && l[k].trim()), `${where}: "${k}" must be text`));
      req(l.worst == null || ['ok', 'hurt', 'badly_hurt', 'dead'].includes(l.worst), `${where}: "worst" must be ok, hurt, badly_hurt or dead`);
      req(l.grace == null || (typeof l.grace === 'number' && l.grace >= 0), `${where}: "grace" must be hours (0 or more)`);
      req(l.after == null || (typeof l.after === 'number' && l.after >= 0 && l.after < 1), `${where}: "after" must be between 0 and 1`);
    });
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
    (sc.factions || []).forEach((f) => req(f.color == null || (Number.isInteger(f.color) && f.color >= 1 && f.color <= S.FACTION_COLORS), `group "${f.id}": "color" must be a whole number from 1 to ${S.FACTION_COLORS} (a theme colour)`));
    if (sc.playerSlot != null && Array.isArray(sc.characters)) problems.push(...E.CharMaker.slotProblems(sc));
    problems.push(...mapProblems(sc, locIds));
    problems.push(...regionProblems(sc));
    problems.push(...standeeProblems(sc, locIds, extraIds));
    // The timeline (task 5-2): shape here; people and clocks are checked
    // across the whole world in validateWorld.
    problems.push(...E.Timeline.problems(sc.timeline, 'scenario', {
      regions: new Set((sc.regions || []).map((r) => r && r.id)), groups: new Set((sc.factions || []).map((f) => f && f.id)), effectKeys: Object.keys(E.Engine.EFFECTS),
    }, []));
    problems.push(...projectProblems(sc.projectTimeline));
    // Lore (task 5-1): its shape here; rooms and people are checked across
    // the whole world in validateWorld.
    if (sc.lore != null) {
      if (!Array.isArray(sc.lore)) problems.push('"lore" must be a list of entries');
      else {
        problems.push(...E.Lore.problems(sc.lore, 'scenario'));
        const regionIds = new Set((sc.regions || []).map((r) => r && r.id));
        sc.lore.forEach((e) => { if (isObj(e) && e.level === 'region' && !regionIds.has(e.ref)) problems.push(`lore "${e.id}" is about unknown region "${e.ref}"`); });
      }
    }
    // fireHarm: who it hurts when it goes off ("all" or "outside"); repeat: it
    // starts again after going off (playtest-coffee-skips). Follow-ups nest.
    const clockShape = (c, where) => {
      Object.keys(c.fireWorld || {}).forEach((k) => req(sc.world && k in sc.world, `${where} "${c.id}" fireWorld key "${k}" not in world`));
      req(c.fireHarm == null || ['all', 'outside'].includes(c.fireHarm), `${where} "${c.id}": "fireHarm" must be "all" or "outside"`);
      req(c.repeat == null || typeof c.repeat === 'boolean', `${where} "${c.id}": "repeat" must be true or false`);
      (c.then || []).forEach((t) => {
        req(t.id && t.name && t.max > 0, `clock "${c.id}" has a follow-up ("then") without id, name and max`);
        clockShape(t, 'follow-up clock');
      });
    };
    (sc.clocks || []).forEach((c) => {
      req(c.id && c.name && c.max > 0, `clock "${c.id || '?'}" needs id, name and max`);
      clockShape(c, 'clock');
    });
    if (problems.length) throw new Error(`Scenario "${sc.title || sc.folder}" has problems:\n- ` + problems.join('\n- '));
    return sc;
  };
})(typeof window !== 'undefined' ? window : globalThis);
