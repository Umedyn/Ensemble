// Map editing for the creator (task 3-5), with no DOM so Node tests can
// check it: region ids from names, neighbours suggested from shared edges,
// hit tests, vertex edits, and keeping references in step when a region is
// renamed or deleted. "world" is world.json; "starts" is { id: start JSON }.
(function (root) {
  const E = root.Ensemble;
  const M = (E.MapEdit = {});

  // A lowercase id from a name, unique among taken ids.
  M.slug = function (name, taken) {
    const base = String(name || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'region';
    let id = base;
    for (let i = 2; (taken || []).includes(id); i++) id = `${base}-${i}`;
    return id;
  };

  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  // Distance from point p to segment a–b.
  M.segDist = function (p, a, b) {
    const l2 = dist2(a, b);
    if (!l2) return Math.sqrt(dist2(p, a));
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2));
    return Math.sqrt(dist2(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]));
  };
  M.inPolygon = function (p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // The region whose polygon (or point, within r) holds p; the last drawn wins.
  M.regionAt = function (map, p, r) {
    const hits = Object.entries((map && map.regions) || {}).filter(([, s]) => (s.polygon || s.polygons ? E.Geo.pieces(s).some((ring) => M.inPolygon(p, ring)) : s.point && Math.sqrt(dist2(p, s.point)) <= (r || 26)));
    return hits.length ? hits[hits.length - 1][0] : null;
  };
  // The polygon edge nearest p: { index (insert after it), dist }.
  M.nearestEdge = function (poly, p) {
    let best = { index: 0, dist: Infinity };
    poly.forEach((a, i) => {
      const d = M.segDist(p, a, poly[(i + 1) % poly.length]);
      if (d < best.dist) best = { index: i, dist: d };
    });
    return best;
  };
  M.insertVertex = (poly, index, p) => poly.slice(0, index + 1).concat([p.map(Math.round)], poly.slice(index + 1));
  M.removeVertex = (poly, i) => (poly.length > 3 ? poly.filter((_, k) => k !== i) : poly);

  // Regions whose polygons touch: a vertex of one within tol of an edge of
  // the other. → [[a, b], …], ids sorted.
  M.suggestNeighbours = function (map, tol) {
    tol = tol == null ? 10 : tol;
    const shapes = {};
    Object.entries((map && map.regions) || {}).forEach(([id, s]) => { const rings = E.Geo.pieces(s).filter((r) => r.length >= 3); if (rings.length) shapes[id] = rings; });
    return E.Geo.neighbours(shapes, tol).map((p) => p.sort()).sort();
  };

  // Neighbour links both ways (validation does this too, but the editor's
  // checkboxes should show it at once).
  M.setNeighbour = function (world, a, b, on) {
    const ra = (world.regions || []).find((r) => r.id === a), rb = (world.regions || []).find((r) => r.id === b);
    if (!ra || !rb || a === b) return;
    [[ra, b], [rb, a]].forEach(([r, other]) => {
      r.neighbours = (r.neighbours || []).filter((x) => x !== other);
      if (on) r.neighbours.push(other);
    });
  };
  M.areNeighbours = (world, a, b) => {
    const ra = (world.regions || []).find((r) => r.id === a), rb = (world.regions || []).find((r) => r.id === b);
    return !!(ra && rb && ((ra.neighbours || []).includes(b) || (rb.neighbours || []).includes(a)));
  };

  // Every place a region id is used: regions' neighbours, the map, starts'
  // "region", rooms' "region" (world and starts), event seeds and the map's
  // named places.
  // neighbourFn (default fn) maps neighbour lists; null drops the link.
  function eachRef(world, starts, fn, neighbourFn) {
    const nf = neighbourFn || fn;
    (world.regions || []).forEach((r) => { r.neighbours = [...new Set((r.neighbours || []).map((n) => nf(n)).filter((n) => n && n !== r.id))]; });
    // Presence (R-5) is keyed by region inside each group: renamed, or gone with it.
    [world].concat(Object.values(starts || {})).forEach((s) => Object.values((s && s.presence) || {}).forEach((m) => {
      Object.keys(m || {}).forEach((rid) => { const v = nf(rid); if (v !== rid) { if (v) m[v] = m[rid]; delete m[rid]; } });
    }));
    // Routes (R-2): where they go (a route to a deleted region goes), and the
    // regions their requirements name.

    (world.regions || []).filter((r) => Array.isArray(r.routes)).forEach((r) => {
      r.routes = r.routes.filter((x) => x && typeof x === 'object').map((x) => Object.assign(x, { to: nf(x.to) })).filter((x) => x.to && x.to !== r.id);
      r.routes.forEach((x) => controlsOf(x.requires).forEach((c) => { const v = fn(c.region); if (v) c.region = v; }));
    });

    const rooms = [].concat(world.locations || [], ...Object.values(starts || {}).map((s) => s.locations || []));
    rooms.forEach((l) => { if (l.region != null) { const v = fn(l.region); if (v) l.region = v; else delete l.region; } });
    Object.values(starts || {}).forEach((s) => { if (s.region != null) { const v = fn(s.region); if (v) s.region = v; else delete s.region; } });
    // Named places on the map (task 4-5) belong to a region.
    E.Scenario.mapPlaces(world).forEach((pl) => { if (pl && pl.region != null) { const v = fn(pl.region); if (v) pl.region = v; else delete pl.region; } });
    Object.values(world.eventSeeds || {}).forEach((list) => (Array.isArray(list) ? list : []).forEach((sd) => {
      if (sd && typeof sd === 'object' && sd.region != null) { const v = fn(sd.region); if (v) sd.region = v; else delete sd.region; }
    }));
  }
  // Lore entries (task 5-1) inline in world.json and starts, and in lore/
  // files (files: the creator's { path: JSON }, of which only lore/ is read).
  function loreEntries(world, starts, files) {
    const fromFiles = Object.entries(files || {}).filter(([p]) => /^lore\/[^/]+\.json$/.test(p)).map(([, d]) => d);
    return [].concat(world.lore || [], ...Object.values(starts || {}).map((s) => s.lore || []), ...fromFiles)
      .filter((e) => e && typeof e === 'object');
  }
  const regionLore = (world, starts, files, id) => loreEntries(world, starts, files).filter((e) => e.level === 'region' && e.ref === id);
  // Timeline events (task 5-2) in world.json and starts, and the "controls"
  // preconditions inside them (also inside "not").
  const timelineEvents = (world, starts) => [].concat(world.timeline || [], ...Object.values(starts || {}).map((s) => s.timeline || []))
    .filter((ev) => ev && typeof ev === 'object');
  const controlsOf = (p) => (!p || typeof p !== 'object' ? [] : p.controls ? [p.controls] : p.not ? controlsOf(p.not) : []);
  // The regions a region may be put inside (R-1): any but itself and the
  // regions inside it, which would make a loop.
  M.parentChoices = function (world, id) {
    const list = world.regions || [];
    return list.filter((r) => r.id !== id && !E.Scenario.regionChainIn(list, r.id).includes(id));
  };
  // ---------- routes and route kinds (R-4) ----------
  // A region's own routes as written (borders stay "neighbours"). Fields
  // are set from form text: time as typed ("45m"), booleans, a condition
  // object or null; empty values go, so the file holds only what was set.
  M.addRoute = function (world, from, to) {
    const r = (world.regions || []).find((x) => x.id === from);
    if (!r) return -1;
    const other = (world.regions || []).find((x) => x.id !== from && (!to || x.id === to));
    r.routes = (Array.isArray(r.routes) ? r.routes : []).concat([{ to: other ? other.id : '', kind: 'road' }]);
    return r.routes.length - 1;
  };
  M.setRouteField = function (world, from, i, field, value) {
    const r = (world.regions || []).find((x) => x.id === from);
    const x = r && Array.isArray(r.routes) ? r.routes[i] : null;
    if (!x || !E.Scenario.ROUTE_FIELDS.includes(field)) return;
    const empty = value == null || value === '' || value === false;
    if (empty && field !== 'to') delete x[field]; else x[field] = typeof value === 'string' ? value.trim() : value;
  };
  M.removeRoute = function (world, from, i) {
    const r = (world.regions || []).find((x) => x.id === from);
    if (!r || !Array.isArray(r.routes)) return;
    r.routes.splice(i, 1);
    if (!r.routes.length) delete r.routes;
  };
  // The route kinds table: the built-in kinds and the world's own, each with
  // what it is now (the world's setting over the default) and whether the
  // world changes it. → [{ kind, builtIn, time, risky, skill, requires, set }]
  M.routeKindRows = function (world) {
    const own = (world.routeKinds && typeof world.routeKinds === 'object') ? world.routeKinds : {};
    const kinds = Object.keys(E.Scenario.ROUTE_KINDS).concat(Object.keys(own).filter((k) => !E.Scenario.ROUTE_KINDS[k]));
    return kinds.map((kind) => {
      const def = E.Scenario.ROUTE_KINDS[kind] || {};
      const set = own[kind] || {};
      return { kind, builtIn: !!E.Scenario.ROUTE_KINDS[kind], time: set.time != null ? set.time : E.Scenario.sayHours(def.time != null ? def.time : E.Scenario.ROUTE_HOURS) || '0m',
        risky: !!set.risky, skill: set.skill || '', requires: set.requires || null, set: Object.keys(set).length > 0 };
    });
  };
  // One setting of a kind: kept only when it differs from the built-in
  // default (a time equal to it goes); a kind with nothing left goes too,
  // except a new kind of the world's own, which stays as {}.
  M.setRouteKind = function (world, kind, field, value) {
    if (!['time', 'risky', 'skill', 'requires'].includes(field)) return;
    const own = world.routeKinds = (world.routeKinds && typeof world.routeKinds === 'object') ? world.routeKinds : {};
    const k = own[kind] = own[kind] || {};
    const def = E.Scenario.ROUTE_KINDS[kind];
    const same = field === 'time' && def && E.Scenario.parseHours(value) === def.time;
    if (value == null || value === '' || value === false || same) delete k[field]; else k[field] = typeof value === 'string' ? value.trim() : value;
    if (!Object.keys(k).length && def) delete own[kind];
    if (!Object.keys(own).length) delete world.routeKinds;
  };
  // A kind of the world's own (such as "ferry"). → its name, or an error.
  M.addRouteKind = function (world, name) {
    const kind = String(name || '').trim().toLowerCase().slice(0, 30);
    if (!kind) return { error: 'give the kind a name' };
    if (E.Scenario.ROUTE_KINDS[kind] || (world.routeKinds && world.routeKinds[kind])) return { error: `there is already a kind "${kind}"` };
    world.routeKinds = Object.assign({}, world.routeKinds, { [kind]: { time: '1h' } });
    return { kind };
  };
  M.removeRouteKind = function (world, kind) {
    if (!world.routeKinds) return;
    delete world.routeKinds[kind];
    if (!Object.keys(world.routeKinds).length) delete world.routeKinds;
  };

  // Every map in the world: the world's and the regions' own (R-3), as
  // [{ owner (null for the world's), map }].
  M.maps = (world) => [].concat(world.map ? [{ owner: null, map: world.map }] : [], (world.regions || []).filter((r) => r && r.map).map((r) => ({ owner: r.id, map: r.map })));
  // A new region (R-4), inside another or at the top level, with an id from
  // its name that no region or room has. → its id.
  M.addRegion = function (world, name, parent, takenRooms) {
    const id = M.slug(name || 'new region', (world.regions || []).map((r) => r.id).concat(takenRooms || []));
    const r = { id, name: name || 'New region', controller: null, tags: [], status: '', neighbours: [], lore: '' };
    if (parent != null && (world.regions || []).some((x) => x.id === parent)) r.parent = parent;
    world.regions = (world.regions || []).concat([r]);
    return id;
  };
  // Puts a region inside another (null: the top level). Refuses a loop, in
  // words. Shapes on a region's map for regions no longer inside it go, and
  // say so. → { error } or { notes }.
  M.setParent = function (world, id, parent) {
    const list = world.regions || [];
    const r = list.find((x) => x.id === id);
    if (!r) return { error: `no region "${id}"` };
    const p = parent == null || parent === '' ? null : list.find((x) => x.id === parent);
    if (parent != null && parent !== '' && !p) return { error: `no region "${parent}"` };
    if (p && (p.id === id || E.Scenario.regionChainIn(list, p.id).includes(id))) return { error: `${r.name} can't go inside ${p.name}: ${p.id === id ? 'that is itself' : `${p.name} is inside ${r.name}`}` };
    if (p) r.parent = p.id; else delete r.parent;
    const notes = [];
    M.maps(world).filter((m) => m.owner && m.map.regions).forEach(({ owner, map }) => {
      Object.keys(map.regions).filter((x) => !E.Scenario.regionChainIn(list, x).slice(1).includes(owner)).forEach((x) => {
        delete map.regions[x];
        notes.push(`${(list.find((y) => y.id === x) || { name: x }).name} is no longer inside ${(list.find((y) => y.id === owner) || { name: owner }).name}, so it came off that map`);
      });
    });
    return { notes };
  };
  M.renameRegion = function (world, starts, from, to, files) {
    if (from === to) return;
    const r = (world.regions || []).find((x) => x.id === from);
    if (!r) return;
    r.id = to;
    // Its shape on every map: the world's and the regions' own (R-3).
    M.maps(world).forEach(({ map }) => {
      if (map.regions && map.regions[from]) { map.regions[to] = map.regions[from]; delete map.regions[from]; }
    });
    eachRef(world, starts, (id) => (id === from ? to : id));
    // The regions inside it (R-1).
    (world.regions || []).forEach((x) => { if (x.parent === from) x.parent = to; });
    regionLore(world, starts, files, from).forEach((e) => { e.ref = to; });
    timelineEvents(world, starts).forEach((ev) => {
      if (ev.region === from) ev.region = to;
      (ev.preconditions || []).flatMap(controlsOf).forEach((c) => { if (c.region === from) c.region = to; });
    });
  };
  // Deletes a region and everything pointing at it. A start or room left
  // without a region falls back to the first region left (validation needs
  // one), or loses the field when none are left. Its lore entries are kept as
  // topics (the text is the author's). Returns notes for the page.
  M.deleteRegion = function (world, starts, id, files) {
    const gone = (world.regions || []).find((r) => r.id === id);
    const notes0 = [];
    world.regions = (world.regions || []).filter((r) => r.id !== id);
    // The regions inside it move up to its own parent (R-1).
    const up = gone && gone.parent != null && world.regions.some((r) => r.id === gone.parent) ? gone.parent : null;
    const lifted = world.regions.filter((r) => r.parent === id);
    lifted.forEach((r) => { if (up) r.parent = up; else delete r.parent; });
    M.maps(world).forEach(({ map }) => { if (map.regions) delete map.regions[id]; });
    if (gone && gone.map) notes0.push(`${gone.name}'s own map went with it`);
    // A route's requirement about who holds it goes (R-2), before refs move to the fallback.
    const unlocked = [];
    world.regions.forEach((r) => (Array.isArray(r.routes) ? r.routes : []).forEach((x) => {
      if (x && controlsOf(x.requires).some((c) => c.region === id)) { delete x.requires; unlocked.push(`${r.name}'s route to ${x.to}`); }
    }));
    const fallback = world.regions[0] ? world.regions[0].id : null;
    const moved = Object.entries(starts || {}).filter(([, s]) => s.region === id).map(([sid]) => sid);
    eachRef(world, starts, (x) => (x === id ? fallback : x), (x) => (x === id ? null : x));
    const notes = notes0.concat(moved.map((sid) => (fallback ? `start "${sid}" now starts in ${fallback}` : `start "${sid}" has no region now`)));
    unlocked.forEach((t) => notes.push(`${t} lost a requirement about who holds ${id}`));
    if (lifted.length) notes.push(`${lifted.map((r) => r.name).join(', ')} ${lifted.length > 1 ? 'are' : 'is'} now ${up ? `inside ${(world.regions.find((r) => r.id === up) || {}).name || up}` : 'at the top level'}`);
    regionLore(world, starts, files, id).forEach((e) => {
      e.level = 'topic';
      delete e.ref;
      notes.push(`lore "${e.id}" is now a topic (it only comes up by its keywords)`);
    });
    // Timeline events there move to the fallback region (or become world
    // events), and preconditions about who holds it are removed.
    timelineEvents(world, starts).forEach((ev) => {
      if (ev.region === id) {
        if (fallback) { ev.region = fallback; notes.push(`timeline "${ev.id}" now happens in ${fallback}`); }
        else { delete ev.region; ev.scope = 'world'; notes.push(`timeline "${ev.id}" is now a world event`); }
      }
      const before = (ev.preconditions || []).length;
      if (before) ev.preconditions = ev.preconditions.filter((p) => !controlsOf(p).some((c) => c.region === id));
      if (ev.preconditions && ev.preconditions.length < before) notes.push(`timeline "${ev.id}" lost a precondition about who holds ${id}`);
    });
    if (!world.regions.length) {
      delete world.regions;
      if (world.map) delete world.map.regions;
    }
    return notes;
  };
})(typeof window !== 'undefined' ? window : globalThis);
