// The Oregon Trail, 1866 (task 7-7): one story, a wagon company going west
// from Council Bluffs to a gold camp nobody else knows about, and making it
// a town. The engine work it brought: timeline events that happen on
// arrival and the "reached" condition (the trail's stages and its
// deadlines); a place that travels (the camp moves as one, by wagon roads
// only, and only its leader can turn it off its road); journeys that stop
// at a stage of the way; far-off news that no longer stops a journey; lots
// built on by the "build" effect, and the "built" condition.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, newGame, mockLLM, fixedRng } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));
// A start's game, with the made character for the emigrant start.
function game(startId) {
  if (startId !== 'emigrant') return newGame('oregon-trail', startId || 'captain');
  const E = loadEngine();
  const loaded = readWorld('oregon-trail', E);
  const sc = loaded.starts.find((x) => x.id === 'emigrant').scenario;
  return { E, state: E.Engine.newGame(E.Scenario.startScenario(loaded, 'emigrant', E.CharMaker.sample(sc))) };
}
// The model for a journey: a quiet montage, nothing major.
function travelMock(E) {
  return mockLLM(E, (call) => {
    if (call.kind === 'intent' && /=== DOWNTIME/.test(call.user)) return { montage: [{ after: '1d', text: 'The wagons roll on up the Platte.' }], events: [], major_event: null, positions: [], player_where: null };
    if (call.kind === 'intent') return { player: { summary: 'go' }, intents: [], events: [] };
    if (call.kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    if (call.kind === 'chapter') return { title: 'x', summary: 'y' };
    return '[+0m] The wagons roll.';
  });
}
const guards = (out, type) => out.res.guards.filter((g) => g.type === type).map((g) => g.detail);
const campRegion = (state) => state.locations['camp-fire'].region;
// No random major event on the way: the dice say "a long time from now".
const calm = (E) => fixedRng(E, [0.9999]);

// ---------- the world ----------

test('The Oregon Trail has three starts: the captain who leads the company, an emigrant of your own in it, and the guide outside it', () => {
  const E = loadEngine();
  const w = readWorld('oregon-trail', E);
  assert.deepEqual([...w.warnings], []);
  assert.deepEqual(w.starts.map((s) => s.id), ['captain', 'emigrant', 'guide']);
  assert.ok(!w.generate, 'one story: no generated starts');
  assert.equal(w.starts.find((s) => s.id === 'emigrant').scenario.player, undefined, 'the emigrant is always your own');
  assert.ok(w.starts.every((s) => s.slot), 'every start has Make my own');
  const cap = game('captain');
  assert.equal(cap.E.Standing.roleOf(cap.state, 'company'), 'leader');
  assert.equal(cap.state.characters.lebeau.groups, undefined, 'the guide is hired, not one of the company');
  const guide = game('guide');
  assert.equal(guide.state.player, 'lebeau');
  assert.equal(guide.E.Standing.roleOf(guide.state, 'company'), null);
  const emi = game('emigrant');
  assert.equal(emi.E.Standing.roleOf(emi.state, 'company'), 'member');
  assert.equal(emi.state.characters.mercer.groups[0].role, 'leader', 'Mercer is the captain');
});

test('the trail\'s stages happen on arrival: due once the player has reached the place, never by date, and the start counts as reached', () => {
  const { E, state } = game('captain');
  const TL = E.Timeline;
  const ev = TL.all(state).find((e) => e.id === 'stage-fort-laramie');
  assert.ok(TL.arrival(ev));
  assert.equal(TL.fmt(state.scenario, ev.when), 'on reaching Fort Laramie');
  assert.deepEqual([...state.reached].sort(), ['nebraska', 'omaha', 'plains', 'united-states']);
  assert.ok(!TL.due(state, 24 * 365).some((d) => d.ev.id === 'stage-fort-laramie'), 'not due by date, however far ahead');
  assert.ok(!TL.next(state) || TL.next(state).id !== 'stage-fort-laramie', 'never the next stop of a skip by date');
  E.Engine.noteReached(state, 'fort-laramie');
  assert.ok(state.reached.includes('dakota'), 'and the regions it is inside');
  assert.ok(TL.due(state, 0).some((d) => d.ev.id === 'stage-fort-laramie'));
});

test('arrival events and "reached" are checked in plain words', () => {
  const E = loadEngine();
  const refs = { regions: new Set(['fort-laramie']), characters: new Set(), groups: new Set(), effectKeys: Object.keys(E.Engine.EFFECTS), places: new Set(['gulch']) };
  const ev = (o) => Object.assign({ id: 'e', scope: 'regional', region: 'fort-laramie', text: 'x' }, o);
  assert.deepEqual([...E.Timeline.problems([ev({ when: { reach: 'fort-laramie' } })], 'w', refs, [])], []);
  assert.match(E.Timeline.problems([ev({ when: { reach: 'nowhere' } })], 'w', refs, []).join(' '), /no region "nowhere" to reach/);
  assert.match(E.Timeline.problems([ev({ when: { reach: 'fort-laramie', day: 3, hour: 1 } })], 'w', refs, []).join(' '), /not both/);
  assert.match(E.Timeline.problems([ev({ when: { day: 3, hour: 1 }, preconditions: [{ reached: 'nowhere' }] })], 'w', refs, []).join(' '), /"reached": unknown region/);
  assert.match(E.Timeline.problems([ev({ when: { day: 3, hour: 1 }, preconditions: [{ built: { place: 'gulch', atLeast: 0 } }] })], 'w', refs, []).join(' '), /"built" must be/);
  assert.match(E.Timeline.problems([ev({ when: { day: 3, hour: 1 }, preconditions: [{ built: { place: 'town', atLeast: 2 } }] })], 'w', refs, []).join(' '), /no place "town"/);
});

test('a deadline: late to Fort Laramie and the grass is grazed out; there in time, it never happens', () => {
  const { E, state } = game('captain');
  const ev = E.Timeline.all(state).find((e) => e.id === 'late-for-laramie');
  assert.deepEqual([...E.Timeline.broken(state, ev)], []);
  E.Engine.noteReached(state, 'fort-laramie');
  assert.deepEqual([...E.Timeline.broken(state, ev)], ['not: the player has reached Fort Laramie']);
});

// ---------- the camp travels ----------

test('the camp travels as one: by wagon road only, everyone and everything in it along, and the stage of the trail it reaches happens', async () => {
  const { E, state } = game('captain');
  calm(E);
  // By stage Fort Kearny is two days; the company's oxen take twelve.
  assert.equal(E.Engine.regionTrip(state, 'omaha', 'fort-kearny').hours, 48);
  assert.equal(E.Engine.regionTrip(state, 'omaha', 'fort-kearny', { kinds: E.Engine.travelOf(state, 'camp').kinds }).hours, 12 * 24);
  const before = Object.fromEntries(Object.values(state.characters).map((c) => [c.id, c.status.location]));
  travelMock(E);
  const out = await E.Engine.runTurn(state, 'We roll out for Fort Kearny.', 'hour');
  assert.equal(campRegion(state), 'fort-kearny');
  assert.equal(E.Engine.playerRegion(state), 'fort-kearny');
  assert.equal(state.time.day, 1582 + 12);
  assert.match(guards(out, 'journey').join(' '), /the camp reached Fort Kearny after 12d/);
  // Nobody changed rooms: the rooms went west.
  Object.values(state.characters).filter((c) => !state.waiting[c.id]).forEach((c) => assert.equal(c.status.location, before[c.id], c.id));
  assert.equal(state.standees['company-families'].location, 'camp-circle');
  assert.equal(state.sites.camp.region, 'fort-kearny');
  assert.equal(state.canon['stage-fort-kearny'].status, 'fired', 'Fort Kearny\'s stage happened on arrival');
  assert.ok(state.reached.includes('fort-kearny'));
  assert.match(E.Prompts.header(state), /In The company camp \(travels with its people\)/);
});

test('a journey stops at the first stage of the trail on the way, and the stage is what happens', async () => {
  const { E, state } = game('captain');
  calm(E);
  travelMock(E);
  const out = await E.Engine.runTurn(state, 'We head out for Fort Laramie.', 'hour');
  assert.equal(campRegion(state), 'fort-kearny');
  assert.match(guards(out, 'journey').join(' '), /the camp stopped 12d into 38d on the way to Fort Laramie, at Fort Kearny/);
  assert.equal(state.canon['stage-fort-kearny'].status, 'fired');
  assert.ok(!state.canon['stage-fort-laramie']);
});

test('only the captain can turn the company off its road; an emigrant can only go along it', () => {
  const emi = game('emigrant');
  const step = { id: 'hour', hours: 1 };
  const off = emi.E.Engine.campJourneyFor(emi.state, { player: {} }, 'We head out for St. Joseph.', step);
  assert.match(off.refused, /The Mercer company is heading for Oregon City; only its leader can turn it toward St\. Joseph/);
  const on = emi.E.Engine.campJourneyFor(emi.state, { player: {} }, 'We roll on to Fort Kearny.', step);
  assert.equal(on.destRegion, 'fort-kearny');
  const cap = game('captain');
  assert.equal(cap.E.Engine.campJourneyFor(cap.state, { player: {} }, 'We head out for St. Joseph.', step).destRegion, 'st-joseph');
  // Alone ("I ride ahead"), the camp stays: that is a trip of the player's own.
  assert.equal(cap.E.Engine.campJourneyFor(cap.state, { player: {} }, 'I ride ahead to Fort Kearny.', step), null);
});

test('a refused move leaves the camp where it is and builds nothing', async () => {
  const { E, state } = game('emigrant');
  calm(E);
  const calls = travelMock(E);
  const out = await E.Engine.runTurn(state, 'We head out for St. Joseph.', 'hour');
  assert.equal(campRegion(state), 'omaha');
  assert.match(guards(out, 'camp stays').join(' '), /only its leader can turn it/);
  assert.ok(!calls.some((c) => /worldbuild/.test(c.kind)), 'no place built at St. Joseph');
});

test('news from far away no longer stops a journey: a riot in Memphis is heard later, the treaty council at Fort Laramie stops you there', () => {
  const { E, state } = game('captain');
  const next = () => (E.Timeline.next(state) || {}).id;
  assert.notEqual(next(), 'memphis-riot', 'Tennessee is far from Council Bluffs');
  E.Engine.moveCamp(state, 'camp', 'fort-laramie');
  state.time.day = E.dayOfDate(state.scenario, '1866-06-10');
  assert.equal(next(), 'red-cloud-walks-out');
});

// ---------- the gulch ----------

test('the gulch stays hidden, rooms and all, until the player learns of it; then the company can go, and its two discoverers are there', async () => {
  const { E, state } = game('captain');
  calm(E);
  assert.ok(!/Poorman|poorman-/.test(E.Prompts.header(state)), 'no hidden room in the header');
  const step = { id: 'hour', hours: 1 };
  assert.equal(E.Engine.campJourneyFor(state, { player: {} }, 'We roll on to Poorman\'s Gulch.', step), null, 'nobody knows where that is');
  assert.ok(!state.characters['michael-doyle'] || state.waiting['michael-doyle'], 'Michael waits for the company');
  // Martha tells the captain.
  E.Memory.addFact(state, { about: ['martha-doyle'], text: 'Martha\'s brother struck gold at Poorman\'s Gulch, a day north of South Pass.', known_by: [state.player, 'martha-doyle'], weight: 2 });
  E.Engine.revealAround(state, { guards: [] });
  assert.ok(E.Engine.regionKnown(state, 'poormans-gulch'));
  E.Engine.moveCamp(state, 'camp', 'south-pass');
  travelMock(E);
  await E.Engine.runTurn(state, 'We roll on to Poorman\'s Gulch.', 'hour');
  assert.equal(campRegion(state), 'poormans-gulch');
  assert.equal(state.canon['gulch-reached'].status, 'fired');
  assert.ok(state.characters['michael-doyle'] && !state.waiting['michael-doyle'], 'the discoverers come into the story');
});

test('building the town: a lot is built on only once someone holds the gulch, never twice, never by the update step; four buildings and the company\'s hold end the story well', () => {
  const { E, state } = game('captain');
  const res = { guards: [] };
  const build = (b) => E.Engine.applyEffects(state, { build: [b] }, 'regional', res, {});
  assert.deepEqual([...build({ room: 'poorman-lot-1', name: 'Assay office' })], []);
  assert.match(res.guards.map((g) => g.detail).join(' '), /nobody holds Poorman's Gulch yet: the town isn't founded/);
  E.Engine.applyEffects(state, { control: [{ region: 'poormans-gulch', to: 'company' }] }, 'regional', res, { authored: true });
  assert.match(build({ room: 'poorman-lot-1', name: 'Assay office', desc: 'A log office with scales and a strongbox.' }).join(' '), /Assay office is built \(Lot 1\)/);
  assert.equal(state.locations['poorman-lot-1'].name, 'Assay office');
  assert.equal(state.features['poorman-lot-1|lot'], 'built');
  build({ room: 'poorman-lot-1', name: 'Saloon' });
  assert.match(res.guards.map((g) => g.detail).join(' '), /Assay office is already built on/);
  build({ room: 'poorman-street', name: 'Saloon' });
  assert.match(res.guards.map((g) => g.detail).join(' '), /"poorman-street" is not a lot/);
  assert.match(build({ room: 'poorman-lot-2', name: 'Doyle\'s store', as: 'tent' }).join(' '), /goes up in canvas/);
  assert.equal(E.Engine.builtLots(state, 'poormans-gulch'), 1, 'a tent isn\'t a building yet');
  // The update step can't put a building up by changing the lot's state.
  state.characters[state.player].status.location = 'poorman-lot-3';
  const upd = { guards: [] };
  E.Engine.applyUpdate(state, { state: [{ kind: 'feature', key: 'poorman-lot-3|lot', field: 'state', value: 'built' }] }, upd, { startLoc: 'poorman-lot-3', endLoc: 'poorman-lot-3', present: [] });
  assert.equal(state.features['poorman-lot-3|lot'], 'staked');
  // Four buildings, and the company holds the gulch: the town stands.
  assert.equal(E.Engine.checkEndings(state, res), null);
  ['Doyle\'s store', 'Saloon', 'Livery'].forEach((name, i) => build({ room: `poorman-lot-${i + 2}`, name }));
  assert.equal(E.Engine.builtLots(state, 'poormans-gulch'), 4);
  assert.equal((E.Engine.checkEndings(state, res) || {}).id, 'a-town-stands');
});

test('a lot is checked in plain words, and a place that travels too', () => {
  const E = loadEngine();
  const w = readWorld('oregon-trail', E);
  const sc = E.clone(w.starts[0].scenario);
  sc.locations.find((l) => l.id === 'camp-fire').lot = 'yes';
  assert.throws(() => E.Scenario.validate(E.clone(sc)), /"lot" must be true, on a room in a place/ );
  const sc2 = E.clone(w.starts[0].scenario);
  sc2.siteInfo.camp.travel.toward = 'atlantis';
  assert.throws(() => E.Scenario.validate(sc2), /"travel" must be \{group/);
});

test('the model is offered "build" only in a place whose region someone holds, with its free lots named', () => {
  const { E, state } = game('captain');
  const offered = () => {
    const u = E.Prompts.intent(state, [], 'We start on the assay office.', 'about an hour', 'hour', { regional: true });
    return /"build":\[\{"room":"one of: ([^"]*)"/.exec(typeof u === 'string' ? u : u.user);
  };
  E.Engine.moveCamp(state, 'camp', 'poormans-gulch');
  E.Engine.revealRegion(state, 'poormans-gulch', null, '');
  state.characters[state.player].status.location = 'poorman-street';
  assert.equal(offered(), null, 'not before the town is founded');
  E.Engine.applyEffects(state, { control: [{ region: 'poormans-gulch', to: 'company' }] }, 'regional', { guards: [] }, { authored: true });
  E.Engine.applyEffects(state, { build: [{ room: 'poorman-lot-1', name: 'Assay office' }] }, 'regional', { guards: [] }, {});
  assert.equal(offered()[1], 'poorman-lot-2, poorman-lot-3, poorman-lot-4, poorman-lot-5, poorman-lot-6');
  state.characters[state.player].status.location = 'camp-fire';
  assert.equal(offered(), null, 'only there');
});
