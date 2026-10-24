// World and regional views (task 3-4): the world map data (an image with a
// polygon or point per region), the automatic node map for worlds without an
// image, faction colours, and the "changed this turn" stamp the view
// highlights. Hidden events change nothing public, so they stamp nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, loadEngine, readScenario, worldFiles } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const regional = (E, state, effects, extra) => {
  const res = { outcomes: [], events: [], guards: [] };
  E.Engine.applyEvents(state, { events: [Object.assign({ text: 'Smoke over town.', scope: 'regional', visibility: 'heard', effects }, extra)] }, [], 'hour', res, { regional: true });
  return res;
};

test('the world map validates: known regions, polygons of 3+ points inside the image, points and rooms inside it, faction colours 1-8', () => {
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  sc.map.regions.shire = { point: [10, 10] };
  sc.map.regions.junction = { polygon: [[0, 0], [10, 0]] };
  sc.map.regions['main-street'] = { polygon: [[0, 0], [900, 0], [10, 10]] };
  sc.map.regions.residential = { point: [-5, 3] };
  sc.map.locations.lot = [5000, 1];
  sc.factions[0].color = 9;
  assert.throws(() => E.Scenario.validate(sc), (err) => [
    'map: unknown region "shire"', 'region "junction" polygon needs at least 3 points', 'region "main-street" polygon has a point outside the image',
    'region "residential" point is outside the image', 'map: location "lot" is outside the image',
    '"color" must be a whole number from 1 to 8',
  ].every((m) => err.message.includes(m)));
  const bad = readScenario('zombie-holdout');
  bad.map = { image: '../secret.png', width: 10, height: 10 };
  assert.throws(() => E.Scenario.validate(bad), /"map" needs an "image" in the world folder/);
});

test('rooms on the world map may come from any start, but must exist in one', () => {
  const E = loadEngine();
  const files = worldFiles('zombie-holdout');
  files['world.json'].map.locations.attic = [1, 1];
  assert.throws(() => E.Scenario.prepareWorld('zombie-holdout', files), /map: unknown location "attic"/);
  const m = worldFiles('mars-station');
  m['world.json'].map = { image: 'maps/x.png', width: 100, height: 100, regions: {}, locations: { garage: [5, 5] } };
  const w = E.Scenario.prepareWorld('mars-station', m);
  assert.ok(w.starts.every((s) => s.scenario), 'garage is a world room: fine in both starts');
});

test('a region left off the map is warned about and gets a point along the bottom', () => {
  const E = loadEngine();
  const files = worldFiles('zombie-holdout');
  delete files['world.json'].map.regions['ridge-town'];
  const w = E.Scenario.prepareWorld('zombie-holdout', files);
  assert.ok([...w.warnings].some((m) => /region "ridge-town" is not on the map/.test(m)));
  const sc = w.starts[0].scenario;
  // Harmon holds regions of its own, so its children stand for it (R-1).
  assert.ok(![...w.warnings].some((m) => /region "town"/.test(m)), 'a region with regions inside needs no shape');
  const g = E.MapDraw.geometry(sc.regions, sc.map, 'zombie-holdout');
  assert.equal(g.shapes.town, undefined);
  const anchors = g.anchors;
  assert.deepEqual([...anchors['ridge-town']], [400, 536]);

  assert.ok(anchors.junction[0] > 300 && anchors.junction[0] < 640, 'a polygon anchors in its middle');
});

test('the node map for a world without an image is the same every time and its boxes never overlap', () => {
  const a = newGame(), b = newGame();
  // The regions the player knows of (R-5: the lava tube is hidden), as the game draws them.
  const known = (g, s) => s.scenario.regions.filter((r) => g.Engine.regionKnown(s, r.id));
  const p = plain(a.E.Layouts.regionMap(known(a.E, a.state), 'mars-station'));
  assert.deepEqual(plain(b.E.Layouts.regionMap(known(b.E, b.state), 'mars-station')), p);
  const loaded = a.E.Engine.migrate(plain(a.state));
  assert.deepEqual(plain(a.E.Layouts.regionMap(known(a.E, loaded), 'mars-station')), p, 'after a save');

  const nodes = Object.entries(p.nodes);
  assert.equal(nodes.length, 4);
  nodes.forEach(([x, n], i) => nodes.slice(i + 1).forEach(([y, o]) => {
    assert.ok(Math.abs(n.x - o.x) >= n.w || Math.abs(n.y - o.y) >= n.h, `${x} overlaps ${y}`);
  }));
  assert.deepEqual(p.edges.map((e) => e.join('-')).sort(), ['basin-floor-crater-rim', 'crater-rim-relay-mast', 'crater-rim-station']);
  nodes.forEach(([, n]) => assert.ok(n.x - n.w / 2 >= 0 && n.y - n.h / 2 >= 0 && n.x + n.w / 2 <= p.width && n.y + n.h / 2 <= p.height));
});

test('each region change is stamped for this turn; rejected and hidden ones are not', () => {
  const { E, state } = newGame('zombie-holdout');
  state.turn = 3;
  regional(E, state, { control: [{ region: 'junction', to: 'convoy' }], add_tag: [{ region: 'junction', tag: 'checkpoint' }] });
  assert.deepEqual(plain(state.regionChanged.junction), { turn: 3, what: ['changed hands', 'new tag'] });
  regional(E, state, { remove_tag: [{ region: 'main-street', tag: 'overrun' }], region_status: [{ region: 'residential', status: 'burning' }] });
  assert.deepEqual([state.regionChanged['main-street'].what[0], state.regionChanged.residential.what[0]], ['tag gone', 'new status']);
  regional(E, state, { control: [{ region: 'ridge-town', to: 'convoy' }] }, { visibility: 'hidden' });
  regional(E, state, { control: [{ region: 'ridge-town', to: 'orcs' }] });
  assert.ok(!state.regionChanged['ridge-town']);
  state.turn = 4;
  regional(E, state, { region_status: [{ region: 'junction', status: 'convoy trucks parked' }] });
  assert.deepEqual(plain(state.regionChanged.junction), { turn: 4, what: ['new status'] }, 'a new turn starts a new list');
});

test('older saves get an empty change list', () => {
  const { E, state } = newGame('zombie-holdout');
  const v9 = plain(state);
  v9.version = 9;
  delete v9.regionChanged;
  const up = E.Engine.migrate(v9);
  assert.equal(up.version, E.Engine.STATE_VERSION);
  assert.deepEqual(plain(up.regionChanged), {});
});

// ---------- the zooming map (R-3) ----------

test('levels with a picture: the world as before, a region without a map zooms the picture to its parts, a leaf as the regional view was', () => {
  const { E, state } = newGame('zombie-holdout');
  const sc = state.scenario;
  const D = E.MapDraw;
  const root = D.level(sc, null);
  const before = D.geometry(sc.regions, sc.map, 'zombie-holdout');
  assert.deepEqual(Object.keys(root.g.shapes).sort(), Object.keys(before.shapes).sort(), 'the same regions as the world view');
  assert.deepEqual([...root.viewBox], [...before.full]);
  assert.equal(root.picture, sc.map);
  const town = D.level(sc, 'town');
  assert.equal(town.picture, sc.map, 'Harmon has no map: the world\'s, zoomed');
  assert.deepEqual([...town.children].sort(), ['highway-strip', 'main-street', 'residential']);
  assert.deepEqual([...town.dim].sort(), ['junction', 'ridge-town']);
  assert.ok(town.viewBox[3] < before.full[3], 'zoomed to the town\'s strip of the map');
  const leaf = D.level(sc, 'highway-strip');
  assert.equal(leaf.leaf, true);
  assert.deepEqual([...leaf.viewBox], [...D.focusBox(before, 'highway-strip', E.Engine.nearbyRegions(state))], 'framed as the Region view was');
  assert.deepEqual([...D.levelPath(sc, 'highway-strip')], [null, 'town', 'highway-strip']);
  assert.equal(D.hasLevel(sc, 'town'), true);
  assert.equal(D.hasLevel(sc, 'ridge-town'), false);
});

test('the picture is drawn first, under every shape, route and label (decoration, never data)', () => {
  const { E, state } = newGame('zombie-holdout');
  const lv = E.MapDraw.level(state.scenario, 'town');
  const svg = E.MapDraw.worldSvg({ g: lv.g, regions: lv.regions, factions: state.factions, imageUrl: 'maps/town.svg', dim: lv.dim });
  assert.match(svg, /^<svg[^>]*><image /);
  assert.equal((svg.match(/class="region-g dim"/g) || []).length, 2);
});

test('levels without a picture: node maps of each level\'s children, with routes lifted from inside them, by kind, closed ones marked', () => {
  const { E, state } = newGame('zombie-holdout');
  const sc = Object.assign({}, state.scenario);
  delete sc.map;
  const D = E.MapDraw;
  const root = D.level(sc, null);
  assert.deepEqual(plain(root.regions.map((r) => r.id)).sort(), ['junction', 'ridge-town', 'town'], 'the top level only');
  assert.deepEqual(plain(root.g.kinds), { 'junction|town': 'border', 'junction|ridge-town': 'road' }, 'the town\'s parts touch the junction, so the town does');
  const town = D.level(sc, 'town');
  assert.deepEqual(plain(town.regions.map((r) => r.id)).sort(), ['highway-strip', 'main-street', 'residential']);
  const svg = D.worldSvg({ g: root.g, regions: root.regions, factions: state.factions, closed: new Set(['junction|ridge-town']) });
  assert.match(svg, /class="region-edge kind-road closed"/);
  assert.match(svg, /class="region-edge kind-border"/);
  assert.equal(D.level(sc, 'ridge-town').leaf, true);
});

test('a region may carry a map of its own, outlining only regions inside it', () => {
  const E = loadEngine();
  const files = worldFiles('zombie-holdout');
  const town = files['world.json'].regions.find((r) => r.id === 'town');
  town.map = { image: 'maps/town.svg', width: 400, height: 300, regions: { 'main-street': { polygon: [[0, 0], [200, 0], [200, 200]] } }, locations: { floor: [10, 10] } };
  const w = E.Scenario.prepareWorld('zombie-holdout', E.clone(files));
  assert.equal(w.starts[0].error, undefined);
  const lv = E.MapDraw.level(w.starts[0].scenario, 'town');
  assert.equal(lv.owner, 'town');
  assert.deepEqual(Object.keys(lv.g.shapes).sort(), ['highway-strip', 'main-street', 'residential'], 'its own outline, and points for the other parts');
  assert.deepEqual([...lv.viewBox], [0, 0, 400, 300]);
  assert.deepEqual(plain(E.MapDraw.level(w.starts[0].scenario, 'main-street').picture), town.map, 'a leaf inside uses the nearest picture');

  town.map.regions['ridge-town'] = { point: [5, 5] };
  assert.match(E.Scenario.prepareWorld('zombie-holdout', E.clone(files)).starts[0].error, /Harmon's map: "ridge-town" isn't inside Harmon/);
  delete town.map.regions['ridge-town'];
  town.map.locations.nowhere = [1, 1];
  assert.throws(() => E.Scenario.prepareWorld('zombie-holdout', E.clone(files)), /Harmon's map: unknown location "nowhere"/);
  town.map.width = 0;
  delete town.map.locations.nowhere;
  assert.match(E.Scenario.prepareWorld('zombie-holdout', E.clone(files)).starts[0].error, /"Harmon's map" needs an "image"/);
});
