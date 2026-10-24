// Real places as a tree (R-9): the base map tool puts states under their
// country and cities in the state that holds them (as pins, or as regions
// under it), gives a region its own sharper map with what's inside it moved
// there, and writes shared borders as neighbours (border routes in play),
// across countries too. On small made-up data: no network, no real map.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEngine, readWorld, mockLLM } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const FIX = path.join(__dirname, 'fixtures', 'geo');
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
// A 360 × 180 raster, one pixel a degree.
const RASTER = { width: 360, height: 180, data: Buffer.alloc(360 * 180 * 3, 90) };

// A blank world in a temporary folder, on a crop of the fixture's corner
// of the world, with the three countries imported.
async function landsWorld() {
  const { main } = await import('../tools/basemap.mjs');
  const E = loadEngine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realtree-'));
  const b = E.WorldEdit.blankWorld('Fixture lands');
  Object.entries(b.files).forEach(([p, j]) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), JSON.stringify(j)); });
  const logs = [];
  const io = { E, raster: RASTER, log: (m) => logs.push(m), geojson: { countries: readFix('countries.geojson'), states: readFix('states.geojson'), places: readFix('cities.geojson') } };
  const run = (...args) => main(args, io);
  await run('crop', dir, '--bounds', '-10,-10,30,15', '--width', '800');
  await run('regions', dir, '--within', '--labels', 'country, state, city');
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  const write = (w) => fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(w));
  return { E, dir, run, read, write, logs, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const def = (w, id) => w.regions.find((r) => r.id === id);
const has = (w, a, b) => def(w, a).neighbours.includes(b) && def(w, b).neighbours.includes(a);

test('states go under their country, on its own map when it has one, with borders as neighbours across countries', async () => {
  const t = await landsWorld();
  // Alandia gets its own map first: the default bounds are its outline plus a margin.
  await t.run('crop', t.dir, '--region', 'alandia', '--width', '400');
  let w = t.read();
  assert.ok(fs.statSync(path.join(t.dir, 'maps', 'alandia.jpg')).size > 100);
  assert.equal(def(w, 'alandia').map.image, 'maps/alandia.jpg');
  assert.ok(t.E.Geo.projected(def(w, 'alandia').map));
  assert.equal(def(w, 'alandia').map.base, 'world', 'the crops say which base map they match, so the creator can cut them again');
  assert.equal(w.map.base, 'world');
  assert.equal(t.E.MapEdit.baseOf(w), 'world');
  assert.ok(w.map.regions.alandia, 'its own outline stays on the world map');
  await t.run('regions', t.dir, '--from', 'states', '--within', '--places', 'cities');
  w = t.read();
  assert.deepEqual(plain(w.regionLabels), ['country', 'state', 'city']);
  assert.deepEqual(['north-alandia', 'south-alandia', 'west-borovia', 'east-borovia'].map((id) => def(w, id).parent), ['alandia', 'alandia', 'borovia', 'borovia']);
  const am = def(w, 'alandia').map;
  assert.ok(am.regions['north-alandia'] && am.regions['south-alandia'], "Alandia's states are on Alandia's map");
  assert.ok(!w.map.regions['north-alandia'], '…not the world map');
  assert.ok(w.map.regions['west-borovia'] && w.map.regions['east-borovia'], "Borovia has no map: its states are on the world's");
  assert.equal(am.regions['south-alandia'].polygons.length, 2, 'the island piece kept');
  // Borders: within a country and across one.
  assert.ok(has(w, 'north-alandia', 'south-alandia'));
  assert.ok(has(w, 'west-borovia', 'east-borovia'));
  assert.ok(has(w, 'north-alandia', 'west-borovia'), 'across the border between countries');
  assert.ok(!has(w, 'north-alandia', 'east-borovia'));
  // Cities in the state that holds them, on that state's level map.
  const pin = (id) => [w.map, am].flatMap((m) => (m.places || []).map((p) => Object.assign({ on: m === am ? 'alandia' : 'world' }, p))).find((p) => p.id === id);
  assert.deepEqual(['norby', 'southby', 'wexley', 'easton', 'port-cass'].map((id) => [pin(id).region, pin(id).on]),
    [['north-alandia', 'alandia'], ['south-alandia', 'alandia'], ['west-borovia', 'world'], ['east-borovia', 'world'], ['castellane', 'world']]);
  assert.equal(pin('norby').kind, 'capital');
  assert.ok(t.logs.some((l) => /4 regions, 4 borders, 5 places/.test(l)), t.logs.join('\n'));
  // Importing again: the same ids, nothing doubled, the author's edits kept.
  def(w, 'north-alandia').name = 'The North';
  t.write(w);
  await t.run('regions', t.dir, '--from', 'states', '--pick', 'North Alandia, West Borovia');
  w = t.read();
  assert.equal(w.regions.length, 7);
  assert.equal(def(w, 'north-alandia').name, 'The North');
  assert.equal(def(w, 'north-alandia').parent, 'alandia');
  assert.equal(Object.keys(am.regions).length, 2);
  assert.ok(has(w, 'west-borovia', 'east-borovia'), 'borders with states imported before');
  // Borovia's own map: its states and cities move onto it.
  await t.run('crop', t.dir, '--region', 'borovia', '--width', '300');
  w = t.read();
  const bm = def(w, 'borovia').map;
  assert.ok(bm.regions['west-borovia'] && bm.regions['east-borovia']);
  assert.ok(!w.map.regions['west-borovia']);
  assert.deepEqual(plain((bm.places || []).map((p) => p.id).sort()), ['easton', 'wexley']);
  assert.ok(!(w.map.places || []).some((p) => p.id === 'wexley'));
  assert.ok(t.logs.some((l) => /Borovia's own map, with 2 regions and 2 places inside it moved onto it/.test(l)), t.logs.join('\n'));
  // And it loads: each map only outlines what's inside its region.
  const loaded = readWorld(t.dir, t.E);
  assert.equal(loaded.starts[0].error, undefined, loaded.starts[0].error);
  // Places on a region's own map are known to the story like the world map's.
  const header = t.E.Prompts.header(t.E.Engine.newGame(t.E.Scenario.startScenario(loaded)));
  assert.match(header, /- north-alandia: The North[^\n]*\[places: Norby \(capital\)\]/);
  t.done();
});

test('the creator and the tool share the region crop: what is inside moves, its own outline stays, the bounds come from the outline', async () => {
  const t = await landsWorld();
  await t.run('regions', t.dir, '--from', 'states', '--within', '--places', 'cities');
  const w = t.read();
  const M = t.E.MapEdit;
  assert.deepEqual(plain(M.regionBounds(w, 'borovia')), [9, -1, 21, 11], 'its outline plus a margin');
  assert.equal(M.regionBounds(w, 'nowhere'), null);
  const map = { image: 'maps/borovia.jpg', width: 240, height: 240, projection: 'equirectangular', bounds: [9, -1, 21, 11], base: 'world', regions: {} };
  assert.deepEqual(plain(M.cropRegion(w, 'borovia', map)), { moved: 2, places: 2 });
  assert.ok(def(w, 'borovia').map.regions['west-borovia'] && w.map.regions.borovia && !w.map.regions['west-borovia']);
  const wex = def(w, 'borovia').map.places.find((p) => p.id === 'wexley');
  assert.deepEqual(plain(t.E.Geo.toLonLat(def(w, 'borovia').map, wex.at).map((v) => Math.round(v))), [12, 5], 'still where it really is');
  t.done();
});

test('states with no country region are put at the top level and said so; --parent puts them under one', async () => {
  const t = await landsWorld();
  let w = t.read();
  w.regions = w.regions.filter((r) => r.id !== 'borovia');
  delete w.map.regions.borovia;
  w.regions.forEach((r) => { r.neighbours = r.neighbours.filter((n) => n !== 'borovia'); });
  t.write(w);
  await t.run('regions', t.dir, '--from', 'states', '--pick', 'West Borovia');
  w = t.read();
  assert.equal(def(w, 'west-borovia').parent, undefined);
  assert.ok(t.logs.some((l) => /no region for Borovia: their states are at the top level/.test(l)));
  await t.run('regions', t.dir, '--from', 'states', '--pick', 'East Borovia', '--parent', 'castellane');
  assert.equal(def(t.read(), 'east-borovia').parent, 'castellane');
  await assert.rejects(t.run('regions', t.dir, '--from', 'states', '--within', '--parent', 'nowhere'), /No region "nowhere"/);
  t.done();
});

test('cities as regions: a point under their state, and a start there plays a turn, with trips across the tree', async () => {
  const t = await landsWorld();
  await t.run('regions', t.dir, '--from', 'states', '--within', '--places', 'cities', '--as', 'regions');
  let w = t.read();
  const norby = def(w, 'norby');
  assert.deepEqual([norby.parent, norby.label, norby.tags], ['north-alandia', 'city', ['capital']]);
  assert.ok(w.map.regions.norby.point, 'a point on its level map');
  assert.ok(!(w.map.places || []).some((p) => p.id === 'norby'), 'not also a pin');
  assert.equal(def(w, 'port-cass').parent, 'castellane', 'no states there: under the country');
  assert.ok(t.logs.some((l) => /5 cities as regions/.test(l)), t.logs.join('\n'));
  // Again: the same regions, by key.
  await t.run('regions', t.dir, '--from', 'states', '--within', '--places', 'cities', '--as', 'regions');
  w = t.read();
  assert.equal(w.regions.filter((r) => r.name === 'Norby').length, 1);
  // Start in Norby and play.
  const sf = path.join(t.dir, 'starts', 'start.json');
  const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
  st.region = 'norby';
  fs.writeFileSync(sf, JSON.stringify(st));
  const loaded = readWorld(t.dir, t.E);
  assert.equal(loaded.starts[0].error, undefined, loaded.starts[0].error);
  const { E } = t;
  const state = E.Engine.newGame(E.Scenario.startScenario(loaded));
  assert.deepEqual([...E.Engine.regionChain(state, 'norby')], ['norby', 'north-alandia', 'alandia']);
  const trip = E.Engine.regionTrip(state, 'norby', 'wexley');
  assert.ok(trip.legs && trip.legs.length, 'a way from Norby to Wexley, across the border');
  const user = E.Prompts.intent(state, [], 'Look around.', 'about an hour', 'hour', {});
  assert.match(user, /\nRegion: Norby, a city \(norby\)/);
  assert.match(user, /\nInside: North Alandia, a state \(north-alandia\)[^\n]*› Alandia, a country/);
  mockLLM(E, (call) => {
    if (call.kind === 'intent') return { player: { summary: 'look' }, intents: [], events: [] };
    if (call.kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    if (call.kind === 'chapter') return { title: 'x', summary: 'y' };
    if (/^worldbuild/.test(call.kind)) return {};
    return '[+0m] Norby is quiet under a grey sky.';
  });
  const out = await E.Engine.runTurn(state, 'I look around.', 'hour');
  assert.equal(state.turn, 1);
  assert.ok(out.res);
  t.done();
});
