// The drawn town plans of scenarios/frontier (task 7-4):
//
//   node tools/frontier-towns.mjs [--world oregon-trail]
//
// Four places laid out the way the West's towns were: a business row of
// false-fronted buildings facing the street (or the railroad), back lots and
// alleys behind, corrals and pens at the ends, the river below. Each room
// is a whole building or lot, a hand-placed polygon. Writes
// sites/<town>.svg (the picture: ground, buildings, tents, fences, water,
// decoration only) and sites/<town>.json (a site map with the rooms as
// authored in world.json and their shapes), and sets each town's siteInfo
// map and the world's "sites". Building again keeps the rest of world.json
// as it is. Original drawing, made for Ensemble.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The world folder: scenarios/frontier, or another built on the same map
// (--world oregon-trail, task 7-7).
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const WORLD = path.join(root, 'scenarios', arg('world') || 'frontier');
const W = 1600, H = 1000;
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// ---------- the towns ----------
// shapes: room id → polygon. street: the side of each building that faces
// the street ('s' or 'n'), for its false front and boardwalk. kinds: how
// each room is drawn ('building', 'tent', 'canvas', 'frame', 'corral',
// 'street', 'lots', 'grade', 'river', 'prairie', 'camp', 'fort', 'diggings').
const TOWNS = [
  { id: 'haddon', name: 'Haddon', type: 'railroad town', entry: 'haddon-front', tags: ['railroad town', 'end of track', 'station'],
    shapes: {
      'haddon-back': box(160, 160, 1440, 380),
      'haddon-saloon': box(160, 380, 400, 560), 'haddon-store': box(400, 380, 620, 560), 'haddon-office': box(620, 380, 800, 560),
      'haddon-boarding': box(800, 380, 1040, 560), 'haddon-smith': box(1040, 380, 1240, 560), 'haddon-corral': box(1240, 380, 1440, 560),
      'haddon-front': box(160, 560, 1440, 660),
      'haddon-ranch': box(160, 660, 600, 760), 'haddon-depot': box(600, 660, 1000, 760), 'haddon-tents': box(1000, 660, 1440, 760),
      'haddon-grade': box(60, 760, 1540, 840), 'haddon-bottoms': box(60, 840, 1540, 980),
    },
    kinds: { 'haddon-back': 'lots', 'haddon-saloon': 'canvas', 'haddon-store': 'canvas', 'haddon-office': 'building', 'haddon-boarding': 'building', 'haddon-smith': 'building',
      'haddon-corral': 'corral', 'haddon-front': 'street', 'haddon-ranch': 'sod', 'haddon-depot': 'frame', 'haddon-tents': 'camp', 'haddon-grade': 'grade', 'haddon-bottoms': 'river' },
    faces: { 'haddon-saloon': 's', 'haddon-store': 's', 'haddon-office': 's', 'haddon-boarding': 's', 'haddon-smith': 's', 'haddon-ranch': 'n' } },
  { id: 'salt-lick', name: 'Salt Lick', type: 'cattle town', entry: 'saltlick-front', tags: ['cattle town', 'cow town', 'stockyards'],
    shapes: {
      'saltlick-alley': box(200, 160, 1400, 240),
      'saltlick-saloon': box(200, 240, 460, 440), 'saltlick-hotel': box(460, 240, 720, 440), 'saltlick-office': box(720, 240, 900, 440),
      'saltlick-store': box(900, 240, 1140, 440), 'saltlick-livery': box(1140, 240, 1400, 440),
      'saltlick-front': box(200, 440, 1400, 540),
      'saltlick-jail': box(200, 540, 400, 740), 'saltlick-smith': box(400, 540, 580, 740), 'saltlick-dancehall': box(580, 540, 860, 740),
      'saltlick-chapel': box(860, 540, 1040, 740), 'saltlick-stage': box(1040, 540, 1400, 740),
      'saltlick-pens': box(20, 240, 200, 740), 'saltlick-herd': box(1400, 160, 1580, 740),
      'saltlick-ford': box(20, 740, 1580, 960),
    },
    kinds: { 'saltlick-alley': 'lots', 'saltlick-saloon': 'building', 'saltlick-hotel': 'building', 'saltlick-office': 'building', 'saltlick-store': 'building', 'saltlick-livery': 'barn',
      'saltlick-front': 'street', 'saltlick-jail': 'stone', 'saltlick-smith': 'building', 'saltlick-dancehall': 'building', 'saltlick-chapel': 'chapel', 'saltlick-stage': 'building',
      'saltlick-pens': 'pens', 'saltlick-herd': 'prairie', 'saltlick-ford': 'river' },
    faces: { 'saltlick-saloon': 's', 'saltlick-hotel': 's', 'saltlick-office': 's', 'saltlick-store': 's', 'saltlick-livery': 's', 'saltlick-jail': 'n', 'saltlick-smith': 'n',
      'saltlick-dancehall': 'n', 'saltlick-chapel': 'n', 'saltlick-stage': 'n' } },
  { id: 'julesburg', name: 'Julesburg', type: 'stage station', entry: 'julesburg-road', tags: ['stage station', 'army post', 'river crossing'],
    shapes: {
      'julesburg-fort': box(40, 80, 380, 420),
      'julesburg-store': box(380, 240, 560, 420), 'julesburg-telegraph': box(560, 240, 700, 420), 'julesburg-station': box(700, 240, 960, 420),
      'julesburg-stable': box(960, 240, 1220, 420), 'julesburg-smith': box(1220, 240, 1400, 420),
      'julesburg-road': box(40, 420, 1480, 500),
      'julesburg-sutler': box(40, 500, 380, 640), 'julesburg-camp': box(700, 500, 1480, 640),
      'julesburg-ford': box(40, 640, 1480, 760), 'julesburg-townsite': box(40, 760, 1480, 920),
    },
    kinds: { 'julesburg-fort': 'fort', 'julesburg-store': 'sod', 'julesburg-telegraph': 'sod', 'julesburg-station': 'sod', 'julesburg-stable': 'corral', 'julesburg-smith': 'sod',
      'julesburg-road': 'street', 'julesburg-sutler': 'building', 'julesburg-camp': 'wagons', 'julesburg-ford': 'river', 'julesburg-townsite': 'stakes' },
    faces: { 'julesburg-store': 's', 'julesburg-telegraph': 's', 'julesburg-station': 's', 'julesburg-smith': 's', 'julesburg-sutler': 'n' } },
  { id: 'poormans-gulch', name: 'Poorman\'s Gulch', type: 'gold camp', entry: 'poorman-trail', tags: ['gold camp', 'mining camp', 'diggings'],
    shapes: {
      'poorman-trail': [[1200, 40], [1560, 40], [1560, 300], [1340, 300], [1200, 200]],
      'poorman-ridge': [[1340, 300], [1560, 300], [1560, 520], [1400, 520]],
      'poorman-lots': [[600, 40], [1200, 40], [1200, 200], [700, 260], [600, 200]],
      // The Oregon Trail's gulch (task 7-7): the flat as a staked street and six lots.
      'poorman-street': [[600, 150], [1200, 150], [1200, 200], [700, 260], [600, 200]],
      'poorman-lot-1': box(600, 40, 700, 150), 'poorman-lot-2': box(700, 40, 800, 150), 'poorman-lot-3': box(800, 40, 900, 150),
      'poorman-lot-4': box(900, 40, 1000, 150), 'poorman-lot-5': box(1000, 40, 1100, 150), 'poorman-lot-6': box(1100, 40, 1200, 150),
      'poorman-tents': [[700, 260], [1200, 200], [1340, 300], [1400, 520], [1000, 560], [760, 480]],
      'poorman-fire': [[1000, 560], [1400, 520], [1420, 640], [1060, 660]],
      'poorman-cabin': [[760, 480], [1000, 560], [960, 640], [740, 600]],
      'poorman-creek': [[260, 420], [700, 260], [760, 480], [740, 600], [420, 760], [260, 700]],
      'poorman-discovery': [[40, 520], [260, 420], [260, 700], [420, 760], [300, 920], [40, 920]],
    },
    kinds: { 'poorman-trail': 'trail', 'poorman-ridge': 'rock', 'poorman-lots': 'stakes', 'poorman-street': 'stakes',
      'poorman-lot-1': 'lot', 'poorman-lot-2': 'lot', 'poorman-lot-3': 'lot', 'poorman-lot-4': 'lot', 'poorman-lot-5': 'lot', 'poorman-lot-6': 'lot', 'poorman-tents': 'camp', 'poorman-fire': 'fire', 'poorman-cabin': 'cabin',
      'poorman-creek': 'diggings', 'poorman-discovery': 'diggings' },
    faces: {} },
  // The Oregon Trail's wagon camp (task 7-7): the same place every night,
  // wherever the company stops. Only in a world that has its rooms.
  { id: 'camp', name: 'The company camp', type: 'wagon camp', entry: 'camp-circle', tags: ['wagon camp', 'emigrant camp', 'wagon circle'],
    shapes: {
      'camp-captain': box(650, 120, 950, 200),
      'camp-circle': [[550, 200], [800, 200], [800, 800], [550, 800], [400, 500]],
      'camp-fire': [[800, 200], [1050, 200], [1200, 500], [1050, 800], [800, 800]],
      'camp-doctor': box(550, 800, 800, 880), 'camp-smith': box(800, 800, 1050, 880),
      'camp-herd': [[1050, 200], [1550, 120], [1550, 880], [1050, 880], [1050, 800], [1200, 500]],
      'camp-edge': [[50, 120], [650, 120], [650, 200], [550, 200], [400, 500], [550, 800], [550, 880], [50, 880]],
      'camp-water': box(50, 880, 1550, 980),
    },
    kinds: { 'camp-captain': 'wagon', 'camp-circle': 'circle', 'camp-fire': 'fires', 'camp-doctor': 'wagon', 'camp-smith': 'wagon', 'camp-herd': 'herd', 'camp-edge': 'prairie-edge', 'camp-water': 'river' },
    faces: {} },
];

// ---------- the picture ----------
const pts = (p) => p.map(([x, y]) => `${x},${y}`).join(' ');
const bbox = (p) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
// A little deterministic noise, so the scatter is the same every build.
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const inside = (p, ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const scatter = (ring, n, pad) => {
  const [x0, y0, x1, y1] = bbox(ring);
  const out = [];
  for (let i = 0; out.length < n && i < n * 30; i++) {
    const p = [x0 + pad + rnd() * (x1 - x0 - 2 * pad), y0 + pad + rnd() * (y1 - y0 - 2 * pad)];
    if (inside(p, ring)) out.push(p);
  }
  return out;
};
const C = { prairie: '#d8cf9e', dirt: '#cdb98d', street: '#c7b083', plank: '#b88d5c', front: '#8c6440', roof: '#9b7651', canvas: '#ece4cf', sod: '#9a8a62',
  stone: '#a9a39a', water: '#8fb3c6', sand: '#e2d6b0', tree: '#7f9a5e', treeDark: '#5f7a42', fence: '#7a5a3a', rock: '#a59d8c', ink: '#4a3c2c', grade: '#d3c195' };

function picture(t) {
  seed = t.id.length * 7919;
  const out = [];
  const add = (s) => out.push(s);
  add(`<rect width="${W}" height="${H}" fill="${t.id === 'poormans-gulch' ? '#c9bb93' : C.prairie}"/>`);
  // Grass tufts everywhere first.
  for (let i = 0; i < 260; i++) add(`<circle cx="${(rnd() * W).toFixed(0)}" cy="${(rnd() * H).toFixed(0)}" r="${(2 + rnd() * 3).toFixed(1)}" fill="#bfb586"/>`);
  Object.entries(t.shapes).forEach(([id, p]) => {
    const kind = t.kinds[id];
    const [x0, y0, x1, y1] = bbox(p);
    const face = t.faces[id];
    const poly = (fill, extra) => add(`<polygon points="${pts(p)}" fill="${fill}"${extra || ''}/>`);
    // A building inset from its lot, with a false front on the street side.
    const building = (fill, roof, inset) => {
      const i = inset || 18;
      const bx0 = x0 + i, by0 = y0 + i, bx1 = x1 - i, by1 = y1 - i;
      add(`<rect x="${bx0}" y="${by0}" width="${bx1 - bx0}" height="${by1 - by0}" fill="${fill}" stroke="${C.ink}" stroke-width="4"/>`);
      // Roof ridge and boards.
      add(`<line x1="${bx0}" y1="${(by0 + by1) / 2}" x2="${bx1}" y2="${(by0 + by1) / 2}" stroke="${roof}" stroke-width="3"/>`);
      for (let x = bx0 + 14; x < bx1; x += 14) add(`<line x1="${x}" y1="${by0 + 4}" x2="${x}" y2="${by1 - 4}" stroke="${roof}" stroke-width="1" opacity="0.5"/>`);
      if (face) {
        const fy = face === 's' ? by1 - 14 : by0;
        add(`<rect x="${bx0 - 6}" y="${fy}" width="${bx1 - bx0 + 12}" height="14" fill="${C.front}" stroke="${C.ink}" stroke-width="3"/>`);
        // Boardwalk.
        const wy = face === 's' ? y1 - i + 2 : y0 + 4;
        add(`<rect x="${bx0 - 6}" y="${wy}" width="${bx1 - bx0 + 12}" height="${i - 6}" fill="#a98458"/>`);
        for (let x = bx0; x < bx1; x += 10) add(`<line x1="${x}" y1="${wy}" x2="${x}" y2="${wy + i - 6}" stroke="#8a6a46" stroke-width="1"/>`);
      }
    };
    const fence = (dash) => add(`<polygon points="${pts(p.map(([x, y]) => [x + (x === x0 ? 8 : -8), y + (y === y0 ? 8 : -8)]))}" fill="none" stroke="${C.fence}" stroke-width="4" stroke-dasharray="${dash || '14 6'}"/>`);
    const trees = (n, pad) => scatter(p, n, pad || 20).forEach(([x, y]) => { add(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(16 + rnd() * 10).toFixed(0)}" fill="${C.tree}" stroke="${C.treeDark}" stroke-width="2"/>`); });
    const tents = (n, pad) => scatter(p, n, pad || 30).forEach(([x, y]) => {
      add(`<polygon points="${x - 16},${y + 12} ${x + 16},${y + 12} ${x + 16},${y - 10} ${x - 16},${y - 10}" fill="${C.canvas}" stroke="#9a8f74" stroke-width="2"/>`);
      add(`<line x1="${x - 16}" y1="${y + 1}" x2="${x + 16}" y2="${y + 1}" stroke="#9a8f74" stroke-width="2"/>`);
    });
    const fires = (n, pad) => scatter(p, n, pad || 30).forEach(([x, y]) => add(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="7" fill="#c8693a" stroke="#6b5a48" stroke-width="3"/>`));
    if (kind === 'street') {
      poly(C.street);
      for (let i = 0; i < 18; i++) { const y = y0 + 20 + rnd() * (y1 - y0 - 40); add(`<line x1="${x0 + 10}" y1="${y.toFixed(0)}" x2="${x1 - 10}" y2="${(y + rnd() * 6 - 3).toFixed(0)}" stroke="#b39d70" stroke-width="2" opacity="0.6"/>`); }
      for (let x = x0 + 60; x < x1 - 40; x += 160) add(`<rect x="${x}" y="${y0 + 6}" width="40" height="4" fill="${C.fence}"/><rect x="${x}" y="${y1 - 10}" width="40" height="4" fill="${C.fence}"/>`);
    } else if (kind === 'lots') {
      poly(C.dirt);
      for (let x = x0 + 80; x < x1; x += 120) add(`<line x1="${x}" y1="${y0 + 10}" x2="${x}" y2="${y1 - 10}" stroke="#a89670" stroke-width="2" stroke-dasharray="4 10"/>`);
      scatter(p, 6, 40).forEach(([x, y]) => add(`<rect x="${(x - 26).toFixed(0)}" y="${(y - 16).toFixed(0)}" width="52" height="32" fill="${C.sod}" stroke="${C.ink}" stroke-width="2"/>`));
      scatter(p, 4, 30).forEach(([x, y]) => add(`<rect x="${(x - 6).toFixed(0)}" y="${(y - 8).toFixed(0)}" width="12" height="16" fill="${C.plank}" stroke="${C.ink}" stroke-width="2"/>`));
    } else if (kind === 'building' || kind === 'chapel' || kind === 'stone' || kind === 'barn') {
      poly(C.dirt);
      building(kind === 'stone' ? C.stone : C.plank, kind === 'stone' ? '#8a857c' : C.roof);
      if (kind === 'chapel') add(`<rect x="${(x0 + x1) / 2 - 12}" y="${y0 + 6}" width="24" height="30" fill="#f1ece0" stroke="${C.ink}" stroke-width="3"/><line x1="${(x0 + x1) / 2}" y1="${y0 - 4}" x2="${(x0 + x1) / 2}" y2="${y0 + 8}" stroke="${C.ink}" stroke-width="3"/>`);
      if (kind === 'barn') add(`<rect x="${x0 + 30}" y="${y0 + 40}" width="${x1 - x0 - 60}" height="${y1 - y0 - 100}" fill="none" stroke="#7a5b3c" stroke-width="2" stroke-dasharray="6 6"/>`);
    } else if (kind === 'canvas') {
      poly(C.dirt);
      add(`<rect x="${x0 + 18}" y="${y0 + 18}" width="${x1 - x0 - 36}" height="${y1 - y0 - 36}" fill="${C.canvas}" stroke="#8f8468" stroke-width="3"/>`);
      add(`<line x1="${x0 + 18}" y1="${(y0 + y1) / 2}" x2="${x1 - 18}" y2="${(y0 + y1) / 2}" stroke="#8f8468" stroke-width="3"/>`);
      if (face) add(`<rect x="${x0 + 12}" y="${face === 's' ? y1 - 32 : y0 + 18}" width="${x1 - x0 - 24}" height="14" fill="${C.front}" stroke="${C.ink}" stroke-width="3"/>`);
    } else if (kind === 'sod') {
      poly(C.dirt);
      building(C.sod, '#7d6f4c', 22);
    } else if (kind === 'frame') {
      poly(C.dirt);
      add(`<rect x="${x0 + 40}" y="${y0 + 20}" width="160" height="${y1 - y0 - 40}" fill="none" stroke="${C.plank}" stroke-width="6" stroke-dasharray="12 8"/>`);
      add(`<circle cx="${x1 - 80}" cy="${(y0 + y1) / 2}" r="30" fill="none" stroke="${C.plank}" stroke-width="6" stroke-dasharray="8 6"/>`);
      for (let i = 0; i < 4; i++) add(`<rect x="${x0 + 230 + i * 22}" y="${y0 + 26}" width="14" height="${y1 - y0 - 52}" fill="#7d5d3c"/>`);
    } else if (kind === 'corral' || kind === 'pens') {
      poly(C.dirt);
      fence(kind === 'pens' ? '20 4' : '14 6');
      if (kind === 'pens') for (let y = y0 + 90; y < y1 - 20; y += 90) add(`<line x1="${x0 + 8}" y1="${y}" x2="${x1 - 8}" y2="${y}" stroke="${C.fence}" stroke-width="4" stroke-dasharray="20 4"/>`);
      if (kind === 'pens') add(`<rect x="${x1 - 40}" y="${(y0 + y1) / 2 - 30}" width="40" height="60" fill="${C.plank}" stroke="${C.ink}" stroke-width="3"/>`);
      scatter(p, 10, 30).forEach(([x, y]) => add(`<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="10" ry="6" fill="#6e5a46"/>`));
      if (kind === 'corral') add(`<rect x="${x0 + 30}" y="${y0 + 30}" width="70" height="40" fill="#cdbb6a" stroke="#a0904a" stroke-width="2"/>`);
    } else if (kind === 'camp') {
      poly(C.dirt);
      tents(14, 26);
      fires(3);
    } else if (kind === 'wagons') {
      poly('#cfc39a');
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2, x = cx + Math.cos(a) * 220, y = cy + Math.sin(a) * 45;
        add(`<rect x="${(x - 18).toFixed(0)}" y="${(y - 9).toFixed(0)}" width="36" height="18" rx="8" fill="${C.canvas}" stroke="#7a6a4e" stroke-width="2" transform="rotate(${((a * 180) / Math.PI + 90).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`);
      }
      fires(2, 50);
    } else if (kind === 'grade') {
      poly(C.dirt);
      add(`<rect x="${x0}" y="${y0 + 22}" width="${x1 - x0}" height="${y1 - y0 - 44}" fill="${C.grade}" stroke="#a8946a" stroke-width="3"/>`);
      for (let x = x0 + 30; x < x1; x += 80) add(`<line x1="${x}" y1="${y0 + 12}" x2="${x}" y2="${y0 + 24}" stroke="#c0392b" stroke-width="3"/>`);
    } else if (kind === 'river') {
      poly(C.sand);
      const mid = (y0 + y1) / 2;
      for (let k = -1; k <= 1; k++) {
        let d = `M${x0} ${mid + k * 30}`;
        for (let x = x0 + 80; x <= x1; x += 80) d += ` Q${x - 40} ${(mid + k * 30 + (rnd() * 40 - 20)).toFixed(0)} ${x} ${(mid + k * 30 + (rnd() * 20 - 10)).toFixed(0)}`;
        add(`<path d="${d}" fill="none" stroke="${C.water}" stroke-width="${k ? 12 : 22}" stroke-linecap="round"/>`);
      }
      trees(8, 10);
    } else if (kind === 'stakes') {
      poly(t.id === 'poormans-gulch' ? '#d2c59d' : C.prairie);
      for (let x = x0 + 40; x < x1; x += 90) for (let y = y0 + 30; y < y1; y += 60) if (inside([x, y], p)) add(`<rect x="${x - 2}" y="${y - 2}" width="5" height="5" fill="#c0392b"/>`);
      if (t.id === 'poormans-gulch') add(`<line x1="${x0 + 40}" y1="${(y0 + y1) / 2 - 20}" x2="${x1 - 40}" y2="${(y0 + y1) / 2 - 40}" stroke="#a3463a" stroke-width="2" stroke-dasharray="6 4"/>`);
    } else if (kind === 'prairie') {
      poly('#d4cb98');
      scatter(p, 26, 20).forEach(([x, y]) => add(`<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="9" ry="5" fill="#6e5a46"/>`));
    } else if (kind === 'fort') {
      poly(C.dirt);
      add(`<rect x="${x0 + 70}" y="${y0 + 90}" width="${x1 - x0 - 140}" height="${y1 - y0 - 150}" fill="#d9c9a0" stroke="#a8946a" stroke-width="2"/>`);
      [[x0 + 20, y0 + 20, x1 - x0 - 40, 50], [x0 + 20, y0 + 90, 40, y1 - y0 - 150], [x1 - 60, y0 + 90, 40, y1 - y0 - 150]].forEach(([x, y, w, h]) => add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${C.sod}" stroke="${C.ink}" stroke-width="3"/>`));
      add(`<line x1="${(x0 + x1) / 2}" y1="${(y0 + y1) / 2 - 30}" x2="${(x0 + x1) / 2}" y2="${(y0 + y1) / 2 + 30}" stroke="${C.ink}" stroke-width="4"/><rect x="${(x0 + x1) / 2}" y="${(y0 + y1) / 2 - 30}" width="24" height="14" fill="#a33"/>`);
    } else if (kind === 'trail') {
      poly('#cfc19a');
      add(`<path d="M${x1} ${y0 + 60} Q${x0 + 150} ${y0 + 80} ${x0 + 40} ${y1 - 40}" fill="none" stroke="#a8946a" stroke-width="10" stroke-dasharray="20 8"/>`);
      scatter(p, 18, 20).forEach(([x, y]) => add(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="6" fill="#8f9a6e"/>`));
    } else if (kind === 'rock') {
      poly(C.rock);
      scatter(p, 14, 20).forEach(([x, y]) => add(`<polygon points="${x - 14},${y + 8} ${x},${y - 12} ${x + 16},${y + 8}" fill="#8b8373" stroke="#6b6355" stroke-width="2"/>`));
    } else if (kind === 'fire') {
      poly(C.dirt);
      const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
      add(`<circle cx="${cx}" cy="${cy}" r="22" fill="#c8693a" stroke="#6b5a48" stroke-width="6"/>`);
      add(`<rect x="${cx - 120}" y="${cy - 40}" width="70" height="40" fill="${C.canvas}" stroke="#9a8f74" stroke-width="2"/>`);
      [[cx + 70, cy - 20], [cx + 100, cy + 10]].forEach(([x, y]) => add(`<rect x="${x}" y="${y}" width="26" height="20" fill="${C.plank}" stroke="${C.ink}" stroke-width="2"/>`));
    } else if (kind === 'cabin') {
      poly(C.dirt);
      const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
      add(`<rect x="${cx - 60}" y="${cy - 40}" width="120" height="80" fill="#8a6a46" stroke="${C.ink}" stroke-width="4"/>`);
      for (let y = cy - 30; y < cy + 40; y += 12) add(`<line x1="${cx - 60}" y1="${y}" x2="${cx + 60}" y2="${y}" stroke="#6b5034" stroke-width="2"/>`);
      add(`<rect x="${cx - 60}" y="${cy - 40}" width="60" height="80" fill="#c9bb93" opacity="0.5"/>`);
    } else if (kind === 'lot') {
      // A staked lot (task 7-7): stakes and string; what is built shows in play by its name.
      poly('#d2c59d');
      add(`<rect x="${x0 + 10}" y="${y0 + 10}" width="${x1 - x0 - 20}" height="${y1 - y0 - 20}" fill="none" stroke="#a3463a" stroke-width="2" stroke-dasharray="6 4"/>`);
      [[x0 + 10, y0 + 10], [x1 - 10, y0 + 10], [x0 + 10, y1 - 10], [x1 - 10, y1 - 10]].forEach(([x, y]) => add(`<rect x="${x - 3}" y="${y - 3}" width="7" height="7" fill="#c0392b"/>`));
    } else if (kind === 'wagon') {
      poly(C.prairie);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      add(`<rect x="${cx - 70}" y="${cy - 26}" width="140" height="52" rx="22" fill="${C.canvas}" stroke="#7a6a4e" stroke-width="3"/>`);
      [-40, 0, 40].forEach((d) => add(`<line x1="${cx + d}" y1="${cy - 26}" x2="${cx + d}" y2="${cy + 26}" stroke="#b8ab8c" stroke-width="2"/>`));
      [[cx - 52, cy + 30], [cx + 52, cy + 30]].forEach(([x, y]) => add(`<circle cx="${x}" cy="${y}" r="9" fill="none" stroke="${C.ink}" stroke-width="3"/>`));
    } else if (kind === 'circle') {
      poly('#cfc39a');
      for (let i = 0; i < 9; i++) {
        const a = Math.PI / 2 + (i / 8) * Math.PI, x = 800 + Math.cos(a) * 360, y = 500 + Math.sin(a) * 290;
        add(`<rect x="${(x - 30).toFixed(0)}" y="${(y - 13).toFixed(0)}" width="60" height="26" rx="11" fill="${C.canvas}" stroke="#7a6a4e" stroke-width="2" transform="rotate(${((a * 180) / Math.PI + 90).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`);
      }
      tents(4, 80);
    } else if (kind === 'fires') {
      poly('#cfc39a');
      for (let i = 0; i < 9; i++) {
        const a = -Math.PI / 2 + (i / 8) * Math.PI, x = 800 + Math.cos(a) * 360, y = 500 + Math.sin(a) * 290;
        add(`<rect x="${(x - 30).toFixed(0)}" y="${(y - 13).toFixed(0)}" width="60" height="26" rx="11" fill="${C.canvas}" stroke="#7a6a4e" stroke-width="2" transform="rotate(${((a * 180) / Math.PI + 90).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`);
      }
      [[900, 400], [960, 560], [880, 650]].forEach(([x, y]) => add(`<circle cx="${x}" cy="${y}" r="16" fill="#c8693a" stroke="#6b5a48" stroke-width="5"/>`));
    } else if (kind === 'herd') {
      poly('#d4cb98');
      scatter(p, 30, 30).forEach(([x, y]) => add(`<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="12" ry="6" fill="#6e5a46"/>`));
      add(`<line x1="${x1 - 60}" y1="${y0 + 120}" x2="${x1 - 60}" y2="${y1 - 80}" stroke="${C.fence}" stroke-width="3" stroke-dasharray="4 10"/>`);
    } else if (kind === 'prairie-edge') {
      poly(C.prairie);
      [[220, 300], [200, 640]].forEach(([x, y]) => add(`<circle cx="${x}" cy="${y}" r="12" fill="#c8693a" stroke="#6b5a48" stroke-width="4"/>`));
      add(`<polygon points="160,420 200,380 240,420" fill="${C.canvas}" stroke="#9a8f74" stroke-width="2"/>`);
    } else if (kind === 'diggings') {
      poly('#c2b38a');
      scatter(p, 16, 30).forEach(([x, y]) => add(`<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(14 + rnd() * 14).toFixed(0)}" ry="${(8 + rnd() * 6).toFixed(0)}" fill="#a69872" stroke="#8a7d5c" stroke-width="2"/>`));
    }
  });
  // Water through the gulch, over its ground: the creek, a ditch and a sluice.
  if (t.id === 'poormans-gulch') {
    add(`<path d="M20 860 Q200 700 330 600 T560 470 T780 400 T1040 330 T1300 250 T1580 140" fill="none" stroke="${C.water}" stroke-width="20" stroke-linecap="round"/>`);
    add(`<rect x="440" y="470" width="140" height="18" fill="${C.plank}" stroke="${C.ink}" stroke-width="2" transform="rotate(-28 510 479)"/>`);
    // The gulch's walls.
    for (let x = 20; x < 1580; x += 26) {
      add(`<line x1="${x}" y1="${980}" x2="${x + 10}" y2="${955}" stroke="#8a7d5c" stroke-width="2"/>`);
    }
  }
  // Every room's outline, faint, so the lots read as lots.
  Object.values(t.shapes).forEach((p) => add(`<polygon points="${pts(p)}" fill="none" stroke="#8a7a58" stroke-width="2" opacity="0.6"/>`));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${out.join('\n')}\n</svg>\n`;
}

// ---------- the maps ----------
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJSON(f, data) {
  const crlf = fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('\r\n');
  const s = JSON.stringify(data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
}
const worldFile = path.join(WORLD, 'world.json');
const world = readJSON(worldFile);
fs.mkdirSync(path.join(WORLD, 'sites'), { recursive: true });
TOWNS.forEach((town) => {
  const rooms = world.locations.filter((l) => l.site === town.id);
  if (!rooms.length) return;
  const ids = new Set(rooms.map((l) => l.id));
  const missing = rooms.filter((l) => !town.shapes[l.id]).map((l) => l.id);
  if (missing.length) throw new Error(`${town.name}: no shape for ${missing.join(', ')}`);
  // Shapes for rooms this world doesn't have (another world's version of the place) are left out.
  const t = Object.assign({}, town, { shapes: Object.fromEntries(Object.entries(town.shapes).filter(([id]) => ids.has(id))) });
  const map = {
    id: t.id, name: t.name, type: t.type, place: t.id, tags: t.tags, setting: ['western'],
    credit: 'Drawn for Ensemble (The Frontier, 1866–1869)', license: 'PolyForm Noncommercial 1.0.0, with the game',
    image: `sites/${t.id}.svg`, width: W, height: H, entry: t.entry,
    rooms: rooms.map((l) => Object.assign({ id: l.id, name: l.name, desc: l.desc },
      ['size', 'level', 'outside', 'features'].reduce((o, k) => (l[k] != null ? Object.assign(o, { [k]: l[k] }) : o), {}),
      { shape: t.shapes[l.id], links: (l.links || []).filter((k) => ids.has(k.to)).map((k) => ({ to: k.to, kind: k.kind })) })),
  };
  fs.writeFileSync(path.join(WORLD, 'sites', `${t.id}.svg`), picture(t));
  writeJSON(path.join(WORLD, 'sites', `${t.id}.json`), map);
  world.sites = [...new Set((world.sites || []).concat(t.id))];
  world.siteInfo[t.id] = Object.assign({}, world.siteInfo[t.id], { map: t.id });
  console.log(`${t.name}: ${rooms.length} rooms drawn.`);
});
writeJSON(worldFile, world);
