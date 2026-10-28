// Real places on a shared base map (task 4-5): projection between latitude/
// longitude and map pixels, simplifying and clipping outlines, labels inside
// their biggest piece, neighbours from shared borders, regions in several
// pieces, named places, the prompt budget for a world of countries, and the
// base map tool end to end on small made-up data (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEngine, worldFiles, ROOT } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const E = loadEngine();
const G = E.Geo;
const FIX = path.join(__dirname, 'fixtures', 'geo');
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
// A map of the fixture's corner of the world: 40° × 25° at 20 px a degree.
const MAP = { image: 'maps/base.jpg', width: 800, height: 500, projection: 'equirectangular', bounds: [-10, -10, 30, 15] };

// ---------- projection ----------

test('latitude and longitude land on the map and come back', () => {
  assert.deepEqual(plain(G.toPixel(MAP, [-10, 15])), [0, 0], 'the top-left corner');
  assert.deepEqual(plain(G.toPixel(MAP, [30, -10])), [800, 500]);
  assert.deepEqual(plain(G.toPixel(MAP, [5, 5])), [300, 200]);
  assert.deepEqual(plain(G.toLonLat(MAP, [300, 200])), [5, 5]);
  assert.equal(G.fmtLonLat([4.84, 45.76]), '45.76° N, 4.84° E');
  assert.equal(G.fmtLonLat([-73.94, -40.5]), '40.50° S, 73.94° W');
  assert.deepEqual(plain(G.projectionProblems({})), [], 'no projection: nothing to check');
  assert.match(G.projectionProblems({ projection: 'mercator', bounds: [0, 0, 1, 1] })[0], /"projection" must be equirectangular/);
  assert.match(G.projectionProblems({ projection: 'equirectangular', bounds: [10, 0, 5, 1] })[0], /west < east/);
});

// ---------- outlines ----------

test('simplifying keeps the corners that matter, and a ring too small collapses', () => {
  const wiggly = [[0, 0], [50, 0.4], [100, 0], [100, 50], [100.3, 75], [100, 100], [0, 100]];
  assert.deepEqual(plain(G.simplify(wiggly, 1)), [[0, 0], [100, 0], [100, 100], [0, 100]]);
  assert.equal(G.simplify([[0, 0], [50, 0.1], [100, 0], [50, -0.1]], 5), null, 'a sliver collapses below 3 corners');
  assert.deepEqual(plain(G.simplify([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], 0)), [[0, 0], [10, 0], [10, 10], [0, 10]], 'a closing point is dropped');
});

test('clipping cuts an outline at the edge of the map', () => {
  const c = G.clip([[-50, 10], [50, 10], [50, 60], [-50, 60]], [0, 0, 100, 100]);
  assert.deepEqual(plain(c).map((p) => p.map(Math.round)).sort(), [[0, 10], [0, 60], [50, 10], [50, 60]].sort());
  assert.equal(G.clip([[200, 200], [300, 200], [300, 300]], [0, 0, 100, 100]), null, 'all off the map');
});

test('a label goes inside the biggest piece, even when its middle is outside it', () => {
  const big = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.deepEqual(plain(G.anchor([[[300, 300], [305, 300], [305, 305]], big])), [50, 50]);
  const ell = [[0, 0], [100, 0], [100, 20], [20, 20], [20, 100], [0, 100]];
  const a = G.anchor([ell]);
  assert.ok(G.inside(a, ell), `inside the L: ${a}`);
});

test('neighbours come from shared borders, not from being close', () => {
  const shapes = {
    a: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
    b: [[[10, 0], [20, 0], [20, 10], [10, 10]]],
    c: [[[0, 10], [20, 10], [20, 15], [0, 15]]],
    d: [[[30, 0], [40, 0], [40, 10], [30, 10]]],
  };
  assert.deepEqual(plain(G.neighbours(shapes, 0.01)), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
});

// ---------- importing ----------

const fixtureFeatures = () => readFix('countries.geojson').features.map((f) => {
  const p = f.properties;
  const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((x) => x[0]);
  return { key: p.ADM0_A3, name: p.NAME, alt: [p.ADMIN, p.ISO_A3_EH], wikidata: p.WIKIDATAID, title: p.NAME_EN, rings };
});

test('countries on the map become regions: pieces, neighbours, Wikipedia links; the rest are left out', () => {
  const imp = G.importRegions(MAP, fixtureFeatures(), { within: true, taken: ['borovia'] });
  assert.deepEqual(plain(imp.regions.map((r) => r.id)), ['alandia', 'borovia-2', 'castellane'], 'Dunmere is off the map; ids clash with nothing');
  assert.deepEqual(plain(imp.regions[0].wiki), { title: 'Alandia', wikidata: 'Q900001' });
  const al = imp.shapes.alandia;
  assert.equal(al.polygons.length, 2, 'the mainland and the southern island; the far territory is off the map');
  assert.deepEqual(plain(al.polygons[0]), [[200, 300], [400, 300], [400, 100], [200, 100]]);
  assert.ok(imp.shapes['borovia-2'].polygon, 'one piece: a plain polygon');
  assert.deepEqual(plain(imp.neighbours), [['alandia', 'borovia-2'], ['alandia', 'castellane'], ['borovia-2', 'castellane']]);
});

test('picking by name, other names or code; a name not found is reported', () => {
  const imp = G.importRegions(MAP, fixtureFeatures(), { pick: ['republic of alandia', 'CAS', 'Atlantis'] });
  assert.deepEqual(plain(imp.regions.map((r) => r.name)), ['Alandia', 'Castellane']);
  assert.deepEqual(plain(imp.missing), ['atlantis']);
});

test('places land in their country by code, or by the shape that holds them; off-map ones are left out', () => {
  const imp = G.importRegions(MAP, fixtureFeatures(), { within: true });
  const pts = readFix('places.geojson').features.map((f) => ({ name: f.properties.name, lon: f.properties.longitude, lat: f.properties.latitude, kind: f.properties.adm0cap ? 'capital' : 'city', key: f.properties.adm0_a3 }));
  pts[2].key = null;
  const places = G.importPlaces(MAP, pts, imp.regions, imp.shapes, []);
  assert.deepEqual(plain(places), [
    { id: 'alton', name: 'Alton', kind: 'capital', at: [300, 200], region: 'alandia' },
    { id: 'bree', name: 'Bree', kind: 'capital', at: [500, 200], region: 'borovia' },
    { id: 'port-cass', name: 'Port Cass', kind: 'city', at: [260, 60], region: 'castellane' },
  ]);
});

// ---------- the engine ----------

function worldOn(map, regions, extra) {
  const files = worldFiles('mars-station');
  const w = files['world.json'];
  w.map = Object.assign({}, map);
  w.regions = regions;
  Object.assign(w, extra || {});
  Object.values(files).forEach((f) => { if (f && f.id && f.start) f.region = regions[0].id; });
  ['starts/recycler.json', 'starts/garage.json'].forEach((p) => { files[p].region = regions[0].id; });
  (w.locations || []).forEach((l) => delete l.region);
  (w.lore || []).forEach((e) => { if (e.level === 'region') { e.level = 'topic'; delete e.ref; } });
  (w.timeline || []).forEach((e) => { delete e.region; e.scope = 'world'; delete e.preconditions; delete e.effects; });
  (w.eventSeeds && w.eventSeeds.regional ? w.eventSeeds.regional : []).forEach((s, i, list) => { if (s && s.region) list[i] = s.text; });
  return files;
}

test('a region in several pieces loads, is drawn as one shape and is found by a click on any piece', () => {
  const imp = G.importRegions(MAP, fixtureFeatures(), { within: true });
  const regions = imp.regions.map((r) => ({ id: r.id, name: r.name, controller: null, tags: [], status: '', neighbours: [], lore: '' }));
  const files = worldOn(Object.assign({}, MAP, { regions: imp.shapes }), regions);
  const loaded = E.Scenario.prepareWorld('mars-station', plain(files));
  loaded.starts.forEach((s) => assert.equal(s.error, undefined, s.error));
  const sc = loaded.starts[0].scenario;
  const g = E.MapDraw.geometry(sc.regions, sc.map, 'x');
  const svg = E.MapDraw.worldSvg({ g, regions: sc.regions, imageUrl: 'x.jpg' });
  assert.match(svg, /data-region="alandia"[^>]*><path class="region-shape[^"]*" d="M200,300L400,300L400,100L200,100ZM/, 'two pieces in one path');
  assert.match(svg, /data-region="castellane"[^>]*><polygon/, 'one piece stays a polygon');
  assert.equal(E.MapEdit.regionAt(sc.map, [260, 440]), 'alandia', 'the island');
  assert.deepEqual(plain(g.anchors.alandia), [300, 200], 'the label on the mainland');
  const bad = plain(files);
  bad['world.json'].map.regions.alandia = { polygons: [[[0, 0], [1, 1]]] };
  assert.match(E.Scenario.prepareWorld('mars-station', bad).starts[0].error, /"polygons" must be a list of pieces, each of at least 3 points/);
});

test('named places are checked, drawn as dots, and listed with their region in the prompt', () => {
  const imp = G.importRegions(MAP, fixtureFeatures(), { within: true });
  const regions = imp.regions.map((r) => ({ id: r.id, name: r.name, controller: null, tags: [], status: '', neighbours: [], lore: '' }));
  const places = [{ id: 'alton', name: 'Alton', kind: 'capital', at: [300, 200], region: 'alandia' }, { id: 'port-cass', name: 'Port Cass', kind: 'city', at: [260, 60], region: 'castellane', notable: true }];
  const files = worldOn(Object.assign({}, MAP, { regions: imp.shapes, places }), regions);
  const sc = E.Scenario.prepareWorld('mars-station', plain(files)).starts[0].scenario;
  const state = E.Engine.newGame(E.Scenario.startScenario({ starts: [{ id: 'x', scenario: sc }], defaultStart: 'x' }));
  assert.match(E.Prompts.header(state), /- alandia: Alandia[^\n]*\[places: Alton \(capital\)\]/);
  const svg = E.MapDraw.worldSvg({ g: E.MapDraw.geometry(sc.regions, sc.map, 'x'), regions: sc.regions, places: E.MapDraw.placesOf(sc.map) });
  assert.match(svg, /<rect class="region-place capital"/);
  assert.match(svg, /Port Cass<\/text>/, 'a notable place is named even zoomed out');
  assert.ok(!/>Alton<\/text>/.test(svg), 'others only when zoomed in');
  const bad = plain(files);
  bad['world.json'].map.places.push({ id: 'alandia', name: 'X', at: [900, 0], region: 'nowhere', kind: 'village' });
  const err = (() => { try { E.Scenario.prepareWorld('mars-station', bad); } catch (e) { return e.message; } })() || E.Scenario.prepareWorld('mars-station', bad).starts[0].error;
  assert.match(err, /place "alandia": id is already a region or a room[\s\S]*"kind" must be one of capital, city, town, place[\s\S]*"at" must be a point inside the image[\s\S]*unknown region "nowhere"/);
});

test('a world of countries keeps the prompt small: full detail near the start, names for the rest', () => {
  const regions = [];
  for (let i = 0; i < 60; i++) regions.push({ id: `r${i}`, name: `Land ${i}`, controller: null, tags: [], status: '', neighbours: [i > 0 ? `r${i - 1}` : null, i < 59 ? `r${i + 1}` : null].filter(Boolean), lore: `Lore of land ${i}.` });
  regions[40].notable = true;
  const sc = { region: 'r10', regions };
  // Standard sizes (16K); a compact context (8K, task G-4) shows fewer.
  E.settings.backends.local.context = 16384;
  const f = E.Prompts.regionOutline(sc);
  assert.deepEqual(plain(f.full.map((r) => r.id)), ['r8', 'r9', 'r10', 'r11', 'r12', 'r40'], 'two steps out, and the notable one');
  assert.deepEqual(plain(f.far.slice(0, 4).map((r) => r.id)), ['r13', 'r7', 'r14', 'r6'], 'nearest first, then by name');
  assert.equal(f.far.length, 54);
  const small = { region: 'r0', regions: regions.slice(0, 10) };
  assert.equal(E.Prompts.regionOutline(small).full.length, 10, 'a small world is shown whole, as before');
  E.settings.backends.local.context = 8192;
  const c = E.Prompts.regionOutline(sc);
  assert.deepEqual(plain(c.full.map((r) => r.id)), ['r8', 'r9', 'r10', 'r11', 'r12', 'r40'], 'compact: the same near ones, up to 12');
  assert.equal(c.far.length, 20, 'compact: 20 names');
  assert.equal(E.Prompts.regionOutline(small).full.length, 10, 'still whole under 12');
});

// ---------- the tool ----------

test('the tool: crop a world from the source, add the countries and capitals, and it loads', async () => {
  const { main, readTiff, cut, unzipFile } = await import('../tools/basemap.mjs');
  // A 360 × 180 raster, one pixel a degree, coloured by longitude.
  const raster = { width: 360, height: 180, data: Buffer.alloc(360 * 180 * 3) };
  for (let y = 0; y < 180; y++) for (let x = 0; x < 360; x++) raster.data[(y * 360 + x) * 3] = x % 256;
  const c = cut(raster, [0, 0, 10, 10], 20);
  assert.equal(c.height, 20, 'height from the bounds');
  assert.equal(c.rgba[0], 180, 'the crop starts at 0° E');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basemap-'));
  const b = E.WorldEdit.blankWorld('Fixture lands');
  Object.entries(b.files).forEach(([p, j]) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), JSON.stringify(j)); });
  const logs = [];
  const io = { E: loadEngine(), raster, log: (m) => logs.push(m), geojson: { countries: readFix('countries.geojson'), places: readFix('places.geojson') } };
  await main(['crop', dir, '--bounds', '-10,-10,30,15', '--width', '800'], io);
  let w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.deepEqual(plain(w.map.bounds), [-10, -10, 30, 15]);
  assert.equal(w.map.height, 500);
  assert.ok(fs.statSync(path.join(dir, 'maps', 'base.jpg')).size > 100);
  await assert.rejects(main(['regions', dir], io), /--pick "France, Italy" or --within/);
  await main(['regions', dir, '--within', '--places', 'capitals'], io);
  w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.deepEqual(w.regions.map((r) => r.id), ['alandia', 'borovia', 'castellane']);
  assert.deepEqual(w.regions[0].neighbours, ['borovia', 'castellane']);
  assert.equal(w.regions[0].key, 'ALA', 'the source id, so importing again updates it');
  assert.deepEqual(w.map.places.map((p) => p.id), ['alton', 'bree'], 'capitals on the map');
  assert.match(w.map.credit, /Natural Earth/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'starts', 'start.json'), 'utf8')).region, 'alandia');
  assert.ok(logs.some((l) => /3 regions, 3 borders, 2 places/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /start "start" had no region/.test(l)));
  assert.ok(!logs.some((l) => /^!.*problems/.test(l)), 'the world loads');
  // Importing again keeps the regions' own edits and ids.
  w.regions[0].controller = null;
  w.regions[0].name = 'Alandia (as the author calls it)';
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(w));
  await main(['regions', dir, '--pick', 'Alandia'], io);
  w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.equal(w.regions.length, 3);
  assert.equal(w.regions[0].name, 'Alandia (as the author calls it)');
  // A new crop moves the regions onto the new picture.
  await main(['crop', dir, '--bounds', '0,0,20,15', '--width', '400'], io);
  w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.deepEqual(w.map.regions.alandia.polygon, [[0, 300], [200, 300], [200, 100], [0, 100]], 'the island is off the new crop');
  assert.deepEqual(w.map.places.find((p) => p.id === 'alton').at, [100, 200]);
  // The zip and TIFF readers, on tiny files made here.
  const zlib = require('zlib');
  const body = Buffer.from('hello');
  const deflated = zlib.deflateRawSync(body);
  const name = Buffer.from('dir/a.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdStart = local.length + name.length + deflated.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(cdStart, 16);
  assert.equal(unzipFile(Buffer.concat([local, name, deflated, central, name, end]), 'a.txt').toString(), 'hello');
  const tif = Buffer.alloc(8 + 2 + 6 * 12 + 4 + 12);
  tif.write('II', 0, 'latin1'); tif.writeUInt16LE(42, 2); tif.writeUInt32LE(8, 4); tif.writeUInt16LE(6, 8);
  [[256, 3, 2], [257, 3, 2], [259, 3, 1], [273, 4, 8 + 2 + 72 + 4], [277, 3, 3], [279, 4, 12]].forEach(([tag, type, v], i) => {
    const e = 10 + i * 12; tif.writeUInt16LE(tag, e); tif.writeUInt16LE(type, e + 2); tif.writeUInt32LE(1, e + 4); if (type === 3) tif.writeUInt16LE(v, e + 8); else tif.writeUInt32LE(v, e + 8);
  });
  for (let k = 0; k < 12; k++) tif[86 + k] = k * 10;
  const t = readTiff(tif);
  assert.deepEqual([t.width, t.height, t.data[11]], [2, 2, 110]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shared base map is in the library, and its picture is where it says', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'library', 'maps', 'world', 'map.json'), 'utf8'));
  assert.deepEqual(plain(G.projectionProblems(m)), []);
  assert.deepEqual(m.bounds, [-180, -90, 180, 90]);
  assert.equal(m.width, 2 * m.height);
  assert.ok(fs.existsSync(path.join(ROOT, 'library', 'maps', 'world', m.image)));
  assert.match(m.credit, /Natural Earth/);
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'library', 'index.json'), 'utf8'));
  assert.ok(idx.maps.some((x) => x.id === 'world'));
});
