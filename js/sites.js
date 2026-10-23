// Generated sites (task 4-4). When the story goes somewhere the map doesn't
// have (the pharmacy on Main Street, the Saints' chop shop), the engine
// builds it: a library map from the world's sites/ when one fits (the model
// then fills in only people and details), otherwise a layout from the model;
// then the people and groups there. Each piece is checked before use and
// retried with the problem named (StartGen's retry loop). The model only
// proposes the place (the intent step's "new_place", or an event's
// "new_site"); the engine decides whether to build it.
//
// A site's rooms join state.locations with `site` set; a "route" link joins
// its entry room to the site the player came from (never locked, no sight
// through it, groups never cross it). Sites fade unless something happened
// there: kept after a notable fact, a promoted person or a second visit;
// otherwise removed keepDays after the last visit, back to a stub (name,
// kind, region and a line about the visit) that a return rebuilds. DOM-free.
(function (root) {
  const E = root.Ensemble;
  const ST = (E.Sites = {});
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const text = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const norm = (t) => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const slug = (t) => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  const Eng = () => E.Engine;

  ST.HOME = 'home';
  const REFERS_BACK = /\b(?:the plan|do it|let'?s go|let'?s move|move out|enact|carry (?:it |that )?out|go now|head out|hit it|we go|time to go)\b/i;
  ST.ROOMS = [2, 6];
  ST.DEFAULTS = { maxSites: 8, keepDays: 3 };
  ST.KINDS = ['open', 'door', 'locked door', 'vent', 'hatch', 'window', 'stairs'];
  ST.config = (sc) => Object.assign({}, ST.DEFAULTS, sc.generatedSites || {});
  ST.enabled = (sc) => isObj(sc.generatedSites);
  ST.siteOf = (state, room) => (state.locations[room] && state.locations[room].site) || ST.HOME;
  ST.playerSite = (state) => ST.siteOf(state, state.characters[state.player].status.location);
  ST.rooms = (state, site) => Object.values(state.locations).filter((l) => (l.site || ST.HOME) === site);
  ST.byName = (state, name) => Object.values(state.sites || {}).find((s) => norm(s.name) === norm(name)) || null;
  ST.hours = (t) => t.day * 24 + t.hour;

  // ---------- world settings and library maps ----------
  ST.configProblems = function (world) {
    const g = world.generatedSites;
    if (g == null) return [];
    if (!isObj(g)) return ['"generatedSites" must be an object like {"maxSites": 8, "keepDays": 3}'];
    const out = [];
    Object.keys(g).filter((k) => !['maxSites', 'keepDays', 'library'].includes(k)).forEach((k) => out.push(`generatedSites: unknown field "${k}"`));
    if (g.library != null && !(Array.isArray(g.library) && g.library.length && g.library.every((t) => typeof t === 'string' && t.trim()))) out.push('generatedSites: "library" must be a list of setting tags, like ["modern"]');
    if (g.maxSites != null && !(Number.isInteger(g.maxSites) && g.maxSites >= 1 && g.maxSites <= 30)) out.push('generatedSites: "maxSites" must be a whole number from 1 to 30');
    if (g.keepDays != null && !(Number.isInteger(g.keepDays) && g.keepDays >= 1 && g.keepDays <= 60)) out.push('generatedSites: "keepDays" must be a whole number from 1 to 60');
    return out;
  };
  // ---------- geometry (task 6-3) ----------
  // Room shapes on a map image: polygons [[x, y], …] in image pixels.
  const G = (ST.Geo = {});
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  G.segDist = function (p, a, b) {
    const l2 = d2(a, b);
    if (!l2) return Math.sqrt(d2(p, a));
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2));
    return Math.sqrt(d2(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]));
  };
  G.edgeDist = (p, poly) => Math.min(...poly.map((a, i) => G.segDist(p, a, poly[(i + 1) % poly.length])));
  G.inside = function (p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  G.area = (poly) => Math.abs(poly.reduce((s, a, i) => { const b = poly[(i + 1) % poly.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
  G.centroid = function (poly) {
    let a = 0, x = 0, y = 0;
    poly.forEach((p, i) => { const q = poly[(i + 1) % poly.length]; const c = p[0] * q[1] - q[0] * p[1]; a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c; });
    if (Math.abs(a) < 1e-9) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
    return [x / (3 * a), y / (3 * a)];
  };
  G.bbox = (poly) => { const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; };
  // Where two shapes meet: the corners of each within tol of the other's
  // edges. → { a, b, mid } (the stretch they share), or null.
  G.shared = function (A, B, tol) {
    tol = tol == null ? 8 : tol;
    const pts = A.filter((p) => G.edgeDist(p, B) <= tol).concat(B.filter((p) => G.edgeDist(p, A) <= tol));
    if (!pts.length) return null;
    let best = [pts[0], pts[0]];
    pts.forEach((p) => pts.forEach((q) => { if (d2(p, q) > d2(best[0], best[1])) best = [p, q]; }));
    return { a: best[0], b: best[1], mid: [(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2].map(Math.round) };
  };
  // Shapes overlap when a corner of one lies well inside the other.
  G.overlaps = (A, B, tol) => A.some((p) => G.inside(p, B) && G.edgeDist(p, B) > (tol || 8)) || B.some((p) => G.inside(p, A) && G.edgeDist(p, A) > (tol || 8));

  // A grid's unit, "5 ft" → { n: 5, word: "ft" }.
  const unitOf = (u) => { const m = String(u || '').match(/^\s*([\d.]+)\s*(.*)$/); return m ? { n: Number(m[1]) || 1, word: m[2].trim() } : { n: 1, word: String(u || '').trim() }; };
  // Measuring only (play is free-form): a room's size from its area in grid
  // squares, and "about 30 × 20 ft" for the narrator.
  ST.roomSize = function (shape, grid) {
    if (!grid || !(grid.square > 0) || !Array.isArray(shape) || shape.length < 3) return null;
    const squares = G.area(shape) / (grid.square * grid.square);
    return squares < 10 ? 'small' : squares < 30 ? 'medium' : 'large';
  };
  ST.dims = function (shape, grid) {
    if (!grid || !(grid.square > 0) || !Array.isArray(shape) || shape.length < 3) return null;
    const u = unitOf(grid.unit);
    const b = G.bbox(shape);
    const r = (px) => Math.max(u.n, Math.round(px / grid.square) * u.n);
    return `about ${r(b.w)} × ${r(b.h)}${u.word ? ' ' + u.word : ''}`;
  };
  // Where a door marker goes: the link's "at", else the middle of the edge
  // the two rooms share, else null (no shapes, or they don't touch).
  ST.doorAt = function (m, a, b) {
    const ra = (m.rooms || []).find((r) => r.id === a), rb = (m.rooms || []).find((r) => r.id === b);
    const k = ((ra && ra.links) || []).find((x) => x.to === b) || ((rb && rb.links) || []).find((x) => x.to === a);
    if (k && Array.isArray(k.at)) return k.at;
    if (!ra || !rb || !Array.isArray(ra.shape) || !Array.isArray(rb.shape)) return null;
    const s = G.shared(ra.shape, rb.shape, m.width ? m.width / 100 : 8);
    return s ? s.mid : null;
  };

  // A library map (sites/<id>.json): { id, name, type, tags, setting, rooms,
  // entry, entrances, credit, license }, rooms in the room format of a start.
  // Task 6-3 adds an image layer, all optional: image, width, height, grid
  // {square, unit}, a shape per room, "at" on links and entrances, and spots.
  ST.SPOTS = ['guard post', 'cover', 'hide', 'loot', 'spawn'];
  ST.mapProblems = function (m, id) {
    const where = `sites/${id}.json`;
    if (!isObj(m)) return [`${where} is not an object`];
    const out = [];
    const req = (c, msg) => { if (!c) out.push(`${where}: ${msg}`); };
    req(m.id === id, `has id "${m.id}"`);
    req(typeof m.type === 'string' && m.type.trim(), 'needs a "type" (warehouse, tavern, farmhouse…)');
    req(m.tags == null || (Array.isArray(m.tags) && m.tags.every((t) => typeof t === 'string')), '"tags" must be a list of words');
    req(m.setting == null || (Array.isArray(m.setting) && m.setting.every((t) => typeof t === 'string' && t.trim())), '"setting" must be a list of setting tags, like ["modern"]');
    req(typeof m.credit === 'string' && m.credit.trim() && typeof m.license === 'string' && m.license.trim(), 'needs "credit" and "license"');
    const hasImage = m.image != null;
    if (hasImage) req(E.isImagePath(m.image) && m.width > 0 && m.height > 0, '"image" needs an image path, a "width" and a "height"');
    const pt = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)) && (!hasImage || (p[0] >= 0 && p[1] >= 0 && p[0] <= m.width && p[1] <= m.height));
    if (m.grid != null) req(isObj(m.grid) && m.grid.square > 0 && (m.grid.unit == null || (typeof m.grid.unit === 'string' && m.grid.unit.length <= 20)), '"grid" must be {"square": pixels, "unit": "5 ft"}');
    const rooms = Array.isArray(m.rooms) ? m.rooms : [];
    req(rooms.length >= ST.ROOMS[0], `needs at least ${ST.ROOMS[0]} rooms`);
    const ids = new Set(rooms.map((r) => r && r.id));
    rooms.forEach((r) => {
      req(r && typeof r.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(r.id) && r.name && r.desc, 'every room needs an id, a name and a desc');
      if (r && r.shape != null) req(hasImage && Array.isArray(r.shape) && r.shape.length >= 3 && r.shape.every(pt), `room "${r.id}": "shape" needs at least 3 points inside the image`);
      (r && r.links || []).forEach((k) => {
        req(k && ids.has(k.to), `room "${r.id}" links to unknown "${k && k.to}"`);
        req(k && ST.KINDS.includes(k.kind), `room "${r.id}": link kind must be one of ${ST.KINDS.join(', ')}`);
        if (k && k.at != null) req(hasImage && pt(k.at), `room "${r.id}": the door to "${k.to}" must be "at" a point inside the image`);
      });
    });
    req(ids.has(m.entry), `"entry" must be one of its rooms`);
    (m.entrances || []).forEach((e) => {
      req(e && ids.has(e.room), `entrance in unknown room "${e && e.room}"`);
      if (e && e.at != null) req(hasImage && pt(e.at), `the entrance in "${e.room}" must be "at" a point inside the image`);
    });
    if (m.spots != null && !Array.isArray(m.spots)) req(false, '"spots" must be a list of {kind, room, at, label}');
    (Array.isArray(m.spots) ? m.spots : []).forEach((sp) => {
      req(isObj(sp) && ST.SPOTS.includes(sp.kind), `a spot's "kind" must be one of ${ST.SPOTS.join(', ')}`);
      req(isObj(sp) && ids.has(sp.room), `spot in unknown room "${sp && sp.room}"`);
      if (isObj(sp) && sp.at != null) req(hasImage && pt(sp.at), `a spot in "${sp.room}" must be "at" a point inside the image`);
      if (isObj(sp)) req(sp.label == null || (typeof sp.label === 'string' && sp.label.trim() && sp.label.length <= 30), 'a spot\'s "label" must be short text (30 characters)');
    });
    return out;
  };
  // What a map's author should look at, without stopping it loading: a
  // secure room with more than one way in, shapes that overlap, a door
  // between rooms whose shapes don't touch.
  ST.mapWarnings = function (m, id) {
    const out = [];
    if (!isObj(m) || !Array.isArray(m.rooms)) return out;
    const where = `sites/${id}.json`;
    const ways = (rid) => new Set(m.rooms.flatMap((r) => (!r ? [] : r.id === rid ? (r.links || []).map((k) => k.to).concat(r.connects || []) : (r.links || []).some((k) => k.to === rid) || (r.connects || []).includes(rid) ? [r.id] : [])));
    m.rooms.filter((r) => r && r.secure).forEach((r) => {
      const n = ways(r.id).size + (m.entrances || []).filter((e) => e && e.room === r.id).length;
      if (n > 1) out.push(`${where}: room "${r.id}" is secure (one way in) but has ${n} ways in`);
    });
    const shaped = m.rooms.filter((r) => r && Array.isArray(r.shape) && r.shape.length >= 3);
    const tol = m.width ? m.width / 100 : 8;
    shaped.forEach((a, i) => shaped.slice(i + 1).forEach((b) => {
      if ((a.level || 0) === (b.level || 0) && G.overlaps(a.shape, b.shape, tol)) out.push(`${where}: rooms "${a.id}" and "${b.id}" overlap`);
    }));
    shaped.forEach((a) => (a.links || []).forEach((k) => {
      const b = shaped.find((x) => x.id === k.to);
      if (b && !['stairs', 'hatch', 'vent'].includes(k.kind) && !Array.isArray(k.at) && !G.shared(a.shape, b.shape, tol)) out.push(`${where}: rooms "${a.id}" and "${b.id}" are joined by a ${k.kind}, but their shapes don't touch`);
    }));
    return out;
  };
  // Library maps that fit a kind of place: the type or a tag among the
  // kind's words. A world's own maps come before the shared library's
  // (task 6-3). The pick is seeded by the site id, so a reload picks the same.
  ST.libraryFits = function (sc, kind) {
    const words = norm(kind).split(' ').filter((w) => w.length > 2).map((w) => w.replace(/s$/, ''));
    const fits = Object.values(sc.siteMaps || {}).filter((m) => {
      const keys = [m.type].concat(m.tags || []).map((t) => norm(t).replace(/s$/, ''));
      return words.some((w) => keys.some((k) => k === w || k.split(' ').includes(w)));
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    const own = fits.filter((m) => !m.library);
    return own.length ? own : fits;
  };
  ST.libraryMatch = function (sc, kind, seed) {
    const fits = ST.libraryFits(sc, kind);
    return fits.length ? fits[E.hash(String(seed)) % fits.length] : null;
  };
  // A site built in play → a site map to keep (task 6-3): its rooms as they
  // were laid out (size, level, outside, secure, authored features and ways),
  // without the route back, the people, live state (doors, feature states)
  // or anything the engine inferred during play. No image: the generated
  // plan stays its layout. credit and license are left for the author.
  ST.toMap = function (state, siteId) {
    const s = state.sites && state.sites[siteId];
    if (!s || s.stub) throw new Error(`"${(s && s.name) || siteId}" was never built, so there is no map to keep.`);
    const own = ST.rooms(state, siteId);
    const ids = new Set(own.map((l) => l.id));
    const rooms = own.map((l) => {
      // (Measurements added from a grid come back when the map is used again.)
      const r = { id: l.id, name: l.name, desc: String(l.desc || l.name).replace(/ \(about [^)]+\)\.$/, '.') };
      ['size', 'level', 'outside', 'secure', 'shape'].forEach((k) => { if (l[k] != null) r[k] = E.clone(l[k]); });
      const feats = (l.features || []).filter((f) => !(f && f.inferred)).map((f) => (isObj(f) ? (f.state != null ? { name: f.name, state: f.state } : f.name) : f));
      if (feats.length) r.features = feats;
      const inferredTo = new Set((l.links || []).filter((k) => k.inferred).map((k) => k.to));
      const links = (l.links || []).filter((k) => k.kind !== 'route' && !k.inferred && ids.has(k.to)).map((k) => Object.assign({ to: k.to, kind: k.kind }, Array.isArray(k.at) ? { at: k.at } : {}));
      if (links.length) r.links = links;
      const connects = (l.connects || []).filter((c) => ids.has(c) && !inferredTo.has(c) && !links.some((k) => k.to === c));
      if (connects.length) r.connects = connects;
      return r;
    });
    const map = { id: slug(s.name) || siteId, name: s.name, type: norm(s.kind).split(' ').pop() || 'place', tags: [...new Set(norm(s.kind).split(' ').filter((w) => w.length > 2))],
      credit: '', license: '', entry: s.entry, rooms };
    const entrances = (s.entrances || []).filter((e) => e && ids.has(e.room)).map((e) => Object.assign({}, e));
    if (entrances.length) map.entrances = entrances;
    // A map drawn on an image keeps it.
    const from = s.map && (state.scenario.siteMaps || {})[s.map];
    if (from && from.image) Object.assign(map, { image: from.image, width: from.width, height: from.height }, from.grid ? { grid: E.clone(from.grid) } : {});
    return map;
  };
  // A site's map when it has an image (drawn as the local map), or null.
  ST.imageMap = function (state, site) {
    const s = state.sites && state.sites[site];
    const m = s && s.map && (state.scenario.siteMaps || {})[s.map];
    return m && m.image ? m : null;
  };

  // ---------- deciding (the intent step's "new_place") ----------
  // What the player's intent asks for → { room } (a room that exists),
  // { site } (a known site: built, or a stub to build), { build } (a new
  // place to build), { error } (refused), or null (nothing about places).
  ST.wanted = function (state, p, actionText) {
    const sc = state.scenario;
    if (!p) return null;
    const ask = isObj(p.new_place) ? p.new_place : null;
    const moveTo = typeof p.move_to === 'string' && p.move_to.trim() && p.move_to !== 'null' ? p.move_to.trim() : null;
    if (moveTo && (Eng().resolveLocation(state, moveTo, true))) return null; // a known room or person: the usual move
    const name = text(ask ? ask.name : moveTo, 60);
    if (!name) return null;
    const room = Eng().resolveLocation(state, name, false);
    if (room) return { room };
    const known = ST.byName(state, name);
    if (known) return { site: known };
    if (!ST.enabled(sc)) return ask ? { error: `"${name}" is not a place on the map (this world doesn't build new places)` } : null;
    const cfg = ST.config(sc);
    if (Object.keys(state.sites || {}).length >= cfg.maxSites) return { error: `this story already has ${cfg.maxSites} places of its own` };
    // Same region or a neighbour; farther takes more than one step.
    const here = Eng().playerRegion(state);
    const regions = sc.regions || [];
    let region = here;
    if (ask && ask.region && regions.length) {
      const r = regions.find((x) => x.id === ask.region || norm(x.name) === norm(ask.region));
      if (!r) return { error: `unknown region "${ask.region}"` };
      const near = r.id === here || (Eng().regionDef(state, here) || {}).neighbours?.includes(r.id);
      if (!near) return { error: `${r.name} is too far for one step from here; go through a neighbouring region first` };
      region = r.id;
    }
    // The player's own words should name it (rule 3: only the player's intent moves them).
    // "enact the plan", "let's go": the player's previous action counts too
    // (playtest-api-chop-shop: the plan named the chop shop a turn earlier).
    const prev = REFERS_BACK.test(String(actionText || '')) && state.recent && state.recent[0] && state.recent[0].action ? state.recent[0].action : '';
    const words = new Set(norm(actionText + ' ' + prev).split(' '));
    if (!norm(name).split(' ').some((w) => w.length >= 3 && words.has(w)) && !norm(ask && ask.kind).split(' ').some((w) => w.length >= 3 && words.has(w))) {
      return { error: `the player's words don't name "${name}"` };
    }
    return { build: { name, kind: text(ask && ask.kind, 40) || name, region } };
  };

  // ---------- building ----------
  // req: { name, kind, region, from ('intent' | 'event'), why, stub? }.
  // Returns { site, rooms, extras, standees, warnings } ready for addSite.
  ST.build = async function (state, req, phase) {
    const sc = state.scenario;
    const id = (req.stub && req.stub.id) || ST.newId(state, req.name);
    const map = ST.libraryMatch(sc, req.kind, id);
    const ctx = { header: E.Prompts.header(state), job: { log: [] } };
    const warnings = [];
    let layout;
    if (map) {
      layout = ST.fromMap(state, map, id);
      warnings.push(`library map "${map.id}" (${map.credit}, ${map.license})`);
    } else {
      if (phase) phase(`Building ${req.name}…`);
      layout = await E.StartGen.attempt(ctx, `worldbuild (site: ${req.name})`, E.Prompts.siteLayout(state, req), 900, (raw) => ST.checkLayout(state, raw, id));
    }
    warnings.push(...(layout.warnings || []));
    if (phase) phase(`Who is at ${req.name}…`);
    const people = await E.StartGen.attempt(ctx, `worldbuild (site people: ${req.name})`, E.Prompts.siteOccupants(state, req, layout, !!map), 700, (raw) => ST.checkOccupants(state, raw, layout, id, !!map));
    warnings.push(...(people.warnings || []));
    ctx.job.log.filter((l) => l.error).forEach((l) => warnings.push(`try ${l.attempt} rejected: ${l.error}`));
    (people.renames || []).forEach((r) => { const room = layout.rooms.find((x) => x.id === r.id); if (room) Object.assign(room, r.name ? { name: r.name } : {}, r.desc ? { desc: r.desc } : {}); });
    const site = {
      id, name: req.name, kind: req.kind, region: req.region, entry: layout.entry, rooms: layout.rooms.map((r) => r.id),
      entrances: layout.entrances, note: people.note || '', from: req.from, why: text(req.why, 200), map: map ? map.id : null,
      made: state.turn, visits: 0, lastVisit: null, kept: false, summary: (req.stub && req.stub.summary) || '',
    };
    return { site, rooms: layout.rooms, extras: people.extras, standees: people.standees, warnings };
  };
  ST.newId = function (state, name) {
    const taken = new Set([].concat(Object.keys(state.sites || {}), Object.keys(state.locations), Object.keys(state.characters), Object.keys(state.extras || {}),
      Object.keys(state.standees || {}), (state.scenario.regions || []).map((r) => r.id), (state.scenario.factions || []).map((f) => f.id)));
    const base = slug(name) || 'place';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  };
  // Ids not yet used anywhere in the game, for rooms and people.
  const takenIds = (state, more) => new Set([].concat(Object.keys(state.locations), Object.keys(state.characters), Object.keys(state.extras || {}), Object.keys(state.standees || {}),
    Object.keys(state.sites || {}), (state.scenario.regions || []).map((r) => r.id), (state.scenario.factions || []).map((f) => f.id), more || []));
  const fresh = (used, t, fallback) => {
    const base = slug(t) || fallback;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  // A library map's rooms, with ids made unique in this game. A drawn map
  // (task 6-3) brings its shapes (for the image map); with a grid, a room's
  // size comes from its area when the author set none, and its description
  // gets its measurements for the narrator. Spots become features of their
  // rooms ("guard post", "cover"); guard posts and spawn points also go to
  // the people step (posts, spawn).
  ST.fromMap = function (state, map, siteId) {
    const used = takenIds(state, [siteId]);
    const ids = {};
    map.rooms.forEach((r) => { ids[r.id] = used.has(r.id) ? fresh(used, `${siteId}-${r.id}`, 'room') : (used.add(r.id), r.id); });
    const spots = Array.isArray(map.spots) ? map.spots.filter((sp) => isObj(sp) && ids[sp.room]) : [];
    const rooms = map.rooms.map((r) => {
      const out = E.clone(r);
      out.id = ids[r.id];
      if (!out.size && ST.roomSize(r.shape, map.grid)) out.size = ST.roomSize(r.shape, map.grid);
      const dims = ST.dims(r.shape, map.grid);
      if (dims) out.desc = `${String(out.desc || '').replace(/\.?\s*$/, '')} (${dims}).`;
      const feats = (out.features || []).slice();
      const has = (n) => feats.some((f) => norm(typeof f === 'string' ? f : f.name) === norm(n));
      spots.filter((sp) => sp.room === r.id && sp.kind !== 'spawn').forEach((sp) => { const n = text(sp.label, 30) || sp.kind; if (!has(n) && feats.length < 6) feats.push(n); });
      if (feats.length) out.features = feats;
      out.links = (r.links || []).map((k) => Object.assign({}, k, { to: ids[k.to] }));
      out.connects = [...new Set((r.connects || []).map((c) => ids[c]).concat(out.links.map((k) => k.to)))];
      return out;
    });
    // Links both ways.
    rooms.forEach((r) => r.connects.forEach((c) => { const o = rooms.find((x) => x.id === c); if (o && !o.connects.includes(r.id)) o.connects.push(r.id); }));
    const entrances = (map.entrances || []).map((e) => Object.assign({}, e, { room: ids[e.room] }));
    const roomsWith = (kind) => [...new Set(spots.filter((sp) => sp.kind === kind).map((sp) => ids[sp.room]))];
    return { rooms, entry: ids[map.entry], entrances, posts: roomsWith('guard post'), spawn: roomsWith('spawn'), warnings: [] };
  };

  // The model's layout → { rooms, entry, entrances, warnings } or { error }.
  ST.checkLayout = function (state, raw, siteId) {
    const list = isObj(raw) && Array.isArray(raw.rooms) ? raw.rooms.filter(isObj) : [];
    if (list.length < ST.ROOMS[0]) return { error: `make ${ST.ROOMS[0]} to ${ST.ROOMS[1]} rooms (got ${list.length})` };
    const warnings = list.length > ST.ROOMS[1] ? [`kept the first ${ST.ROOMS[1]} of ${list.length} rooms`] : [];
    const used = takenIds(state, [siteId]);
    const names = new Set(Object.values(state.locations).map((l) => norm(l.name)));
    const rooms = [];
    for (const r of list.slice(0, ST.ROOMS[1])) {
      const name = text(r.name, 40);
      const desc = E.StartGen.clip(r.desc, 240);
      if (!name || !desc) return { error: 'every room needs a "name" and a "desc"' };
      if (names.has(norm(name))) return { error: `"${name}" is already a room on the map; give this one its own name` };
      names.add(norm(name));
      const room = { id: fresh(used, r.id && /^[a-z0-9][a-z0-9_-]*$/.test(String(r.id)) ? String(r.id) : name, 'room'), name, desc, connects: [], links: [], _raw: r, _alias: [String(r.id || ''), name] };
      if (r.outside === true) room.outside = true;
      if (['small', 'medium', 'large'].includes(r.size)) room.size = r.size;
      const feats = (Array.isArray(r.features) ? r.features : []).slice(0, 6).map((f) => (isObj(f) ? { name: text(f.name, 30), state: f.state != null ? text(String(f.state), 20) : undefined } : text(f, 30)))
        .filter((f) => (typeof f === 'string' ? f : f.name));
      if (feats.length) room.features = feats.map((f) => (typeof f === 'object' && f.state === undefined ? f.name : f));
      if (r.secure === true) room.secure = true;
      rooms.push(room);
    }
    const find = (ref) => rooms.find((x) => x.id === ref || x._alias.some((a) => a && norm(a) === norm(ref)));
    rooms.forEach((r) => (Array.isArray(r._raw.links) ? r._raw.links : Array.isArray(r._raw.connects) ? r._raw.connects.map((to) => ({ to })) : []).forEach((k) => {
      const to = find(isObj(k) ? k.to : k);
      if (!to || to === r || r.connects.includes(to.id)) return;
      const kind = ST.KINDS.includes(isObj(k) && k.kind) ? k.kind : 'door';
      r.connects.push(to.id);
      to.connects.push(r.id);
      r.links.push({ to: to.id, kind });
    }));
    const entry = find(raw.entry) && !find(raw.entry).secure ? find(raw.entry) : rooms.find((r) => !r.secure) || rooms[0];
    if (!find(raw.entry)) warnings.push(`no usable "entry"; the way in is ${entry.name}`);
    // Every room reachable from the entry (rule 1: fix what a retry would repeat).
    const reach = new Set([entry.id]);
    const queue = [entry.id];
    while (queue.length) {
      const at = queue.shift();
      rooms.find((x) => x.id === at).connects.forEach((c) => { if (!reach.has(c)) { reach.add(c); queue.push(c); } });
    }
    rooms.filter((r) => !reach.has(r.id)).forEach((r) => {
      warnings.push(`${r.name} connected nowhere; a door to ${entry.name} added`);
      r.connects.push(entry.id); entry.connects.push(r.id); r.links.push({ to: entry.id, kind: 'door' });
    });
    // A secure room (vault, cell, armory) has exactly one way in.
    rooms.filter((r) => r.secure && r.connects.length !== 1).forEach((r) => { delete r.secure; warnings.push(`${r.name} has ${r.connects.length} ways in, so it isn't secure`); });
    const entrances = (Array.isArray(raw.entrances) ? raw.entrances : []).filter(isObj).map((e) => ({ room: (find(e.room) || {}).id, kind: text(e.kind, 30) || 'door', watched: e.watched === true })).filter((e) => e.room);
    if (!entrances.some((e) => e.room === entry.id)) entrances.unshift({ room: entry.id, kind: 'door', watched: false });
    rooms.forEach((r) => { delete r._raw; delete r._alias; if (!r.links.length) delete r.links; });
    return { rooms, entry: entry.id, entrances: entrances.slice(0, 4), warnings };
  };

  // The people and groups there → { extras, standees, note, renames, warnings } or { error }.
  ST.checkOccupants = function (state, raw, layout, siteId, library) {
    if (!isObj(raw)) return { error: 'reply with one JSON object' };
    const rooms = layout.rooms;
    const roomOf = (ref) => { const r = rooms.find((x) => x.id === ref || norm(x.name) === norm(ref)); return r ? r.id : null; };
    const used = takenIds(state, [siteId].concat(rooms.map((r) => r.id)));
    const names = new Set([].concat(Object.values(state.characters).map((c) => c.name), Object.values(state.extras || {}).map((x) => x.name)).map(norm));
    const warnings = [];
    const extras = [];
    (Array.isArray(raw.people) ? raw.people : []).filter(isObj).slice(0, 2).forEach((x) => {
      const name = text(x.name, 40);
      const role = text(x.role, 60);
      if (!name || !role || names.has(norm(name))) return warnings.push(`person "${x.name || '?'}" skipped (needs a new name and a role)`);
      names.add(norm(name));
      // Someone the model didn't place starts at a spawn point, else the way in.
      const loc = roomOf(x.room) || (layout.spawn || [])[0] || layout.entry;
      extras.push(Object.assign({ id: fresh(used, name, 'someone'), name, role, location: loc, note: E.StartGen.clip(x.note, 200) }, text(x.pronouns, 20) ? { pronouns: text(x.pronouns, 20) } : {}));
    });
    const groupIds = new Set((state.scenario.factions || []).map((f) => f.id));
    const standees = [];
    (Array.isArray(raw.groups) ? raw.groups : []).filter(isObj).slice(0, 3).forEach((g) => {
      const label = text(g.label, 40);
      const loc = roomOf(g.room);
      if (!label || !loc) return warnings.push(`group "${g.label || '?'}" skipped (needs a label and one of the rooms)`);
      const st = { id: fresh(used, label, 'group'), label, count: E.Scenario.parseCount(g.count), location: loc, state: ['calm', 'alert', 'hostile'].includes(g.state) ? g.state : 'calm', note: E.StartGen.clip(g.note, 200) };
      if (groupIds.has(g.faction)) st.faction = g.faction;
      if (g.post === true || g.post === loc || norm(g.post) === norm(rooms.find((r) => r.id === loc).name)) st.post = loc;
      // A group in a room the map marks as a guard post holds it (task 6-3).
      else if ((layout.posts || []).includes(loc) && !Array.isArray(g.patrol)) st.post = loc;
      else if (Array.isArray(g.patrol)) {
        let loop = g.patrol.map(roomOf).filter(Boolean);
        const linked = (a, b) => rooms.find((r) => r.id === a).connects.includes(b);
        const path = loop.length >= 2 && loop.includes(loc) && loop.every((r, i) => i === loop.length - 1 || linked(r, loop[i + 1]));
        // A path walked out and back (playtest-api-chop-shop: bay, floor, lounge).
        if (path && loop.length > 2 && !linked(loop[loop.length - 1], loop[0])) { loop = loop.concat(loop.slice(1, -1).reverse()); warnings.push(`${label}: patrol walked out and back (${loop.join(', ')})`); }
        if (path) st.patrol = loop; else warnings.push(`${label}: patrol isn't a path of linked rooms; they stay put`);
      }
      standees.push(st);
    });
    const renames = [];
    if (library && Array.isArray(raw.rooms)) raw.rooms.filter(isObj).forEach((r) => {
      const id = roomOf(r.id);
      const name = text(r.name, 40);
      if (id && (name || r.desc) && !(name && rooms.some((x) => x.id !== id && norm(x.name) === norm(name)))) renames.push({ id, name, desc: E.StartGen.clip(r.desc, 240) });
    });
    return { extras, standees, note: E.StartGen.clip(raw.note, 300), renames, warnings };
  };

  // ---------- adding to the game ----------
  // The room a route leaves from: an outdoor room of the site `from` is in,
  // else `from` itself.
  ST.routeFrom = function (state, from) {
    const site = ST.siteOf(state, from);
    // Open ground at street level (not a roof), never a secure room.
    const outside = ST.rooms(state, site).find((l) => l.outside && l.id !== from && !(l.level > 0) && !l.secure);
    return state.locations[from].outside ? from : outside ? outside.id : from;
  };
  // Puts a built site into a state (the live one, and the start-of-turn copy
  // a step-in rewinds to). from: the room the player is leaving.
  ST.add = function (st, built, from) {
    const { site } = built;
    const origin = st.locations[from] ? ST.routeFrom(st, from) : null;
    built.rooms.forEach((r) => {
      st.locations[r.id] = Object.assign({ connects: [] }, E.clone(r), { region: site.region, site: site.id, seen: false });
    });
    if (origin) {
      const a = st.locations[origin], b = st.locations[site.entry];
      a.connects = [...new Set((a.connects || []).concat(b.id))];
      b.connects = [...new Set((b.connects || []).concat(a.id))];
      a.links = (a.links || []).concat({ to: b.id, kind: 'route' });
      b.links = (b.links || []).concat({ to: a.id, kind: 'route' });
    }
    st.links = st.links || {};
    Eng().initSite(st);
    if (origin) st.links[Eng().linkKey(origin, site.entry)] = { locked: false, open: false };
    st.extras = st.extras || {};
    built.extras.forEach((x) => { st.extras[x.id] = Eng().newExtra(x, 'site', st.turn); });
    st.standees = st.standees || {};
    built.standees.forEach((g) => { st.standees[g.id] = Eng().newStandee(g); });
    st.sites = st.sites || {};
    st.sites[site.id] = Object.assign(E.clone(site), { origin, extras: built.extras.map((x) => x.id) });
  };

  // A stub: a place the story knows of, not built yet (an event's new_site).
  ST.addStub = function (state, s) {
    const id = ST.newId(state, s.name);
    state.sites = state.sites || {};
    state.sites[id] = { id, name: s.name, kind: s.kind || s.name, region: s.region, stub: true, from: s.from || 'event', why: text(s.why, 200), summary: s.summary || '', made: state.turn, visits: 0, lastVisit: null, kept: false };
    return state.sites[id];
  };

  // The turn's site work, between the intent call and resolution: reads the
  // player's intent, builds a place if the engine agrees, and points the
  // intent's move_to at its entry. notes: Debug lines. pre: the start-of-turn
  // copy, which gets the same site.
  ST.forIntent = async function (state, intentObj, actionText, pre, phase, notes) {
    const p = intentObj && intentObj.player;
    const want = ST.wanted(state, p, actionText);
    if (!want) return null;
    if (want.room) { p.move_to = want.room; return null; }
    if (want.error) { notes.push({ type: 'site refused', detail: want.error }); if (p) p.move_to = null; return null; }
    const site = want.site;
    if (site && !site.stub) { p.move_to = site.entry; return null; }
    const req = site ? { name: site.name, kind: site.kind, region: site.region, from: site.from, why: site.why, stub: site } : Object.assign({ from: 'intent', why: actionText }, want.build);
    const from = state.characters[state.player].status.location;
    // No calls for a place the player can't set out for (rule 4: a locked door on the way out).
    const blocked = Eng().moveProblem(state, state.player, from, ST.routeFrom(state, from));
    if (blocked) { notes.push({ type: 'site refused', detail: `${req.name}: ${blocked}` }); p.move_to = null; return null; }
    let built;
    try {
      built = await ST.build(state, req, phase);
    } catch (err) {
      notes.push({ type: 'site not built', detail: `${req.name}: ${err.message}` });
      p.move_to = null;
      return null;
    }
    if (site) { delete state.sites[site.id]; if (pre.sites) delete pre.sites[site.id]; }
    ST.add(state, built, from);
    ST.add(pre, E.clone(built), from);
    p.move_to = built.site.entry;
    const s = built.site;
    // Debug lines are short, so one for the site and one per note.
    notes.push({ type: 'site built', detail: `${s.name} (${s.kind}, ${s.region || 'no region'}): ${built.rooms.map((r) => r.name).join(', ')}; ${built.extras.length} people, ${built.standees.length} groups${s.map ? `; library map ${s.map}` : ''}` });
    notes.push({ type: 'site why', detail: req.from === 'intent' ? `the player's action: "${text(actionText, 150)}"` : `an event: ${s.why || s.name}` });
    built.warnings.forEach((w) => notes.push({ type: 'site note', detail: w }));
    return s;
  };

  // ---------- visits, keeping, fading ----------
  // After a turn's moves: a site the player is in counts a visit when they
  // arrive, and records when they were last there.
  ST.noteVisit = function (state, startLoc) {
    const now = ST.playerSite(state);
    const s = (state.sites || {})[now];
    if (!s) return;
    if (ST.siteOf(state, startLoc) !== now) s.visits += 1;
    s.lastVisit = { day: state.time.day, hour: state.time.hour, turn: state.turn };
    if (s.visits >= 2 && !s.kept) { s.kept = true; s.keptWhy = 'a second visit'; }
  };
  // At commit: a notable fact (weight 2+) recorded while the player was in a
  // site keeps it.
  ST.noteFacts = function (state, factsBefore, rooms, out) {
    const notable = state.facts.slice(factsBefore).filter((f) => f.weight >= 2);
    if (!notable.length) return;
    [...new Set(rooms.map((r) => r && ST.siteOf(state, r)))].forEach((id) => {
      const s = (state.sites || {})[id];
      if (s && !s.kept) { s.kept = true; s.keptWhy = `"${text(notable[0].text, 80)}"`; out.push(`${s.name} is kept: ${s.keptWhy}`); }
    });
  };
  // Sites with nothing notable, keepDays after the last visit, with the
  // player and the cast elsewhere, go back to stubs. Returns Debug lines.
  ST.fade = function (state) {
    const out = [];
    const cfg = ST.config(state.scenario);
    const nowH = ST.hours(state.time);
    Object.values(state.sites || {}).forEach((s) => {
      if (s.stub || !s.lastVisit) return;
      if (!s.kept && (s.extras || []).some((id) => state.characters[id])) { s.kept = true; s.keptWhy = 'someone from there joined the story'; }
      if (s.kept || nowH - ST.hours(s.lastVisit) < cfg.keepDays * 24) return;
      const rooms = new Set(s.rooms);
      if (ST.playerSite(state) === s.id || Object.values(state.characters).some((c) => rooms.has(c.status.location))) return;
      ST.remove(state, s);
      out.push(`${s.name} faded (nothing notable there in ${cfg.keepDays} days); remembered as a place to go back to`);
    });
    return out;
  };
  ST.remove = function (state, s) {
    const rooms = new Set(s.rooms);
    const met = Object.values(state.extras || {}).filter((x) => rooms.has(x.location)).map((x) => x.name);
    s.rooms.forEach((id) => { delete state.locations[id]; });
    Object.values(state.locations).forEach((l) => {
      l.connects = (l.connects || []).filter((c) => !rooms.has(c));
      if (l.links) l.links = l.links.filter((k) => !rooms.has(k.to));
    });
    Object.keys(state.links || {}).forEach((k) => { if (k.split('|').some((r) => rooms.has(r))) delete state.links[k]; });
    Object.keys(state.features || {}).forEach((k) => { if (rooms.has(k.split('|')[0])) delete state.features[k]; });
    state.seenRooms = (state.seenRooms || []).filter((r) => !rooms.has(r));
    Object.values(state.extras || {}).forEach((x) => { if (rooms.has(x.location)) delete state.extras[x.id]; });
    Object.values(state.standees || {}).forEach((g) => { if (rooms.has(g.location)) delete state.standees[g.id]; });
    const visit = `visited ${s.visits === 1 ? 'once' : `${s.visits} times`}, last on ${state.scenario.timeLabel || 'Day'} ${s.lastVisit.day}${met.length ? `; met ${met.join(', ')}` : ''}`;
    state.sites[s.id] = { id: s.id, name: s.name, kind: s.kind, region: s.region, stub: true, from: s.from, why: s.why, summary: visit, made: s.made, visits: s.visits, lastVisit: s.lastVisit, kept: false };
  };

  // Entrances of the start and of every built site (detection on the way, task 3-6).
  ST.entrances = (state) => [].concat(state.scenario.entrances || [], ...Object.values(state.sites || {}).map((s) => s.entrances || []));
  // Routes out of a site: [{ from, to, name }] for the map.
  ST.routes = (state, site) => ST.rooms(state, site).flatMap((l) => (l.links || []).filter((k) => k.kind === 'route' && state.locations[k.to])
    .map((k) => ({ from: l.id, to: k.to, name: ((state.sites || {})[ST.siteOf(state, k.to)] || state.locations[k.to]).name })));
})(typeof window !== 'undefined' ? window : globalThis);
