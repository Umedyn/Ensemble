// Map focus (R-8): tense worlds keep the tactical local map; everyday ones
// live at the region level, with flavour places (one call, 1 to 3 rooms, a
// scene card) that grow into tactical ones when danger comes. Presentation
// and cost only: the rules are the same either way.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, worldFiles, newGame, mockLLM } = require('./helpers');
const { replies, stepOf } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));
const FLAT = path.join(__dirname, 'fixtures', 'slice-of-life');

// The slice-of-life flat in Brightwater's Old Town, a world that builds places.
function cityGame(edit) {
  const E = loadEngine();
  const f = worldFiles(FLAT);
  const w = f['world.json'];
  w.regionLabels = ['city', 'district'];
  w.regions = [
    { id: 'brightwater', name: 'Brightwater' },
    { id: 'old-town', name: 'Old Town', parent: 'brightwater', neighbours: ['docks'] },
    { id: 'docks', name: 'The Docks', parent: 'brightwater', routes: [{ to: 'old-town', kind: 'bus', time: '20m' }] },
  ];
  w.generatedSites = { maxSites: 6, keepDays: 3 };
  f['starts/sunday.json'].region = 'old-town';
  if (edit) edit(f);
  const world = E.Scenario.prepareWorld('city', f);
  assert.equal(world.starts[0].error, undefined, world.starts[0].error);
  return { E, state: E.Engine.newGame(E.Scenario.startScenario(world)) };
}
function turnMock(E, intentPlayer, over = {}) {
  const r = replies(over);
  return mockLLM(E, (call) => {
    const step = stepOf(call.user);
    if (step) { const v = r[step]; return typeof v === 'function' ? v(call.user, call) : v; }
    if (call.kind === 'intent') return { player: Object.assign({ summary: 'go' }, intentPlayer), intents: [], events: [] };
    if (call.kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    if (call.kind === 'chapter') return { title: 'x', summary: 'y' };
    return '[+0m] You walk round the corner.';
  });
}
const CAFE = { new_place: { name: 'the corner café', kind: 'cafe', region: 'old-town' } };

test('a non-lethal world without hostile groups is region-focused and its map opens at the city level', () => {
  const { E, state } = cityGame();
  assert.equal(E.Sites.mapFocus(state.scenario), 'region');
  assert.deepEqual([...E.MapDraw.levelPath(state.scenario, E.Engine.playerRegion(state))], [null, 'brightwater', 'old-town']);
  assert.ok(!E.Sites.tactical(state, E.Sites.HOME), 'the flat is flavour');
  const pins = E.Sites.regularPlaces(state, 'brightwater');
  assert.equal(pins.length, 1);
  assert.equal(pins[0].here, true, 'home is a pin, and you are there');
  // A hostile group, or the world saying so, makes it local.
  const { E: E2, state: s2 } = cityGame((f) => { f['world.json'].mapFocus = 'local'; });
  assert.equal(E2.Sites.mapFocus(s2.scenario), 'local');
  assert.ok(E2.Sites.tactical(s2, E2.Sites.HOME));
});

test('a lethal world\'s sites are tactical by default, and the bundled worlds say local', () => {
  const { E, state } = newGame('zombie-holdout');
  assert.equal(E.Sites.mapFocus(state.scenario), 'local');
  assert.ok(E.Sites.tactical(state, E.Sites.HOME));
  const { E: E2 } = cityGame((f) => { f['world.json'].tags = ['survival', 'grim']; delete f['world.json'].mapFocus; });
  assert.equal(E2.Sites.mapFocus({ tags: ['survival', 'horror'] }), 'local', 'lethal danger: local');
  assert.equal(E2.Sites.mapFocus({ tags: ['slice-of-life'], standees: [{ label: 'gang', state: 'hostile' }] }), 'local', 'a hostile group: local');
  assert.equal(E2.Sites.mapFocus({ tags: [] }), 'local', 'no known genre: local');
  ['mars-station', 'zombie-holdout'].forEach((w) => assert.equal(newGame(w).state.scenario.mapFocus, 'local'));
});

test('mapFocus and tactical are checked when the world loads', () => {
  const E = loadEngine();
  const f = worldFiles(FLAT);
  f['world.json'].mapFocus = 'zoomed';
  assert.match(E.Scenario.prepareWorld('city', f).starts[0].error || '', /mapFocus/);
});

test('a flavour place builds in one call with at most 3 rooms, no posts or patrols and no secure room', async () => {
  const { E, state } = cityGame();
  const calls = turnMock(E, CAFE);
  await E.Engine.runTurn(state, 'I pop round to the corner café.', 'hour');
  const builds = calls.filter((c) => /^worldbuild \(site/.test(c.kind)).map((c) => c.kind);
  assert.deepEqual(builds, ['worldbuild (site: the corner café)'], 'one call, no separate people step');
  const site = state.sites['the-corner-cafe'] || Object.values(state.sites)[0];
  assert.equal(site.flavour, true);
  assert.ok(site.rooms.length >= 1 && site.rooms.length <= 3);
  assert.ok(!site.rooms.some((id) => state.locations[id].secure), 'flavour has no secure rooms');
  const g = Object.values(state.standees).find((x) => x.label === 'regulars');
  assert.ok(g && !g.post && !g.patrol, 'no posts or patrols');
  assert.equal(state.characters[state.player].status.location, 'cafe-floor');
  assert.ok(!E.Sites.tactical(state, site.id));
  // Too many rooms: the first three are kept.
  const big = cityGame();
  const many = replies().siteFlavour;
  turnMock(big.E, CAFE, { siteFlavour: Object.assign({}, many, { rooms: many.rooms.concat([1, 2, 3].map((i) => ({ id: `nook-${i}`, name: `Nook ${i}`, desc: 'A nook.' }))) }) });
  await big.E.Engine.runTurn(big.state, 'I pop round to the corner café.', 'hour');
  assert.equal(Object.values(big.state.sites)[0].rooms.length, 3);
});

test('a hostile group arriving makes the place tactical and grows rooms around it without moving the ones it had', async () => {
  const { E, state } = cityGame();
  turnMock(E, CAFE);
  await E.Engine.runTurn(state, 'I pop round to the corner café.', 'hour');
  const site = Object.values(state.sites)[0];
  const before = site.rooms.map((id) => plain(state.locations[id]));
  Object.values(state.standees).find((x) => x.label === 'regulars').state = 'hostile';
  assert.ok(E.Sites.tactical(state, site.id), 'danger now: tactical');
  const calls = turnMock(E, { summary: 'stay put' });
  const out = await E.Engine.runTurn(state, 'I keep my head down.', 'hour');
  assert.ok(calls.some((c) => c.kind === 'worldbuild (site grows: the corner café)'));
  assert.equal(site.grown, true);
  assert.deepEqual([...site.rooms.slice(0, before.length)], [...before.map((r) => r.id)], 'the rooms it had come first');
  assert.deepEqual([...site.rooms.slice(before.length)], ['stairwell', 'yard']);
  before.forEach((r) => {
    const now = state.locations[r.id];
    assert.equal(now.name, r.name);
    assert.equal(now.desc, r.desc);
    assert.ok(r.connects.every((c) => now.connects.includes(c)), 'its links kept');
  });
  assert.ok(state.locations['cafe-back'].connects.includes('stairwell'), 'joined back to the place');
  assert.equal(state.locations.yard.site, site.id);
  assert.ok(out.res.guards.some((g) => g.type === 'site grown' && /Stairwell, Yard/.test(g.detail)));
  // It stays tactical once calm again, and grows only once.
  Object.values(state.standees).find((x) => x.label === 'regulars').state = 'calm';
  assert.ok(E.Sites.tactical(state, site.id));
  const again = turnMock(E, { summary: 'stay put' });
  await E.Engine.runTurn(state, 'I wait.', 'hour');
  assert.ok(!again.some((c) => /site grows/.test(c.kind)));
});

test('growth that changes a room the place has is refused', () => {
  const { E, state } = cityGame();
  state.sites = { cafe: { id: 'cafe', name: 'Café', entry: 'cafe-floor', rooms: ['cafe-floor'], flavour: true } };
  state.locations['cafe-floor'] = { id: 'cafe-floor', name: 'Café Floor', desc: 'Tables.', connects: [], site: 'cafe', region: 'old-town' };
  const moved = E.Sites.checkGrowth(state, { rooms: [{ id: 'cafe-floor', name: 'Café Floor', desc: 'Now a bigger room.' }, { id: 'yard', name: 'Yard', desc: 'Bins.' }] }, 'cafe');
  assert.match(moved.error, /keep the rooms that are there/);
  const few = E.Sites.checkGrowth(state, { rooms: [{ id: 'yard', name: 'Yard', desc: 'Bins.' }] }, 'cafe');
  assert.match(few.error, /add 2 to 4/);
  const ok = E.Sites.checkGrowth(state, { rooms: [{ id: 'yard', name: 'Yard', desc: 'Bins.' }, { id: 'loft', name: 'Loft', desc: 'Boxes.', links: ['yard'] }] }, 'cafe');
  assert.ok(ok.rooms.find((r) => r.id === 'yard').connects.includes('cafe-floor'), 'a room linked nowhere gets a door to the way in');
});

test('region focus: the header leaves room descriptions out and stays the same all game; the room you are in is described in the user message', async () => {
  const { E, state } = cityGame();
  const header = E.Prompts.header(state);
  const here = state.locations[state.characters[state.player].status.location];
  assert.ok(header.includes(`- ${here.id}: ${here.name}`));
  assert.ok(!header.includes(here.desc), 'no descriptions in the header');
  const user = E.Prompts.intent(state, [], 'Look around.', 'about an hour', 'hour', {});
  assert.ok(user.includes(here.desc.replace(/\.$/, '')), 'the room you are in, described');
  assert.match(user, /bus to Old Town|Old Town|The Docks/, 'routes listed, plain borders too');
  const calls = turnMock(E, { summary: 'look' });
  await E.Engine.runTurn(state, 'I look around.', 'hour');
  const static0 = header.split('\n=== STORY SO FAR')[0];
  calls.forEach((c) => assert.equal(c.system.split('\n=== STORY SO FAR')[0], static0, `${c.kind}: the header's static part is unchanged`));
  // A local-focused world keeps the descriptions.
  const local = cityGame((f) => { f['world.json'].mapFocus = 'local'; });
  assert.ok(E.Prompts.header(local.state).includes(here.desc));
});
