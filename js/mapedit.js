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
    const hits = Object.entries((map && map.regions) || {}).filter(([, s]) => (s.polygon ? M.inPolygon(p, s.polygon) : s.point && Math.sqrt(dist2(p, s.point)) <= (r || 26)));
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
    const polys = Object.entries((map && map.regions) || {}).filter(([, s]) => s.polygon && s.polygon.length >= 3);
    const out = [];
    const touches = (A, B) => A.some((p) => B.some((b, i) => M.segDist(p, b, B[(i + 1) % B.length]) <= tol));
    polys.forEach(([a, sa], i) => polys.slice(i + 1).forEach(([b, sb]) => {
      if (touches(sa.polygon, sb.polygon) || touches(sb.polygon, sa.polygon)) out.push([a, b].sort());
    }));
    return out.sort();
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
  // "region", rooms' "region" (world and starts) and event seeds.
  // neighbourFn (default fn) maps neighbour lists; null drops the link.
  function eachRef(world, starts, fn, neighbourFn) {
    const nf = neighbourFn || fn;
    (world.regions || []).forEach((r) => { r.neighbours = [...new Set((r.neighbours || []).map((n) => nf(n)).filter((n) => n && n !== r.id))]; });
    const rooms = [].concat(world.locations || [], ...Object.values(starts || {}).map((s) => s.locations || []));
    rooms.forEach((l) => { if (l.region != null) { const v = fn(l.region); if (v) l.region = v; else delete l.region; } });
    Object.values(starts || {}).forEach((s) => { if (s.region != null) { const v = fn(s.region); if (v) s.region = v; else delete s.region; } });
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
  M.renameRegion = function (world, starts, from, to, files) {
    if (from === to) return;
    const r = (world.regions || []).find((x) => x.id === from);
    if (!r) return;
    r.id = to;
    if (world.map && world.map.regions && world.map.regions[from]) {
      world.map.regions[to] = world.map.regions[from];
      delete world.map.regions[from];
    }
    eachRef(world, starts, (id) => (id === from ? to : id));
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
    world.regions = (world.regions || []).filter((r) => r.id !== id);
    if (world.map && world.map.regions) delete world.map.regions[id];
    const fallback = world.regions[0] ? world.regions[0].id : null;
    const moved = Object.entries(starts || {}).filter(([, s]) => s.region === id).map(([sid]) => sid);
    eachRef(world, starts, (x) => (x === id ? fallback : x), (x) => (x === id ? null : x));
    const notes = moved.map((sid) => (fallback ? `start "${sid}" now starts in ${fallback}` : `start "${sid}" has no region now`));
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
