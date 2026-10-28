// The world today: the base template for modern-day worlds, every country
// and major city as a region with its Wikipedia page, for the research helper
// to fill. And what the base map tool does to build it, on made-up data: tiny
// countries kept as points, cities by size, a city-state's city not twice,
// each city in its own country, names without the source's abbreviations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEngine, readWorld } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));

test('the world today has every country and its major cities as regions, each with a page for the research helper', () => {
  const E = loadEngine();
  const loaded = readWorld('modern-earth');
  const w = loaded.bundle.world;
  const byId = new Map(w.regions.map((r) => [r.id, r]));
  const countries = w.regions.filter((r) => !r.parent), cities = w.regions.filter((r) => r.parent);
  assert.deepEqual(plain(w.regionLabels), ['country', 'city']);
  assert.ok(countries.length >= 240 && cities.length >= 400, `${countries.length} countries, ${cities.length} cities`);
  cities.forEach((c) => assert.ok(!byId.get(c.parent).parent, `${c.name} is directly under a country`));
  // Enclaves and small states: in their own country, on the map as a point if need be.
  assert.equal(byId.get('maseru').parent, 'lesotho');
  assert.equal(byId.get('paris').parent, 'france');
  assert.ok(byId.get('paris').tags.includes('capital'));
  assert.ok(w.map.regions.monaco.point, 'Monaco is too small to outline');
  assert.ok(!cities.some((c) => c.parent === 'singapore'), 'a city-state is one region');
  assert.ok(!countries.some((r) => r.name.includes('.')), 'no abbreviated country names');
  // No lore yet: that's the research helper's job, from each region's page.
  assert.ok(w.regions.every((r) => !r.lore && r.wiki && r.wiki.title && r.wiki.wikidata));
  const topics = E.Research.topics(loaded);
  assert.equal(topics.filter((t) => t.level === 'region' && t.page).length, w.regions.length);
  // Open: no starts, so the player makes one anywhere, and the header stays small.
  assert.ok(!(w.starts || []).length && !loaded.errors);
  assert.ok(E.Prompts.genHeader(E.StartGen.contextScenario(loaded, 'lyon'), []).length < 4000);
});

test('one picture for a deep tree: the world map shows the countries, and a country its own cities', () => {
  const E = loadEngine();
  const w = readWorld('modern-earth').bundle.world;
  const sc = { regions: w.regions, map: w.map, worldId: 'modern-earth' };
  const ids = (lv) => lv.regions.map((r) => r.id);
  const world = E.MapDraw.level(sc, null);
  assert.ok(ids(world).includes('france') && !ids(world).includes('paris'), 'cities wait for their country');
  assert.equal(world.children.length, w.regions.filter((r) => !r.parent).length);
  const france = E.MapDraw.level(sc, 'france');
  assert.ok(['paris', 'lyon', 'germany'].every((id) => ids(france).includes(id)) && !ids(france).includes('berlin'), "France's cities, not Germany's");
  assert.deepEqual(plain(france.children).sort(), ['lille', 'lyon', 'marseille', 'paris']);
  const lyon = E.MapDraw.level(sc, 'lyon');
  assert.ok(lyon.leaf && ids(lyon).includes('paris'), "a city shows its country's level");
});

// A square ring, west/south corner and size in degrees.
const square = (w, s, d) => [[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]];
const country = (props, ring) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });
const place = (p) => ({ type: 'Feature', properties: Object.assign({ ADM0CAP: 0, POP_MAX: 0 }, p), geometry: { type: 'Point', coordinates: [p.LONGITUDE, p.LATITUDE] } });
const COUNTRIES = { type: 'FeatureCollection', features: [
  // Big Republic takes in Dot (an enclave: its outer ring covers it).
  country({ ADM0_A3: 'BIG', NAME: 'Big Rep.', NAME_LONG: 'Big Republic', ADMIN: 'Big Republic', WIKIDATAID: 'Q1' }, square(0, 0, 10)),
  country({ ADM0_A3: 'DOT', NAME: 'Dot', ADMIN: 'Dot', WIKIDATAID: 'Q2' }, square(4, 4, 1)),
  country({ ADM0_A3: 'ISL', NAME: 'Isle', ADMIN: 'Isle', WIKIDATAID: 'Q3' }, square(15, 5, 0.05)),
] };
const PLACES = { type: 'FeatureCollection', features: [
  place({ NAME: 'Bigtown', ADM0_A3: 'BIG', POP_MAX: 2000000, WIKIDATAID: 'Q10', LONGITUDE: 2, LATITUDE: 2 }),
  place({ NAME: 'Smallville', ADM0_A3: 'BIG', POP_MAX: 50000, WIKIDATAID: 'Q11', LONGITUDE: 8, LATITUDE: 8 }),
  place({ NAME: 'Capitol', ADM0_A3: 'BIG', ADM0CAP: 1, POP_MAX: 90000, WIKIDATAID: 'Q12', LONGITUDE: 7, LATITUDE: 2 }),
  // The source places it in Big Republic though Dot's outline holds it.
  place({ NAME: 'Edge', ADM0_A3: 'BIG', POP_MAX: 1500000, WIKIDATAID: 'Q13', LONGITUDE: 4.5, LATITUDE: 4.2 }),
  place({ NAME: 'Dotford', ADM0_A3: 'DOT', POP_MAX: 1200000, WIKIDATAID: 'Q14', LONGITUDE: 4.8, LATITUDE: 4.8 }),
  // Dot's capital is Dot itself (the same Wikidata item): one region.
  place({ NAME: 'Dot', ADM0_A3: 'DOT', ADM0CAP: 1, POP_MAX: 30000, WIKIDATAID: 'Q2', LONGITUDE: 4.5, LATITUDE: 4.5 }),
] };

test('the base map tool keeps tiny countries as points, takes cities by size into their own country, and names them in full', async () => {
  const { main } = await import('../tools/basemap.mjs');
  const E = loadEngine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modernearth-'));
  try {
    const b = E.WorldEdit.blankWorld('Made-up lands');
    Object.entries(b.files).forEach(([p, j]) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), JSON.stringify(j)); });
    const logs = [];
    const io = { E, raster: { width: 360, height: 180, data: Buffer.alloc(360 * 180 * 3, 90) }, log: (m) => logs.push(m), geojson: { countries: COUNTRIES, places: PLACES } };
    await main(['crop', dir, '--bounds', '-5,-5,25,15', '--width', '600'], io);
    await main(['regions', dir, '--pick', 'Big. Rep., Dot, Isle'], io);
    let w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
    assert.ok(!w.regions.some((r) => r.id === 'isle'), 'too small to outline: left out by default');
    assert.ok(logs.some((l) => /too small or off the map: Isle/.test(l)), logs.join('\n'));
    await main(['regions', dir, '--within', '--points', '--places', 'cities', '--min-pop', '1000000', '--as', 'regions'], io);
    w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
    const def = (id) => w.regions.find((r) => r.id === id);
    assert.equal(def('big-republic').name, 'Big Republic', 'the first name without a full stop');
    assert.ok(w.map.regions.isle.point, 'with --points, a point instead');
    assert.ok(logs.some((l) => /as points: Isle/.test(l)), logs.join('\n'));
    // A million or more, and every capital; each with its page.
    const cities = w.regions.filter((r) => r.parent).map((r) => `${r.id}<${r.parent}`).sort();
    assert.deepEqual(cities, ['bigtown<big-republic', 'capitol<big-republic', 'dotford<dot', 'edge<big-republic']);
    assert.deepEqual(plain(def('bigtown').wiki), { title: 'Bigtown', wikidata: 'Q10' });
    assert.ok(def('capitol').tags.includes('capital'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
