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
  sc.map.locations.attic = [1, 1];
  sc.map.locations.lot = [5000, 1];
  sc.factions[0].color = 9;
  assert.throws(() => E.Scenario.validate(sc), (err) => [
    'map: unknown region "shire"', 'region "junction" polygon needs at least 3 points', 'region "main-street" polygon has a point outside the image',
    'region "residential" point is outside the image', 'map: unknown location "attic"', 'map: location "lot" is outside the image',
    '"color" must be a whole number from 1 to 8',
  ].every((m) => err.message.includes(m)));
  const bad = readScenario('zombie-holdout');
  bad.map = { image: '../secret.png', width: 10, height: 10 };
  assert.throws(() => E.Scenario.validate(bad), /"map" needs an "image" in the world folder/);
});

test('a region left off the map is warned about and gets a point along the bottom', () => {
  const E = loadEngine();
  const files = worldFiles('zombie-holdout');
  delete files['world.json'].map.regions['ridge-town'];
  const w = E.Scenario.prepareWorld('zombie-holdout', files);
  assert.ok([...w.warnings].some((m) => /region "ridge-town" is not on the map/.test(m)));
  const sc = w.starts[0].scenario;
  const anchors = E.Layouts.regionAnchors(sc.regions, sc.map);
  assert.deepEqual([...anchors['ridge-town']], [400, 536]);
  assert.ok(anchors.junction[0] > 300 && anchors.junction[0] < 640, 'a polygon anchors in its middle');
});

test('the node map for a world without an image is the same every time and its boxes never overlap', () => {
  const a = newGame(), b = newGame();
  const p = plain(a.E.Layouts.regionMap(a.state.scenario.regions, 'mars-station'));
  assert.deepEqual(plain(b.E.Layouts.regionMap(b.state.scenario.regions, 'mars-station')), p);
  const loaded = a.E.Engine.migrate(plain(a.state));
  assert.deepEqual(plain(a.E.Layouts.regionMap(loaded.scenario.regions, 'mars-station')), p, 'after a save');
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
