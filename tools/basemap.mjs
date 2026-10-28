// The base map tool (task 4-5): a shared topographic world map, and real
// places from open data for any world built on it. Build time only: nothing
// here runs in the game, and play never fetches anything.
//
//   npm run basemap -- fetch [--states]
//   npm run basemap -- world [--width 8192]
//   npm run basemap -- crop <world> --bounds W,S,E,N [--width 2400] [--file maps/base.jpg]
//   npm run basemap -- crop <world> --region <id> [--bounds W,S,E,N] [--width 2400]
//   npm run basemap -- regions <world> [--from countries|states] [--pick "France, Italy"] [--within]
//                      [--parent <id>] [--places capitals|cities] [--min-pop N] [--as pins|regions]
//                      [--labels "country, state, city"] [--tol 1.5] [--min-area 6] [--points] [--wiki]
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
//
// A tree (R-9): states go under their country (the region with the same
// source key, or --parent), cities into the state that holds them (as pins,
// or --as regions under it), and "crop --region" gives a region its own,
// sharper map, moving what's inside it there. Shared borders are neighbours,
// which the game reads as border routes.
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
  // The full places file: the simple one has no Wikidata ids for the pages.
  places: { url: `${GEOJSON}/ne_50m_populated_places.geojson`, file: 'ne_50m_populated_places.geojson', older: 'ne_50m_populated_places_simple.geojson' },
  states: { url: `${GEOJSON}/ne_10m_admin_1_states_provinces.geojson`, file: 'ne_10m_admin_1_states_provinces.geojson' },
};
export const CREDIT = 'Made with Natural Earth (naturalearthdata.com): 1:50m cross-blended hypsometric tints with shaded relief and water';
export const LICENSE = 'Public domain';

const USAGE = `Usage:
  npm run basemap -- fetch [--states]
  npm run basemap -- world [--width 8192]
  npm run basemap -- crop <world> --bounds W,S,E,N [--width 2400] [--file maps/base.jpg]
  npm run basemap -- crop <world> --region <id> [--bounds W,S,E,N] [--width 2400]
  npm run basemap -- regions <world> [--from countries|states] [--pick "France, Italy"] [--within] [--parent <id>]
                     [--places capitals|cities] [--min-pop N] [--as pins|regions] [--labels "country, state, city"] [--tol 1.5] [--min-area 6] [--points] [--wiki]`;

export function parseArgs(argv) {
  const out = { cmd: argv[0], world: argv[1] && !argv[1].startsWith('--') ? argv[1] : null, flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (['within', 'wiki', 'states', 'points'].includes(k)) out.flags[k] = true;
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
// Natural Earth's short names abbreviate ("Dem. Rep. Congo"): the first of
// its names without a full stop; the short one stays an alternative for --pick.
export function countryFeatures(gj) {
  return gj.features.map((f) => {
    const p = f.properties;
    const name = [p.NAME, p.NAME_LONG, p.ADMIN, p.NAME_EN].find((x) => x && !x.includes('.')) || p.NAME || p.ADMIN;
    return { key: p.ADM0_A3, name, alt: [p.NAME].concat( [p.ADMIN, p.NAME_LONG, p.NAME_EN, p.ISO_A3_EH, p.ADM0_A3]).filter((x) => x && x !== '-99' && x !== name), wikidata: p.WIKIDATAID || null, title: p.NAME_EN || p.ADMIN, rings: ringsOf(f.geometry) };
  });
}
export function stateFeatures(gj) {
  return gj.features.map((f) => {
    const p = f.properties;
    return { key: p.adm1_code, name: p.name || p.name_en, alt: [p.name_en, p.gn_name, `${p.name}, ${p.admin}`].filter(Boolean), country: p.admin, countryKey: p.adm0_a3 || null, wikidata: p.wikidataid || null, title: p.name_en || p.name, rings: ringsOf(f.geometry) };
  });
}
// Populated places → points: capitals only, or every city on the map (with
// minPop, the cities of at least that many people, and every capital). The
// full file names its fields in capitals, the simple one in lower case.
export function placePoints(gj, which, minPop) {
  const v = (p, k) => (p[k.toUpperCase()] !== undefined ? p[k.toUpperCase()] : p[k]);
  return gj.features.map((f) => f.properties)
    .filter((p) => v(p, 'adm0cap') === 1 || (which === 'cities' && !(v(p, 'pop_max') < (minPop || 0))))
    .map((p) => Object.assign({ name: v(p, 'name_en') || v(p, 'nameascii') || v(p, 'name'), lon: v(p, 'longitude'), lat: v(p, 'latitude'), kind: v(p, 'adm0cap') === 1 ? 'capital' : 'city', key: v(p, 'adm0_a3') },
      v(p, 'wikidataid') ? { wikidata: v(p, 'wikidataid') } : {}));
}
// Wikipedia titles for Wikidata ids (English sitelinks), 50 at a time. Wikidata
// turns away quick runs of requests ("You are making too many requests"), so
// batches are spaced and a refusal waits and tries again. opts: { wait (ms) }.
export async function wikiTitles(ids, fetchFn, opts = {}) {
  const out = {};
  const list = [...new Set(ids.filter(Boolean))];
  const wait = opts.wait ?? 1000;
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
  for (let i = 0; i < list.length; i += 50) {
    if (i) await pause(wait);
    const q = new URLSearchParams({ action: 'wbgetentities', ids: list.slice(i, i + 50).join('|'), props: 'sitelinks', sitefilter: 'enwiki', format: 'json', maxlag: '5' });
    let j = null;
    for (let tries = 0; !j; tries++) {
      const res = await fetchFn(`https://www.wikidata.org/w/api.php?${q}`, { headers: { 'User-Agent': 'Ensemble-basemap/1 (build-time tool)' } });
      const text = await res.text();
      try { j = JSON.parse(text); } catch (e) { /* a refusal page, not JSON */ }
      if (j && j.error && j.error.code === 'maxlag') j = null;
      if (j) break;
      if (tries >= 5) throw new Error(`Wikidata keeps refusing (${res.status}): try --wiki again later, or leave it off`);
      await pause(wait * 5 * (tries + 1));
    }
    Object.entries(j.entities || {}).forEach(([id, e]) => { const t = e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title; if (t) out[id] = t; });
  }
  return out;
}

// ---------- the commands ----------
// Every map in a world: the world's, then each region's own.
const mapsOf = (world) => [world.map].concat((world.regions || []).map((r) => r.map)).filter(Boolean);
// The map a region's level is drawn on (R-3): its own projected map, else
// the nearest one up the chain, else the world's. null: the world's.
export function levelMap(E, world, id) {
  for (const x of id ? E.Scenario.regionChainIn(world.regions || [], id) : []) {
    const def = world.regions.find((r) => r.id === x);
    if (def && def.map && E.Geo.projected(def.map)) return def.map;
  }
  return world.map;
}
// Imported regions and places into world.json: new ones added, ones with the
// same id get the new outline (their other fields kept); neighbours set
// both ways among the imported. opts: { parents: {id: parent or null},
// label: for every region, mapFor(id): the map its outline goes on (default
// the world's) }. A region's outline is on one map only. → a summary line.
export function mergeIntoWorld(E, world, imp, places, opts = {}) {
  world.regions = world.regions || [];
  const mapFor = opts.mapFor || (() => world.map);
  const touched = new Set();
  imp.regions.forEach((r) => {
    let def = world.regions.find((x) => x.id === r.id);
    if (!def) { def = { id: r.id, name: r.name, controller: null, tags: [], status: '', neighbours: [], lore: '' }; world.regions.push(def); }
    def.key = r.key;
    if (r.wiki) def.wiki = r.wiki;
    if (opts.parents && r.id in opts.parents) { if (opts.parents[r.id]) def.parent = opts.parents[r.id]; else delete def.parent; }
    if (opts.label && !def.label) def.label = opts.label;
  });
  // Outlines after the parents are set, so each finds its level's map.
  imp.regions.forEach((r) => {
    mapsOf(world).forEach((m) => { if (m.regions) delete m.regions[r.id]; });
    const m = mapFor(r.id);
    m.regions = m.regions || {};
    m.regions[r.id] = imp.shapes[r.id];
    touched.add(m);
  });
  imp.neighbours.forEach(([a, b]) => {
    [[a, b], [b, a]].forEach(([x, y]) => { const d = world.regions.find((r) => r.id === x); if (d && !(d.neighbours || []).includes(y)) d.neighbours = (d.neighbours || []).concat(y); });
  });
  (places || []).forEach((p) => {
    const { map: m, ...pl } = p;
    mapsOf(world).forEach((x) => { if (Array.isArray(x.places)) x.places = x.places.filter((q) => q.id !== pl.id); });
    const on = m || world.map;
    on.places = (on.places || []).concat(pl);
    touched.add(on);
  });
  touched.forEach((m) => { m.credit = m.credit || CREDIT; m.license = m.license || LICENSE; });
  return `${imp.regions.length} regions, ${imp.neighbours.length} borders, ${(places || []).length} places${(imp.points || []).length ? `; as points: ${imp.points.join(', ')}` : ''}${imp.skipped.length ? `; too small or off the map: ${imp.skipped.join(', ')}` : ''}${imp.missing.length ? `; not found: ${imp.missing.join(', ')}` : ''}`;
}
// Moving outlines between crops and giving a region its own map are
// shared with the creator: E.MapEdit.reproject, regionBounds, cropRegion.
export const reproject = (E, oldMap, newMap) => E.MapEdit.reproject(oldMap, newMap);
export const regionBounds = (E, world, id, margin) => E.MapEdit.regionBounds(world, id, margin);
export const cropRegion = (E, world, id, newMap) => E.MapEdit.cropRegion(world, id, newMap);
// Places onto the tree: each point goes to the imported region whose source
// outline holds it, else the region with its key; drawn on that region's
// level map. As pins (map places), or as regions under their holder.
function treePlaces(E, world, points, imp, known, taken, asRegions) {
  const G = E.Geo;
  const used = new Set(taken);
  const pins = [], regions = [];
  points.forEach((p) => {
    // A city-state's city (Singapore in Singapore) is the region itself.
    if (asRegions && p.wikidata && imp.regions.concat(known).some((r) => r.wiki && r.wiki.wikidata === p.wikidata)) return;
    // Its country, when this import is of countries (the source says which, as
    // the outlines don't always: Jerusalem, Nicosia); else the smallest outline
    // that holds it, as outer rings take in enclaves (Italy's holds San Marino).
    const size = (id) => imp.lonlat[id].reduce((t, r) => t + G.area(r), 0);
    const holders = imp.regions.filter((r) => imp.lonlat[r.id] && G.insideAny([p.lon, p.lat], imp.lonlat[r.id])).sort((a, b) => size(a.id) - size(b.id));
    const holder = (p.key && imp.regions.find((r) => r.key === p.key)) || holders[0] || (p.key && known.find((r) => r.key === p.key));
    if (!holder) return;
    const map = levelMap(E, world, holder.id);
    const at = G.toPixel(map, [p.lon, p.lat]).map(Math.round);
    if (at[0] < 0 || at[1] < 0 || at[0] > map.width || at[1] > map.height) return;
    const key = `place:${G.slug(p.name)}@${p.lon.toFixed(2)},${p.lat.toFixed(2)}`;
    const again = asRegions && (world.regions || []).find((r) => r.key === key);
    let id = again ? again.id : G.slug(p.name);
    if (!again) { for (let n = 2; used.has(id); n++) id = `${G.slug(p.name)}-${n}`; used.add(id); }
    if (asRegions) regions.push(Object.assign({ id, key, name: p.name, parent: holder.id, map, at, capital: p.kind === 'capital' }, p.wikidata ? { wiki: { title: p.name, wikidata: p.wikidata } } : {}));
    else pins.push({ id, name: p.name, kind: p.kind || 'city', at, region: holder.id, map });
  });
  return { pins, regions };
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
    const def = flags.region ? (w.regions || []).find((r) => r.id === flags.region) : null;
    if (flags.region && !def) throw new Error(`No region "${flags.region}" in this world.`);
    const bounds = flags.bounds ? String(flags.bounds).split(',').map(Number) : def ? regionBounds(E, w, def.id) : [];
    if (def && !bounds) throw new Error(`${def.name} has no outline on a projected map yet: give --bounds W,S,E,N.`);
    const probe = { projection: 'equirectangular', bounds };
    const p = E.Geo.projectionProblems(probe);
    if (p.length) throw new Error(`${p.join('; ')} (for example --bounds -11,35,30,60 for western Europe)`);
    const width = Number(flags.width) || 2400;
    const src = io.raster || loadRaster(dir);
    const img = cut(src, bounds, width);
    const file = flags.file || (def ? `maps/${def.id}.jpg` : 'maps/base.jpg');
    writeJpeg(path.join(wdir, file), img.rgba, img.width, img.height, Number(flags.quality) || 85);
    // base: the shared map it matches (cut from the same picture's source), so
    // the creator can cut it again from library/maps/world/ if the image is missing.
    let map = { image: file, width: img.width, height: img.height, projection: 'equirectangular', bounds, base: 'world', regions: {}, credit: CREDIT, license: LICENSE };
    if (def) {
      const n = cropRegion(E, w, def.id, map);
      writeJSON(wfile, w);
      log(`✓ ${path.relative(root, path.join(wdir, file))} (${img.width} × ${img.height}); ${def.name}'s own map, with ${n.moved} regions and ${n.places} places inside it moved onto it`);
      return;
    }
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
    const features = from === 'states' ? stateFeatures(gj) : countryFeatures(gj);
    w.regions = w.regions || [];
    if (flags.parent && !w.regions.some((r) => r.id === flags.parent)) throw new Error(`No region "${flags.parent}" to put them under.`);
    if (flags.labels) w.regionLabels = String(flags.labels).split(',').map((s) => s.trim()).filter(Boolean);
    const taken = [].concat(w.regions.map((r) => r.id), (w.locations || []).map((l) => l.id));
    const pick = flags.pick ? String(flags.pick).split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (!pick && !flags.within) throw new Error('Say which: --pick "France, Italy" or --within (everything on the map).');
    // Which features: picked by name, or everything on the world map.
    const sel = E.Geo.pickFeatures(w.map, features, { pick, within: !!flags.within });
    const chosen = sel.chosen;
    // Each one's parent (R-9): --parent, else the country region with the
    // state's country key; countries (and states with no such region) at the top.
    const byCountry = new Map(w.regions.filter((r) => r.key).map((r) => [r.key, r.id]));
    const parentOf = (f) => flags.parent || (from === 'states' && f.countryKey && byCountry.get(f.countryKey)) || null;
    const orphans = from === 'states' && !flags.parent ? [...new Set(chosen.filter((f) => !parentOf(f)).map((f) => f.country).filter(Boolean))] : [];
    // Fitted to the map of their parent's level, a group per map.
    const byKey = new Map(w.regions.filter((r) => r.key).map((r) => [r.key, r.id]));
    const groups = new Map();
    chosen.forEach((f) => { const m = levelMap(E, w, parentOf(f)); if (!groups.has(m)) groups.set(m, []); groups.get(m).push(f); });
    const imp = { regions: [], shapes: {}, neighbours: [], skipped: [], points: [], missing: sel.missing, lonlat: {} };
    const used = taken.filter((id) => ![...byKey.values()].includes(id));
    groups.forEach((list, m) => {
      const g = E.Geo.importRegions(m, list, { within: true, taken: used.concat(imp.regions.map((r) => r.id)), tol: Number(flags.tol) || 1.5, minArea: Number(flags['min-area']) || 6, points: !!flags.points });
      imp.regions.push(...g.regions); Object.assign(imp.shapes, g.shapes); Object.assign(imp.lonlat, g.lonlat); imp.skipped.push(...g.skipped); imp.points.push(...g.points);
    });
    // Regions already imported keep their ids (the same key replaces the outline).
    imp.regions.forEach((r) => {
      const old = byKey.get(r.key);
      if (old && old !== r.id) { imp.shapes[old] = imp.shapes[r.id]; delete imp.shapes[r.id]; imp.lonlat[old] = imp.lonlat[r.id]; delete imp.lonlat[r.id]; r.id = old; }
    });
    // Borders from the source outlines, across groups and with regions
    // imported before from the same source (a second country's states).
    const before = {};
    features.filter((f) => byKey.has(f.key) && !imp.regions.some((r) => r.key === f.key)).forEach((f) => { before[byKey.get(f.key)] = f.rings; });
    imp.neighbours = E.Geo.neighbours(Object.assign({}, before, imp.lonlat), 0.02).filter(([a, b]) => imp.lonlat[a] || imp.lonlat[b]);
    if (flags.wiki) {
      const titles = await wikiTitles(imp.regions.map((r) => r.wiki && r.wiki.wikidata), io.fetch || fetch);
      imp.regions.forEach((r) => { if (r.wiki && titles[r.wiki.wikidata]) r.wiki.title = titles[r.wiki.wikidata]; });
    }
    const parents = {};
    const keyOf = new Map(chosen.map((f) => [f.key, f]));
    imp.regions.forEach((r) => { parents[r.id] = parentOf(keyOf.get(r.key)); });
    const summary = mergeIntoWorld(E, w, imp, [], { parents, mapFor: (id) => levelMap(E, w, (w.regions.find((r) => r.id === id) || {}).parent) });
    // Cities and capitals: pins in the region that holds them, or (--as
    // regions) regions under it, a point on its level's map.
    let placed = '';
    if (flags.places) {
      const pf = [SOURCES.places.file, SOURCES.places.older].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
      if (!io.geojson && !pf) throw new Error('No places yet: run "npm run basemap -- fetch" first.');
      if (!io.geojson && pf.endsWith(SOURCES.places.older)) log('! the older places file has no Wikipedia pages: run "npm run basemap -- fetch" again for the full one');
      const pg = io.geojson ? io.geojson.places : readJSON(pf);
      const known = imp.regions.concat(w.regions.filter((r) => r.key && !imp.regions.some((x) => x.id === r.id)));
      const pts = placePoints(pg, flags.places, Number(flags['min-pop']) || 0);
      const asRegions = flags.as === 'regions';
      const t = treePlaces(E, w, pts, imp, known, taken.concat(imp.regions.map((r) => r.id), ...mapsOf(w).map((m) => (m.places || []).map((p) => p.id))), asRegions);
      if (asRegions && flags.wiki) {
        const titles = await wikiTitles(t.regions.map((c) => c.wiki && c.wiki.wikidata), io.fetch || fetch);
        t.regions.forEach((c) => { if (c.wiki && titles[c.wiki.wikidata]) c.wiki.title = titles[c.wiki.wikidata]; });
      }
      if (asRegions) {
        t.regions.forEach((c) => {
          let def = w.regions.find((r) => r.id === c.id);
          if (!def) { def = { id: c.id, name: c.name, controller: null, tags: [], status: '', neighbours: [], lore: '' }; w.regions.push(def); }
          Object.assign(def, { key: c.key, parent: c.parent }, c.wiki ? { wiki: c.wiki } : {});
          if (!def.label) def.label = 'city';
          if (c.capital && !def.tags.includes('capital')) def.tags = def.tags.concat('capital');
          mapsOf(w).forEach((m) => { if (m.regions) delete m.regions[c.id]; if (Array.isArray(m.places)) m.places = m.places.filter((p) => p.id !== c.id); });
          c.map.regions = c.map.regions || {};
          c.map.regions[c.id] = { point: c.at };
        });
        placed = `, ${t.regions.length} cities as regions`;
      } else {
        mergeIntoWorld(E, w, { regions: [], neighbours: [], skipped: [], missing: [] }, t.pins);
        placed = `, ${t.pins.length} places`;
      }
    }
    log(`✓ ${summary.replace(/, 0 places/, placed)}`);
    if (orphans.length) log(`! no region for ${orphans.join(', ')}: their states are at the top level (import the country first, or use --parent)`);
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
