// Regions (task 3-1): who holds each part of the map, its tags and status.
// The definition (names, neighbours, lore) is static and goes in the prompt
// header; the current state lives in state.regions, changes only through
// rationed event effects, and only the player's region and its neighbours
// reach the user message.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newGame, loadEngine, readScenario, worldFiles } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const zombies = () => newGame('zombie-holdout');
const fresh = () => ({ outcomes: [], events: [], guards: [] });
const guards = (res, type) => res.guards.filter((g) => g.type === type).map((g) => g.detail);
// One heard regional event with these effects, due this turn.
function regional(E, state, effects, extra) {
  const res = fresh();
  E.Engine.applyEvents(state, { events: [Object.assign({ text: 'Smoke rises over town.', scope: 'regional', visibility: 'heard', effects }, extra)] }, [], 'hour', res, { regional: true });
  return res;
}
const validate = (edit) => {
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  edit(sc);
  return () => E.Scenario.validate(sc);
};

// ---------- data ----------

test('regions validate: neighbours, controllers, the start region, location regions and seed regions must be real', () => {
  assert.throws(validate((sc) => sc.regions[0].neighbours.push('mordor')), /region "highway-strip": unknown neighbour "mordor"/);
  assert.throws(validate((sc) => { sc.regions[1].controller = 'orcs'; }), /controller "orcs" is not one of the groups/);
  assert.throws(validate((sc) => { delete sc.region; }), /the start needs a "region"/);
  assert.throws(validate((sc) => { sc.region = 'shire'; }), /start region "shire" is not one of the regions/);
  assert.throws(validate((sc) => { sc.locations[0].region = 'shire'; }), /location "floor" is in unknown region "shire"/);
  assert.throws(validate((sc) => sc.eventSeeds.regional.push({ text: 'a riot', region: 'shire' })), /"a riot" is in unknown region "shire"/);
  assert.throws(validate((sc) => sc.regions.push({ id: 'junction', name: 'Again' })), /region "junction" is listed twice/);
  assert.throws(validate((sc) => { sc.regions[0].tags = ['a', 'b', 'c', 'd', 'e', 'f', 'g']; }), /"tags" must be a list of at most 6/);
  assert.throws(validate((sc) => { delete sc.regions; }), /start region "highway-strip" given, but the world has no "regions"/);
});

test('a location without a region is in the start region, and neighbour links work both ways', () => {
  const { state } = zombies();
  assert.ok(Object.values(state.locations).every((l) => l.region === 'highway-strip'));
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  sc.regions.find((r) => r.id === 'junction').neighbours = ['highway-strip'];
  E.Scenario.validate(sc);
  assert.ok(sc.regions.find((r) => r.id === 'ridge-town').neighbours.includes('junction'), 'listed on one side only, filled in on the other');
  assert.deepEqual([...sc.regions.find((r) => r.id === 'junction').neighbours], ['highway-strip', 'ridge-town']);
});

test('a start can change a region by id, and Ares Deep puts the surface on the crater rim', () => {
  const E = loadEngine();
  const f = worldFiles('mars-station');
  const chars = {};
  f['world.json'].characters.forEach((id) => (chars[id] = f[`characters/${id}.json`]));
  const st = Object.assign({}, f['starts/recycler.json'], { regions: [{ id: 'crater-rim', tags: ['storm front'] }] });
  const sc = E.Scenario.validate(E.Scenario.compose(f['world.json'], st, chars, 'mars-station'));
  const rim = sc.regions.find((r) => r.id === 'crater-rim');
  assert.deepEqual([...rim.tags], ['storm front']);
  assert.equal(rim.name, 'Hellas crater rim', 'other fields kept');
  const state = E.Engine.newGame(sc);
  assert.equal(state.locations.surface.region, 'crater-rim');
  assert.equal(state.locations.ops.region, 'station');
  assert.deepEqual(plain(state.regions['crater-rim']), { controller: 'mission', tags: ['storm front'], status: 'solar field and drill site working' });
});

// ---------- effects ----------

test('control: a region changes hands to a real group or to no one, near the player or far away', () => {
  const { E, state } = zombies();
  const res = regional(E, state, { control: [{ region: 'junction', to: 'convoy' }] });
  assert.equal(state.regions.junction.controller, 'convoy');
  assert.deepEqual([...res.director[0].effects], ['Highway junction: now held by Coastal rescue convoy']);
  regional(E, state, { control: [{ region: 'ridge-town', to: null }] }, { region: 'junction' });
  assert.equal(state.regions['ridge-town'].controller, null);
});

test('control rejects unknown regions, unknown groups and no change', () => {
  const { E, state } = zombies();
  const before = plain(state.regions);
  const r1 = regional(E, state, { control: [{ region: 'mordor', to: 'convoy' }] });
  const r2 = regional(E, state, { control: [{ region: 'junction', to: 'orcs' }] });
  const r3 = regional(E, state, { control: [{ region: 'ridge-town', to: 'ridge' }] });
  assert.deepEqual(plain(state.regions), before);
  assert.deepEqual([...guards(r1, 'effect rejected'), ...guards(r2, 'effect rejected'), ...guards(r3, 'effect rejected')],
    ['control: unknown region "mordor"', 'control: unknown group "orcs" for junction', 'control: ridge-town is already held by ridge']);
});

test('add_tag and remove_tag change a region\'s tags, up to six, and reject unknown regions and tags', () => {
  const { E, state } = zombies();
  const res = regional(E, state, { add_tag: [{ region: 'main-street', tag: 'On Fire' }], remove_tag: [{ region: 'main-street', tag: 'overrun' }] });
  assert.deepEqual([...state.regions['main-street'].tags], ['on fire']);
  assert.deepEqual([...res.director[0].effects], ['Main Street: on fire', 'Main Street: no longer overrun']);
  const bad = regional(E, state, { add_tag: [{ region: 'shire', tag: 'quiet' }], remove_tag: [{ region: 'main-street', tag: 'flooded' }] });
  assert.deepEqual(guards(bad, 'effect rejected'), ['add_tag: unknown region "shire"', 'remove_tag: main-street has no tag "flooded"']);
  // A full region drops its oldest event tag (playtest-coffee-skips); authored tags stay.
  const def = state.scenario.regions.find((x) => x.id === 'junction');
  def.tags = ['a'];
  state.regions.junction.tags = ['a', 'b', 'c', 'd', 'e', 'f'];
  const full = regional(E, state, { add_tag: [{ region: 'junction', tag: 'g' }] });
  assert.deepEqual([...state.regions.junction.tags], ['a', 'c', 'd', 'e', 'f', 'g']);
  assert.match(full.director[0].effects[0], /: g \(no longer b\)$/);
  def.tags = ['a', 'c', 'd', 'e', 'f', 'g'];
  const authored = regional(E, state, { add_tag: [{ region: 'junction', tag: 'h' }] });
  assert.match(guards(authored, 'effect rejected')[0], /already has 6 tags/);
  const long = regional(E, state, { add_tag: [{ region: 'main-street', tag: 'commons losing pressure at the chase' }] });
  assert.match(guards(long, 'effect rejected')[0], /tag too long/);
});

test('region_status sets a region\'s status line and rejects unknown regions', () => {
  const { E, state } = zombies();
  regional(E, state, { region_status: [{ region: 'residential', status: 'burning, block by block' }] });
  assert.equal(state.regions.residential.status, 'burning, block by block');
  const bad = regional(E, state, { region_status: [{ region: 'atlantis', status: 'sunk' }] });
  assert.deepEqual(guards(bad, 'effect rejected'), ['region_status: unknown region "atlantis"']);
});

test('region effects are rationed: a regional event that is not due, a local or a hidden one changes nothing', () => {
  const { E, state } = zombies();
  const before = plain(state.regions);
  const eff = { control: [{ region: 'junction', to: 'convoy' }] };
  const notDue = fresh();
  E.Engine.applyEvents(state, { events: [{ text: 'The convoy takes the junction.', scope: 'regional', effects: eff }] }, [], 'hour', notDue, {});
  assert.equal(guards(notDue, 'event dropped').length, 1);
  regional(E, state, eff, { visibility: 'hidden' });
  regional(E, state, eff, { scope: 'local' });
  assert.deepEqual(plain(state.regions), before);
});

test('bigger events say where they happen: a known region, else the player\'s region for regional ones', () => {
  const { E, state } = zombies();
  const ok = regional(E, state, null, { region: 'junction' });
  assert.equal(ok.director[0].region, 'junction');
  assert.equal(state.news[state.news.length - 1].region, 'junction');
  const bad = regional(E, state, null, { region: 'narnia' });
  assert.equal(bad.director[0].region, 'highway-strip');
  assert.deepEqual(guards(bad, 'event region'), ['unknown region "narnia" for: Smoke rises over town.']);
  const res = fresh();
  E.Engine.applyEvents(state, { events: [{ text: 'Markets crash.', scope: 'world', visibility: 'heard' }] }, [], 'hour', res, { world: true });
  assert.equal(res.director[0].region, null, 'a world event can be nowhere in particular');
});

// ---------- prompts ----------

test('the header lists the static geography and does not change when a region changes hands', () => {
  const { E, state } = zombies();
  const before = E.Prompts.header(state);
  assert.match(before, /=== REGIONS ===\n- highway-strip: The highway strip, a part of town in Harmon — .* \(neighbours: main-street, residential, junction\)/);
  assert.match(before, /\n- town: Harmon, a town — A small farm town/);
  assert.ok(!/held by|overrun|fortified/.test(before), 'no controllers, tags or status in the header');
  regional(E, state, { control: [{ region: 'junction', to: 'convoy' }], add_tag: [{ region: 'junction', tag: 'checkpoint' }], region_status: [{ region: 'junction', status: 'convoy trucks parked across the ramp' }] });
  // The event itself becomes a public fact, so the header only grows at its end (rule 7).
  const after = E.Prompts.header(state);
  assert.ok(after.startsWith(before));
  assert.equal(after.slice(before.length), '\n- [T0] Smoke rises over town.');
  assert.match(E.Prompts.intent(state, [], 'Look out.', 'about an hour', 'hour', {}), /Highway junction \(junction\): held by Coastal rescue convoy; present: Coastal rescue convoy \(some\), The Ridge \(a little\); contested; tags: blocked, checkpoint; convoy trucks parked across the ramp/
);
});

test('only the player\'s region and its neighbours reach the user message', () => {
  const { E, state } = zombies();
  E.settings.backends.local.context = 16384; // standard: the chain with its state (compact: who holds it, task G-4)
  const user = E.Prompts.intent(state, [], 'Look out.', 'about an hour', 'hour', { regional: true });
  assert.match(user, /\nRegion: The highway strip, a part of town \(highway-strip\): held by no one; tags: dead nearby; quiet except for stragglers\n/);
  assert.match(user, /\nInside: Harmon, a town \(town\): held by no one; mostly empty since the evacuation buses\n/);
  assert.match(user, /\nNearby: Main Street \(main-street\): .*\| The houses \(residential\): .*\| Highway junction \(junction\): /);
  assert.ok(!/Ridge \(ridge-town\)|fortified|trucks seen coming/.test(user), 'Ridge is two regions away: its state stays out');
  assert.match(user, /"region": the region id where it happens \(regional events: highway-strip, town, main-street, residential, junction; world events: any region, or null\)/);
  // Any region can change, even far ones; only their current state stays out.
  assert.match(user, /regions: highway-strip, main-street, residential, junction, ridge-town, town\)/);

  assert.match(user, /"control":\[\{"region":"region_id"/);
  const narr = E.Prompts.narrate(state, [], 'Look out.', { startLoc: 'floor', startTime: E.fmtTime(state), stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 }, fresh());
  assert.ok(!/fortified/.test(narr));
});

test('regional event ideas for far regions are left out; the rest say where they are', () => {
  const { E, state } = newGame('mars-station');
  const atStation = E.Prompts.intent(state, [], 'Work.', 'about an hour', 'hour', { regional: true });
  assert.match(atStation, /dust devils crossing the solar field \(Hellas crater rim\)/);
  assert.ok(!/neighboring outpost going quiet/.test(atStation), 'the relay mast is not next to the station');
  state.characters[state.player].status.location = 'surface';
  const outside = E.Prompts.intent(state, [], 'Work.', 'about an hour', 'hour', { regional: true });
  assert.match(outside, /neighboring outpost going quiet on the regional relay \(Relay mast\)/);
  assert.match(outside, /\nRegion: Hellas crater rim, a stretch of surface \(crater-rim\)/

);
});

test('a world without regions has no region lines or region effects in its prompts', () => {
  const { E, state } = newGame(path.join(__dirname, 'fixtures', 'slice-of-life'));
  assert.deepEqual(plain(state.regions), {});
  const user = E.Prompts.intent(state, [], 'Hi.', 'about an hour', 'hour', { regional: true });
  assert.ok(!/REGIONS/.test(E.Prompts.header(state)));
  assert.ok(!/Region:|"control"|"region"/.test(user));
});

// ---------- saves ----------

test('saves round-trip regions, and older saves get an empty set', () => {
  const { E, state } = zombies();
  regional(E, state, { control: [{ region: 'junction', to: 'convoy' }] });
  const loaded = E.Engine.migrate(plain(state));
  assert.deepEqual(plain(loaded.regions), plain(state.regions));
  assert.equal(loaded.regions.junction.controller, 'convoy');
  const v6 = plain(state);
  v6.version = 6;
  delete v6.regions;
  v6.pending = { pre: { characters: {} } };
  const up = E.Engine.migrate(v6);
  assert.equal(up.version, E.Engine.STATE_VERSION);
  assert.deepEqual(plain(up.regions), {});
  assert.deepEqual(plain(up.pending.pre.regions), {});
});
