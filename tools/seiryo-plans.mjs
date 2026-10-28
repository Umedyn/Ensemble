// The drawn floor plan of Seiryo High (task 7-2), for scenarios/seiryo-high:
//
//   node tools/seiryo-plans.mjs
//
// One sheet with the school's four floors (the ground floor and its grounds,
// the first-years' floor, the older years' floor, the roof), each room a
// hand-placed polygon. Writes sites/seiryo.svg (the picture: floors, walls
// and furniture, decoration only) and sites/seiryo.json (a site map with the
// rooms as authored in world.json and their shapes), and sets the school's
// siteInfo map and the world's "sites". Building again keeps the rest of
// world.json as it is. Original drawing, made for Ensemble.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORLD = path.join(root, 'scenarios', 'seiryo-high');
const W = 1800, H = 2140;

// ---------- the rooms, by floor ----------
const SHAPES = {
  // Ground floor: the old wing (west), the main building, the gym and the grounds (east), the gate (south).
  'old-wing': [[40, 300], [300, 300], [300, 640], [200, 640], [200, 380], [40, 380]],
  'art-room': [[40, 380], [200, 380], [200, 640], [40, 640]],
  walkway: [[300, 560], [380, 560], [380, 620], [300, 620]],
  'ground-hall': [[380, 540], [1000, 540], [1000, 620], [460, 620], [460, 700], [380, 700]],
  'staff-room': [[380, 420], [600, 420], [600, 540], [380, 540]],
  principal: [[600, 420], [720, 420], [720, 540], [600, 540]],
  nurse: [[720, 420], [820, 420], [820, 540], [720, 540]],
  cafeteria: [[820, 420], [900, 420], [900, 320], [1000, 320], [1000, 540], [820, 540]],
  entrance: [[560, 620], [780, 620], [780, 720], [560, 720]],
  gate: [[460, 720], [1360, 720], [1360, 900], [620, 900], [620, 960], [460, 960]],
  courtyard: [[1000, 440], [1360, 440], [1360, 720], [1000, 720]],
  gym: [[1020, 100], [1360, 100], [1360, 200], [1300, 200], [1300, 440], [1020, 440]],
  'behind-gym': [[1300, 200], [1360, 200], [1360, 440], [1300, 440]],
  field: [[1360, 60], [1760, 60], [1760, 560], [1520, 560], [1520, 900], [1360, 900]],
  pool: [[1520, 560], [1760, 560], [1760, 900], [1520, 900]],
  // First floor.
  'club-room': [[200, 1100], [300, 1100], [300, 1220], [200, 1220]],
  'classroom-1a': [[380, 1060], [580, 1060], [580, 1160], [380, 1160]],
  'classroom-1b': [[580, 1060], [780, 1060], [780, 1160], [580, 1160]],
  'classroom-1c': [[780, 1060], [1000, 1060], [1000, 1160], [780, 1160]],
  hallway: [[380, 1160], [1000, 1160], [1000, 1240], [460, 1240], [460, 1320], [380, 1320]],
  library: [[560, 1240], [860, 1240], [860, 1380], [700, 1380], [700, 1340], [560, 1340]],
  'council-room': [[860, 1240], [1000, 1240], [1000, 1340], [860, 1340]],
  'judo-dojo': [[1020, 1060], [1300, 1060], [1300, 1340], [1020, 1340]],
  // Second floor.
  'classrooms-2': [[380, 1500], [700, 1500], [700, 1600], [380, 1600]],
  'classrooms-3': [[700, 1500], [1000, 1500], [1000, 1600], [700, 1600]],
  'upper-hall': [[380, 1600], [1000, 1600], [1000, 1680], [460, 1680], [460, 1760], [380, 1760]],
  'music-room': [[560, 1680], [860, 1680], [860, 1800], [620, 1800], [620, 1760], [560, 1760]],
  // The roof.
  rooftop: [[380, 1900], [1000, 1900], [1000, 2100], [460, 2100], [460, 2040], [380, 2040]],
};
// Doors the shared edge can't place: the roof door is at the end of the corridor.
const DOORS = { 'upper-hall|rooftop': [975, 1640] };
const FLOORS = [['Ground floor and grounds', 40], ['First floor', 1030], ['Second floor', 1470], ['The roof', 1870]];

// ---------- the picture ----------
const pts = (p) => p.map(([x, y]) => `${x},${y}`).join(' ');
const out = [];
const add = (s) => out.push(s);
const rect = (x, y, w, h, fill, extra) => add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra || ''}/>`);
const OUTDOOR = { gate: '#d8d0bb', courtyard: '#c9d4b0', 'behind-gym': '#c4bda9', field: '#8db878', pool: '#7db3d6', rooftop: '#bdb9b0' };
const FLOOR = { 'old-wing': '#e2cfa8', 'art-room': '#e2cfa8', 'club-room': '#e2cfa8', walkway: '#d6d0c4', gym: '#dcc08c', 'judo-dojo': '#d9cf8f' };
function picture() {
  add(`<rect width="${W}" height="${H}" fill="#ebe6da"/>`);
  FLOORS.forEach(([name, y]) => add(`<text x="40" y="${y}" font-family="sans-serif" font-size="22" font-weight="bold" fill="#6b6658">${name}</text>`));
  // Floors.
  Object.entries(SHAPES).forEach(([id, p]) => add(`<polygon points="${pts(p)}" fill="${OUTDOOR[id] || FLOOR[id] || '#f3eee3'}"/>`));
  // The grounds.
  add('<g fill="none" stroke="#d6dfe8" stroke-width="3">' + [600, 660, 720, 780, 840].map((y) => `<line x1="1530" y1="${y}" x2="1750" y2="${y}"/>`).join('') + '</g>');
  add('<rect x="1380" y="80" width="360" height="460" rx="150" fill="none" stroke="#c9845a" stroke-width="18"/>');
  add('<path d="M1440 760 L1440 640 L1500 700 Z" fill="#c9a06a" stroke="#fff" stroke-width="3"/>');
  [[490, 760], [560, 800], [640, 760], [720, 800], [800, 760], [880, 800], [520, 900], [580, 930]].forEach(([x, y]) => add(`<circle cx="${x}" cy="${y}" r="26" fill="#f1b7c6" stroke="#d98aa0" stroke-width="2"/>`));
  add('<circle cx="1180" cy="580" r="60" fill="#8fae6e" stroke="#6f8f52" stroke-width="3"/>');
  [[1060, 680], [1240, 680], [1100, 480]].forEach(([x, y]) => rect(x - 40, y - 8, 80, 16, '#a88b62'));
  for (let y = 220; y < 440; y += 22) for (let x = 1310; x < 1360; x += 22) add(`<circle cx="${x}" cy="${y}" r="2" fill="#9a937e"/>`);
  // Furniture: desks, shelves, tables, the court, mats, the piano.
  const desks = (x0, y0, x1, y1) => { for (let y = y0 + 20; y < y1 - 20; y += 22) for (let x = x0 + 24; x < x1 - 24; x += 28) rect(x, y, 16, 11, '#c8b48c'); };
  desks(380, 1060, 580, 1160); desks(580, 1060, 780, 1160); desks(780, 1060, 1000, 1160); desks(380, 1500, 700, 1600); desks(700, 1500, 1000, 1600);
  [[400, 1068], [600, 1068], [800, 1068], [400, 1508], [720, 1508]].forEach(([x, y]) => rect(x, y, 140, 6, '#4f6b55'));
  for (let x = 580; x < 850; x += 34) rect(x, 1255, 12, 70, '#9b7b55');
  rect(720, 1350, 120, 18, '#c8b48c');
  rect(880, 1270, 100, 40, '#b59a6e');
  for (let y = 350; y < 530; y += 36) rect(920, y, 70, 14, '#c8b48c');
  rect(835, 440, 50, 80, '#d9c9a8');
  [[400, 440], [460, 440], [520, 440], [400, 490], [460, 490], [520, 490]].forEach(([x, y]) => rect(x, y, 44, 26, '#c8b48c'));
  rect(620, 440, 80, 30, '#8c6b4a'); rect(625, 490, 70, 26, '#7a5b46');
  rect(735, 435, 30, 70, '#ffffff', ' stroke="#c4bdb0"'); rect(780, 435, 30, 70, '#ffffff', ' stroke="#c4bdb0"');
  for (let x = 575; x < 770; x += 24) rect(x, 630, 16, 50, '#9b8f7a');
  for (let y = 400; y < 630; y += 46) [60, 130].forEach((x) => rect(x, y, 50, 30, '#c8b48c'));
  add('<rect x="1050" y="140" width="220" height="260" fill="none" stroke="#ffffff" stroke-width="3"/><circle cx="1160" cy="270" r="40" fill="none" stroke="#ffffff" stroke-width="3"/>');
  rect(1030, 108, 260, 28, '#9b7b55');
  for (let y = 1070; y < 1330; y += 40) for (let x = 1030; x < 1290; x += 64) rect(x, y, 60, 36, 'none', ' stroke="#b8ad6e" stroke-width="2"');
  add('<path d="M580 1700 h90 a40 40 0 0 1 0 50 h-90 z" fill="#2e2b28"/>');
  for (let y = 1705; y < 1795; y += 22) add(`<line x1="700" y1="${y}" x2="850" y2="${y}" stroke="#c8b48c" stroke-width="3"/>`);
  add('<circle cx="250" cy="1150" r="22" fill="none" stroke="#5c5f6b" stroke-width="5"/><line x1="250" y1="1150" x2="285" y2="1120" stroke="#5c5f6b" stroke-width="6"/>');
  for (let x = 50; x < 300; x += 18) add(`<line x1="${x}" y1="300" x2="${x}" y2="380" stroke="#d2bd92" stroke-width="2"/>`);
  // Stairs in each corridor's bend, and to the old wing's top floor.
  [[380, 620, 80, 80], [380, 1240, 80, 80], [380, 1680, 80, 80], [210, 580, 80, 50]].forEach(([x, y, w, h]) => { for (let i = 8; i < h; i += 10) add(`<line x1="${x + 6}" y1="${y + i}" x2="${x + w - 6}" y2="${y + i}" stroke="#a49c8c" stroke-width="2"/>`); });
  add('<circle cx="900" cy="2000" r="44" fill="#d6d3cc" stroke="#8d8a83" stroke-width="4"/>');
  add('<rect x="388" y="2048" width="64" height="44" fill="#a7a39a"/>');
  // Walls: every indoor room's outline; outdoor ground gets a fence or a kerb.
  Object.entries(SHAPES).forEach(([id, p]) => add(OUTDOOR[id]
    ? `<polygon points="${pts(p)}" fill="none" stroke="#8b8576" stroke-width="3" stroke-dasharray="${id === 'rooftop' || id === 'pool' ? '10 6' : '2 0'}"/>`
    : `<polygon points="${pts(p)}" fill="none" stroke="#4a4a52" stroke-width="8" stroke-linejoin="miter"/>`));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${out.join('\n')}\n</svg>\n`;
}

// ---------- the map ----------
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJSON(f, data) {
  const crlf = fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('\r\n');
  const s = JSON.stringify(data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
}
const worldFile = path.join(WORLD, 'world.json');
const world = readJSON(worldFile);
const rooms = world.locations.filter((l) => l.site === 'seiryo');
const ids = new Set(rooms.map((l) => l.id));
const missing = rooms.filter((l) => !SHAPES[l.id]).map((l) => l.id).concat(Object.keys(SHAPES).filter((id) => !ids.has(id)));
if (missing.length) throw new Error(`rooms and shapes don't match: ${missing.join(', ')}`);
const map = {
  id: 'seiryo', name: 'Seiryo High', type: 'school', place: 'seiryo', tags: [], setting: ['modern'],
  credit: 'Drawn for Ensemble (Seiryo High)', license: 'PolyForm Noncommercial 1.0.0, with the game',
  image: 'sites/seiryo.svg', width: W, height: H, entry: 'gate',
  rooms: rooms.map((l) => Object.assign({ id: l.id, name: l.name, desc: l.desc },
    ['size', 'level', 'outside', 'features'].reduce((o, k) => (l[k] != null ? Object.assign(o, { [k]: l[k] }) : o), {}),
    { shape: SHAPES[l.id], links: (l.links || []).filter((k) => ids.has(k.to)).map((k) => Object.assign({ to: k.to, kind: k.kind }, DOORS[`${l.id}|${k.to}`] ? { at: DOORS[`${l.id}|${k.to}`] } : {})) })),
};
fs.writeFileSync(path.join(WORLD, 'sites', 'seiryo.svg'), picture());
writeJSON(path.join(WORLD, 'sites', 'seiryo.json'), map);
world.sites = [...new Set((world.sites || []).concat('seiryo'))];
world.siteInfo.seiryo = Object.assign({}, world.siteInfo.seiryo, { map: 'seiryo' });
writeJSON(worldFile, world);
console.log(`Seiryo High: ${rooms.length} rooms drawn on a ${W} × ${H} sheet.`);
