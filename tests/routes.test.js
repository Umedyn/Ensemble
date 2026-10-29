// Routes and travel (R-2): routes between regions with kinds, times and
// requirements; neighbours as border routes; moves that cross regions follow
// them (a closed way blocks with no model call, a risky one is a roll); a
// trip longer than the step is a journey turn through the skip machinery,
// which can stop on the way; the routes out of a region in the prompt; old
// saves.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, worldFiles, mockLLM, fixedRng, newGame } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));
const FLAT = path.join(__dirname, 'fixtures', 'slice-of-life');

// The slice-of-life flat, with a town and a city beyond it:
//   Flat 4B --checkpoint (needs papers, risky, hurts on a failure)--> Town --rail 3h (needs trains)--> City
// Rooms: the kitchen and living room (flat), the station hall (town), the
// city square (city), each linked to the next.
function routeFiles(edit) {
  const f = worldFiles(FLAT);
  const w = f['world.json'];
  w.world = Object.assign({}, w.world, { papers: 'yes', trains: 'running' });
  w.regions = [
    { id: 'flat', name: 'Flat 4B', routes: [{ to: 'town', kind: 'checkpoint', requires: { world: 'papers', is: 'yes' }, risky: true, failHarm: true }] },
    { id: 'town', name: 'Old Town', routes: [{ to: 'city', kind: 'rail', time: '3h', requires: { world: 'trains', is: 'running' } }] },
    { id: 'city', name: 'The City' },
  ];
  const st = f['starts/sunday.json'];
  st.region = 'flat';
  st.locations[1].connects = ['kitchen', 'station-hall'];
  st.locations.push(
    { id: 'station-hall', name: 'Station Hall', desc: 'Echoing tiles and a departures board.', connects: ['living', 'city-square'], region: 'town', outside: true },
    { id: 'city-square', name: 'City Square', desc: 'Pigeons and trams.', connects: ['station-hall'], region: 'city', outside: true },
  );
  if (edit) edit(f);
  return f;
}
function routeGame(edit) {
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('routes', routeFiles(edit));
  assert.equal(w.starts[0].error, undefined, w.starts[0].error);
  const state = E.Engine.newGame(E.Scenario.startScenario(w));
  state.characters.sam.status.location = 'living';
  return { E, state };
}
// A turn where the model sends the player to `to` (and others as given);
// the downtime and narration calls get plain replies.
function travelMock(E, to, others) {
  return mockLLM(E, (call) => {
    if (call.kind === 'intent' && /=== DOWNTIME/.test(call.user)) return { montage: [{ after: '1h', text: 'The train rattles on.' }], events: [], major_event: null, positions: [], player_where: null };
    if (call.kind === 'intent') return { player: { summary: 'go', move_to: to }, intents: others || [], events: [] };
    if (call.kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    if (call.kind === 'chapter') return { title: 'x', summary: 'y' };
    return '[+0m] Off you go.';
  });
}
const guards = (out, type) => out.res.guards.filter((g) => g.type === type).map((g) => g.detail);

// ---------- data ----------

test('times read as minutes, hours and days; kinds have defaults a world can override', () => {
  const { E, state } = routeGame((f) => { f['world.json'].routeKinds = { rail: { time: '90m' } }; });
  const S = E.Scenario;
  assert.deepEqual([S.parseHours('45m'), S.parseHours('4h'), S.parseHours('1h30m'), S.parseHours('2d'), S.parseHours('2d 6h'), S.parseHours(1.5), S.parseHours('soon')], [0.75, 4, 1.5, 48, 54, 1.5, null]);
  assert.deepEqual([S.sayHours(0.75), S.sayHours(3.5), S.sayHours(54)], ['45m', '3h 30m', '2d 6h']);
  assert.equal(S.routeOf(state.scenario, { to: 'x', kind: 'sea' }).hours, 24);
  assert.equal(S.routeOf(state.scenario, { to: 'x' }).hours, 0, 'a border is part of the move');
  assert.equal(S.routeOf(state.scenario, { to: 'x', kind: 'mule track' }).hours, 1, 'a kind the table does not know');
  assert.equal(S.routeOf(state.scenario, { to: 'x', kind: 'rail' }).hours, 1.5, 'the world\'s routeKinds win');
  assert.equal(S.routeOf(state.scenario, { to: 'x', kind: 'rail', time: '3h' }).hours, 3, 'the route\'s own time wins');
});

test('validation: routes to real regions, readable times, the precondition grammar, in plain words', () => {
  const E = loadEngine();
  const err = (edit) => E.Scenario.prepareWorld('routes', routeFiles(edit)).starts[0].error || '';
  const route = (fn) => (f) => fn(f['world.json'].regions[1].routes[0]);
  assert.match(err(route((r) => { r.to = 'moon'; })), /Old Town's route to "moon": goes to "moon", which isn't one of the regions/);
  assert.match(err(route((r) => { r.time = 'a while'; })), /"time" must be like "45m", "4h", "1h30m" or "2d"/);
  assert.match(err(route((r) => { r.requires = { ticket: true }; })), /"requires": precondition must be one of/);
  assert.match(err(route((r) => { r.requires = { controls: { region: 'atlantis', group: null } }; })), /unknown region "atlantis"/);
  assert.match(err(route((r) => { r.speed = 'fast'; })), /unknown field "speed"/);
  assert.match(err(route((r) => { r.skill = 'flying'; })), /"skill" must be one of the world's skills/);
  assert.match(err((f) => { f['world.json'].routeKinds = { rail: { time: 'later' } }; }), /routeKinds\.rail: "time" must be like/);
  assert.equal(err(), '');
});

test('neighbours become border routes; a neighbour with a route of its own keeps it', () => {
  const E = loadEngine();
  const sc = E.Scenario.compose({ title: 't', setting: 's', regions: [
    { id: 'a', name: 'A', neighbours: ['b', 'c'] }, { id: 'b', name: 'B', neighbours: ['a'] },
    { id: 'c', name: 'C', neighbours: ['a'], routes: [{ to: 'a', kind: 'road', time: '2h' }] },
  ] }, { id: 's', cast: [] }, {}, 'x');
  assert.deepEqual(plain(sc.regions[0].routes), [{ to: 'b', kind: 'border', derived: true }], 'C\'s road to A stays the way between them');
  assert.deepEqual(plain(sc.regions[1].routes), [{ to: 'a', kind: 'border', derived: true }]);
  assert.deepEqual(plain(sc.regions[2].routes), [{ to: 'a', kind: 'road', time: '2h' }]);
});

// ---------- trips ----------

test('a multi-leg trip counts time per leg along the quickest open way', () => {
  const { E, state } = routeGame();
  const t = E.Engine.regionTrip(state, 'flat', 'city');
  assert.deepEqual(plain(t.legs.map((e) => [e.from, e.to, e.kind, e.hours])), [['flat', 'town', 'checkpoint', 0], ['town', 'city', 'rail', 3]]);
  assert.equal(t.hours, 3);
  assert.equal(E.Engine.sayTrip(state, t), 'by checkpoint to Old Town, then by rail to The City (3h)');
  assert.equal(E.Engine.regionTrip(state, 'city', 'flat').hours, 3, 'two-way unless oneWay');
  state.scenario.regions[1].routes[0].oneWay = true;
  assert.equal(E.Engine.regionTrip(state, 'city', 'flat').blocked, true);
});

test('inside the tree: a route on a region serves what is inside it, and inside counts as there', () => {
  const { E, state } = routeGame((f) => {
    f['world.json'].regions.push({ id: 'old-quarter', name: 'Old Quarter', parent: 'city' }, { id: 'harbour', name: 'Harbour', parent: 'city' });
  });
  assert.equal(E.Engine.regionTrip(state, 'flat', 'old-quarter').hours, 3, 'arriving in the city reaches its quarters');
  assert.equal(E.Engine.regionTrip(state, 'old-quarter', 'town').hours, 3, 'leaving the quarter by the city\'s rail');
  assert.deepEqual(plain(E.Engine.regionTrip(state, 'old-quarter', 'city')), { legs: [], hours: 0 });
  assert.equal(E.Engine.regionTrip(state, 'old-quarter', 'harbour').hours, 0, 'quarters with no routes of their own are next door');
});

test('an unmet requirement blocks the move with no model call beyond the scene, and the narrator is told why', async () => {
  const { E, state } = routeGame((f) => { f['world.json'].regions[1].routes[0].time = '30m'; });
  state.world.trains = 'stopped';
  const calls = travelMock(E, 'city-square');
  state.characters.sam.status.location = 'station-hall';
  const out = await E.Engine.runTurn(state, 'I take the train to the city square.', 'hour');
  assert.equal(state.characters.sam.status.location, 'station-hall');
  assert.match(guards(out, 'move blocked')[0], /the rail to The City needs trains is "running"/);
  assert.match(out.res.outcomes[0].action, /but the rail to The City needs trains is "running", so you stay in Station Hall/);
  assert.deepEqual(calls.filter((c) => /intent|site/.test(c.kind)).map((c) => c.kind), ['intent'], 'no site built, no journey');
  assert.ok(!calls.some((c) => /=== DOWNTIME/.test(c.user)));
  assert.match(calls.find((c) => c.kind === 'narrate').user, /needs trains is "running"/, 'the narrator sees why');

});

test('a risky crossing is a hard roll: through on a success; turned back and hurt on a failure', async () => {
  const play = async (d) => {
    const { E, state } = routeGame();
    state.world.papers = 'no';
    fixedRng(E, [d]);
    travelMock(E, 'station-hall');
    const out = await E.Engine.runTurn(state, 'I slip past the checkpoint to the station.', 'hour');
    return { state, out };
  };
  const ok = await play(0.99);
  assert.equal(ok.state.characters.sam.status.location, 'station-hall');
  assert.match(guards(ok.out, 'roll required')[0], /crossing: the checkpoint to Old Town needs papers is "yes"/);
  assert.equal(ok.out.res.outcomes[0].roll.dc, 16, 'hard');
  assert.equal(guards(ok.out, 'crossed').length, 1);
  const bad = await play(0.01);
  assert.equal(bad.state.characters.sam.status.location, 'living');
  assert.match(guards(bad.out, 'turned back')[0], /needs papers is "yes"; the attempt failed/);
  assert.equal(bad.state.characters.sam.status.health, 'hurt', 'failHarm');
});

test('others cannot cross a closed way, or a trip longer than the step', async () => {
  const { E, state } = routeGame();
  state.characters.jo.status.location = 'station-hall';
  state.characters.sam.status.location = 'station-hall';
  state.world.trains = 'stopped';
  travelMock(E, null, [{ id: 'jo', action: 'heads off', move_to: 'city-square' }]);
  const out = await E.Engine.runTurn(state, 'I wait.', 'hour');
  assert.equal(state.characters.jo.status.location, 'station-hall');
  assert.match(guards(out, 'move blocked').join(' '), /Jo Lindqvist → city-square: the rail to The City needs trains/);
  state.world.trains = 'running';
  travelMock(E, null, [{ id: 'jo', action: 'heads off', move_to: 'city-square' }]);
  const out2 = await E.Engine.runTurn(state, 'I wait.', 'hour');
  assert.match(guards(out2, 'move blocked').join(' '), /City Square is 3h away/);
});

test('a long trip the player did not ask for is cancelled (rule 3)', async () => {
  const { E, state } = routeGame();
  state.characters.sam.status.location = 'station-hall';
  travelMock(E, 'city-square');
  const out = await E.Engine.runTurn(state, 'I read the departures board.', 'hour');
  assert.equal(state.characters.sam.status.location, 'station-hall');
  assert.match(guards(out, 'move cancelled')[0], /a trip of 3h to City Square/);
});

// ---------- journeys ----------

test('a trip longer than the step goes as far as the step, with the time left; Jo comes along', async () => {
  const { E, state } = routeGame();
  state.characters.jo.status.location = 'living';
  travelMock(E, 'city-square', [{ id: 'jo', action: 'comes along with Sam', move_to: null }]);
  const out = await E.Engine.runTurn(state, 'Jo and I take the train to the city square.', 'hour');
  const here = state.characters.sam.status.location;
  assert.match(here, /^on-the-way/, 'past the station, on the train');
  assert.equal(state.characters.jo.status.location, here, 'she comes along');
  assert.ok(guards(out, 'travel').some((d) => /City Square is 3h 1m away; the step ends on the way, 2h 1m short/.test(d)));
  assert.equal(state.log.filter((e) => e.type === 'scene').pop().travel, 'City Square is still about 2h 1m away.');
  assert.deepEqual({ ...state.travel }, { dest: 'city-square', destName: 'City Square', turn: 1 });
});

test('the major step is the journey: the skip machinery, time per leg, arrival', async () => {
  const { E, state } = routeGame();
  state.characters.jo.status.location = 'living';
  const t0 = state.time.hour;
  const calls = travelMock(E, 'city-square');
  const out = await E.Engine.runTurn(state, 'Jo and I take the train to the city square.', 'major');
  assert.equal(state.characters.sam.status.location, 'city-square');
  assert.equal(state.characters.jo.status.location, 'city-square', 'named, so she comes along');
  assert.equal(state.time.hour, t0 + 3);
  assert.match(guards(out, 'journey').join(' '), /the turn is the journey/);
  assert.match(guards(out, 'journey').join(' '), /arrived at City Square after 3h/);
  const downtime = calls.find((c) => /=== DOWNTIME/.test(c.user));
  assert.match(downtime.user, /The downtime is a journey: travelling from Flat 4B to City Square in The City: by checkpoint to Old Town, then by rail to The City \(3h\), 3h in all, with Jo Lindqvist\./);
  assert.match(downtime.user, /ends when Sam Okoye arrives at City Square/);
  const narr = calls[calls.length - 1];
  assert.match(narr.user, /The journey's end: arriving at City Square/);
  assert.equal(state.skipStreak || 0, 0, 'a journey is not sitting things out');
});

test('a journey stops on the way when a pressure comes to a head, and goes on from there', async () => {
  const { E, state } = routeGame();
  state.clocks.forEach((c) => { c.perHour = 0; });
  state.clocks[0].perHour = 20; // the landlord, within the hour
  travelMock(E, 'city-square');
  const out = await E.Engine.runTurn(state, 'I take the train to the city square.', 'major');
  const here = state.characters.sam.status.location;
  assert.match(here, /^on-the-way/);
  const room = state.locations[here];
  assert.deepEqual([room.region, room.transit, [...room.connects]], ['town', true, ['city-square', 'living']]);
  assert.match(guards(out, 'journey').join(' '), /stopped 1h into 3h on the way to City Square/);
  assert.ok(!E.Prompts.header(state).includes(here), 'never in the header');
  // Going on: the rest of the trip, from where it stopped (R-10: no model choice of the way).
  travelMock(E, null);
  await E.Engine.runTurn(state, 'I keep going.', 'major');
  assert.equal(state.characters.sam.status.location, 'city-square');
  E.Engine.clearTransit(state);
  assert.equal(state.locations[here], undefined, 'gone once nobody is there');
});

// ---------- prompts and sites ----------

test('the user message lists routes that say more than next door: kind, time, closed and why', () => {
  const { E, state } = routeGame();
  state.world.papers = 'no';
  const user = E.Prompts.intent(state, [], 'Look around.', 'about an hour', 'hour', {});
  assert.match(user, /\nRoutes from here: Old Town \(checkpoint, closed: needs papers is "yes", but can be risked\)\n/);

  state.characters.sam.status.location = 'station-hall';
  assert.match(E.Prompts.intent(state, [], 'Look around.', 'about an hour', 'hour', {}), /\nRoutes from here: Flat 4B \(checkpoint, closed: .*\) \| The City \(rail, 3h\)/);
});

test('flat worlds keep their prompts: plain borders are not listed as routes', () => {
  const { E, state } = newGame('zombie-holdout');
  assert.ok(!/Routes from here/.test(E.Prompts.intent(state, [], 'Look.', 'about an hour', 'hour', {})));
  state.locations[state.characters[state.player].status.location].region = 'junction';
  assert.match(E.Prompts.intent(state, [], 'Look.', 'about an hour', 'hour', {}), /\nRoutes from here: Ridge \(road, 45m\)\n/);
});

test('Ares Deep: the rim road to the relay mast needs the rover', () => {
  const { E, state } = newGame('mars-station');
  assert.equal(E.Engine.regionTrip(state, 'station', 'relay-mast').hours, 24);
  state.world.rover = 'the Mule, dead in the garage';
  const t = E.Engine.regionTrip(state, 'station', 'relay-mast');
  assert.equal(t.blocked, true);
  assert.match(t.why, /the road to Relay mast needs rover is "the Mule, operational"/);
});

// ---------- saves ----------

test('old saves: neighbours become routes and site links become trips', () => {
  const { E, state } = newGame('zombie-holdout');
  const old = plain(state);
  old.version = 13;
  old.scenario.regions.forEach((r) => { delete r.routes; });
  old.locations.lot.links = [{ to: 'storefront', kind: 'route' }];
  const m = E.Engine.migrate(old);
  assert.equal(m.version, E.Engine.STATE_VERSION);
  assert.deepEqual(plain(m.scenario.regions.find((r) => r.id === 'highway-strip').routes.map((x) => [x.to, x.kind])), [['main-street', 'border'], ['residential', 'border'], ['junction', 'border']]);
  assert.equal(m.locations.lot.links[0].kind, 'trip');
  assert.equal(E.Engine.regionTrip(m, 'highway-strip', 'junction').hours, 0);
});

test('the creator keeps routes whole: renames follow them, a deleted region\'s routes go', () => {
  const E = loadEngine();
  const M = E.MapEdit;
  const world = { regions: [
    { id: 'a', name: 'A', routes: [{ to: 'b', kind: 'road', requires: { controls: { region: 'c', group: null } } }] },
    { id: 'b', name: 'B', routes: [{ to: 'c', kind: 'rail' }] },
    { id: 'c', name: 'C' },
  ] };
  M.renameRegion(world, {}, 'c', 'see', {});
  assert.deepEqual(plain(world.regions[1].routes), [{ to: 'see', kind: 'rail' }]);
  assert.equal(world.regions[0].routes[0].requires.controls.region, 'see');
  const notes = M.deleteRegion(world, {}, 'see', {});
  assert.deepEqual(plain(world.regions.map((r) => r.routes)), [[{ to: 'b', kind: 'road' }], []]);
  assert.ok(notes.some((n) => /A's route to b lost a requirement about who holds see/.test(n)), notes.join('; '));
});

test('playtest-r2-drive-to-ridge: setting out for a region by name goes there, even when the model only moved the player outside', async () => {
  const { replay } = require('./replay');
  const { state } = await replay('playtest-r2-drive-to-ridge');
  const res = state.pending.res;
  assert.ok(res.guards.some((g) => g.type === 'site region' && /the player sets out for Ridge; the model only moved them to lot/.test(g.detail)));
  assert.equal(state.sites['ridge-2'].region, 'ridge-town');
  assert.equal(state.characters.pike.status.location, 'ridge-barricade');
  assert.equal(state.characters.coleman.status.location, 'ridge-barricade', 'Dex said he was coming');
  assert.match(res.outcomes[0].action, /\(the way, planned by the engine: by road to Ridge \(45m\); leaves \+0m; arrives at Ridge Road Barricade \+47m\)/);
});

test('heading for a region by name: only when the words set out, and not when the move already goes there', () => {
  const { E, state } = newGame('zombie-holdout');
  const ST = E.Sites;
  assert.equal(ST.regionHeadedFor(state, 'lot', 'I drive to Ridge.').id, 'ridge-town');
  assert.equal(ST.regionHeadedFor(state, null, 'What do people say about Ridge?'), null, 'talking about it is not going');
  assert.equal(ST.regionHeadedFor(state, 'lot', 'I head out to the highway strip.'), null, 'already there');
  assert.equal(ST.regionHeadedFor(state, 'lot', 'I head back into Harmon.'), null, 'a region the player is inside');
});
