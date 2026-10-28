// Site rules (task 3-6): the engine plays by the map. Moves follow links and
// stop at locked doors (unless you hold the key); picking a lock rolls; doors
// open and shut and that changes what you can see; cameras and watched
// entrances on the way count when sneaking; things the map is silent about
// can be added when the player uses them, if nothing contradicts them; and a
// scene that puts the player at another room's feature is a relocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, loadEngine, readScenario, fixedRng } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const fresh = () => newGame('zombie-holdout');
const guards = (res, type) => [...(res.guards || [])].filter((g) => g.type === type).map((g) => g.detail);
const resolve = (E, state, obj, action = 'Wait.', step = 'moment') =>
  E.Engine.resolve(state, Object.assign({ player: { summary: action }, intents: [], events: [] }, obj), E.Engine.present(state), action, step);

// ---------- moving ----------

test('nobody walks through a locked door; the player is told why and stays put', () => {
  const { E, state } = fresh();
  const res = resolve(E, state, { player: { summary: 'goes into the office', move_to: 'office' } }, 'Go into the office.');
  assert.equal(state.characters.pike.status.location, 'floor');
  assert.deepEqual(guards(res, 'move blocked'), ["Jordan Pike → office: the door between Sales Floor and Manager's Office is locked"]);
  assert.match(res.outcomes[0].action, /but the door between Sales Floor and Manager's Office is locked, so you stay in Sales Floor/);
  const npc = resolve(E, state, { intents: [{ id: 'coleman', action: 'tries the office', move_to: 'office' }] });
  assert.equal(state.characters.coleman.status.location, 'floor');
  assert.equal(guards(npc, 'move blocked').length, 1);
});

test('the key holder comes and goes; events, the update step and groups obey the same locks', () => {
  const { E, state } = fresh();
  E.Engine.resolve(state, { player: { summary: 'x' }, intents: [], events: [{ text: 'Gil steps out.', who: ['ferris'], where: 'floor', visibility: 'seen', moves: [{ id: 'ferris', to: 'floor' }] }] }, [], 'Wait.', 'moment');
  assert.equal(state.characters.ferris.status.location, 'floor', 'Gil has the key');
  const ev = E.Engine.resolve(state, { player: { summary: 'x' }, intents: [], events: [{ text: 'Ruth slips into the office.', who: ['han'], where: 'office', visibility: 'hidden', moves: [{ id: 'han', to: 'office' }] }] }, [], 'Wait.', 'moment');
  assert.equal(state.characters.han.status.location, 'floor');
  assert.equal(guards(ev, 'move blocked').length, 1);
  const rep = E.Engine.applyUpdate(state, { state: [{ target: 'char:han', field: 'location', value: 'office' }] }, ['han'], { startLoc: 'floor', endLoc: 'floor', turn: 1 });
  assert.match([...rep.rejected][0], /locked/);
  // A group can't go through either.
  state.standees.stragglers.location = 'floor';
  state.characters.pike.status.location = 'floor';
  const g = resolve(E, state, { group_intents: [{ id: 'stragglers', action: 'shove', move_to: 'office' }] });
  assert.deepEqual(guards(g, 'standee move'), ['stragglers → office: the way to office is locked']);
});

test('moving through rooms on the way says which', () => {
  const { E, state } = fresh();
  const res = resolve(E, state, { player: { summary: 'heads out to the lot', move_to: 'lot' } }, 'Head out to the lot.');
  assert.equal(state.characters.pike.status.location, 'lot');
  assert.deepEqual([...res.outcomes[0].via], ['dock']);
  const frame = { startLoc: 'floor', startTime: E.fmtTime(state), stepId: 'moment', stepLabel: 'a few minutes', spanMinutes: 10 };
  assert.match(E.Prompts.narrate(state, [], 'Head out to the lot.', frame, res), /\[moves to Parking Lot, through Loading Dock\]/);
});

// ---------- locks ----------

test('picking a lock always rolls: a success unlocks it, a failure leaves it locked', () => {
  const { E, state } = fresh();
  fixedRng(E, [0.05]);
  const fail = resolve(E, state, { player: { summary: 'picks the lock', unlock: 'office', move_to: 'office' } }, 'Pick the office lock and slip inside.');
  assert.deepEqual(guards(fail, 'roll required'), ["unlocking the way to Manager's Office"]);
  assert.equal(fail.outcomes[0].skill, 'mechanics');
  assert.equal(state.links['floor|office'].locked, true);
  assert.equal(state.characters.pike.status.location, 'floor');
  fixedRng(E, [0.95]);
  const ok = resolve(E, state, { player: { summary: 'picks the lock', unlock: 'office', move_to: 'office' } }, 'Pick the office lock and slip inside.');
  assert.equal(state.links['floor|office'].locked, false);
  assert.equal(state.characters.pike.status.location, 'office', 'unlocked and in, the same turn');
  assert.deepEqual(guards(ok, 'unlocked'), ["Jordan Pike: the way between Sales Floor and Manager's Office"]);
});

test('only a key holder locks and unlocks without a roll', () => {
  const { E, state } = fresh();
  state.characters.ferris.status.location = 'floor';
  const ok = resolve(E, state, { intents: [{ id: 'ferris', action: 'unlocks his office', unlock: 'office' }, { id: 'coleman', action: 'locks it again', lock: 'office' }] });
  assert.equal(state.links['floor|office'].locked, false);
  assert.ok(guards(ok, 'lock rejected').some((d) => /Dex Coleman has no key/.test(d)));
  assert.equal(ok.outcomes.find((o) => o.id === 'ferris').roll, null);
  resolve(E, state, { intents: [{ id: 'ferris', action: 'locks up', lock: 'office' }] });
  assert.equal(state.links['floor|office'].locked, true);
  assert.match(E.Prompts.intent(state, E.Engine.present(state), 'Look.', 'a few minutes', 'moment', {}), /Gil Ferris has the key to the door to Manager's Office \(locked; can set "unlock":"office"\)/);
});

// ---------- doors and sight ----------

test('an open door lets you see through; the update step opens and shuts doors only in the scene, never a locked one', () => {
  const { E, state } = fresh();
  state.characters.pike.status.location = 'dock';
  assert.ok(!E.Engine.visibleRooms(state).includes('lot'), 'the roller door is shut');
  const ctx = { startLoc: 'dock', endLoc: 'dock', turn: 1 };
  E.Engine.applyUpdate(state, { state: [{ target: 'link:dock|lot', field: 'open', value: true }] }, [], ctx);
  assert.ok(E.Engine.visibleRooms(state).includes('lot'));
  assert.equal(E.Engine.linkShown(state, 'dock', 'lot'), 'open');
  const rep = E.Engine.applyUpdate(state, { state: [{ target: 'link:floor|office', field: 'open', value: true }, { target: 'link:office|roof', field: 'open', value: true }] }, [], ctx);
  assert.deepEqual([...rep.rejected].map((r) => r.replace(/^.* — /, '')), ['nobody in the scene was there', 'nobody in the scene was there']);
  const rep2 = E.Engine.applyUpdate(state, { state: [{ target: 'link:floor|office', field: 'open', value: true }] }, [], { startLoc: 'floor', endLoc: 'floor', turn: 2 });
  assert.match([...rep2.rejected][0], /it is locked/);
  assert.equal(E.Engine.linkShown(state, 'floor', 'office'), 'locked door');
  state.links['floor|office'].locked = false;
  assert.equal(E.Engine.linkShown(state, 'floor', 'office'), 'door', 'unlocked: drawn as a plain door');
});

test('cameras that are on and watched entrances on the way make sneaking harder', () => {
  const { E, state } = fresh();
  state.locations.lot.features.push({ name: 'camera' });
  state.features['lot|camera'] = 'on';
  delete state.standees.stragglers;
  fixedRng(E, [0.5]);
  const sneak = () => resolve(E, state, { player: { summary: 'sneaks out', needs_roll: true, skill: 'stealth', difficulty: 'normal', move_to: 'lot' } }, 'Sneak out to the lot.');
  const r1 = sneak();
  assert.equal(r1.outcomes[0].roll.dc, 14);
  assert.match(r1.outcomes[0].dcWhy, /watched by camera in Parking Lot \+2/, 'the lot is two rooms away, but on the way');
  state.characters.pike.status.location = 'lot';
  E.Engine.applyUpdate(state, { state: [{ target: 'feature:lot|camera', field: 'state', value: 'Off' }] }, [], { startLoc: 'lot', endLoc: 'lot', turn: 1 });
  assert.equal(state.features['lot|camera'], 'off');
  state.characters.pike.status.location = 'floor';
  assert.equal(sneak().outcomes[0].roll.dc, 10, 'nobody on the route');
  state.characters.pike.status.location = 'floor';
  state.scenario.entrances.find((e) => e.room === 'dock').watched = true;
  assert.match(sneak().outcomes[0].dcWhy, /watched roller door in Loading Dock \+2/);
});

// ---------- inferred features ----------

test('something the map is silent about is added when the player uses it, and stays', () => {
  const { E, state } = fresh();
  const header = E.Prompts.header(state);
  const res = resolve(E, state, { player: { summary: 'grabs it', new_feature: { name: 'Fire extinguisher', to: null } } }, 'Grab the fire extinguisher off the wall.');
  assert.deepEqual(guards(res, 'feature added'), ['Sales Floor: + fire extinguisher']);
  assert.ok(E.Engine.features(state, 'floor').some((f) => f.name === 'fire extinguisher' && f.inferred));
  const loaded = E.Engine.migrate(plain(state));
  assert.ok(E.Engine.features(loaded, 'floor').some((f) => f.name === 'fire extinguisher'), 'kept in saves');
  assert.equal(E.Prompts.header(state), header, 'the header never changes');
  const no = resolve(E, state, { player: { summary: 'x', new_feature: { name: 'crowbar rack' } } }, 'Look around.');
  assert.deepEqual(guards(no, 'feature rejected'), ["the player's action doesn't use \"crowbar rack\""]);
  const dup = resolve(E, state, { player: { summary: 'x', new_feature: { name: 'generator' } } }, 'Kick the generator.');
  assert.deepEqual(guards(dup, 'feature rejected'), ['Sales Floor already has "generator"']);
  const far = resolve(E, state, { player: { summary: 'x', new_feature: { room: 'roof', name: 'antenna' } } }, 'Climb the antenna.');
  assert.deepEqual(guards(far, 'feature rejected'), ["only in the player's room (Sales Floor)"]);
});

test('a window out is accepted only through an outside wall, to a neighbouring or outside room, never for a secure room', () => {
  const { E, state } = fresh();
  state.characters.pike.status.location = 'stockroom';
  const before = plain(E.Layouts.plan(state.scenario.locations, { type: 'hall', seed: 'x' }).rooms);
  const res = resolve(E, state, { player: { summary: 'climbs out', new_feature: { name: 'back window', to: 'lot' }, move_to: 'lot' } }, 'Climb out the back window into the lot.');
  assert.deepEqual(guards(res, 'feature added'), ['Stockroom: + back window (a way to Parking Lot)']);
  assert.equal(state.characters.pike.status.location, 'lot', 'out through the new window');
  assert.equal(E.Engine.linkInfo(state, 'stockroom', 'lot').kind, 'window');
  assert.deepEqual(plain(E.Layouts.plan(state.scenario.locations, { type: 'hall', seed: 'x' }).rooms), before, 'the map does not move');
  const g = fresh();
  g.state.characters.pike.status.location = 'stockroom';
  const notNext = resolve(g.E, g.state, { player: { summary: 'x', new_feature: { name: 'window', to: 'office' } } }, 'Climb through the window.');
  assert.match(guards(notNext, 'feature rejected')[0], /not on the other side of a wall of Stockroom/);
  g.state.locations.stockroom.secure = true;
  const secure = resolve(g.E, g.state, { player: { summary: 'x', new_feature: { name: 'vent', to: 'lot' } } }, 'Crawl into the vent.');
  assert.match(guards(secure, 'feature rejected')[0], /a secure room never gets another way in/);
});

test('a room boxed in by others has no outside wall', () => {
  const L = loadEngine().Layouts;
  const plan = { rooms: {
    mid: { x: 1, y: 1, w: 1, h: 1, level: 0 }, n: { x: 0, y: 0, w: 3, h: 1, level: 0 }, s: { x: 0, y: 2, w: 3, h: 1, level: 0 },
    w: { x: 0, y: 1, w: 1, h: 1, level: 0 }, e: { x: 2, y: 1, w: 1, h: 1, level: 0 },
  } };
  assert.ok(!L.hasOutsideWall(plan, 'mid'));
  assert.ok(L.hasOutsideWall(plan, 'n'));
});

// ---------- relocation and plans ----------

test('a scene that puts the player at another room\'s feature is a relocation (playtest-stragglers-sneak)', () => {
  const { E, state } = fresh();
  const rec = require('./fixtures/playtest-stragglers-sneak.json');
  const prose = rec.actions[1].calls.find((c) => c.kind === 'narrate').response.text;
  state.characters.pike.status.location = 'dock';
  assert.equal(E.Engine.findRelocation(state, prose, 'dock').id, 'lot', '"You\'re almost to the abandoned pickup"');
  assert.equal(E.Engine.findRelocation(state, 'You lean on the forklift. A pickup truck sits abandoned near the highway.', 'dock'), null, 'seeing it is fine');
});

test('the update step can reveal a room the player didn\'t know', () => {
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  sc.locations.find((l) => l.id === 'roof').seen = false;
  const state = E.Engine.newGame(E.Scenario.validate(sc));
  assert.match(E.Prompts.update(state, 'x', { outcomes: [], events: [] }, 'p', [], false), /rooms the player doesn't know yet: roof/);
  E.Engine.applyUpdate(state, { state: [{ target: 'room:roof', field: 'seen', value: true }] }, [], { startLoc: 'floor', endLoc: 'floor', turn: 1 });
  assert.ok(state.seenRooms.includes('roof'));
});

// ---------- data and saves ----------

test('site rule fields validate: keys, feature states, entrances', () => {
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  sc.locations.find((l) => l.id === 'floor').links[0].key = ['nobody'];
  sc.locations.find((l) => l.id === 'dock').features.push({ name: 'camera', state: 'x'.repeat(21) });
  sc.entrances.push({ room: 'attic', watched: 'yes' });
  assert.throws(() => E.Scenario.validate(sc), (err) => ['has a "key" for someone not in the cast', '"features" must be a list', 'entrance in unknown room "attic"', '"watched" must be true or false']
    .every((m) => err.message.includes(m)));
});

test('older saves get link and feature state from their rooms', () => {
  const { E, state } = newGame();
  const v10 = plain(state);
  v10.version = 10;
  delete v10.links;
  delete v10.features;
  const up = E.Engine.migrate(v10);
  assert.equal(up.version, E.Engine.STATE_VERSION);
  assert.deepEqual(plain(up.links), { 'suitroom|surface': { locked: false, open: false }, 'garage|surface': { locked: false, open: false } });
  assert.deepEqual(plain(up.features), { 'med|drug cabinet': 'locked', 'hydro|water recycler': 'rattling' });
});

test('after a move, walking back out of the room is a relocation; staying is fine', () => {
  const { E, state } = fresh();
  state.characters.pike.status.location = 'dock';
  assert.equal(E.Engine.findRelocation(state, 'You step out of the loading dock and back onto the floor.', 'floor').to, 'back out of Loading Dock');
  assert.equal(E.Engine.findRelocation(state, 'You leave the dock behind you.', 'floor').to, 'back out of Loading Dock');
  assert.equal(E.Engine.findRelocation(state, 'You lean on the forklift and look back at the floor.', 'floor'), null);
  assert.equal(E.Engine.findRelocation(state, 'You step out of the way of the forklift.', 'dock'), null, 'no move this turn: not this check');
});

test('a scene never ends on the player\'s own quoted line', () => {
  const { E } = fresh();
  assert.equal(E.Engine.trimPlayerEnding('Ruth frowns.\n\n"Fine," you say. "Let\'s go."'), 'Ruth frowns.');
  assert.equal(E.Engine.trimPlayerEnding('"Fine," Ruth says.'), '"Fine," Ruth says.');
});

test('the engine reads a way out from the player\'s words when the model leaves it out, but not one that exists', () => {
  const { E, state } = fresh();
  state.characters.pike.status.location = 'stockroom';
  const res = resolve(E, state, { player: { summary: 'climbs out', move_to: 'lot' } }, 'Climb out the back window into the lot.');
  assert.deepEqual(guards(res, 'feature added'), ["Stockroom: + back window (a way to Parking Lot) (from the player's words)"]);
  const again = fresh();
  again.state.characters.pike.status.location = 'floor';
  const none = resolve(again.E, again.state, { player: { summary: 'x', move_to: 'dock' } }, 'Walk to the dock past the boarded windows.');
  assert.equal(guards(none, 'feature added').length, 0, 'the floor already has its windows, and "past" them is no way out');
  assert.equal(again.state.characters.pike.status.location, 'dock');
});
