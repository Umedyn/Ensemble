// Site map editing for the creator's Sites tab (task 6-3): maps in the
// working copy (sites/<id>.json, in the world once they validate and are
// saved there), rooms drawn as polygons on an image with a grid to snap to,
// doors on shared edges, entrances, spots, copies from the shared library,
// keeping a site generated in play, the library export and the matching
// test box. DOM-free; the canvas and forms are in creator.js.
(function (root) {
  const E = root.Ensemble;
  const SE = (E.SiteEdit = {});
  const ST = () => E.Sites;
  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const slug = (name, taken, fallback) => E.WorldEdit.slug(name, taken, fallback);

  SE.path = (id) => `sites/${id}.json`;
  // Every site map in the working copy: [{ id, map, listed }] (listed: in
  // world.sites, so the game uses it; otherwise a draft).
  SE.maps = function (files) {
    const listed = new Set((files['world.json'].sites || []));
    return Object.keys(files).map((p) => /^sites\/([^/]+)\.json$/.exec(p)).filter(Boolean)
      .map((m) => ({ id: m[1], map: files[m[0]], listed: listed.has(m[1]) })).sort((a, b) => (a.id < b.id ? -1 : 1));
  };
  const taken = (files) => SE.maps(files).map((x) => x.id).concat(Object.keys(E.Scenario.library.maps || {}));
  // A new map, a draft until it is saved to the world.
  SE.newMap = function (files, name) {
    const id = slug(name || 'new site', taken(files), 'site');
    files[SE.path(id)] = { id, name: name || 'New site', type: '', tags: [], setting: [], credit: '', license: '', entry: '', rooms: [] };
    return id;
  };
  // A copy of a map (a shared one, or one kept from a save) under a free id.
  // Its image path follows the new id; the caller copies the image file.
  SE.addCopy = function (files, map) {
    const id = slug(map.id || map.name, taken(files), 'site');
    const m = Object.assign(E.clone(map), { id });
    delete m.library;
    if (m.image) m.image = `sites/${id}.${(m.image.split('.').pop() || 'png').toLowerCase()}`;
    files[SE.path(id)] = m;
    return id;
  };
  // The world's own places (task 7-2: rooms with a "site"), in the world and
  // its starts: [{ id, name, file (where its rooms are), rooms, map }].
  SE.places = function (files) {
    const w = files['world.json'];
    const out = new Map();
    const add = (file, src) => ((src && src.locations) || []).filter((l) => l && l.site).forEach((l) => {
      const info = (w.siteInfo || {})[l.site] || ((src.siteInfo || {})[l.site]) || {};
      if (!out.has(l.site)) out.set(l.site, { id: l.site, name: info.name || l.name, kind: info.kind || '', file, rooms: [], map: info.map || null });
      out.get(l.site).rooms.push(l);
    });
    add('world.json', w);
    (w.starts || []).forEach((sid) => add(`starts/${sid}.json`, files[`starts/${sid}.json`]));
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  };
  // A draft map of one of those places, its rooms as authored (with the
  // ways between them), ready for an image and their shapes. "place" ties it
  // to the place: saved to the world, the place is drawn on it.
  SE.fromPlace = function (files, placeId) {
    const p = SE.places(files).find((x) => x.id === placeId);
    if (!p) return null;
    const ids = new Set(p.rooms.map((l) => l.id));
    const id = slug(placeId, taken(files), 'site');
    files[SE.path(id)] = {
      id, name: p.name, type: p.kind || 'place', tags: [], setting: [], credit: '', license: '', place: placeId, entry: p.rooms[0].id,
      rooms: p.rooms.map((l) => Object.assign({ id: l.id, name: l.name, desc: l.desc || l.name },
        ['size', 'level', 'outside', 'features'].reduce((o, k) => (l[k] != null ? Object.assign(o, { [k]: E.clone(l[k]) }) : o), {}),
        { links: (l.links || []).filter((k) => ids.has(k.to) && k.kind !== 'trip').map((k) => ({ to: k.to, kind: k.kind })) })),
    };
    return id;
  };
  // Problems that stop it joining the world, and warnings that don't.
  SE.check = (map, id) => ({ problems: ST().mapProblems(map, id), warnings: ST().mapWarnings(map, id) });
  SE.saveToWorld = function (files, id) {
    const p = ST().mapProblems(files[SE.path(id)], id);
    if (p.length) return { error: `Fix these first: ${p.map((x) => x.replace(/^sites\/[^:]+: /, '')).join('; ')}` };
    const w = files['world.json'];
    const m = files[SE.path(id)];
    // A map of one of the world's places draws that place (task 7-2).
    if (m.place) {
      if (!m.image) return { error: 'Load the floor plan image and draw its rooms on it first.' };
      const p = SE.places(files).find((x) => x.id === m.place);
      if (!p) return { error: `There is no place "${m.place}" in this world any more.` };
      const missing = p.rooms.filter((l) => !(m.rooms || []).some((r) => r.id === l.id && Array.isArray(r.shape)));
      if (missing.length) return { error: `Draw these rooms first: ${missing.map((l) => l.name).join(', ')}` };
      const src = files[p.file];
      src.siteInfo = src.siteInfo || {};
      src.siteInfo[m.place] = Object.assign({ name: p.name }, src.siteInfo[m.place] || {}, { map: id });
    }
    w.sites = [...new Set((w.sites || []).concat(id))];
    return {};
  };
  SE.takeOut = function (files, id) {
    const w = files['world.json'];
    // A place drawn on it goes back to its laid-out floor plan.
    [w].concat((w.starts || []).map((sid) => files[`starts/${sid}.json`])).forEach((src) => Object.values((src && src.siteInfo) || {}).forEach((i) => { if (i && i.map === id) delete i.map; }));
    w.sites = (w.sites || []).filter((x) => x !== id);
    if (!w.sites.length) delete w.sites;
  };
  SE.removeMap = function (files, id) {
    SE.takeOut(files, id);
    delete files[SE.path(id)];
  };

  // ---------- rooms ----------
  SE.addRoom = function (map, name, shape) {
    const ids = (map.rooms || []).map((r) => r.id);
    const id = slug(name || 'room', ids, 'room');
    const room = { id, name: name || `Room ${ids.length + 1}`, desc: '' };
    if (shape) room.shape = shape.map((p) => p.map(Math.round));
    map.rooms = (map.rooms || []).concat([room]);
    if (!map.entry) map.entry = id;
    return id;
  };
  SE.removeRoom = function (map, id) {
    map.rooms = (map.rooms || []).filter((r) => r.id !== id);
    map.rooms.forEach((r) => {
      if (r.links) { r.links = r.links.filter((k) => k.to !== id); if (!r.links.length) delete r.links; }
      if (r.connects) { r.connects = r.connects.filter((c) => c !== id); if (!r.connects.length) delete r.connects; }
    });
    if (map.entrances) map.entrances = map.entrances.filter((e) => e.room !== id);
    if (map.spots) map.spots = map.spots.filter((s) => s.room !== id);
    if (map.entry === id) map.entry = (map.rooms[0] || {}).id || '';
  };
  // The room whose shape holds p (the last drawn wins).
  SE.roomAt = function (map, p) {
    const hits = (map.rooms || []).filter((r) => Array.isArray(r.shape) && r.shape.length >= 3 && ST().Geo.inside(p, r.shape));
    return hits.length ? hits[hits.length - 1].id : null;
  };
  // Snapping to the grid (a drawing aid only).
  SE.snap = function (p, grid, on) {
    if (!on || !grid || !(grid.square > 0)) return p.map(Math.round);
    return p.map((v) => Math.round(v / grid.square) * grid.square);
  };
  // What a click near an edge means: between two rooms (a door), or on one
  // room's outer edge (an entrance). → { a, b, at } | { room, at } | null
  SE.edgeAt = function (map, p, tol) {
    const G = ST().Geo;
    const near = (map.rooms || []).filter((r) => Array.isArray(r.shape) && r.shape.length >= 3 && G.edgeDist(p, r.shape) <= tol)
      .sort((a, b) => G.edgeDist(p, a.shape) - G.edgeDist(p, b.shape));
    if (near.length >= 2) return { a: near[0].id, b: near[1].id, at: p.map(Math.round) };
    if (near.length === 1) return { room: near[0].id, at: p.map(Math.round) };
    return null;
  };

  // ---------- links, entrances, spots ----------
  // A link kept on one side (the game makes it two-way).
  SE.link = function (map, a, b) {
    const ra = (map.rooms || []).find((r) => r.id === a), rb = (map.rooms || []).find((r) => r.id === b);
    return ((ra && ra.links) || []).find((k) => k.to === b) || ((rb && rb.links) || []).find((k) => k.to === a) || null;
  };
  SE.links = (map) => (map.rooms || []).flatMap((r) => (r.links || []).map((k) => ({ a: r.id, b: k.to, kind: k.kind, at: k.at, key: k.key })));
  SE.setLink = function (map, a, b, kind, at) {
    if (a === b) return;
    const keep = SE.link(map, a, b);
    SE.removeLink(map, a, b);
    const ra = map.rooms.find((r) => r.id === a);
    const k = { to: b, kind: kind || (keep && keep.kind) || 'door' };
    const point = at || (keep && keep.at);
    if (Array.isArray(point)) k.at = point.map(Math.round);
    if (keep && keep.key) k.key = keep.key;
    ra.links = (ra.links || []).concat([k]);
  };
  SE.removeLink = function (map, a, b) {
    (map.rooms || []).forEach((r) => {
      if (!r.links || (r.id !== a && r.id !== b)) return;
      r.links = r.links.filter((k) => !((r.id === a && k.to === b) || (r.id === b && k.to === a)));
      if (!r.links.length) delete r.links;
    });
  };
  SE.addEntrance = function (map, room, at) {
    map.entrances = (map.entrances || []).concat([Object.assign({ room, kind: 'door', watched: false }, at ? { at: at.map(Math.round) } : {})]);
  };
  SE.addSpot = function (map, kind, room, at) {
    map.spots = (map.spots || []).concat([Object.assign({ kind, room }, at ? { at: at.map(Math.round) } : {})]);
  };

  // A new image for a map: everything drawn scales to it.
  SE.setImage = function (map, path, width, height) {
    if (map.image && map.width && map.height) {
      const sx = width / map.width, sy = height / map.height;
      const sc = (p) => [Math.round(p[0] * sx), Math.round(p[1] * sy)];
      (map.rooms || []).forEach((r) => {
        if (r.shape) r.shape = r.shape.map(sc);
        (r.links || []).forEach((k) => { if (k.at) k.at = sc(k.at); });
      });
      (map.entrances || []).forEach((e) => { if (e.at) e.at = sc(e.at); });
      (map.spots || []).forEach((s) => { if (s.at) s.at = sc(s.at); });
      if (map.grid && map.grid.square) map.grid.square = Math.max(1, Math.round(map.grid.square * sx));
    }
    Object.assign(map, { image: path, width, height });
  };

  // ---------- keeping a site from a save ----------
  // A save file → the sites built in it: [{ id, name, kind, rooms }].
  SE.savedSites = function (saveJson) {
    const state = E.Engine.migrate(E.clone(saveJson));
    return { state, sites: Object.values(state.sites || {}).filter((s) => !s.stub).map((s) => ({ id: s.id, name: s.name, kind: s.kind, rooms: (s.rooms || []).length })) };
  };
  SE.fromSave = (files, state, siteId) => SE.addCopy(files, ST().toMap(state, siteId));

  // ---------- the library ----------
  // One map as a library folder: index.json and sites/<id>.json (the image
  // beside it is added by the caller). Opened with Open folder in the game,
  // or merged into library/.
  SE.libraryFiles = function (map) {
    const m = E.clone(map);
    delete m.library;
    return { 'index.json': { format: 1, sites: [E.Scenario.libraryEntry(m)] }, [`sites/${m.id}.json`]: m };
  };
  // The matching test box: which maps fit a kind of place, for a world with
  // these setting tags, and which one a site would get. The world's maps
  // (in it, plus the draft being edited) come before shared ones.
  SE.testMatch = function (files, kind, setting, extra) {
    const own = {};
    SE.maps(files).filter((x) => x.listed || (extra && x.id === extra)).forEach((x) => (own[x.id] = x.map));
    const lib = E.Scenario.libraryFor({ generatedSites: { library: setting || [] } }, own);
    const sc = { siteMaps: Object.assign({}, own, lib) };
    const fits = ST().libraryFits(sc, kind);
    const seed = slug(kind, [], 'place');
    return { fits: fits.map((m) => ({ id: m.id, name: m.name || m.id, library: !!m.library })), pick: (ST().libraryMatch(sc, kind, seed) || {}).id || null, seed };
  };
})(typeof window !== 'undefined' ? window : globalThis);
