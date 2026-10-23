// Generated sites (task 4-4): a place the story goes that the map doesn't
// have is built by the engine (library map first), joined by a route, and
// kept or faded. Rule 4 still holds: moves follow links, locked doors stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, readWorld, newGame, mockLLM } = require('./helpers');
const { replies, stepOf } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));
const CHROME = path.join(__dirname, 'fixtures', 'chrome-district');

// A turn's replies: the intent (with the player's new_place), the site
// steps from the shared mock, narration and an empty update.
function turnMock(E, intentPlayer, over = {}) {
  const r = replies(over);
  return mockLLM(E, (call) => {
    const step = stepOf(call.user);
    if (step) { const v = r[step]; return typeof v === 'function' ? v(call.user, call) : v; }
    if (call.kind === 'intent') return over.intent || { player: Object.assign({ summary: 'go' }, intentPlayer), intents: [], events: [] };
    if (call.kind === 'update') return over.update || { facts: [], state: [], relations: [], player_attitude: [] };
    if (call.kind === 'chapter') return { title: 'x', summary: 'y' };
    return '[+0m] You make your way there through the rain.';
  });
}
const PHARMACY = { new_place: { name: 'the pharmacy', kind: 'pharmacy', region: 'main-street' } };

test('generatedSites and library maps are checked when the world loads', () => {
  const E = loadEngine();
  assert.equal(readWorld('zombie-holdout', E).starts[0].scenario.generatedSites.keepDays, 3);
  assert.equal(readWorld('mars-station', E).starts[0].scenario.generatedSites, undefined, 'Ares Deep is a closed station');
  const { worldFiles } = require('./helpers');
  const f = worldFiles(CHROME);
  f['world.json'].generatedSites.maxSites = 99;
  assert.throws(() => E.Scenario.prepareWorld('chrome', f), /"maxSites" must be a whole number from 1 to 30/);
  const g = worldFiles(CHROME);
  g['sites/chop-shop.json'].rooms[0].links[0].to = 'nowhere';
  g['sites/chop-shop.json'].license = '';
  assert.throws(() => E.Scenario.prepareWorld('chrome', g), /needs "credit" and "license"[\s\S]*links to unknown "nowhere"/);
  const h = worldFiles(CHROME);
  delete h['sites/chop-shop.json'];
  assert.throws(() => E.Scenario.prepareWorld('chrome', h), /missing sites\/chop-shop\.json/);
});

test('a trip to a new place builds one checked site, joined by a route, and the player arrives at its entry', async () => {
  const { E, state } = newGame('zombie-holdout');
  const calls = turnMock(E, PHARMACY);
  const out = await E.Engine.runTurn(state, 'I head to the pharmacy on Main Street for antibiotics.', 'hour');
  assert.deepEqual(calls.map((c) => c.kind).slice(0, 3), ['intent', 'worldbuild (site: the pharmacy)', 'worldbuild (site people: the pharmacy)']);
  assert.equal(calls[1].system, calls[0].system, 'the turn\'s header: the cache holds');
  const site = state.sites.pharmacy;
  assert.equal(site.region, 'main-street');
  assert.deepEqual([...site.rooms], ['storefront', 'behind-counter', 'drug-room']);
  assert.equal(state.locations.storefront.site, 'pharmacy');
  assert.equal(state.locations.storefront.region, 'main-street');
  assert.ok(state.locations['drug-room'].secure, 'one way in: still secure');
  assert.deepEqual(plain(state.locations.lot.links).find((k) => k.kind === 'trip'), { to: 'storefront', kind: 'trip' }, 'the route leaves from open ground, not the roof');
  assert.equal(E.Engine.linkInfo(state, 'lot', 'storefront').kind, 'trip');
  assert.equal(state.characters.pike.status.location, 'storefront', 'arrives at the entry');
  assert.deepEqual(plain(state.extras['dale-ruiz']).location, 'behind-counter');
  assert.equal(state.standees.dead.location, 'storefront');
  assert.ok(out.res.guards.some((g) => g.type === 'site built' && /the pharmacy \(pharmacy, main-street\): Pharmacy Storefront, Behind the Counter, Drug Room; 1 people, 1 groups/.test(g.detail)));
  assert.equal(site.visits, 1);
  assert.ok(state.pending.pre.sites.pharmacy && state.pending.pre.locations.storefront, 'a step-in rewinds to a copy that has the site');
  // going back home and returning use the route, no new calls
  const again = turnMock(E, { move_to: 'lot' });
  await E.Engine.runTurn(state, 'I go back to the lot.', 'hour');
  assert.equal(state.characters.pike.status.location, 'lot');
  turnMock(E, { new_place: { name: 'the pharmacy', kind: 'pharmacy' } });
  await E.Engine.runTurn(state, 'Back to the pharmacy.', 'hour');
  assert.equal(state.characters.pike.status.location, 'storefront');
  assert.ok(!again.some((c) => /worldbuild \(site/.test(c.kind)));
  assert.equal(state.sites.pharmacy.kept, true, 'a second visit keeps it');
});

test('the engine refuses: a closed way, not in the player\'s words, a locked door on the way out, or a world that builds no places', async () => {
  const play = async (folder, player, action, setup) => {
    const { E, state } = newGame(folder);
    if (setup) setup(state);
    const calls = turnMock(E, player);
    const out = await E.Engine.runTurn(state, action, 'hour');
    return { state, calls, guards: out.res.guards.filter((g) => /^site/.test(g.type)).map((g) => `${g.type}: ${g.detail}`) };
  };
  // Every way to Ridge needs fuel (R-2: far places are trips; closed ways refuse).
  const noFuel = (s) => s.scenario.regions.forEach((r) => (r.routes || []).forEach((x) => { if (x.to === 'ridge-town' || r.id === 'ridge-town') x.requires = { world: 'fuel', is: 'yes' }; }));
  const far = await play('zombie-holdout', { new_place: { name: 'Ridge', kind: 'town', region: 'ridge-town' } }, 'I drive to Ridge.', noFuel);
  assert.match(far.guards[0], /site refused: Ridge: the road to Ridge needs fuel is "yes"/);
  assert.equal(far.state.characters.pike.status.location, 'floor');
  const unasked = await play('zombie-holdout', { new_place: { name: 'the church', kind: 'church', region: 'main-street' } }, 'I look around the store.');
  assert.match(unasked.guards[0], /don't name "the church"/);
  const locked = await play('zombie-holdout', PHARMACY, 'I head out to the pharmacy.', (s) => { s.characters.pike.status.location = 'office'; });
  assert.match(locked.guards[0], /site refused: the pharmacy: the door between Manager's Office and Sales Floor is locked/);
  assert.ok(!locked.calls.some((c) => /site/.test(c.kind)), 'no calls for a place the player can\'t set out for');
  const mars = await play('mars-station', { new_place: { name: 'the old lander', kind: 'wreck' } }, 'I walk to the old lander.');
  assert.match(mars.guards[0], /not a place on the map \(this world doesn't build new places\)/);
  assert.equal(Object.keys(mars.state.sites).length, 0);
});

test('a group never crosses a route', async () => {
  const { E, state } = newGame('zombie-holdout');
  turnMock(E, PHARMACY);
  await E.Engine.runTurn(state, 'I head to the pharmacy on Main Street.', 'hour');
  state.standees.dead.state = 'hostile';
  const intent = { player: { summary: 'wait' }, intents: [], events: [], group_intents: [{ id: 'dead', action: 'shamble after you', move_to: 'lot' }] };
  turnMock(E, {}, { intent });
  const out = await E.Engine.runTurn(state, 'I wait by the window.', 'moment');
  assert.ok(out.res.guards.some((g) => g.type === 'standee move' && /groups stay in their own place|not linked/.test(g.detail)));
  assert.equal(state.standees.dead.location, 'storefront');
});

test('a library map is used when one fits: its layout kept, the model fills in people and names; the pick is the same every time', async () => {
  const run = async () => {
    const E = loadEngine();
    const state = E.Engine.newGame(E.Scenario.startScenario(readWorld(CHROME, E)));
    const calls = turnMock(E, { new_place: { name: "the Saints' chop shop", kind: 'chop shop', region: 'docks' } }, {
      siteOccupants: { people: [{ name: 'Vex', role: 'runs the chop shop', room: 'office', note: 'keeps the ledger on the terminal' }],
        groups: [{ label: 'Chrome Saints', count: 2, room: 'loading-bay', state: 'alert', faction: 'saints', post: true }, { label: 'Saints off duty', count: 3, room: 'crew-lounge', state: 'calm', faction: 'saints' }],
        note: 'The ledger is on the office terminal.', rooms: [{ id: 'crew-lounge', name: 'Break Room' }] },
    });
    const out = await E.Engine.runTurn(state, "We hit the Saints' chop shop tonight, through the back.", 'hour');
    return { E, state, calls, out };
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a.calls.map((c) => c.kind).slice(0, 2), ['intent', "worldbuild (site people: the Saints' chop shop)"], 'no layout call');
  const s = a.state.sites['saints-chop-shop'];
  assert.equal(s.map, 'chop-shop');
  assert.deepEqual([...s.rooms], ['loading-bay', 'garage-floor', 'office', 'stash-cage', 'crew-lounge', 'roof']);
  assert.equal(a.state.locations['crew-lounge'].name, 'Break Room', 'renamed by the model, same id');
  assert.equal(E_linkKind(a), 'locked door');
  assert.equal(a.E.Engine.linkInfo(a.state, 'roof', 'office').kind, 'vent', '"through the roof vent into the office" is a real way in');
  assert.ok(a.state.locations['stash-cage'].secure);
  assert.deepEqual(plain(a.E.Sites.entrances(a.state).filter((e) => e.watched).map((e) => e.room)), ['loading-bay']);
  assert.deepEqual(plain(a.state.standees['chrome-saints']).post, 'loading-bay');
  assert.equal(a.state.standees['chrome-saints'].faction, 'saints');
  assert.equal(a.state.locations['back-alley'].links.find((k) => k.kind === 'trip').to, 'loading-bay', 'the route leaves from the alley');
  assert.ok(a.out.res.guards.some((g) => g.type === 'site note' && /library map "chop-shop" \(Ensemble/.test(g.detail)));
  assert.deepEqual(plain(b.state.sites['saints-chop-shop'].rooms), plain(s.rooms), 'the same map on a reload');
  function E_linkKind(r) { return r.E.Engine.linkInfo(r.state, 'garage-floor', 'office').kind; }
});

test('an event makes a place known; the first visit builds it', async () => {
  const { E, state } = newGame('zombie-holdout');
  const intent = { player: { summary: 'wait' }, intents: [], events: [{ text: 'A radio voice says a church on Main Street is taking in survivors.', scope: 'regional', region: 'main-street', visibility: 'heard',
    effects: { new_site: { name: 'St. Brigid\'s church', kind: 'church', region: 'main-street', why: 'a radio broadcast' } } }] };
  turnMock(E, {}, { intent });
  state.scenario.eventRates = { regional: 0.01, world: 0 };
  await E.Engine.runTurn(state, 'I listen to the radio.', 'hour');
  const stub = Object.values(state.sites)[0];
  assert.ok(stub && stub.stub, 'a stub: no rooms yet');
  assert.equal(stub.name, "St. Brigid's church");
  const header = E.Prompts.intent(state, E.Engine.present(state), 'x', 'an hour', 'hour', {});
  assert.match(header, /Places the story knows of: St\. Brigid's church \(church, main-street; not visited yet\)/);
  const calls = turnMock(E, { new_place: { name: "St. Brigid's church" } });
  await E.Engine.runTurn(state, "Let's go to St. Brigid's church.", 'hour');
  assert.ok(calls.some((c) => /worldbuild \(site: St\. Brigid's church\)/.test(c.kind)));
  const built = Object.values(state.sites)[0];
  assert.equal(built.stub, undefined);
  assert.equal(state.characters.pike.status.location, built.entry);
});

test('a site with nothing notable fades after keepDays and comes back from its stub; a notable fact keeps one', async () => {
  const { E, state } = newGame('zombie-holdout');
  turnMock(E, PHARMACY);
  await E.Engine.runTurn(state, 'I head to the pharmacy on Main Street.', 'hour');
  turnMock(E, { move_to: 'lot' });
  await E.Engine.runTurn(state, 'Back to the lot.', 'hour');
  assert.ok(state.locations.storefront);
  state.time.day += 4;
  const faded = E.Sites.fade(state);
  assert.match(faded[0], /the pharmacy faded/);
  assert.equal(state.locations.storefront, undefined);
  assert.ok(!state.locations.lot.connects.includes('storefront') && !state.locations.lot.links.some((k) => k.kind === 'trip'));
  assert.equal(state.extras['dale-ruiz'], undefined);
  assert.equal(state.standees.dead, undefined);
  assert.match(state.sites.pharmacy.summary, /visited once, last on Day 23; met Dale Ruiz/);
  const calls = turnMock(E, PHARMACY);
  await E.Engine.runTurn(state, 'I head back to the pharmacy.', 'hour');
  assert.match(calls.find((c) => /worldbuild \(site: /.test(c.kind)).user, /The player has been here before: visited once, last on Day 23; met Dale Ruiz/);
  assert.equal(state.characters.pike.status.location, 'storefront');

  // A notable fact while there keeps it.
  const k = newGame('zombie-holdout');
  turnMock(k.E, PHARMACY);
  await k.E.Engine.runTurn(k.state, 'I head to the pharmacy on Main Street.', 'hour');
  turnMock(k.E, { move_to: 'lot' }, { update: { facts: [{ about: ['pike'], text: 'Jordan found antibiotics in the pharmacy drug room.', known_by: ['pike'], weight: 2 }], state: [], relations: [], player_attitude: [] } });
  const out = await k.E.Engine.runTurn(k.state, 'Back to the lot.', 'hour');
  assert.ok(k.state.sites.pharmacy.kept);
  assert.ok(out.report.applied !== undefined);
  k.state.time.day += 10;
  assert.deepEqual([...k.E.Sites.fade(k.state)], []);
  assert.ok(k.state.locations.storefront);
});

test('saves round-trip; older saves migrate; undo puts the map back', async () => {
  const { E, state } = newGame('zombie-holdout');
  turnMock(E, PHARMACY);
  await E.Engine.runTurn(state, 'I head to the pharmacy on Main Street.', 'hour');
  const loaded = E.Engine.migrate(JSON.parse(JSON.stringify(state)));
  assert.equal(loaded.sites.pharmacy.entry, 'storefront');
  assert.equal(loaded.locations.storefront.site, 'pharmacy');
  const old = JSON.parse(JSON.stringify(newGame('zombie-holdout').state));
  old.version = 11;
  delete old.sites;
  assert.deepEqual(plain(E.Engine.migrate(old).sites), {});
  E.Engine.undo(state);
  assert.equal(state.sites.pharmacy, undefined);
  assert.equal(state.locations.storefront, undefined);
  assert.equal(state.characters.pike.status.location, 'floor');
});

test('the map and prompts: rooms made in play are in the user message, never the header', async () => {
  const { E, state } = newGame('zombie-holdout');
  const header = E.Prompts.header(state);
  turnMock(E, PHARMACY);
  await E.Engine.runTurn(state, 'I head to the pharmacy on Main Street.', 'hour');
  assert.equal(E.Prompts.header(state).split('=== CHAPTERS')[0].includes('Pharmacy'), false);
  assert.equal(E.Prompts.header(state).startsWith(header.split('\n=== ESTABLISHED FACTS')[0].split('\n=== STORY SO FAR')[0]), true, 'the header only grows at its end');
  const intent = E.Prompts.intent(state, E.Engine.present(state), 'x', 'an hour', 'hour', {});
  assert.match(intent, /the pharmacy has these rooms: storefront \(Pharmacy Storefront\), behind-counter \(Behind the Counter\), drug-room \(Drug Room\)/);
  assert.match(intent, /Ways from here: [^\n]*Parking Lot \(the way to Parking Lot\)|Ways from here: [^\n]*\(the way to/);
  assert.deepEqual(plain(E.Sites.trips(state, 'pharmacy').map((r) => r.to)), ['lot']);
});

// ---------- from the first API runs (2026-10-22, DeepSeek V4.1 Flash) ----------
const { replay } = require('./replay');

test('playtest-api-chop-shop: someone who says they come along goes with the player', async () => {
  const r = await replay('playtest-api-chop-shop');
  assert.equal(r.state.characters.rook.status.location, 'loading-bay');
  assert.equal(r.state.characters.juno.status.location, 'loading-bay', '"pulls on her coat to come along"');
  const last = r.steps[r.steps.length - 1].result;
  assert.ok(last.res.guards.some((g) => g.type === 'came along' && /Juno Park/.test(g.detail)));
});

test('playtest-api-chop-shop: a patrol given as a path walks it out and back', async () => {
  const r = await replay('playtest-api-chop-shop');
  const g = r.state.standees['corner-patrol'];
  assert.deepEqual(plain(g.patrol), ['loading-bay', 'garage-floor', 'crew-lounge', 'garage-floor']);
  const E = r.E;
  const seen = [];
  for (let h = 0; h < 5; h++) { E.Engine.advanceTime(r.state, 1, { events: [] }); seen.push(r.state.standees['corner-patrol'].location); }
  assert.deepEqual(seen, ['crew-lounge', 'garage-floor', 'loading-bay', 'garage-floor', 'crew-lounge'], 'back to the start, not stuck between the last two (the turn already carried part of an hour)');
});

test('playtest-api: "enact the plan" can go where the player\'s last action named', async () => {
  const E = loadEngine();
  const state = E.Engine.newGame(E.Scenario.startScenario(readWorld(CHROME, E)));
  turnMock(E, {});
  await E.Engine.runTurn(state, "We hit the Saints' chop shop tonight. Mags puts a drone on the roof and I go in through the vent.", 'hour');
  turnMock(E, { new_place: { name: "the Saints' chop shop", kind: 'chop shop', region: 'docks' } }, { siteOccupants: { people: [], groups: [] } });
  await E.Engine.runTurn(state, 'enact the plan', 'hour');
  assert.equal(state.characters.rook.status.location, 'loading-bay');
  // Not when this action doesn't refer back to anything.
  const k = loadEngine();
  const s2 = k.Engine.newGame(k.Scenario.startScenario(readWorld(CHROME, k)));
  turnMock(k, {});
  await k.Engine.runTurn(s2, "We hit the Saints' chop shop tonight.", 'hour');
  turnMock(k, { new_place: { name: "the Saints' chop shop", kind: 'chop shop', region: 'docks' } });
  const out = await k.Engine.runTurn(s2, 'I check my gear.', 'hour');
  assert.equal(s2.characters.rook.status.location, 'main-room');
  assert.ok(out.res.guards.some((g) => g.type === 'site refused'));
});

test('playtest-api-kessler-lobby: the people prompt shows each link\'s kind from both sides', async () => {
  const r = await replay('playtest-api-kessler-lobby');
  const s = r.state;
  assert.equal(r.E.Engine.linkInfo(s, 'service-corridor', 'lobby-atrium').kind, 'locked door');
  const layout = { rooms: r.E.Sites.rooms(s, 'kessler-tower-lobby'), entry: 'lobby-atrium' };
  const text = r.E.Prompts.siteOccupants(s, { name: 'Kessler Tower Lobby', kind: 'corporate lobby', region: 'uptown' }, layout, false);
  assert.match(text, /- service-corridor: [^\n]*locked door to lobby-atrium/);
  assert.match(text, /- security-gate: [^\n]*door to service-corridor/);
  assert.doesNotMatch(text, /route/, 'the route home is not part of the place');
});

test('playtest-r2-ridge: a place named after a region is in that region, so the trip takes the road there', async () => {
  const RIDGE = { new_place: { name: 'Ridge', kind: 'town', region: 'highway-strip' } };
  const go = async (step) => {
    const { E, state } = newGame('zombie-holdout');
    const calls = turnMock(E, RIDGE);
    const out = await E.Engine.runTurn(state, 'I drive to Ridge', step);
    return { E, state, out, calls };
  };
  const hour = await go('hour');
  const site = Object.values(hour.state.sites)[0];
  assert.equal(site.region, 'ridge-town', 'not the player\'s own region');
  assert.ok(hour.out.res.guards.some((g) => g.type === 'site region' && /"Ridge" is Ridge, not The highway strip/.test(g.detail)));
  assert.equal(hour.E.Engine.regionOf(hour.state, hour.state.characters.pike.status.location), 'ridge-town');
  assert.match(hour.out.res.outcomes[0].action, /\(the way: by road to Ridge \(45m\)\)/);
  // Shorter than the trip: the turn is the journey, and it gets there.
  const moment = await go('moment');
  assert.ok(moment.out.res.guards.some((g) => g.type === 'journey' && /arrived at .* after 45m/.test(g.detail)), moment.out.res.guards.map((g) => g.type).join(', '));
  assert.ok(moment.calls.some((c) => /The downtime is a journey: travelling from The highway strip to .* in Ridge: .*by road to Ridge \(45m\)/.test(c.user)));
});
