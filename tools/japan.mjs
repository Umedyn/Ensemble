// The map builder for scenarios/seiryo-high (task 7-2). Build time only:
// nothing here runs in the game.
//
//   node tools/japan.mjs fetch     the municipal outlines of Tokyo and Ibaraki into .cache/japan/
//   node tools/japan.mjs build     the pictures in maps/, and the regions and maps in world.json
//
// Sources: Natural Earth (public domain; "Made with Natural Earth"): the base
// raster and 1:10m prefectures, from .cache/basemap/ (run "npm run basemap --
// fetch --states" first); the municipal outlines of Tokyo (13) and Ibaraki
// (08) from MLIT's National Land Numerical Information, administrative areas
// (N03, 2024), used under its terms with the credit it asks for.
//
// Japan by its eight regions and 47 prefectures; Tokyo's 23 wards and the
// Tama area on Tokyo's own map; six of Ibaraki's towns on Ibaraki's map; and
// two close-ups the official data doesn't divide: Mito's neighbourhoods and
// the areas of Daigo (Fukuroda Onsen), each the part of the town nearest a
// landmark (cells around real points, clipped to the town's outline), so
// their edges are approximate.
//
// Building again keeps every field it doesn't own (lore, tags, status,
// notable, startable…) on regions with the same id, the map's room points,
// and the rest of world.json as it is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readTiff, cut, writeJpeg, unzipFile, SOURCES } from './basemap.mjs';
import { ringsOf, open, union, intersect } from './polygons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loadEngine } = require(path.join(root, 'tests', 'helpers.js'));
const E = loadEngine();
const G = E.Geo;
const WORLD = path.join(root, 'scenarios', 'seiryo-high');
const NE = path.join(root, '.cache', 'basemap');
const CACHE = path.join(root, '.cache', 'japan');
const N03 = (pref) => ({ url: `https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2024/N03-20240101_${pref}_GML.zip`, zip: `n03-${pref}.zip`, file: `N03-20240101_${pref}.geojson`, out: `n03-${pref}.geojson` });
const FETCH = [N03('13'), N03('08')];
const CREDIT_NE = 'Made with Natural Earth (naturalearthdata.com): 1:50m cross-blended hypsometric tints with shaded relief and water';
const CREDIT_N03 = 'Municipal outlines: National Land Numerical Information, administrative areas (N03, 2024), MLIT Japan (国土数値情報 行政区域データ, 国土交通省), adapted';
const CREDIT_CELLS = `${CREDIT_N03}; neighbourhood edges drawn for the game, approximate`;

// ---------- Japan ----------
const JAPAN = [122.5, 24, 146.2, 45.8];
const AREAS = [
  { id: 'hokkaido-region', name: 'Hokkaido', prefs: [1] },
  { id: 'tohoku', name: 'Tohoku', prefs: [2, 3, 4, 5, 6, 7] },
  { id: 'kanto', name: 'Kanto', prefs: [8, 9, 10, 11, 12, 13, 14], notable: true },
  { id: 'chubu', name: 'Chubu', prefs: [15, 16, 17, 18, 19, 20, 21, 22, 23] },
  { id: 'kansai', name: 'Kansai', prefs: [24, 25, 26, 27, 28, 29, 30] },
  { id: 'chugoku', name: 'Chugoku', prefs: [31, 32, 33, 34, 35] },
  { id: 'shikoku', name: 'Shikoku', prefs: [36, 37, 38, 39] },
  { id: 'kyushu', name: 'Kyushu and Okinawa', prefs: [40, 41, 42, 43, 44, 45, 46, 47] },
];
// Plain English names, the way people say them.
const PREFS = ['Hokkaido', 'Aomori', 'Iwate', 'Miyagi', 'Akita', 'Yamagata', 'Fukushima', 'Ibaraki', 'Tochigi', 'Gunma', 'Saitama', 'Chiba', 'Tokyo', 'Kanagawa',
  'Niigata', 'Toyama', 'Ishikawa', 'Fukui', 'Yamanashi', 'Nagano', 'Gifu', 'Shizuoka', 'Aichi', 'Mie', 'Shiga', 'Kyoto', 'Osaka', 'Hyogo', 'Nara', 'Wakayama',
  'Tottori', 'Shimane', 'Okayama', 'Hiroshima', 'Yamaguchi', 'Tokushima', 'Kagawa', 'Ehime', 'Kochi', 'Fukuoka', 'Saga', 'Nagasaki', 'Kumamoto', 'Oita', 'Miyazaki',
  'Kagoshima', 'Okinawa'];
const prefId = (n) => G.slug(PREFS[n - 1]);
// Between prefectures that share a border: a road, two hours (so a train
// route below is quicker where there is one).
const BORDER = { kind: 'road', time: '2h' };
// Fast ways across the country, from the prefecture that holds each end.
const LONG_ROUTES = [
  ['tokyo', 'kyoto', 'rail', '2h15m'], ['tokyo', 'osaka', 'rail', '2h30m'], ['tokyo', 'aichi', 'rail', '1h40m'], ['tokyo', 'miyagi', 'rail', '1h30m'],
  ['tokyo', 'ishikawa', 'rail', '2h30m'], ['tokyo', 'nagano', 'rail', '1h30m'], ['tokyo', 'hokkaido', 'air', '1h30m'], ['tokyo', 'fukuoka', 'air', '2h'],
  ['tokyo', 'okinawa', 'air', '2h45m'], ['tokyo', 'hiroshima', 'rail', '4h'], ['osaka', 'fukuoka', 'rail', '2h30m'], ['okayama', 'kagawa', 'rail', '1h'],
  ['hiroshima', 'ehime', 'sea', '3h'], ['yamaguchi', 'fukuoka', 'rail', '30m'], ['aomori', 'hokkaido', 'rail', '1h'], ['tokyo', 'chiba', 'rail', '40m'],
  ['tokyo', 'kanagawa', 'rail', '30m'], ['tokyo', 'saitama', 'rail', '30m'],
];
const JAPAN_PLACES = [['Sapporo', 141.35, 43.06], ['Sendai', 140.87, 38.27], ['Niigata', 139.04, 37.92], ['Kanazawa', 136.66, 36.56], ['Nagoya', 136.91, 35.18],
  ['Kyoto', 135.77, 35.01], ['Osaka', 135.5, 34.69], ['Kobe', 135.19, 34.69], ['Nara', 135.8, 34.69], ['Hiroshima', 132.46, 34.39], ['Fukuoka', 130.4, 33.59],
  ['Naha', 127.68, 26.21], ['Yokohama', 139.64, 35.44], ['Utsunomiya', 139.88, 36.56], ['Nikko', 139.6, 36.75], ['Matsuyama', 132.77, 33.84], ['Kagoshima', 130.56, 31.6]];

// ---------- Tokyo: the 23 wards and the Tama area ----------
const WARDS = ['Chiyoda', 'Chuo', 'Minato', 'Shinjuku', 'Bunkyo', 'Taito', 'Sumida', 'Koto', 'Shinagawa', 'Meguro', 'Ota', 'Setagaya', 'Shibuya', 'Nakano',
  'Suginami', 'Toshima', 'Kita', 'Arakawa', 'Itabashi', 'Nerima', 'Adachi', 'Katsushika', 'Edogawa'];
const wardCode = (i) => `131${String(i + 1).padStart(2, '0')}`;
const TOKYO_BOX = [138.93, 35.48, 139.95, 35.9];
const TAMA = (code) => /^132\d\d$/.test(code) || /^1330\d$/.test(code);
const TOKYO_PLACES = [['Shibuya Crossing', 139.7005, 35.6595, 'shibuya'], ['Takeshita Street, Harajuku', 139.7027, 35.6716, 'shibuya'], ['Akihabara', 139.7731, 35.6984, 'chiyoda'],
  ['Tokyo Station', 139.7671, 35.6812, 'chiyoda'], ['Ueno Park', 139.7713, 35.7148, 'taito'], ['Senso-ji, Asakusa', 139.7967, 35.7148, 'taito'],
  ['Tokyo Skytree', 139.8107, 35.7101, 'sumida'], ['Tokyo Tower', 139.7454, 35.6586, 'minato'], ['Odaiba', 139.7753, 35.6267, 'minato'],
  ['Shinjuku Station', 139.7006, 35.6896, 'shinjuku'], ['Ikebukuro Station', 139.7109, 35.7295, 'toshima'], ['Hongo university district', 139.7621, 35.7126, 'bunkyo'],
  ['Shimokitazawa', 139.6681, 35.6616, 'setagaya'], ['Nakano Broadway', 139.6658, 35.7091, 'nakano'], ['Kichijoji', 139.5797, 35.7031, 'tama'],
  ['Haneda Airport', 139.7798, 35.5494, 'ota'], ['Ryogoku', 139.7932, 35.6969, 'sumida']];

// ---------- Ibaraki: the towns the story uses ----------
const IBARAKI_BOX = [139.68, 35.73, 140.88, 36.97];
const TOWNS = [
  { id: 'mito', name: 'Mito', code: '08201', label: 'city', notable: true,
    routes: [{ to: 'tokyo', kind: 'rail', time: '1h20m' }, { to: 'daigo', kind: 'rail', time: '1h20m' }, { to: 'oarai', kind: 'rail', time: '20m' },
      { to: 'hitachinaka', kind: 'rail', time: '15m' }, { to: 'kasama', kind: 'rail', time: '25m' }, { to: 'hitachiota', kind: 'rail', time: '30m' }] },
  { id: 'hitachinaka', name: 'Hitachinaka', code: '08221', label: 'city' },
  { id: 'oarai', name: 'Oarai', code: '08309', label: 'town' },
  { id: 'kasama', name: 'Kasama', code: '08216', label: 'city' },
  { id: 'hitachiota', name: 'Hitachiota', code: '08212', label: 'city', routes: [{ to: 'daigo', kind: 'road', time: '45m' }] },
  { id: 'daigo', name: 'Daigo', code: '08364', label: 'town', notable: true, routes: [{ to: 'tochigi', kind: 'road', time: '1h30m' }] },
];
const IBARAKI_PLACES = [['Tsukuba', 140.11, 36.08], ['Hitachi', 140.65, 36.6], ['Tsuchiura', 140.2, 36.08], ['Koga', 139.75, 36.18], ['Kashima', 140.64, 35.97],
  ['Hitachi Seaside Park', 140.6, 36.4, 'hitachinaka'], ['Oarai beach', 140.58, 36.31, 'oarai'], ['Kasama Inari Shrine', 140.26, 36.385, 'kasama'], ['Ryujin Gorge', 140.47, 36.63, 'hitachiota']];

// ---------- the close-ups: cells around landmarks ----------
const CLOSEUPS = [
  { id: 'mito', box: [140.3, 36.285, 140.61, 36.48], width: 1800, label: 'neighbourhood',
    cells: [
      { id: 'mito-downtown', name: 'Downtown (Minamimachi, the castle hill)', at: [140.47, 36.377] },
      { id: 'mito-station-south', name: 'Station South (Sakuragawa)', at: [140.484, 36.364] },
      { id: 'mito-senba', name: 'Lake Senba and Kairakuen', at: [140.452, 36.368], notable: true },
      { id: 'mito-akatsuka', name: 'Akatsuka', at: [140.425, 36.39] },
      { id: 'mito-kasahara', name: 'Kasahara (the prefectural office)', at: [140.447, 36.34] },
      { id: 'mito-east', name: 'East Mito (toward the sea)', at: [140.52, 36.372] },
      { id: 'mito-north-bank', name: 'Across the Naka River', at: [140.46, 36.415] },
      { id: 'mito-uchihara', name: 'Uchihara', at: [140.36, 36.355] },
    ],
    places: [['Mito Station', 140.4767, 36.3708], ['Kairakuen garden', 140.4541, 36.3735], ['Lake Senba', 140.459, 36.3672], ['Kodokan (old domain school)', 140.4757, 36.3777],
      ['Art Tower Mito', 140.4687, 36.3742], ['Prefectural office', 140.4468, 36.3418], ['Akatsuka Station', 140.43, 36.3895], ['Uchihara shopping mall', 140.357, 36.351]],
    // Lake Senba, decoration only: an ellipse, [lon, lat, rx°, ry°].
    lakes: [[140.4585, 36.3668, 0.0075, 0.0018]] },
  { id: 'daigo', box: [140.21, 36.655, 140.51, 36.955], width: 1500, label: 'area',
    cells: [
      { id: 'daigo-centre', name: 'Daigo town centre', at: [140.352, 36.768] },
      { id: 'fukuroda', name: 'Fukuroda Onsen', at: [140.405, 36.758], notable: true },
      { id: 'daigo-north', name: 'The Yamizo foothills', at: [140.33, 36.87] },
      { id: 'daigo-east', name: 'The eastern hills (orchards and tea)', at: [140.445, 36.81] },
      { id: 'daigo-south', name: 'The southern Kuji valley', at: [140.345, 36.705] },
      { id: 'daigo-west', name: 'The western hills', at: [140.27, 36.79] },
    ],
    places: [['Fukuroda Falls', 140.4072, 36.7642], ['Fukuroda Station', 140.398, 36.744], ['Hitachi-Daigo Station', 140.352, 36.7685], ['Mount Yamizo', 140.27, 36.93]],
    lakes: [] },
];

// ---------- geometry in degrees ----------
// The part of a ring on the near side of the line halfway between two seeds
// (Sutherland–Hodgman against one half-plane), in a local metric so a cell's
// edges are true bisectors.
function halfPlane(ring, a, b, k) {
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n = [(b[0] - a[0]) * k * k, b[1] - a[1]];
  const side = (p) => (p[0] - m[0]) * n[0] + (p[1] - m[1]) * n[1];
  const out = [];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  });
  return out.length >= 3 ? out : null;
}
// Each seed's cell (convex: a box cut by every bisector, exact), then the
// town's outline inside it (Greiner–Hormann, so a concave outline leaves no
// slivers).
function cells(outline, seeds) {
  const k = Math.cos((seeds[0].at[1] * Math.PI) / 180);
  const [w, s, e, n] = G.bbox(outline.map(open));
  const box = [[w - 1, s - 1], [e + 1, s - 1], [e + 1, n + 1], [w - 1, n + 1]];
  return Object.fromEntries(seeds.map((seed) => {
    const cell = seeds.reduce((ring, o) => (ring && o !== seed ? halfPlane(ring, seed.at, o.at, k) : ring), box);
    return [seed.id, cell ? outline.flatMap((r) => intersect(r, cell)).filter((r) => G.area(r) > 1e-7) : []];
  }));
}
const simplifyDeg = (rings, tol) => rings.map((r) => G.simplify(open(r), tol)).filter(Boolean);

// ---------- pictures ----------
const lonlatFrame = (bounds, width) => {
  const [w, s, e, n] = bounds;
  const k = Math.cos(((s + n) / 2) * Math.PI / 180);
  const height = Math.round(width * ((n - s) / ((e - w) * k)));
  return { width, height, px: ([lon, lat]) => [((lon - w) / (e - w)) * width, ((n - lat) / (n - s)) * height] };
};
const pathSimple = (rings, f, tol) => rings.map((r) => G.simplify(open(r).map((p) => f.px(p)), tol)).filter(Boolean)
  .map((r) => 'M' + r.map((p) => p.map((v) => v.toFixed(1)).join(',')).join('L') + 'Z').join('');
const svg = (f, parts) => `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}">\n${parts.join('\n')}\n</svg>\n`;
const toPx = (f, rings, tol) => rings.map((r) => G.simplify(open(r).map((p) => f.px(p)), tol)).filter(Boolean)
  .map((r) => r.map((p) => [Math.round(Math.max(0, Math.min(f.width, p[0]))), Math.round(Math.max(0, Math.min(f.height, p[1])))]))
  .filter((r) => r.length >= 3 && G.area(r) >= 2);
const shapeOf = (rings) => (rings.length === 1 ? { polygon: rings[0] } : { polygons: rings });
// A plain picture: sea, the municipalities around (faint), the ones that
// matter (stronger). Decoration only (rule 11).
// Land: Natural Earth's prefectures, under everything (set by build).
let land = [];
function picture(f, file, around, strong, lakes) {
  const box = [f.px.bounds[0] - 0.05, f.px.bounds[1] - 0.05, f.px.bounds[2] + 0.05, f.px.bounds[3] + 0.05];
  const clipped = (rings) => rings.map((r) => G.clip(open(r), box)).filter(Boolean);
  const parts = [`<rect width="${f.width}" height="${f.height}" fill="#a9c3cf"/>`];
  parts.push(`<path d="${pathSimple(clipped(land), f, 0.8)}" fill="#e3dcc6" stroke="none"/>`);
  parts.push(`<path d="${pathSimple(clipped(around), f, 0.8)}" fill="#e3dcc6" stroke="#cbc1a5" stroke-width="1"/>`);
  parts.push(`<path d="${pathSimple(clipped(strong), f, 0.6)}" fill="#efe9d8" stroke="#a89c7c" stroke-width="2.5"/>`);
  (lakes || []).forEach(([lon, lat, rx, ry]) => {
    const [cx, cy] = f.px([lon, lat]);
    const [ex] = f.px([lon + rx, lat]);
    const [, ey] = f.px([lon, lat - ry]);
    parts.push(`<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(ex - cx).toFixed(1)}" ry="${(ey - cy).toFixed(1)}" fill="#a9c3cf" stroke="#7fa6bb" stroke-width="2"/>`);
  });
  fs.writeFileSync(path.join(WORLD, file), svg(f, parts));
}
const frame = (bounds, width) => { const f = lonlatFrame(bounds, width); f.px.bounds = bounds; return f; };

// ---------- build ----------
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJSON(f, data) {
  const crlf = fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('\r\n');
  const s = JSON.stringify(data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
}
// Municipalities of a prefecture: code → outer rings (as in the source, so
// neighbours share vertices and merge cleanly).
function municipalities(pref) {
  const by = {};
  readJSON(path.join(CACHE, N03(pref).out)).features.forEach((f) => {
    const code = f.properties.N03_007;
    if (!code) return;
    (by[code] = by[code] || []).push(...ringsOf(f.geometry));
  });
  Object.keys(by).forEach((c) => { by[c] = by[c].filter((r) => G.area(r) > 2e-7); });
  return by;
}
const neighboursOf = (id, pairs) => pairs.filter((p) => p.includes(id)).map((p) => (p[0] === id ? p[1] : p[0]));

function build() {
  const need = [path.join(NE, SOURCES.states.file), path.join(NE, SOURCES.raster.tif)].concat(FETCH.map((x) => path.join(CACHE, x.out)));
  need.forEach((f) => { if (!fs.existsSync(f)) throw new Error(`Missing ${path.relative(root, f)}: run "npm run basemap -- fetch --states" and "node tools/japan.mjs fetch".`); });
  const worldFile = path.join(WORLD, 'world.json');
  const world = fs.existsSync(worldFile) ? readJSON(worldFile) : { title: 'Seiryo High', setting: 'A high school in Mito, Japan.' };
  const kept = new Map((world.regions || []).map((r) => [r.id, r]));
  const keptMaps = new Map((world.regions || []).filter((r) => r.map).map((r) => [r.id, r.map]));
  const regions = [];
  const OWN = ['id', 'name', 'parent', 'label', 'neighbours', 'routes', 'key', 'map', 'notable'];
  const put = (r) => {
    const old = kept.get(r.id) || {};
    const def = Object.assign({}, r);
    Object.keys(old).filter((k) => !OWN.includes(k)).forEach((k) => { def[k] = old[k]; });
    regions.push(def);
    return def;
  };
  // A map's room points are the author's: kept across builds.
  const keepRooms = (map, old) => { if (old && old.locations) map.locations = old.locations; return map; };

  console.log('Reading the base raster…');
  const src = readTiff(fs.readFileSync(path.join(NE, SOURCES.raster.tif)));
  const c = cut(src, JAPAN, 2400);
  writeJpeg(path.join(WORLD, 'maps/japan.jpg'), c.rgba, c.width, c.height, 85);
  const japan = keepRooms({ image: 'maps/japan.jpg', width: c.width, height: c.height, projection: 'equirectangular', bounds: JAPAN, base: 'world', credit: CREDIT_NE, license: 'Public domain', regions: {} }, world.map);

  // Regions and prefectures.
  AREAS.forEach((a) => put(Object.assign({ id: a.id, name: a.name, label: 'region' }, a.notable ? { notable: true } : {})));
  const states = readJSON(path.join(NE, SOURCES.states.file)).features.filter((f) => f.properties.adm0_a3 === 'JPN');
  const prefRings = {};
  states.forEach((f) => { prefRings[prefId(Number(f.properties.iso_3166_2.slice(3)))] = ringsOf(f.geometry).filter((r) => r.some(([x, y]) => x > JAPAN[0] && x < JAPAN[2] && y > JAPAN[1] && y < JAPAN[3])); });
  const prefNb = G.neighbours(prefRings, 0.02);
  land = Object.values(prefRings).flat();
  AREAS.forEach((a) => a.prefs.forEach((n) => {
    const id = prefId(n);
    const rings = G.fitRings(japan, prefRings[id], { tol: 0.8, minArea: 3 });
    japan.regions[id] = rings.length ? shapeOf(rings) : { point: G.toPixel(japan, G.centroid(prefRings[id][0])).map(Math.round) };
    const fast = LONG_ROUTES.filter((r) => r[0] === id).map(([, to, kind, time]) => ({ to, kind, time }));
    const routes = neighboursOf(id, prefNb).filter((to) => !fast.some((r) => r.to === to)).map((to) => Object.assign({ to }, BORDER)).concat(fast);
    put(Object.assign({ id, name: PREFS[n - 1], parent: a.id, label: 'prefecture', routes, key: `JP-${String(n).padStart(2, '0')}` }, ['tokyo', 'ibaraki'].includes(id) ? { notable: true } : {}));
  }));
  const prefOf = (lon, lat) => Object.keys(prefRings).find((id) => G.insideAny([lon, lat], prefRings[id].map(open)));
  japan.places = JAPAN_PLACES.map(([name, lon, lat]) => Object.assign({ id: `city-${G.slug(name)}`, name, kind: 'city', at: G.toPixel(japan, [lon, lat]).map(Math.round) }, prefOf(lon, lat) ? { region: prefOf(lon, lat) } : {}));

  // Tokyo: wards and Tama on Tokyo's own map.
  const tk = municipalities('13');
  const tf = frame(TOKYO_BOX, 2000);
  const tokyo = keepRooms({ image: 'maps/tokyo.svg', width: tf.width, height: tf.height, credit: CREDIT_N03, license: 'MLIT National Land Numerical Information terms (attribution)', regions: {}, places: [] }, keptMaps.get('tokyo'));
  const tokyoLonLat = {};
  WARDS.forEach((name, i) => { tokyoLonLat[G.slug(name)] = tk[wardCode(i)]; });
  tokyoLonLat.tama = union(Object.keys(tk).filter(TAMA).map((k) => tk[k]));
  if (!tokyoLonLat.tama.length) throw new Error('Tama: the union failed');
  const tokyoNb = G.neighbours(Object.fromEntries(Object.entries(tokyoLonLat).map(([k, v]) => [k, simplifyDeg(v, 0.0008)])), 0.001);
  Object.entries(tokyoLonLat).forEach(([id, rings]) => {
    if (!rings || !rings.length) throw new Error(`Tokyo: no outline for ${id}`);
    tokyo.regions[id] = shapeOf(toPx(tf, rings, 0.8));
    const name = id === 'tama' ? 'The Tama area' : WARDS.find((w) => G.slug(w) === id);
    put({ id, name, parent: 'tokyo', label: id === 'tama' ? 'area' : 'ward', neighbours: neighboursOf(id, tokyoNb) });
  });
  tokyo.places = TOKYO_PLACES.map(([name, lon, lat, region]) => ({ id: `tokyo-${G.slug(name)}`, name, kind: 'place', at: tf.px([lon, lat]).map(Math.round), region }));
  picture(tf, tokyo.image, Object.values(tk).flat(), Object.values(tokyoLonLat).flat(), []);
  console.log(`  Tokyo: ${WARDS.length} wards and Tama, ${tokyo.places.length} places`);

  // Ibaraki: the story's towns on Ibaraki's map, the rest drawn faintly.
  const ib = municipalities('08');
  const iff = frame(IBARAKI_BOX, 1600);
  const ibaraki = keepRooms({ image: 'maps/ibaraki.svg', width: iff.width, height: iff.height, credit: CREDIT_N03, license: 'MLIT National Land Numerical Information terms (attribution)', regions: {}, places: [] }, keptMaps.get('ibaraki'));
  const townLonLat = Object.fromEntries(TOWNS.map((t) => [t.id, ib[t.code]]));
  TOWNS.forEach((t) => {
    if (!townLonLat[t.id]) throw new Error(`Ibaraki: no outline for ${t.name} (${t.code})`);
    ibaraki.regions[t.id] = shapeOf(toPx(iff, townLonLat[t.id], 0.7));
    put(Object.assign({ id: t.id, name: t.name, parent: 'ibaraki', label: t.label, routes: t.routes || [] }, t.notable ? { notable: true } : {}));
  });
  const townOf = (lon, lat) => TOWNS.find((t) => G.insideAny([lon, lat], townLonLat[t.id].map(open)));
  ibaraki.places = IBARAKI_PLACES.map(([name, lon, lat, region]) => Object.assign({ id: `ibaraki-${G.slug(name)}`, name, kind: region ? 'place' : 'city', at: iff.px([lon, lat]).map(Math.round) }, region || (townOf(lon, lat) && townOf(lon, lat).id) ? { region: region || townOf(lon, lat).id } : {}));
  picture(iff, ibaraki.image, Object.values(ib).flat(), Object.values(townLonLat).flat(), []);
  console.log(`  Ibaraki: ${TOWNS.length} towns, ${ibaraki.places.length} places`);

  // The close-ups: Mito's neighbourhoods, Daigo's areas.
  const closeMaps = {};
  CLOSEUPS.forEach((cu) => {
    const town = TOWNS.find((t) => t.id === cu.id);
    const outline = townLonLat[cu.id];
    const f = frame(cu.box, cu.width);
    const map = keepRooms({ image: `maps/${cu.id}.svg`, width: f.width, height: f.height, credit: CREDIT_CELLS, license: 'MLIT National Land Numerical Information terms (attribution)', regions: {}, places: [] }, keptMaps.get(cu.id));
    const parts = cells(outline, cu.cells);
    const nb = G.neighbours(parts, 0.0005);
    cu.cells.forEach((cell) => {
      if (!parts[cell.id].length) throw new Error(`${town.name}: ${cell.name} has no ground (move its point)`);
      map.regions[cell.id] = shapeOf(toPx(f, parts[cell.id], 0.8));
      put(Object.assign({ id: cell.id, name: cell.name, parent: cu.id, label: cu.label, neighbours: neighboursOf(cell.id, nb) }, cell.notable ? { notable: true } : {}));
    });
    const cellOf = (lon, lat) => cu.cells.find((cell) => G.insideAny([lon, lat], parts[cell.id]));
    map.places = cu.places.map(([name, lon, lat]) => Object.assign({ id: `${cu.id}-${G.slug(name)}`, name, kind: 'place', at: f.px([lon, lat]).map(Math.round) }, cellOf(lon, lat) ? { region: cellOf(lon, lat).id } : {}));
    picture(f, map.image, Object.values(ib).flat(), outline, cu.lakes);
    closeMaps[cu.id] = map;
    console.log(`  ${town.name}: ${cu.cells.length} ${cu.label}s, ${map.places.length} places`);
  });

  regions.find((r) => r.id === 'tokyo').map = tokyo;
  regions.find((r) => r.id === 'ibaraki').map = ibaraki;
  Object.entries(closeMaps).forEach(([id, m]) => { regions.find((r) => r.id === id).map = m; });
  world.regions = regions;
  world.regionLabels = ['region', 'prefecture', 'city', 'neighbourhood'];
  world.map = japan;
  kept.forEach((r, id) => { if (!regions.some((x) => x.id === id)) { regions.push(r); console.log(`  kept ${id} (not built here)`); } });
  writeJSON(worldFile, world);
  console.log(`${regions.length} regions.`);
}

async function fetchAll() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const x of FETCH) {
    console.log(`Fetching ${x.zip}…`);
    const res = await fetch(x.url);
    if (!res.ok) throw new Error(`${x.url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(CACHE, x.zip), buf);
    fs.writeFileSync(path.join(CACHE, x.out), unzipFile(buf, x.file));
  }
}

export const _test = { cells, halfPlane, union };
const cmd = process.argv[2];
if (cmd === 'fetch') await fetchAll();
else if (cmd === 'build') build();
else console.log('Usage: node tools/japan.mjs fetch | build');
