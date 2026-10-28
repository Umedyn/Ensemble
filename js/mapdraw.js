// The world map, drawn the same way in the game and the creator (task 3-5):
// regions coloured by who holds them, tag badges, your region marked, rooms
// placed on the map. Returns SVG text from plain data, with no DOM, so Node
// tests can check it. Public state only: controllers, tags, names. Colours
// are theme classes (fc-1…fc-8, none) styled in css/style.css.
(function (root) {
  const E = root.Ensemble;
  const D = (E.MapDraw = {});
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  D.esc = esc;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // A faction's colour class: its "color" (1–8), else one picked from its id.
  D.factionClass = function (factions, fid) {
    const f = fid && (factions || []).find((x) => x.id === fid);
    if (!f) return 'none';
    return 'fc-' + (f.color || (E.hash(f.id) % E.Scenario.FACTION_COLORS) + 1);
  };
  D.factionName = (factions, fid) => { const f = fid && (factions || []).find((x) => x.id === fid); return f ? f.name : 'no one'; };

  // Shapes and anchors for a world map: the image's polygons and points, or
  // the automatic node map. regions: the definitions; map: the world's map
  // (or null); seed: the world id.
  D.geometry = function (regions, map, seed) {
    // A region with regions inside it (R-1) is drawn only when the map gives
    // it a shape of its own; otherwise its children stand for it, and it gets
    // no automatic point or node. Parents go first, so children sit on top.
    const parents = new Set((regions || []).map((r) => r && r.parent).filter((p) => p != null));
    const own = (r) => map && map.regions && map.regions[r.id];
    regions = (regions || []).filter((r) => !parents.has(r.id) || own(r)).sort((a, b) => parents.has(b.id) - parents.has(a.id));
    if (map) {
      const anchors = E.Layouts.regionAnchors(regions, map);
      const shapes = {};
      regions.forEach((r) => {
        const sh = map.regions && map.regions[r.id];
        // A region in several pieces (islands; task 4-5) is one shape.
        shapes[r.id] = sh && (sh.polygon || sh.polygons) ? { polygons: E.Geo.pieces(sh) } : { circle: anchors[r.id], r: 4 };
      });
      return { image: map, anchors, shapes, edges: [], full: [0, 0, map.width, map.height] };
    }
    const nm = E.Layouts.regionMap(regions, seed);
    const anchors = {}, shapes = {};
    Object.entries(nm.nodes).forEach(([id, n]) => { anchors[id] = [n.x, n.y]; shapes[id] = { box: n }; });
    return { image: null, anchors, shapes, edges: nm.edges, kinds: nm.kinds, full: [0, 0, nm.width, nm.height] };
  };

  // ---------- the zooming map (R-3) ----------
  // One level of the map: a region (or null, the world) and what it shows.
  // Its picture is the nearest map up the chain: its own, an ancestor's, or
  // the world's. With a picture, everything outlined on it is drawn as
  // before (the picture is decoration underneath, never data: rule 11), and
  // the view zooms to the level; regions outside it are dimmed (how much
  // detail shows depends on the zoom: worldSvg). Without one, a node map of
  // its children and their routes. A leaf shows its parent's
  // view, zoomed to it.
  // → { id, picture (map or null), owner (whose map), regions (definitions
  // to draw), g, viewBox, children (ids a click zooms into), dim (ids outside
  // the level), rooms ([{id, x, y}] placed on the picture, in the level) }
  // opts.hidden: regions the player doesn't know of (R-5), left out entirely.
  D.level = function (sc, levelId, opts) {
    const S = E.Scenario;
    const hidden = (opts && opts.hidden) || new Set();
    const list = (sc.regions || []).filter((r) => r && r.id && !hidden.has(r.id));
    const def = (id) => list.find((r) => r.id === id) || null;
    const id = levelId != null && def(levelId) ? levelId : null;
    const chainOf = (x) => S.regionChainIn(list, x);
    const inside = (x, of) => of == null || (x !== of && chainOf(x).includes(of));
    const children = S.regionChildrenIn(list, id);
    // A leaf shows its parent's level, zoomed to it.
    const leaf = id != null && !children.length && !def(id).map;
    const base = leaf ? (def(id).parent != null && def(def(id).parent) ? def(id).parent : null) : id;
    const owner = (base != null ? chainOf(base) : []).find((x) => def(x).map) || null;
    const picture = owner ? def(owner).map : sc.map || null;
    const seed = `${sc.worldId || ''}${base ? ':' + base : ''}`;
    if (picture) {
      const regions = list.filter((r) => inside(r.id, owner));
      const g = D.geometry(regions, picture, seed);
      const focus = id == null || id === owner ? null : (leaf ? [id] : list.filter((r) => inside(r.id, id)).map((r) => r.id).filter((x) => g.shapes[x]));
      // A leaf: as the regional view was, twice its size within what's near it.
      const near = leaf ? [id].concat(S.regionNearIn(list, id)).filter((x) => g.shapes[x]) : [];
      const viewBox = leaf && g.shapes[id] ? D.focusBox(g, id, near) : focus && focus.length ? D.regionBox(g, focus) : g.full;
      const dim = id == null || id === owner || leaf ? [] :
 regions.map((r) => r.id).filter((x) => g.shapes[x] && x !== id && !inside(x, id));
      const rooms = Object.entries(isObj(picture.locations) ? picture.locations : {}).map(([room, p]) => ({ id: room, x: p[0], y: p[1] }));
      return { id, leaf, picture, owner, regions, g, viewBox, children: regions.map((r) => r.id).filter((x) => g.shapes[x] && inside(x, id) && !dim.includes(x)), dim, rooms };
    }
    // Routes between regions inside the ones shown count as routes between
    // them (the town's parts touch the junction, so the town does), a kind
    // other than a border winning.
    const kids = S.regionChildrenIn(list, base);
    const up = (x) => S.regionChainIn(list, x).find((c) => kids.includes(c)) || null;
    const lifted = new Map(kids.map((k) => [k, new Map()]));
    list.forEach((r) => [].concat((r.neighbours || []).map((to) => ({ to, kind: 'border' })), Array.isArray(r.routes) ? r.routes : []).forEach((x) => {
      const a = up(r.id), b = x && up(x.to);
      if (!a || !b || a === b) return;
      const was = lifted.get(a).get(b);
      if (!was || (was === 'border' && x.kind && x.kind !== 'border')) lifted.get(a).set(b, x.kind || 'border');
    }));
    const shown = kids.map((k) => Object.assign({}, def(k), { neighbours: [], routes: [...lifted.get(k)].map(([to, kind]) => ({ to, kind })) }));
    const g = D.geometry(shown, null, seed);
    return { id, leaf, picture: null, owner: null, regions: shown, g, viewBox: leaf ? D.regionBox(g, [id]) : g.full, children: leaf ? [] : shown.map((r) => r.id), dim: [], rooms: [], liftTo: up };

  };
  // The levels from the world down to one: [null, …ancestors, id].
  D.levelPath = (sc, id) => [null].concat(id == null ? [] : E.Scenario.regionChainIn(sc.regions || [], id).reverse());
  // Can a region be zoomed into (it has regions inside it, or a map)?
  D.hasLevel = (sc, id, hidden) => { const r = (sc.regions || []).find((x) => x && x.id === id); return !!r && (!!r.map || E.Scenario.regionChildrenIn(sc.regions, id).some((c) => !(hidden && hidden.has(c)))); };
  // The box around some regions, padded.
  D.regionBox = function (g, ids) {
    const pts = [];
    ids.forEach((id) => {
      const sh = g.shapes[id];
      if (!sh) return;
      if (sh.polygons) sh.polygons.forEach((ring) => pts.push(...ring));
      else if (sh.box) pts.push([sh.box.x - sh.box.w / 2, sh.box.y - sh.box.h / 2], [sh.box.x + sh.box.w / 2, sh.box.y + sh.box.h / 2]);
      else pts.push([sh.circle[0] - 60, sh.circle[1] - 40], [sh.circle[0] + 60, sh.circle[1] + 40]);
    });
    if (!pts.length) return g.full.slice();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const pad = 30;
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad];
  };
  // The regional view: your region at twice its size, within the box around
  // it and its neighbours.
  D.focusBox = function (g, mine, near) {
    const [ox, oy, ow, oh] = D.regionBox(g, [mine]);
    const [nx, ny, nw, nh] = D.regionBox(g, near);
    const cx = ox + ow / 2, cy = oy + oh / 2;
    const x0 = Math.max(nx, cx - ow), y0 = Math.max(ny, cy - oh);
    const x1 = Math.min(nx + nw, cx + ow), y1 = Math.min(ny + nh, cy + oh);
    return [x0, y0, x1 - x0, y1 - y0];
  };

  // A map's named places (task 4-5) as the renderer takes them.
  D.placesOf = (map) => ((map && Array.isArray(map.places)) ? map.places : []).filter((p) => p && Array.isArray(p.at)).map((p) => ({ x: p.at[0], y: p.at[1], name: p.name, kind: p.kind, notable: p.notable }));
  // o: { g (from geometry), regions (definitions), now ({id: {controller,
  // tags}}), factions, mine, selected, pulse (ids), imageUrl, viewBox, id,
  // view, label, rooms ([{x, y, name}]), places ([{x, y, name, kind,
  // notable}]: named points such as capitals, task 4-5), overlay (extra SVG
  // on top) }
  // Detail by zoom: a region inside one outlined on the picture (a city in
  // its country) shows once that outline's biggest piece is at least
  // 1/DETAIL of the view's width (inside a point, only the cap below); on a crowded picture (over CROWDED
  // regions: a world of countries), never in a view wider than DETAIL_MAX of
  // the whole picture, so zoomed out it shows only the top level. Yours, the
  // ones you're inside and the selected one always show.
  D.DETAIL = 5;
  D.DETAIL_MAX = 0.6;
  D.CROWDED = 60;
  D.detailShown = function (g, regions, vbox, always) {
    const byId = new Map((regions || []).map((r) => [r.id, r]));
    const sizes = new Map();
    const size = (id) => {
      if (!sizes.has(id)) {
        const sh = g.shapes[id];
        const big = sh && sh.polygons && sh.polygons.slice().sort((a, b) => E.Geo.area(b) - E.Geo.area(a))[0];
        const b = big && E.Geo.bbox([big]);
        sizes.set(id, b ? Math.max(b[2] - b[0], b[3] - b[1]) : sh ? Infinity : null);
      }
      return sizes.get(id);
    };
    const keep = new Set((always || []).filter((x) => x != null));
    const crowded = (regions || []).filter((r) => g.shapes[r.id]).length > D.CROWDED;
    const widest = crowded ? g.full[2] * D.DETAIL_MAX : Infinity;
    return (r) => {
      if (keep.has(r.id)) return true;
      const seen = new Set();
      for (let p = r.parent; p != null && byId.has(p) && !seen.has(p); p = byId.get(p).parent) {
        seen.add(p);
        const s = size(p);
        if (s != null) return vbox[2] <= Math.min(s * D.DETAIL, widest);
      }
      return true;
    };
  };
  D.worldSvg = function (o) {
    const g = o.g;
    const vbox = o.viewBox || g.full;
    const shown = D.detailShown(g, o.regions, vbox, [o.mine, o.selected].concat(o.branch || []));
    // Text, badges and pins keep their size on screen whatever the map's
    // size: a whole-world image is thousands of pixels wide (task 4-5).
    const k = Math.max(1, vbox[2] / 900);
    const n1 = (v) => Math.round(v * 10) / 10;
    const shapeSvg = (id, cls) => {
      const sh = g.shapes[id];
      if (sh.polygons && sh.polygons.length === 1) return `<polygon class="${cls}" points="${sh.polygons[0].map((p) => p.join(',')).join(' ')}"/>`;
      if (sh.polygons) return `<path class="${cls}" d="${sh.polygons.map((ring) => 'M' + ring.map((p) => p.join(',')).join('L') + 'Z').join('')}"/>`;
      if (sh.box) return `<rect class="${cls}" x="${sh.box.x - sh.box.w / 2}" y="${sh.box.y - sh.box.h / 2}" width="${sh.box.w}" height="${sh.box.h}" rx="10" style="fill-opacity:0.8"/>`;
      // A point is a dot, with a bigger invisible target around it to click.
      return `<circle class="region-hit" cx="${sh.circle[0]}" cy="${sh.circle[1]}" r="${n1(14 * k)}"/><circle class="${cls} point" cx="${sh.circle[0]}" cy="${sh.circle[1]}" r="${n1(sh.r * k)}"/>`;
    };
    // A label shows where it fits: always for points and the node map, for
    // an outline when it is wide enough in this view, and for yours and the
    // selected one.
    const fits = (r) => {
      const sh = g.shapes[r.id];
      if (!sh.polygons || r.id === o.mine || r.id === o.selected) return true;
      const b = E.Geo.bbox(sh.polygons);
      return b[2] - b[0] >= String(r.name).length * 12 * k * 0.55;
    };
    // Routes on the node map (R-3): a line style per kind, closed ones marked.
    const closed = o.closed || new Set();
    const kindClass = (k) => (['border', 'road', 'rail', 'sea', 'air', 'checkpoint'].includes(k) ? k : 'other');
    const edges = g.edges.map(([a, b]) => {
      const key = `${a}|${b}`;
      const kind = (g.kinds || {})[key] || 'border';
      return `<line class="region-edge kind-${kindClass(kind)}${closed.has(key) ? ' closed' : ''}" x1="${g.anchors[a][0]}" y1="${g.anchors[a][1]}" x2="${g.anchors[b][0]}" y2="${g.anchors[b][1]}"><title>${esc(kind)}${closed.has(key) ? ' (closed)' : ''}</title></line>`;
    }).join('');
    const dim = new Set(o.dim || []);
    const zoomable = new Set(o.zoomable || []);
    const pulse = new Set(o.pulse || []);
    const parents = new Set((o.regions || []).map((r) => r.parent).filter((p) => p != null));
    const body = (o.regions || []).filter((r) => g.shapes[r.id] && shown(r)).sort((a, b) => parents.has(b.id) - parents.has(a.id)).map((r) => {
      const now = (o.now || {})[r.id] || { controller: r.controller || null, tags: r.tags || [] };
      const fc = D.factionClass(o.factions, now.controller);
      const cls = `region-shape ${fc}${fc === 'none' ? ' none' : ''}${(o.contested || []).includes(r.id) ? ' contested' : ''}${r.id === o.mine ? ' here' : ''}${(o.branch || []).includes(r.id) && r.id !== o.mine ? ' branch' : ''}${r.id === o.selected ? ' selected' : ''}`;
      const [ax, ay] = g.anchors[r.id];
      const show = fits(r);
      const tags = show ? (now.tags || []).slice(0, 2).concat((now.tags || []).length > 2 ? [`+${now.tags.length - 2}`] : []) : [];
      // A point's name sits just above its dot.
      const ly = g.shapes[r.id].circle ? ay - 7 * k : ay;
      let tx = ax - tags.reduce((t, x) => t + (x.length * 5.3 + 12) * k, 0) / 2;
      const ts = k > 1 ? ` style="font-size:${n1(9.5 * k)}px"` : '';
      const badges = tags.map((t) => {
        const w = (t.length * 5.3 + 8) * k;
        const out = `<rect class="region-tag" x="${n1(tx)}" y="${n1(ay + 7 * k)}" width="${n1(w)}" height="${n1(14 * k)}" rx="${n1(7 * k)}"/><text class="region-tag-text" x="${n1(tx + 4 * k)}" y="${n1(ay + 17.5 * k)}"${ts}>${esc(t)}</text>`;
        tx += w + 4 * k;
        return out;
      }).join('');
      const pin = r.id === o.mine ? `<circle class="region-pin" cx="${ax}" cy="${n1(ay - 24 * k)}" r="${n1(6 * k)}"/>` : '';
      const label = `${r.name}, held by ${D.factionName(o.factions, now.controller)}${(o.contested || []).includes(r.id) ? ', contested' : ''}${r.id === o.mine ? ', you are here' : ''}`;
      const text = show ? `<text class="region-label" x="${ax}" y="${n1(ly)}" text-anchor="middle"${k > 1 ? ` style="font-size:${n1(12 * k)}px;stroke-width:${n1(3 * k)}px"` : ''}>${esc(r.name)}</text>` : '';
      return `<g class="region-g${pulse.has(r.id) ? ' changed' : ''}${dim.has(r.id) ? ' dim' : ''}" tabindex="0" role="button" data-region="${esc(r.id)}"${zoomable.has(r.id) ? ' data-zoomable="1"' : ''} aria-label="${esc(label)}${zoomable.has(r.id) ? ', zoom in' : ''}">${shapeSvg(r.id, cls)}${text}${badges}${pin}</g>`;
    }).join('');
    const small = k > 1 ? ` style="font-size:${n1(11 * k)}px;stroke-width:${n1(3 * k)}px"` : '';
    const rooms = (o.rooms || []).map((p) => `<circle class="region-loc" cx="${p.x}" cy="${p.y}" r="${n1(4 * k)}"/><text class="region-loc-label" x="${n1(p.x + 7 * k)}" y="${n1(p.y + 4 * k)}"${small}>${esc(p.name)}</text>`).join('');
    // Places: a dot each; names when zoomed in, or for notable ones.
    const zoomed = vbox[2] <= g.full[2] * 0.35;
    const places = (o.places || []).map((p) => {
      const r = (p.kind === 'capital' ? 4.5 : 3) * k;
      const dot = p.kind === 'capital' ? `<rect class="region-place capital" x="${n1(p.x - r)}" y="${n1(p.y - r)}" width="${n1(2 * r)}" height="${n1(2 * r)}"/>` : `<circle class="region-place" cx="${p.x}" cy="${p.y}" r="${n1(r)}"/>`;
      const name = zoomed || p.notable ? `<text class="region-loc-label" x="${n1(p.x + r + 3 * k)}" y="${n1(p.y + 4 * k)}"${small}>${esc(p.name)}</text>` : '';
      return `<g class="region-place-g"><title>${esc(p.name)}</title>${dot}${name}</g>`;
    }).join('');
    const img = o.imageUrl && g.image ? `<image href="${esc(o.imageUrl)}" x="0" y="0" width="${g.image.width}" height="${g.image.height}"/>` : '';
    const vb = vbox.map((n) => Math.round(n)).join(' ');
    return `<svg class="world-svg" id="${esc(o.id || 'worldSvg')}" data-view="${esc(o.view || 'world')}" viewBox="${vb}" role="img" aria-label="${esc(o.label || 'World map')}">${img}${edges}${body}${places}${rooms}${o.overlay || ''}</svg>`;
  };
})(typeof window !== 'undefined' ? window : globalThis);
