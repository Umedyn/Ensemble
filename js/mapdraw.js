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
        shapes[r.id] = sh && sh.polygon ? { polygon: sh.polygon } : { circle: anchors[r.id], r: 26 };
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
      if (sh.polygon) pts.push(...sh.polygon);
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

  // o: { g (from geometry), regions (definitions), now ({id: {controller,
  // tags}}), factions, mine, selected, pulse (ids), imageUrl, viewBox, id,
  // view, label, rooms ([{x, y, name}]), overlay (extra SVG on top) }
  D.worldSvg = function (o) {
    const g = o.g;
    const shapeSvg = (id, cls) => {
      const sh = g.shapes[id];
      if (sh.polygon) return `<polygon class="${cls}" points="${sh.polygon.map((p) => p.join(',')).join(' ')}"/>`;
      if (sh.box) return `<rect class="${cls}" x="${sh.box.x - sh.box.w / 2}" y="${sh.box.y - sh.box.h / 2}" width="${sh.box.w}" height="${sh.box.h}" rx="10" style="fill-opacity:0.8"/>`;
      return `<circle class="${cls}" cx="${sh.circle[0]}" cy="${sh.circle[1]}" r="${sh.r}"/>`;
    };
    const edges = g.edges.map(([a, b]) => `<line class="region-edge" x1="${g.anchors[a][0]}" y1="${g.anchors[a][1]}" x2="${g.anchors[b][0]}" y2="${g.anchors[b][1]}"/>`).join('');
    const pulse = new Set(o.pulse || []);
    const body = (o.regions || []).filter((r) => g.shapes[r.id]).map((r) => {
      const now = (o.now || {})[r.id] || { controller: r.controller || null, tags: r.tags || [] };
      const fc = D.factionClass(o.factions, now.controller);
      const cls = `region-shape ${fc}${fc === 'none' ? ' none' : ''}${r.id === o.mine ? ' here' : ''}${r.id === o.selected ? ' selected' : ''}`;
      const [ax, ay] = g.anchors[r.id];
      const tags = (now.tags || []).slice(0, 2).concat((now.tags || []).length > 2 ? [`+${now.tags.length - 2}`] : []);
      let tx = ax - tags.reduce((t, x) => t + x.length * 6.2 + 14, 0) / 2;
      const badges = tags.map((t) => {
        const w = t.length * 6.2 + 10;
        const out = `<rect class="region-tag" x="${tx}" y="${ay + 8}" width="${w}" height="16" rx="8"/><text class="region-tag-text" x="${tx + 5}" y="${ay + 20}">${esc(t)}</text>`;
        tx += w + 4;
        return out;
      }).join('');
      const pin = r.id === o.mine ? `<circle class="region-pin" cx="${ax}" cy="${ay - 24}" r="6"/>` : '';
      const label = `${r.name}, held by ${D.factionName(o.factions, now.controller)}${r.id === o.mine ? ', you are here' : ''}`;
      return `<g class="region-g${pulse.has(r.id) ? ' changed' : ''}" tabindex="0" role="button" data-region="${esc(r.id)}" aria-label="${esc(label)}">${shapeSvg(r.id, cls)}<text class="region-label" x="${ax}" y="${ay}" text-anchor="middle">${esc(r.name)}</text>${badges}${pin}</g>`;
    }).join('');
    const rooms = (o.rooms || []).map((p) => `<circle class="region-loc" cx="${p.x}" cy="${p.y}" r="4"/><text class="region-loc-label" x="${p.x + 7}" y="${p.y + 4}">${esc(p.name)}</text>`).join('');
    const img = o.imageUrl && g.image ? `<image href="${esc(o.imageUrl)}" x="0" y="0" width="${g.image.width}" height="${g.image.height}"/>` : '';
    const vb = (o.viewBox || g.full).map((n) => Math.round(n)).join(' ');
    return `<svg class="world-svg" id="${esc(o.id || 'worldSvg')}" data-view="${esc(o.view || 'world')}" viewBox="${vb}" role="img" aria-label="${esc(o.label || 'World map')}">${img}${edges}${body}${rooms}${o.overlay || ''}</svg>`;
  };
})(typeof window !== 'undefined' ? window : globalThis);
