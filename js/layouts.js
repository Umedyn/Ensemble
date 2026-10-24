// Site layouts (task 3-3): the model describes rooms and links, the engine
// draws. Layouts.plan turns rooms (size, level, links) into rectangles on a
// grid, one block per level, plus where each link sits on a shared wall. It
// is deterministic (seeded by the start, never random) and depends only on
// authored data, so the same site always lays out the same way and nothing
// needs saving. DOM-free, so it runs in the Node tests.
(function (root) {
  const E = root.Ensemble;
  const L = (E.Layouts = {});

  // Grid units per room size; outside areas default to large. Levels stack
  // top to bottom (ground first), since the map pane is tall and narrow.
  L.SIZES = { small: { w: 3, h: 2 }, medium: { w: 4, h: 3 }, large: { w: 6, h: 4 } };
  L.STYLES = ['generic', 'hall', 'corridor'];
  const LEVEL_GAP = 2;

  // FNV-1a, for tie-breaks that differ per room but never per run.
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const levelOf = (l) => (Number.isInteger(l.level) ? l.level : 0);
  // Ground floor first, then up, then down.
  const levelOrder = (a, b) => {
    const k = (n) => (n === 0 ? 0 : n > 0 ? n : 100 - n);
    return k(a) - k(b);
  };

  // Every pair of linked rooms once, with the link's kind (default open).
  L.links = function (locs) {
    const byId = {};
    locs.forEach((l) => (byId[l.id] = l));
    const seen = new Set();
    const out = [];
    locs.forEach((l) => (l.connects || []).forEach((to) => {
      if (!byId[to]) return;
      const key = [l.id, to].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      const kindOf = (a, b) => ((byId[a].links || []).find((k) => k.to === b) || {}).kind;
      out.push({ a: l.id, b: to, kind: kindOf(l.id, to) || kindOf(to, l.id) || 'open' });
    }));
    return out;
  };

  // Candidate spots for room r against the side of placed room p, nearest
  // to aligned first.
  function spots(p, r, side) {
    const out = [];
    if (side === 'right' || side === 'left') {
      const x = side === 'right' ? p.x + p.w : p.x - r.w;
      for (let y = p.y - r.h + 1; y <= p.y + p.h - 1; y++) out.push({ x, y, d: Math.abs(y - p.y) });
    } else {
      const y = side === 'bottom' ? p.y + p.h : p.y - r.h;
      for (let x = p.x - r.w + 1; x <= p.x + p.w - 1; x++) out.push({ x, y, d: Math.abs(x - p.x) });
    }
    return out.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
  }

  function placeLevel(rooms, adj, style, seed) {
    const sizeOf = (l) => Object.assign({}, L.SIZES[l.size] || (l.outside ? L.SIZES.large : L.SIZES.medium));
    const deg = (l) => (adj[l.id] || []).length;
    const area = (l) => { const s = sizeOf(l); return s.w * s.h; };
    const byId = {};
    rooms.forEach((l) => (byId[l.id] = l));
    const hubOrder = rooms.slice().sort((a, b) => (style === 'hall' ? area(b) - area(a) : 0) || deg(b) - deg(a) || (a.id < b.id ? -1 : 1));
    const placed = {};
    const rects = [];
    let children = 0;
    const put = (id, rect) => { placed[id] = rect; rects.push(rect); };
    const free = (rect) => !rects.some((o) => overlaps(o, rect));

    hubOrder.forEach((start, comp) => {
      if (placed[start.id]) return;
      const s = sizeOf(start);
      // The first hub shapes the style: a big hall, or a long corridor.
      if (comp === 0 && style === 'hall') { s.w = Math.max(s.w, 7); s.h = Math.max(s.h, 5); }
      if (comp === 0 && style === 'corridor') { s.w = Math.max(6, 3 * Math.ceil(deg(start) / 2)); s.h = 2; }
      const bx = rects.length ? Math.max(...rects.map((o) => o.x + o.w)) + 1 : 0;
      put(start.id, { x: bx, y: 0, w: s.w, h: s.h, hub: comp === 0 });
      const queue = [start.id];
      while (queue.length) {
        const pid = queue.shift();
        (adj[pid] || []).slice().sort().forEach((cid) => {
          if (placed[cid] || !byId[cid]) return;
          const r = sizeOf(byId[cid]);
          // The free spot touching the most rooms it links to that are already
          // placed (so links get a shared wall), then by side order and offset.
          const touches = (rect) => (adj[cid] || []).filter((o) => placed[o] && door(Object.assign({ level: 0 }, rect), Object.assign({ level: 0 }, placed[o])).remote !== true).length;
          const tryOn = (p, sides) => {
            let best = null;
            sides.forEach((side, si) => spots(p, r, side).forEach((sp, oi) => {
              const rect = { x: sp.x, y: sp.y, w: r.w, h: r.h };
              if (!free(rect)) return;
              const score = touches(rect) * 1e6 - si * 1e3 - oi;
              if (!best || score > best.score) best = { rect, score };
            }));
            return best && best.rect;
          };
          const base = ['right', 'bottom', 'left', 'top'];
          const rot = hash(seed + ':' + cid) % 4;
          let sides = base.slice(rot).concat(base.slice(0, rot));
          if (style === 'corridor' && placed[pid].hub) sides = (children++ % 2 ? ['bottom', 'top'] : ['top', 'bottom']).concat(['right', 'left']);
          let rect = tryOn(placed[pid], sides);
          // Next to any other placed room it links to, else off to the side.
          for (const other of (adj[cid] || []).slice().sort()) { if (rect) break; if (placed[other] && other !== pid) rect = tryOn(placed[other], base); }
          if (!rect) rect = { x: Math.max(...rects.map((o) => o.x + o.w)) + 1, y: 0, w: r.w, h: r.h };
          put(cid, rect);
          queue.push(cid);
        });
      }
    });
    // Normalise to start at 0, 0.
    const minX = Math.min(...rects.map((o) => o.x)), minY = Math.min(...rects.map((o) => o.y));
    rects.forEach((o) => { o.x -= minX; o.y -= minY; });
    return { placed, w: Math.max(...rects.map((o) => o.x + o.w)), h: Math.max(...rects.map((o) => o.y + o.h)) };
  }

  // Where a link between two rooms sits: the middle of their shared wall, or
  // remote (no shared wall, or on different levels).
  function door(a, b) {
    if (a.level !== b.level) return { remote: true };
    const vx = a.x + a.w === b.x ? b.x : b.x + b.w === a.x ? a.x : null;
    if (vx != null) {
      const lo = Math.max(a.y, b.y), hi = Math.min(a.y + a.h, b.y + b.h);
      if (hi > lo) return { x: vx, y: (lo + hi) / 2, orient: 'v' };
    }
    const hy = a.y + a.h === b.y ? b.y : b.y + b.h === a.y ? a.y : null;
    if (hy != null) {
      const lo = Math.max(a.x, b.x), hi = Math.min(a.x + a.w, b.x + b.w);
      if (hi > lo) return { x: (lo + hi) / 2, y: hy, orient: 'h' };
    }
    return { remote: true };
  }

  // ---------- the world map without an image (task 3-4) ----------
  // A node map of the regions from their neighbours: a small force layout
  // with a fixed number of steps, starting from a circle in id order rotated
  // by the seed, so it is the same every time. Boxes never overlap.
  L.NODE = { w: 130, h: 46 };
  L.regionMap = function (regions, seed) {
    const list = (regions || []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    const n = list.length;
    const { w, h } = L.NODE;
    const pos = {};
    const rot = (hash(String(seed || '')) % 360) * Math.PI / 180;
    const radius = 90 + 45 * n;
    list.forEach((r, i) => { const a = rot + (2 * Math.PI * i) / Math.max(1, n); pos[r.id] = { x: Math.cos(a) * radius, y: Math.sin(a) * radius * 0.7 }; });
    const ids = new Set(list.map((r) => r.id));
    // Edges from neighbours and routes (R-2) between the regions shown; a
    // route's kind wins over a plain border (R-3 draws them by kind).
    const edges = [];
    const kinds = {};
    const seen = new Set();
    const link = (a, b, kind) => {
      const k = [a, b].sort().join('|');
      if (!ids.has(b) || a === b) return;
      if (!seen.has(k)) { seen.add(k); edges.push([a, b].sort()); }
      if (kind && kind !== 'border' || !kinds[k]) kinds[k] = kind || 'border';
    };
    list.forEach((r) => {
      (r.neighbours || []).forEach((o) => link(r.id, o, null));
      (Array.isArray(r.routes) ? r.routes : []).forEach((x) => x && link(r.id, x.to, x.kind || 'border'));
    });
    const ideal = 220;
    for (let it = 0; it < 300; it++) {
      const f = {};
      list.forEach((r) => (f[r.id] = { x: 0, y: 0 }));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = pos[list[i].id], b = pos[list[j].id];
        const dx = a.x - b.x || 0.01, dy = a.y - b.y || 0.01;
        const d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
        const rep = (ideal * ideal) / d2;
        f[list[i].id].x += (dx / d) * rep; f[list[i].id].y += (dy / d) * rep;
        f[list[j].id].x -= (dx / d) * rep; f[list[j].id].y -= (dy / d) * rep;
      }
      edges.forEach(([p, q]) => {
        const a = pos[p], b = pos[q];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const pull = (d - ideal) / d * 0.1;
        f[p].x += dx * pull; f[p].y += dy * pull; f[q].x -= dx * pull; f[q].y -= dy * pull;
      });
      const step = 8 * (1 - it / 300) + 0.5;
      list.forEach((r) => {
        const v = f[r.id], len = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
        pos[r.id].x += (v.x / len) * Math.min(step, len);
        pos[r.id].y += (v.y / len) * Math.min(step, len);
      });
    }
    // Push apart any boxes that still overlap.
    for (let pass = 0; pass < 50; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = pos[list[i].id], b = pos[list[j].id];
        const ox = w + 20 - Math.abs(a.x - b.x), oy = h + 20 - Math.abs(a.y - b.y);
        if (ox > 0 && oy > 0) {
          moved = true;
          if (ox < oy) { const s = (a.x < b.x ? -1 : 1) * ox / 2; a.x += s; b.x -= s; } else { const s = (a.y < b.y ? -1 : 1) * oy / 2; a.y += s; b.y -= s; }
        }
      }
      if (!moved) break;
    }
    const xs = list.map((r) => pos[r.id].x), ys = list.map((r) => pos[r.id].y);
    const minX = Math.min(...xs) - w / 2 - 20, minY = Math.min(...ys) - h / 2 - 20;
    const nodes = {};
    list.forEach((r) => { nodes[r.id] = { x: Math.round(pos[r.id].x - minX), y: Math.round(pos[r.id].y - minY), w, h }; });
    return {
      width: n ? Math.round(Math.max(...xs) - minX + w / 2 + 20) : 0,
      height: n ? Math.round(Math.max(...ys) - minY + h / 2 + 20) : 0,
      nodes, edges, kinds,
    };
  };
  // Where a region's label and pin go on an image map: the middle of its
  // polygon, its point, or (not on the map) a spot along the bottom edge.
  L.regionAnchors = function (regions, map) {
    const out = {};
    const missing = [];
    (regions || []).forEach((r) => {
      const s = map.regions && map.regions[r.id];
      // Inside its biggest piece (task 4-5: countries with islands).
      if (s && (s.polygon || s.polygons)) out[r.id] = E.Geo.anchor(E.Geo.pieces(s)).map((v) => Math.round(v));
      else if (s && s.point) out[r.id] = s.point.slice();
      else missing.push(r.id);
    });
    missing.forEach((id, i) => { out[id] = [map.width * (i + 1) / (missing.length + 1), map.height - 24]; });
    return out;
  };

  // Do two placed rooms share a stretch of wall? (task 3-6)
  L.sharesWall = (a, b) => door(Object.assign({}, a, { level: a.level || 0 }), Object.assign({}, b, { level: b.level || 0 })).remote !== true;
  // Does a room have wall that no other room on its level covers? Windows and
  // vents to the outside need one (task 3-6).
  L.hasOutsideWall = function (plan, id) {
    const r = plan.rooms[id];
    if (!r) return false;
    const others = Object.entries(plan.rooms).filter(([o, x]) => o !== id && x.level === r.level).map(([, x]) => x);
    const covered = (cells) => cells.every(([x, y]) => others.some((o) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h));
    const sides = [
      Array.from({ length: r.w }, (_, i) => [r.x + i, r.y - 1]), Array.from({ length: r.w }, (_, i) => [r.x + i, r.y + r.h]),
      Array.from({ length: r.h }, (_, i) => [r.x - 1, r.y + i]), Array.from({ length: r.h }, (_, i) => [r.x + r.w, r.y + i]),
    ];
    return sides.some((cells) => !covered(cells));
  };

  // locs: the locations (list or object); opts: { type, seed, linkLocs }.
  // linkLocs (task 3-6): rooms are placed from locs (the authored ones, so
  // the map never moves), links drawn from linkLocs (with inferred ones).
  // → { style, width, height, levels: [{level, x, y, w, h}], rooms: {id: {x, y, w, h, level}}, links: [{a, b, kind, x, y, orient} | {a, b, kind, remote}] }
  L.plan = function (locs, opts) {
    const list = (Array.isArray(locs) ? locs : Object.values(locs || {})).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    const style = L.STYLES.includes(opts && opts.type) ? opts.type : 'generic';
    const seed = String((opts && opts.seed) || '');
    const links = L.links(list);
    const levels = [...new Set(list.map(levelOf))].sort(levelOrder);
    const rooms = {};
    const blocks = [];
    let y0 = 0;
    const many = levels.length > 1;
    levels.forEach((lv) => {
      if (many) y0 += 1; // a row for the level's name
      const here = list.filter((l) => levelOf(l) === lv);
      const adj = {};
      links.forEach((k) => {
        const a = here.find((l) => l.id === k.a), b = here.find((l) => l.id === k.b);
        if (!a || !b) return;
        (adj[k.a] = adj[k.a] || []).push(k.b);
        (adj[k.b] = adj[k.b] || []).push(k.a);
      });
      const out = placeLevel(here, adj, lv === levels[0] ? style : 'generic', seed + ':' + lv);
      Object.entries(out.placed).forEach(([id, r]) => { rooms[id] = { x: r.x, y: r.y + y0, w: r.w, h: r.h, level: lv }; });
      blocks.push({ level: lv, x: 0, y: y0, w: out.w, h: out.h });
      y0 += out.h + LEVEL_GAP;
    });
    return {
      style,
      width: Math.max(0, ...blocks.map((b) => b.w)),
      height: Math.max(0, y0 - LEVEL_GAP),
      levels: blocks,
      rooms,
      links: (opts && opts.linkLocs ? L.links(Array.isArray(opts.linkLocs) ? opts.linkLocs : Object.values(opts.linkLocs)) : links)
        .filter((k) => rooms[k.a] && rooms[k.b]).map((k) => Object.assign(k, door(rooms[k.a], rooms[k.b]))),
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
