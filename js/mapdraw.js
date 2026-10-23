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
    regions = regions || [];
    if (map) {
      const anchors = E.Layouts.regionAnchors(regions, map);
      const shapes = {};
      regions.forEach((r) => {
        const sh = map.regions && map.regions[r.id];
        // A region in several pieces (islands; task 4-5) is one shape.
        shapes[r.id] = sh && (sh.polygon || sh.polygons) ? { polygons: E.Geo.pieces(sh) } : { circle: anchors[r.id], r: 26 };
      });
      return { image: map, anchors, shapes, edges: [], full: [0, 0, map.width, map.height] };
    }
    const nm = E.Layouts.regionMap(regions, seed);
    const anchors = {}, shapes = {};
    Object.entries(nm.nodes).forEach(([id, n]) => { anchors[id] = [n.x, n.y]; shapes[id] = { box: n }; });
    return { image: null, anchors, shapes, edges: nm.edges, full: [0, 0, nm.width, nm.height] };
  };
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
  D.worldSvg = function (o) {
    const g = o.g;
    const vbox = o.viewBox || g.full;
    // Text, badges and pins keep their size on screen whatever the map's
    // size: a whole-world image is thousands of pixels wide (task 4-5).
    const k = Math.max(1, vbox[2] / 900);
    const n1 = (v) => Math.round(v * 10) / 10;
    const shapeSvg = (id, cls) => {
      const sh = g.shapes[id];
      if (sh.polygons && sh.polygons.length === 1) return `<polygon class="${cls}" points="${sh.polygons[0].map((p) => p.join(',')).join(' ')}"/>`;
      if (sh.polygons) return `<path class="${cls}" d="${sh.polygons.map((ring) => 'M' + ring.map((p) => p.join(',')).join('L') + 'Z').join('')}"/>`;
      if (sh.box) return `<rect class="${cls}" x="${sh.box.x - sh.box.w / 2}" y="${sh.box.y - sh.box.h / 2}" width="${sh.box.w}" height="${sh.box.h}" rx="10" style="fill-opacity:0.8"/>`;
      return `<circle class="${cls}" cx="${sh.circle[0]}" cy="${sh.circle[1]}" r="${n1(sh.r * k)}"/>`;
    };
    // A label shows where it fits: always for points and the node map, for
    // an outline when it is wide enough in this view, and for yours and the
    // selected one.
    const fits = (r) => {
      const sh = g.shapes[r.id];
      if (!sh.polygons || r.id === o.mine || r.id === o.selected) return true;
      const b = E.Geo.bbox(sh.polygons);
      return b[2] - b[0] >= String(r.name).length * 15 * k * 0.55;
    };
    const edges = g.edges.map(([a, b]) => `<line class="region-edge" x1="${g.anchors[a][0]}" y1="${g.anchors[a][1]}" x2="${g.anchors[b][0]}" y2="${g.anchors[b][1]}"/>`).join('');
    const pulse = new Set(o.pulse || []);
    const body = (o.regions || []).filter((r) => g.shapes[r.id]).map((r) => {
      const now = (o.now || {})[r.id] || { controller: r.controller || null, tags: r.tags || [] };
      const fc = D.factionClass(o.factions, now.controller);
      const cls = `region-shape ${fc}${fc === 'none' ? ' none' : ''}${r.id === o.mine ? ' here' : ''}${r.id === o.selected ? ' selected' : ''}`;
      const [ax, ay] = g.anchors[r.id];
      const show = fits(r);
      const tags = show ? (now.tags || []).slice(0, 2).concat((now.tags || []).length > 2 ? [`+${now.tags.length - 2}`] : []) : [];
      let tx = ax - tags.reduce((t, x) => t + (x.length * 6.2 + 14) * k, 0) / 2;
      const ts = k > 1 ? ` style="font-size:${n1(11 * k)}px"` : '';
      const badges = tags.map((t) => {
        const w = (t.length * 6.2 + 10) * k;
        const out = `<rect class="region-tag" x="${n1(tx)}" y="${n1(ay + 8 * k)}" width="${n1(w)}" height="${n1(16 * k)}" rx="${n1(8 * k)}"/><text class="region-tag-text" x="${n1(tx + 5 * k)}" y="${n1(ay + 20 * k)}"${ts}>${esc(t)}</text>`;
        tx += w + 4 * k;
        return out;
      }).join('');
      const pin = r.id === o.mine ? `<circle class="region-pin" cx="${ax}" cy="${n1(ay - 24 * k)}" r="${n1(6 * k)}"/>` : '';
      const label = `${r.name}, held by ${D.factionName(o.factions, now.controller)}${r.id === o.mine ? ', you are here' : ''}`;
      const text = show ? `<text class="region-label" x="${ax}" y="${ay}" text-anchor="middle"${k > 1 ? ` style="font-size:${n1(15 * k)}px;stroke-width:${n1(4 * k)}px"` : ''}>${esc(r.name)}</text>` : '';
      return `<g class="region-g${pulse.has(r.id) ? ' changed' : ''}" tabindex="0" role="button" data-region="${esc(r.id)}" aria-label="${esc(label)}">${shapeSvg(r.id, cls)}${text}${badges}${pin}</g>`;
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
