// Polygon helpers in degrees for the build-time map tools (tools/occupied-france.mjs,
// tools/japan.mjs). Nothing here runs in the game.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loadEngine } = require(path.join(root, 'tests', 'helpers.js'));
const G = loadEngine().Geo;

export const ringsOf = (geom) => (!geom ? [] : geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0]) : []);
export const open = (r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r.slice());
export const signed = (ring) => ring.reduce((s, a, i) => { const b = ring[(i + 1) % ring.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
export const ccw = (ring) => (signed(ring) < 0 ? ring.slice().reverse() : ring);
// Outlines that share borders vertex for vertex (one source's own topology)
// as one: shared edges cancel, what's left is chained into rings.
export function union(ringLists) {
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const edges = new Map();
  ringLists.flat().map((r) => ccw(open(r))).forEach((r) => r.forEach((a, i) => {
    const b = r[(i + 1) % r.length];
    const k = `${key(a)}|${key(b)}`, back = `${key(b)}|${key(a)}`;
    if (edges.has(back)) edges.delete(back); else edges.set(k, [a, b]);
  }));
  const from = new Map();
  edges.forEach(([a, b]) => { const k = key(a); if (!from.has(k)) from.set(k, []); from.get(k).push(b); });
  const rings = [];
  for (const [k0] of from) {
    while (from.get(k0) && from.get(k0).length) {
      const ring = [];
      let k = k0;
      for (let guard = 0; guard < 1e6; guard++) {
        const next = from.get(k);
        if (!next || !next.length) break;
        const b = next.pop();
        ring.push(k.split(',').map(Number));
        k = key(b);
        if (k === k0) break;
      }
      if (ring.length >= 3 && signed(ring) > 0) rings.push(ring);
    }
  }
  return rings;
}
// Greiner–Hormann: the parts of subject inside clip (simple rings, no holes).
export function intersect(subject, clip) {
  const mk = (ring) => {
    const vs = ring.map((p) => ({ x: p[0], y: p[1], inter: false }));
    vs.forEach((v, i) => { v.next = vs[(i + 1) % vs.length]; v.prev = vs[(i + vs.length - 1) % vs.length]; });
    return vs;
  };
  const S = mk(open(subject)), C = mk(open(clip));
  const segX = (a, b, c, d) => {
    const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
    if (Math.abs(den) < 1e-15) return null;
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
    const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
    return t > 0 && t < 1 && u > 0 && u < 1 ? { t, u } : null;
  };
  const inserts = new Map();
  const add = (v, node) => { if (!inserts.has(v)) inserts.set(v, []); inserts.get(v).push(node); };
  let count = 0;
  S.forEach((a) => C.forEach((c) => {
    const x = segX(a, a.next, c, c.next);
    if (!x) return;
    const p = { x: a.x + x.t * (a.next.x - a.x), y: a.y + x.t * (a.next.y - a.y) };
    const ns = { x: p.x, y: p.y, inter: true, alpha: x.t }, nc = { x: p.x, y: p.y, inter: true, alpha: x.u };
    ns.neighbour = nc; nc.neighbour = ns;
    add(a, ns); add(c, nc);
    count++;
  }));
  const inside = (v, ring) => G.inside([v.x, v.y], ring);
  const sRing = open(subject), cRing = open(clip);
  if (!count) return inside(S[0], cRing) ? [sRing] : inside(C[0], sRing) ? [cRing] : [];
  // Thread the crossings into both lists, in order along each edge.
  inserts.forEach((nodes, v) => {
    nodes.sort((a, b) => a.alpha - b.alpha);
    let prev = v;
    const end = v.next;
    nodes.forEach((n) => { n.prev = prev; prev.next = n; prev = n; });
    prev.next = end; end.prev = prev;
  });
  const mark = (start, other) => {
    let entry = !G.inside([start.x, start.y], other);
    let v = start;
    do { if (v.inter) { v.entry = entry; entry = !entry; } v = v.next; } while (v !== start);
  };
  mark(S[0], cRing); mark(C[0], sRing);
  const out = [];
  let firstOpen;
  const all = [];
  let v = S[0];
  do { if (v.inter) all.push(v); v = v.next; } while (v !== S[0]);
  while ((firstOpen = all.find((n) => !n.seen))) {
    const ring = [];
    let cur = firstOpen;
    for (let guard = 0; guard < 1e6; guard++) {
      if (cur.seen) break;
      cur.seen = true; if (cur.neighbour) cur.neighbour.seen = true;
      ring.push([cur.x, cur.y]);
      if (cur.entry) { do { cur = cur.next; ring.push([cur.x, cur.y]); } while (!cur.inter); }
      else { do { cur = cur.prev; ring.push([cur.x, cur.y]); } while (!cur.inter); }
      cur = cur.neighbour;
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}
