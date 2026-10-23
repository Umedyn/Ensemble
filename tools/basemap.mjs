// The base map tool (task 4-5): a shared topographic world map, and real
// places from open data for any world built on it. Build time only: nothing
// here runs in the game, and play never fetches anything.
//
//   npm run basemap -- fetch [--states]
//   npm run basemap -- world [--width 8192]
//   npm run basemap -- crop <world> --bounds W,S,E,N [--width 2400] [--file maps/base.jpg]
//   npm run basemap -- regions <world> [--from countries|states] [--pick "France, Italy"] [--within]
//                      [--places capitals|cities] [--tol 1.5] [--min-area 6] [--wiki]
//
// Sources (Natural Earth, public domain; "Made with Natural Earth"): the
// 1:50m cross-blended hypsometric tints with shaded relief and water
// (10,800 × 5,400, latitude/longitude), 1:50m countries, 1:50m populated
// places, and (--states) 1:10m states and provinces. "fetch" puts them in
// .cache/basemap/ (git ignores it). "world" writes the shared base map,
// library/maps/world/. "crop" cuts a world's own map from the full source, so
// a close-up stays sharp; a world that already has a projected map keeps its
// regions, moved onto the new picture. "regions" adds countries (or states)
// and their places to a world: outlines fitted to its map, simplified, with
// neighbours from shared borders and each one's Wikipedia page for the
// research helper (--wiki looks the titles up on Wikidata). Today's borders
// are a starting point: redraw them for another era in the creator.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loadEngine } = require(path.join(root, 'tests', 'helpers.js'));

const NE = 'https://naciscdn.org/naturalearth';
const GEOJSON = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
export const SOURCES = {
  raster: { url: `${NE}/50m/raster/HYP_50M_SR_W.zip`, file: 'HYP_50M_SR_W.zip', tif: 'HYP_50M_SR_W.tif' },
  countries: { url: `${GEOJSON}/ne_50m_admin_0_countries.geojson`, file: 'ne_50m_admin_0_countries.geojson' },
  places: { url: `${GEOJSON}/ne_50m_populated_places_simple.geojson`, file: 'ne_50m_populated_places_simple.geojson' },
  states: { url: `${GEOJSON}/ne_10m_admin_1_states_provinces.geojson`, file: 'ne_10m_admin_1_states_provinces.geojson' },
};
export const CREDIT = 'Made with Natural Earth (naturalearthdata.com): 1:50m cross-blended hypsometric tints with shaded relief and water';
export const LICENSE = 'Public domain';

const USAGE = `Usage:
  npm run basemap -- fetch [--states]
  npm run basemap -- world [--width 8192]
  npm run basemap -- crop <world> --bounds W,S,E,N [--width 2400] [--file maps/base.jpg]
  npm run basemap -- regions <world> [--from countries|states] [--pick "France, Italy"] [--within] [--places capitals|cities] [--tol 1.5] [--min-area 6] [--wiki]`;

export function parseArgs(argv) {
  const out = { cmd: argv[0], world: argv[1] && !argv[1].startsWith('--') ? argv[1] : null, flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (['within', 'wiki', 'states'].includes(k)) out.flags[k] = true;
    else out.flags[k] = argv[++i];
  }
  return out;
}

// Reads and writes keep each file's line endings.
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJSON(f, data) {
  const crlf = fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('\r\n');
  const s = JSON.stringify(data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
}
const dirOf = (world) => (fs.existsSync(path.join(root, 'scenarios', world)) ? path.join(root, 'scenarios', world) : path.resolve(world));
const cacheDir = (flags) => path.resolve(flags.cache || path.join(root, '.cache', 'basemap'));

// ---------- files: zip, TIFF, JPEG ----------
// One file out of a zip (stored or deflated).
export function unzipFile(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (entry.split('/').pop() !== name) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
  }
  throw new Error(`${name} is not in the zip`);
}
// A baseline TIFF: uncompressed, 8-bit RGB (or RGBA), in strips, as Natural
// Earth's rasters are. → { width, height, data (RGB, row by row) }
export function readTiff(buf) {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error('not a TIFF file');
  const ifd = u32(4);
  const tags = {};
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    // Only the tags that place the pixels (GeoTIFF's text and doubles are skipped).
    if (![256, 257, 259, 273, 277, 279].includes(tag) || (type !== 3 && type !== 4)) continue;
    const size = type === 3 ? 2 : 4;
    const at = count * size > 4 ? u32(e + 8) : e + 8;
    const vals = [];
    for (let k = 0; k < count; k++) vals.push(type === 3 ? u16(at + k * 2) : u32(at + k * 4));
    tags[tag] = vals;
  }
  const width = tags[256][0], height = tags[257][0];
  const comp = (tags[259] || [1])[0], spp = (tags[277] || [1])[0];
  if (comp !== 1) throw new Error('only uncompressed TIFF files are supported');
  if (spp < 3) throw new Error('only RGB TIFF files are supported');
  const offsets = tags[273], counts = tags[279];
  const data = Buffer.alloc(width * height * 3);
  let o = 0;
  offsets.forEach((off, i) => {
    const strip = buf.subarray(off, off + counts[i]);
    if (spp === 3) { strip.copy(data, o); o += strip.length; }
    else for (let k = 0; k + spp <= strip.length; k += spp) { data[o++] = strip[k]; data[o++] = strip[k + 1]; data[o++] = strip[k + 2]; }
  });
  return { width, height, data };
}
// Part of a raster (sx, sy, sw, sh in source pixels) → width × height RGBA,
// averaging when it shrinks and blending neighbours when it grows.
export function resample(src, sx, sy, sw, sh, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const fx = sw / width, fy = sh / height;
  const px = (x, y, c) => src.data[(Math.min(src.height - 1, Math.max(0, y)) * src.width + Math.min(src.width - 1, Math.max(0, x))) * 3 + c];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (fx >= 1 && fy >= 1) {
        const x0 = Math.floor(sx + x * fx), x1 = Math.max(x0 + 1, Math.floor(sx + (x + 1) * fx));
        const y0 = Math.floor(sy + y * fy), y1 = Math.max(y0 + 1, Math.floor(sy + (y + 1) * fy));
        const n = (x1 - x0) * (y1 - y0);
        for (let c = 0; c < 3; c++) {
          let t = 0;
          for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) t += px(xx, yy, c);
          out[o + c] = Math.round(t / n);
        }
      } else {
        const gx = sx + (x + 0.5) * fx - 0.5, gy = sy + (y + 0.5) * fy - 0.5;
        const x0 = Math.floor(gx), y0 = Math.floor(gy), ax = gx - x0, ay = gy - y0;
        for (let c = 0; c < 3; c++) {
          const v = px(x0, y0, c) * (1 - ax) * (1 - ay) + px(x0 + 1, y0, c) * ax * (1 - ay) + px(x0, y0 + 1, c) * (1 - ax) * ay + px(x0 + 1, y0 + 1, c) * ax * ay;
          out[o + c] = Math.round(v);
        }
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
export function writeJpeg(file, rgba, width, height, quality) {
  const jpeg = require('jpeg-js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jpeg.encode({ data: rgba, width, height }, quality || 85).data);
}

// ---------- sources ----------
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
function loadRaster(dir) {
  const tif = path.join(dir, SOURCES.raster.tif);
  if (!fs.existsSync(tif)) {
    const zip = path.join(dir, SOURCES.raster.file);
    if (!fs.existsSync(zip)) throw new Error('No source image yet: run "npm run basemap -- fetch" first.');
    fs.writeFileSync(tif, unzipFile(fs.readFileSync(zip), SOURCES.raster.tif));
  }
  return readTiff(fs.readFileSync(tif));
}
// The raster's corners: Natural Earth's world rasters cover the whole globe.
export const SOURCE_BOUNDS = [-180, -90, 180, 90];
// Cuts bounds out of the source at a width (height from the bounds, as the
// projection is linear). → { rgba, width, height }
export function cut(src, bounds, width) {
  const [w, s, e, n] = bounds;
  const sx = ((w + 180) / 360) * src.width, sw = ((e - w) / 360) * src.width;
  const sy = ((90 - n) / 180) * src.height, sh = ((n - s) / 180) * src.height;
  const height = Math.max(1, Math.round(width * (sh / sw)));
  return { rgba: resample(src, sx, sy, sw, sh, width, height), width, height };
}

// GeoJSON features → outlines for Geo.importRegions: outer rings only.
const ringsOf = (geom) => (!geom ? [] : geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0]) : []);
export function countryFeatures(gj) {
  return gj.features.map((f) => {
    const p = f.properties;
    return { key: p.ADM0_A3, name: p.NAME || p.ADMIN, alt: [p.ADMIN, p.NAME_LONG, p.NAME_EN, p.ISO_A3_EH, p.ADM0_A3].filter((x) => x && x !== '-99'), wikidata: p.WIKIDATAID || null, title: p.NAME_EN || p.ADMIN, rings: ringsOf(f.geometry) };
  });
}
export function stateFeatures(gj) {
  return gj.features.map((f) => {
    const p = f.properties;
    return { key: p.adm1_code, name: p.name || p.name_en, alt: [p.name_en, p.gn_name, `${p.name}, ${p.admin}`].filter(Boolean), country: p.admin, wikidata: p.wikidataid || null, title: p.name_en || p.name, rings: ringsOf(f.geometry) };
  });
}
// Populated places → points: capitals only, or every city on the map.
export function placePoints(gj, which) {
  return gj.features.map((f) => f.properties).filter((p) => (which === 'cities' ? true : p.adm0cap === 1))
    .map((p) => ({ name: p.nameascii || p.name, lon: p.longitude, lat: p.latitude, kind: p.adm0cap === 1 ? 'capital' : 'city', key: p.adm0_a3 }));
}
// Wikipedia titles for Wikidata ids (English sitelinks), 50 at a time.
export async function wikiTitles(ids, fetchFn) {
  const out = {};
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 50) {
    const q = new URLSearchParams({ action: 'wbgetentities', ids: list.slice(i, i + 50).join('|'), props: 'sitelinks', sitefilter: 'enwiki', format: 'json' });
    const res = await fetchFn(`https://www.wikidata.org/w/api.php?${q}`, { headers: { 'User-Agent': 'Ensemble-basemap/1 (build-time tool)' } });
    const j = await res.json();
    Object.entries(j.entities || {}).forEach(([id, e]) => { const t = e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title; if (t) out[id] = t; });
  }
  return out;
}

// ---------- the commands ----------
// Imported regions and places into world.json: new ones added, ones with the
// same id get the new outline (their other fields kept); neighbours set
// both ways among the imported. → a summary line.
export function mergeIntoWorld(E, world, imp, places) {
  const map = world.map;
  world.regions = world.regions || [];
  map.regions = map.regions || {};
  imp.regions.forEach((r) => {
    let def = world.regions.find((x) => x.id === r.id);
    if (!def) { def = { id: r.id, name: r.name, controller: null, tags: [], status: '', neighbours: [], lore: '' }; world.regions.push(def); }
    def.key = r.key;
    if (r.wiki) def.wiki = r.wiki;
    map.regions[r.id] = imp.shapes[r.id];
  });
  imp.neighbours.forEach(([a, b]) => {
    [[a, b], [b, a]].forEach(([x, y]) => { const d = world.regions.find((r) => r.id === x); if (d && !(d.neighbours || []).includes(y)) d.neighbours = (d.neighbours || []).concat(y); });
  });
  if (places && places.length) {
    const ids = new Set(places.map((p) => p.id));
    map.places = (map.places || []).filter((p) => !ids.has(p.id)).concat(places);
  }
  map.credit = map.credit || CREDIT;
  map.license = map.license || LICENSE;
  return `${imp.regions.length} regions, ${imp.neighbours.length} borders, ${(places || []).length} places${imp.skipped.length ? `; too small or off the map: ${imp.skipped.join(', ')}` : ''}${imp.missing.length ? `; not found: ${imp.missing.join(', ')}` : ''}`;
}
// A projected map's regions and places moved onto a new map (another crop).
export function reproject(E, oldMap, newMap) {
  const G = E.Geo;
  const move = (p) => G.toPixel(newMap, G.toLonLat(oldMap, p));
  const regions = {};
  Object.entries(oldMap.regions || {}).forEach(([id, sh]) => {
    if (sh.point) { const p = move(sh.point).map(Math.round); if (p[0] >= 0 && p[1] >= 0 && p[0] <= newMap.width && p[1] <= newMap.height) regions[id] = { point: p }; return; }
    const rings = G.pieces(sh).map((r) => G.clip(r.map(move), [0, 0, newMap.width, newMap.height])).filter(Boolean).map((r) => r.map((p) => p.map(Math.round)));
    if (rings.length) regions[id] = rings.length === 1 ? { polygon: rings[0] } : { polygons: rings };
  });
  const inside = (p) => p[0] >= 0 && p[1] >= 0 && p[0] <= newMap.width && p[1] <= newMap.height;
  const places = (oldMap.places || []).map((p) => Object.assign({}, p, { at: move(p.at).map(Math.round) })).filter((p) => inside(p.at));
  const locations = {};
  Object.entries(oldMap.locations || {}).forEach(([id, p]) => { const q = move(p).map(Math.round); if (inside(q)) locations[id] = q; });
  return Object.assign({}, newMap, { regions, places, locations });
}

export async function main(argv, io = {}) {
  const log = io.log || console.log;
  const { cmd, world, flags } = parseArgs(argv);
  const E = io.E || loadEngine();
  const dir = cacheDir(flags);
  if (cmd === 'fetch') {
    for (const k of ['raster', 'countries', 'places'].concat(flags.states ? ['states'] : [])) {
      const f = path.join(dir, SOURCES[k].file);
      if (fs.existsSync(f)) { log(`✓ ${SOURCES[k].file} (already here)`); continue; }
      log(`… ${SOURCES[k].url}`);
      await download(SOURCES[k].url, f);
      log(`✓ ${SOURCES[k].file}`);
    }
    return;
  }
  if (cmd === 'world') {
    const width = Number(flags.width) || 8192;
    const src = io.raster || loadRaster(dir);
    const img = cut(src, SOURCE_BOUNDS, width);
    const out = path.join(root, 'library', 'maps', 'world');
    writeJpeg(path.join(out, 'world.jpg'), img.rgba, img.width, img.height, Number(flags.quality) || 82);
    const map = { id: 'world', title: 'The world (shaded relief)', image: 'world.jpg', width: img.width, height: img.height, projection: 'equirectangular', bounds: SOURCE_BOUNDS, credit: CREDIT, license: LICENSE };
    writeJSON(path.join(out, 'map.json'), map);
    const idxFile = path.join(root, 'library', 'index.json');
    const idx = readJSON(idxFile);
    idx.maps = (idx.maps || []).filter((m) => m.id !== 'world').concat([{ id: 'world', title: map.title, bounds: map.bounds }]);
    writeJSON(idxFile, idx);
    log(`✓ library/maps/world/world.jpg (${img.width} × ${img.height})`);
    return;
  }
  if (!world) throw new Error(USAGE);
  const wdir = dirOf(world);
  const wfile = path.join(wdir, 'world.json');
  if (!fs.existsSync(wfile)) throw new Error(`No world.json in ${wdir}`);
  const w = readJSON(wfile);
  if (cmd === 'crop') {
    const bounds = String(flags.bounds || '').split(',').map(Number);
    const probe = { projection: 'equirectangular', bounds };
    const p = E.Geo.projectionProblems(probe);
    if (p.length) throw new Error(`${p.join('; ')} (for example --bounds -11,35,30,60 for western Europe)`);
    const width = Number(flags.width) || 2400;
    const src = io.raster || loadRaster(dir);
    const img = cut(src, bounds, width);
    const file = flags.file || 'maps/base.jpg';
    writeJpeg(path.join(wdir, file), img.rgba, img.width, img.height, Number(flags.quality) || 85);
    let map = { image: file, width: img.width, height: img.height, projection: 'equirectangular', bounds, regions: {}, credit: CREDIT, license: LICENSE };
    if (w.map && E.Geo.projected(w.map)) map = reproject(E, w.map, map);
    else if (w.map && Object.keys(w.map.regions || {}).length) throw new Error('This world\'s map has no projection, so its regions can\'t be moved onto the new picture. Remove the map in the creator first, or crop into a copy of the world.');
    w.map = map;
    writeJSON(wfile, w);
    log(`✓ ${path.relative(root, path.join(wdir, file))} (${img.width} × ${img.height}); world.json "map" updated`);
    return;
  }
  if (cmd === 'regions') {
    if (!w.map || !E.Geo.projected(w.map)) throw new Error('This world has no projected map yet: make one with "crop" (or start the world from the base map in the creator).');
    const from = flags.from || 'countries';
    const gj = io.geojson ? io.geojson[from] : readJSON(path.join(dir, SOURCES[from].file));
    let features = from === 'states' ? stateFeatures(gj) : countryFeatures(gj);
    const taken = [].concat((w.regions || []).map((r) => r.id), (w.locations || []).map((l) => l.id));
    const pick = flags.pick ? String(flags.pick).split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (!pick && !flags.within) throw new Error('Say which: --pick "France, Italy" or --within (everything on the map).');
    // Regions already imported keep their ids (the same key replaces the outline).
    const byKey = new Map((w.regions || []).filter((r) => r.key).map((r) => [r.key, r.id]));
    const imp = E.Geo.importRegions(w.map, features, { pick, within: !!flags.within, taken: taken.filter((id) => ![...byKey.values()].includes(id)), tol: Number(flags.tol) || 1.5, minArea: Number(flags['min-area']) || 6 });
    imp.regions.forEach((r) => {
      const old = byKey.get(r.key);
      if (old && old !== r.id) { imp.shapes[old] = imp.shapes[r.id]; delete imp.shapes[r.id]; imp.neighbours = imp.neighbours.map((p) => p.map((x) => (x === r.id ? old : x))); r.id = old; }
    });
    if (flags.wiki) {
      const titles = await wikiTitles(imp.regions.map((r) => r.wiki && r.wiki.wikidata), io.fetch || fetch);
      imp.regions.forEach((r) => { if (r.wiki && titles[r.wiki.wikidata]) r.wiki.title = titles[r.wiki.wikidata]; });
    }
    let places = [];
    if (flags.places) {
      const pg = io.geojson ? io.geojson.places : readJSON(path.join(dir, SOURCES.places.file));
      const known = imp.regions.concat((w.regions || []).filter((r) => r.key && !imp.regions.some((x) => x.id === r.id)).map((r) => ({ id: r.id, key: r.key })));
      const shapes = Object.assign({}, w.map.regions, imp.shapes);
      const pts = placePoints(pg, flags.places);
      places = E.Geo.importPlaces(w.map, pts, known, shapes, taken.concat(imp.regions.map((r) => r.id), (w.map.places || []).map((p) => p.id)))
        .filter((p) => p.region);
    }
    log(`✓ ${mergeIntoWorld(E, w, imp, places)}`);
    writeJSON(wfile, w);
    // A world with regions needs one for every start: one without gets the
    // first, as in the creator (pick the right one in the Map tab).
    const first = (w.regions || [])[0];
    (w.starts || []).forEach((sid) => {
      const f = path.join(wdir, 'starts', `${sid}.json`);
      if (!first || !fs.existsSync(f)) return;
      const st = readJSON(f);
      if (st.region) return;
      st.region = first.id;
      writeJSON(f, st);
      log(`! start "${sid}" had no region: it is in ${first.name} for now (change it in the creator's Map tab, "Where each start begins")`);
    });
    // The world still has to load.
    try {
      const files = { 'world.json': w };
      E.Scenario.neededFiles(w, false).forEach((p) => { const f = path.join(wdir, p); if (fs.existsSync(f)) files[p] = readJSON(f); });
      const loaded = E.Scenario.prepareWorld(path.basename(wdir), files);
      loaded.starts.filter((s) => s.error).forEach((s) => log(`! start "${s.id}": ${s.error}`));
    } catch (e) { log(`! ${e.message}`); }
    return;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
