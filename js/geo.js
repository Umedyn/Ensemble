// Map geometry (task 4-5): between latitude/longitude and map pixels, region
// shapes in several pieces (islands), simplifying and clipping outlines,
// anchors for labels, and neighbours from shared borders. DOM-free: the
// engine, the creator and tools/basemap.mjs all use it.
//
// A projected map ("projection": "equirectangular", "bounds": [west, south,
// east, north] in degrees) places longitude and latitude linearly on the
// image, as Natural Earth's rasters are drawn.
(function (root) {
  const E = root.Ensemble;
  const G = (E.Geo = {});
  G.PROJECTIONS = ['equirectangular'];

  // ---------- projection ----------
  G.projected = (map) => !!(map && map.projection === 'equirectangular' && Array.isArray(map.bounds) && map.bounds.length === 4);
  G.toPixel = function (map, ll) {
    const [w, s, e, n] = map.bounds;
    return [((ll[0] - w) / (e - w)) * map.width, ((n - ll[1]) / (n - s)) * map.height];
  };
  G.toLonLat = function (map, p) {
    const [w, s, e, n] = map.bounds;
    return [w + (p[0] / map.width) * (e - w), n - (p[1] / map.height) * (n - s)];
  };
  // "45.76° N, 4.84° E"
  G.fmtLonLat = (ll) => `${Math.abs(ll[1]).toFixed(2)}° ${ll[1] >= 0 ? 'N' : 'S'}, ${Math.abs(ll[0]).toFixed(2)}° ${ll[0] >= 0 ? 'E' : 'W'}`;
  // Problems with a map's projection fields (none when it has none).
  G.projectionProblems = function (map) {
    if (map.projection == null && map.bounds == null) return [];
    const out = [];
    if (!G.PROJECTIONS.includes(map.projection)) out.push(`map: "projection" must be ${G.PROJECTIONS.join(' or ')}`);
    const b = map.bounds;
    if (!(Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number' && Number.isFinite(x)) && b[0] < b[2] && b[1] < b[3] && b[0] >= -180 && b[2] <= 180 && b[1] >= -90 && b[3] <= 90)) {
      out.push('map: "bounds" must be [west, south, east, north] in degrees, west < east and south < north');
    }
    return out;
  };

  // ---------- shapes ----------
  // A region's shape on the map: { polygon: ring } or { polygons: [ring, …] }
  // (islands), or { point }. → its rings ([] for a point).
  G.pieces = (sh) => (!sh ? [] : Array.isArray(sh.polygons) ? sh.polygons : Array.isArray(sh.polygon) ? [sh.polygon] : []);
  G.area = (ring) => Math.abs(ring.reduce((s, a, i) => { const b = ring[(i + 1) % ring.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
  G.inside = function (p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  G.insideAny = (p, rings) => rings.some((r) => G.inside(p, r));
  G.bbox = function (rings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    rings.forEach((r) => r.forEach(([x, y]) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }));
    return [x0, y0, x1, y1];
  };
  G.centroid = function (ring) {
    let a = 0, x = 0, y = 0;
    ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; const c = p[0] * q[1] - q[0] * p[1]; a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c; });
    if (Math.abs(a) < 1e-9) return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    return [x / (3 * a), y / (3 * a)];
  };
  // Where a region's label goes: inside its biggest piece (the centroid when
  // it is inside; else the middle of the widest stretch across that line).
  G.anchor = function (rings) {
    if (!rings.length) return null;
    const ring = rings.reduce((best, r) => (G.area(r) > G.area(best) ? r : best), rings[0]);
    const c = G.centroid(ring);
    if (G.inside(c, ring)) return c;
    const xs = [];
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      if ((a[1] > c[1]) !== (b[1] > c[1])) xs.push(a[0] + ((c[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    });
    xs.sort((p, q) => p - q);
    let best = null;
    for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
    return best ? [(best[0] + best[1]) / 2, c[1]] : c;
  };

  // ---------- simplifying and clipping ----------
  const segDist = function (p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  G.segDist = segDist;
  // Douglas–Peucker on a closed ring, keeping corners further than tol from
  // the simplified line. → a ring of 3+ points, or null when it collapses.
  G.simplify = function (ring, tol) {
    const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
    if (pts.length < 4 || !(tol > 0)) return pts.length >= 3 ? pts : null;
    // Split at the point furthest from the first, so the ring has two ends.
    let far = 1, fd = 0;
    pts.forEach((p, i) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = i; } });
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[far] = 1;
    const dp = (lo, hi, end) => {
      const stack = [[lo, hi]];
      while (stack.length) {
        const [a, b] = stack.pop();
        let idx = -1, md = tol;
        const pa = pts[a], pb = pts[b % pts.length];
        for (let i = a + 1; i < b; i++) { const d = segDist(pts[i % pts.length], pa, pb); if (d > md) { md = d; idx = i; } }
        if (idx >= 0) { keep[idx % pts.length] = 1; stack.push([a, idx], [idx, b]); }
      }
    };
    dp(0, far);
    dp(far, pts.length);
    const out = pts.filter((_, i) => keep[i]);
    return out.length >= 3 ? out : null;
  };
  // A ring clipped to a box [x0, y0, x1, y1] (Sutherland–Hodgman). → ring or null.
  G.clip = function (ring, box) {
    const [x0, y0, x1, y1] = box;
    const edges = [
      [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((x0 - a[0]) * (b[1] - a[1])) / (b[0] - a[0])]],
      [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((x1 - a[0]) * (b[1] - a[1])) / (b[0] - a[0])]],
      [(p) => p[1] >= y0, (a, b) => [a[0] + ((y0 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y0]],
      [(p) => p[1] <= y1, (a, b) => [a[0] + ((y1 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y1]],
    ];
    let out = ring.slice();
    for (const [inside, cut] of edges) {
      if (!out.length) break;
      const src = out;
      out = [];
      src.forEach((p, i) => {
        const q = src[(i + 1) % src.length];
        const pi = inside(p), qi = inside(q);
        if (pi) out.push(p);
        if (pi !== qi) out.push(cut(p, q));
      });
    }
    return out.length >= 3 && G.area(out) > 0 ? out : null;
  };
  // Rings → pixel rings fit for a map: projected, clipped to the image,
  // simplified (tol pixels), rounded, small islands dropped (minArea px²).
  G.fitRings = function (map, lonLatRings, o) {
    const opts = Object.assign({ tol: 1.5, minArea: 6 }, o || {});
    const box = [0, 0, map.width, map.height];
    return lonLatRings.map((r) => {
      const px = r.map((ll) => G.toPixel(map, ll));
      const clipped = G.clip(px, box);
      const s = clipped && G.simplify(clipped, opts.tol);
      if (!s) return null;
      const rounded = s.map((p) => [Math.round(Math.max(0, Math.min(map.width, p[0]))), Math.round(Math.max(0, Math.min(map.height, p[1])))]);
      const dedup = rounded.filter((p, i) => { const q = rounded[(i + rounded.length - 1) % rounded.length]; return p[0] !== q[0] || p[1] !== q[1]; });
      return dedup.length >= 3 && G.area(dedup) >= opts.minArea ? dedup : null;
    }).filter(Boolean);
  };

  // ---------- importing real places (task 4-5, tools/basemap.mjs) ----------
  // Outlines from open data → regions on a projected map. features: [{ key,
  // name, alt: [other names], wikidata, title (a Wikipedia title), rings:
  // [[[lon, lat], …], …] (outer rings) }]. opts: { pick: [names] (any of
  // name, alt or key, any case), within: true (anything on the map), taken:
  // [ids in use], tol, minArea }. → { regions: [{ id, key, name, wiki }],
  // shapes: {id: {polygon} | {polygons}}, neighbours: [[a, b]], skipped:
  // [names], missing: [picked names not found], lonlat: {id: source rings} }.
  const slug = (t) => String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'region';
  G.slug = slug;
  // Which features: picked by name (any of name, alt or key, any case), or
  // (within) any with a point on the map. → { chosen, missing }
  G.pickFeatures = function (map, features, o) {
    const norm = (t) => String(t || '').trim().toLowerCase();
    const names = (f) => [f.name, f.key].concat(f.alt || []).filter(Boolean).map(norm);
    const want = (o.pick || []).map(norm).filter(Boolean);
    const box = [map.bounds[0], map.bounds[1], map.bounds[2], map.bounds[3]];
    const onMap = (f) => f.rings.some((r) => r.some(([lon, lat]) => lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3]));
    const chosen = features.filter((f) => (want.length ? names(f).some((n) => want.includes(n)) : o.within && onMap(f)));
    return { chosen, missing: want.filter((w) => !features.some((f) => names(f).includes(w))) };
  };
  G.importRegions = function (map, features, opts) {
    const o = Object.assign({ tol: 1.5, minArea: 6, taken: [] }, opts || {});
    const { chosen, missing } = G.pickFeatures(map, features, o);
    const used = new Set(o.taken);
    const out = { regions: [], shapes: {}, neighbours: [], skipped: [], missing };
    const lonlat = {};
    chosen.forEach((f) => {
      const rings = G.fitRings(map, f.rings, o);
      if (!rings.length) return out.skipped.push(f.name);
      let id = slug(f.name);
      for (let n = 2; used.has(id); n++) id = `${slug(f.name)}-${n}`;
      used.add(id);
      out.regions.push(Object.assign({ id, key: f.key, name: f.name }, f.title || f.wikidata ? { wiki: Object.assign({}, f.title ? { title: f.title } : {}, f.wikidata ? { wikidata: f.wikidata } : {}) } : {}));
      out.shapes[id] = rings.length === 1 ? { polygon: rings[0] } : { polygons: rings };
      lonlat[id] = f.rings;
    });
    // Neighbours from the source outlines (shared borders are exact there).
    out.neighbours = G.neighbours(lonlat, 0.02);
    out.lonlat = lonlat;
    return out;
  };
  // Named places → map places. points: [{ name, lon, lat, kind, key (the
  // region feature's key, if known) }]; regions: from importRegions (or the
  // world's own regions with a "key"). Places off the map are left out; a
  // place without a matching key goes to the region whose shape holds it.
  G.importPlaces = function (map, points, regions, shapes, taken) {
    const used = new Set(taken || []);
    const out = [];
    points.forEach((p) => {
      const at = G.toPixel(map, [p.lon, p.lat]).map(Math.round);
      if (at[0] < 0 || at[1] < 0 || at[0] > map.width || at[1] > map.height) return;
      const byKey = p.key && regions.find((r) => r.key === p.key);
      const holder = byKey || regions.find((r) => shapes[r.id] && G.insideAny(at, G.pieces(shapes[r.id])));
      let id = slug(p.name);
      for (let n = 2; used.has(id); n++) id = `${slug(p.name)}-${n}`;
      used.add(id);
      out.push(Object.assign({ id, name: p.name, kind: p.kind || 'city', at }, holder ? { region: holder.id } : {}));
    });
    return out;
  };

  // ---------- neighbours ----------
  // Shapes that share a border: a corner of one within tol of an edge of the
  // other. shapes: {id: [ring, …]} in any units (degrees from the source
  // data are best: exact shared borders). → [[a, b], …], ids sorted.
  G.neighbours = function (shapes, tol) {
    tol = tol == null ? 0.01 : tol;
    const ids = Object.keys(shapes).filter((id) => shapes[id].length).sort();
    const boxes = {};
    ids.forEach((id) => { boxes[id] = G.bbox(shapes[id]); });
    const near = (A, B) => A.some((ra) => ra.some((p) => B.some((rb) => rb.some((b, i) => segDist(p, b, rb[(i + 1) % rb.length]) <= tol))));
    const out = [];
    ids.forEach((a, i) => ids.slice(i + 1).forEach((b) => {
      const A = boxes[a], B = boxes[b];
      if (A[0] - tol > B[2] || B[0] - tol > A[2] || A[1] - tol > B[3] || B[1] - tol > A[3]) return;
      // Only the parts of each that are near the other's box.
      const crop = (rings, box) => rings.map((r) => r.filter(([x, y]) => x >= box[0] - tol && x <= box[2] + tol && y >= box[1] - tol && y <= box[3] + tol)).filter((r) => r.length);
      const pa = crop(shapes[a], B), pb = crop(shapes[b], A);
      if (pa.length && pb.length && (near(pa, shapes[b]) || near(pb, shapes[a]))) out.push([a, b]);
    }));
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
