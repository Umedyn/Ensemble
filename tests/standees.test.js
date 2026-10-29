// Standees (task 3-2): unnamed groups on the local map (guards, a gang, the
// dead) as one entity with a label, count, room and state. One intent per
// group; counts, states and moves are clamped by the engine; rolls against
// them get harder with size and state; one member can be singled out as an
// extra. Groups exist only in rooms: wiped out or fled, they leave the map.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, loadEngine, readScenario, worldFiles, fixedRng } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const fresh = () => newGame('zombie-holdout');
const guards = (res, type) => [...(res.guards || [])].filter((g) => g.type === type).map((g) => g.detail);
const resolve = (E, state, obj, action = 'Wait.', step = 'moment') =>
  E.Engine.resolve(state, Object.assign({ player: { summary: action }, intents: [], events: [] }, obj), E.Engine.present(state), action, step);
const inLot = () => { const g = fresh(); g.state.characters.pike.status.location = 'lot'; return g; };

// ---------- data ----------

test('standees validate: ids, counts, rooms, states, factions, posts and patrols', () => {
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  sc.standees = [
    { id: 'Bad Id', label: 'x', count: 1, location: 'lot' },
    { id: 'albee', label: 'twins', count: 2, location: 'lot' },
    { id: 'nowhere', label: 'drifters', count: 3, location: null },
    { id: 'many', label: 'swarm', count: 1000, location: 'lot', state: 'fled' },
    { id: 'gang', label: 'gang', count: 4, location: 'lot', faction: 'orcs' },
    { id: 'both', label: 'guards', count: 2, location: 'dock', post: 'dock', patrol: ['dock', 'lot'] },
    { id: 'walkers', label: 'walkers', count: 2, location: 'lot', patrol: ['lot', 'roof'] },
  ];
  assert.throws(() => E.Scenario.validate(sc), (err) => [
    '"id" must be lowercase', 'standee "albee": id is already used', 'standee "nowhere": unknown location "null" (groups are always in a room)',
    '"count" must be a whole number from 1 to 999', '"state" must be calm, alert, hostile or down', 'faction "orcs" is not one of the groups',
    'holds a "post" or walks a "patrol", not both', 'patrol step lot → roof is not a linked room',
  ].every((m) => err.message.includes(m)));
});

test('group extras in a room load as standees; ones in no room are left out with a warning', () => {
  const E = loadEngine();
  const files = worldFiles('zombie-holdout');
  files['world.json'].extras.push(
    { id: 'pack', name: 'the dog pack', role: 'half-wild dogs', group: true, count: 'a dozen', location: 'lot' },
    { id: 'herd', name: 'the herd', role: 'a slow tide of the dead', group: true, count: 'hundreds', location: null });
  const w = E.Scenario.prepareWorld('zombie-holdout', files);
  assert.ok([...w.warnings].some((m) => /group "herd" is in no room and is left out/.test(m)));
  const sc = w.starts[0].scenario;
  assert.ok(!sc.extras.some((x) => x.group));
  const pack = sc.standees.find((g) => g.id === 'pack');
  assert.deepEqual([pack.label, pack.count, pack.location, pack.state], ['the dog pack', 12, 'lot', 'calm']);
  assert.ok(!sc.standees.some((g) => g.id === 'herd'));
  assert.deepEqual([E.Scenario.parseCount('hundreds'), E.Scenario.parseCount('six'), E.Scenario.parseCount('about 40'), E.Scenario.parseCount('lots')], [100, 6, 40, 10]);
});

test('tokens list everyone on a room: characters, then minor people, then groups', () => {
  const { E, state } = fresh();
  state.characters.ortiz.status.location = 'dock';
  const tokens = plain(E.Engine.tokens(state, 'dock'));
  assert.deepEqual(tokens.map((t) => [t.kind, t.id]), [['character', 'ortiz'], ['extra', 'albee']]);
  const lot = plain(E.Engine.tokens(state, 'lot'));
  assert.deepEqual(lot, [{ kind: 'standee', id: 'stragglers', label: 'stragglers', count: 5, state: 'calm', faction: null }]);
  assert.equal(plain(E.Engine.tokens(state, state.characters.pike.status.location))[0].player, true);
});

// ---------- intents ----------

test('one intent per group with the player; unknown, absent or repeated ones are dropped; moves follow links', () => {
  const { E, state } = inLot();
  const res = resolve(E, state, { group_intents: [
    { id: 'stragglers', action: 'shamble toward the dock door', move_to: 'dock' },
    { id: 'stragglers', action: 'again' },
    { id: 'ghosts', action: 'haunt' },
  ] });
  assert.deepEqual(plain(res.groups), [{ id: 'stragglers', action: 'shamble toward the dock door', visible: true, moved: 'dock' }]);
  assert.equal(state.standees.stragglers.location, 'dock');
  assert.deepEqual(guards(res, 'standee rejected'), ['group intent for "ghosts": no such group here']);
  const r2 = resolve(E, state, { group_intents: [{ id: 'stragglers', action: 'climb', move_to: 'roof' }] });
  assert.deepEqual(guards(r2, 'standee rejected'), ['group intent for "stragglers": no such group here'], 'the group left the lot');
  state.characters.pike.status.location = 'dock';
  const r3 = resolve(E, state, { group_intents: [{ id: 'stragglers', action: 'climb', move_to: 'roof' }] });
  assert.deepEqual(guards(r3, 'standee move'), ['stragglers → roof: roof is not linked to dock']);
});

test('a group on guard holds its post unless hostile; a group that is down cannot act', () => {
  const { E, state } = inLot();
  state.standees.stragglers.post = 'lot';
  const r1 = resolve(E, state, { group_intents: [{ id: 'stragglers', action: 'wander', move_to: 'dock' }] });
  assert.equal(state.standees.stragglers.location, 'lot');
  assert.deepEqual(guards(r1, 'standee move'), ['stragglers → dock: holds its post in lot']);
  state.standees.stragglers.state = 'hostile';
  resolve(E, state, { group_intents: [{ id: 'stragglers', action: 'charge', move_to: 'dock' }] });
  assert.equal(state.standees.stragglers.location, 'dock');
  state.characters.pike.status.location = 'dock';
  state.standees.stragglers.state = 'down';
  const r2 = resolve(E, state, { group_intents: [{ id: 'stragglers', action: 'get up' }] });
  assert.deepEqual(guards(r2, 'standee rejected'), ["stragglers is down and can't act"]);
});

test('the narrator gets each group as one line and only the groups that are there', () => {
  const { E, state } = inLot();
  const res = resolve(E, state, { group_intents: [{ id: 'stragglers', action: 'turn toward the noise', visible: true }] });
  const frame = { startLoc: 'lot', startTime: E.fmtTime(state), stepId: 'moment', stepLabel: 'a few minutes', spanMinutes: 10 };
  const narr = E.Prompts.narrate(state, [], 'Freeze.', frame, res);
  assert.match(narr, /- stragglers \(group of 5\): turn toward the noise/);
  assert.match(narr, /Unnamed groups around \(exactly these, no more\): stragglers \(5, calm\) in Parking Lot\./);
  assert.doesNotMatch(narr, /bunch up at the dock door/, 'the note stays out of the narrator');
});

test('group intents and the against/single_out fields are asked for only when a group is here; never in the header', () => {
  const { E, state } = inLot();
  const intent = E.Prompts.intent(state, [], 'Look.', 'a few minutes', 'moment', {});
  assert.match(intent, /=== UNNAMED GROUPS[^\n]*\n- here: stragglers: stragglers \(5, calm\) — Slow dead/);
  assert.match(intent, /"group_intents":\[\{"id":"stragglers","action":"one sentence","visible":true,"move_to":null\}\]/);
  assert.match(intent, /"against":null,"single_out":null/);
  assert.match(intent, /\nUnnamed groups here: stragglers \(5, calm\)\n/);
  assert.doesNotMatch(E.Prompts.header(state), /stragglers \(/);
  state.characters.pike.status.location = 'floor';
  const away = E.Prompts.intent(state, E.Engine.present(state), 'Look.', 'a few minutes', 'moment', {});
  assert.match(away, /- elsewhere: stragglers \(stragglers, 5, calm, Parking Lot\)/);
  assert.doesNotMatch(away, /group_intents|"against"/);
  const mars = newGame();
  assert.doesNotMatch(mars.E.Prompts.intent(mars.state, mars.E.Engine.present(mars.state), 'Look.', 'a few minutes', 'moment', {}), /UNNAMED GROUPS|against/);
});

// ---------- rolls ----------

test('rolls against a group get harder with its state and size', () => {
  const { E, state } = inLot();
  fixedRng(E, [0.5]);
  const calm = resolve(E, state, { player: { summary: 'shove past', needs_roll: true, skill: 'fighting', difficulty: 'normal', against: 'stragglers' } }, 'Shove past the stragglers.');
  assert.equal(calm.outcomes[0].roll.dc, 12 + 2, 'five of them: +2');
  assert.match(calm.outcomes[0].dcWhy, /5 calm stragglers \+2/);
  state.standees.stragglers.state = 'hostile';
  state.standees.stragglers.count = 20;
  const hostile = resolve(E, state, { player: { summary: 'fight', needs_roll: true, skill: 'fighting', difficulty: 'normal', against: 'stragglers' } }, 'Fight the stragglers.');
  assert.equal(hostile.outcomes[0].roll.dc, 12 + 4 + 4);
  const bogus = resolve(E, state, { player: { summary: 'fight', needs_roll: true, skill: 'fighting', difficulty: 'normal', against: 'convoy' } }, 'Fight.');
  assert.equal(bogus.outcomes[0].roll.dc, 12);
  assert.deepEqual(guards(bogus, 'standee rejected'), ['roll against "convoy": no such group here that can resist']);
  const mars = newGame();
  fixedRng(mars.E, [0.5]);
  const plainRoll = resolve(mars.E, mars.state, { player: { summary: 'sneak', needs_roll: true, skill: 'stealth', difficulty: 'normal' } }, 'Sneak.');
  assert.equal(plainRoll.outcomes[0].roll.dc, 12, 'no groups in the world: stealth unchanged');
});

test('stealth counts who could notice: wary groups nearby make it harder, an empty route easier', () => {
  const { E, state } = fresh();
  fixedRng(E, [0.5]);
  state.characters.pike.status.location = 'dock';
  state.standees.stragglers.state = 'alert';
  const watched = resolve(E, state, { player: { summary: 'sneak', needs_roll: true, skill: 'stealth', difficulty: 'normal' } }, 'Sneak to the forklift.');
  assert.equal(watched.outcomes[0].roll.dc, 14);
  assert.match(watched.outcomes[0].dcWhy, /watched by stragglers \+2/);
  state.characters.pike.status.location = 'roof';
  const empty = resolve(E, state, { player: { summary: 'sneak', needs_roll: true, skill: 'stealth', difficulty: 'normal' } }, 'Sneak along the roof.');
  assert.equal(empty.outcomes[0].roll.dc, 10);
});

test('a failed stealth roll makes the nearest group warier, and a group next door steps in; the narrator is told exactly that', () => {
  const { E, state } = fresh();
  state.characters.pike.status.location = 'dock';
  fixedRng(E, [0.1]);
  const sneak = { player: { summary: 'sneak', needs_roll: true, skill: 'stealth', difficulty: 'normal' } };
  const r1 = resolve(E, state, sneak, 'Sneak to the forklift.');
  assert.equal(state.standees.stragglers.state, 'alert');
  assert.equal(state.standees.stragglers.location, 'lot', 'only noticed, so far');
  const r2 = resolve(E, state, sneak, 'Sneak to the forklift.');
  assert.deepEqual([state.standees.stragglers.state, state.standees.stragglers.location], ['hostile', 'dock']);
  assert.deepEqual(plain(r2.standeeChanges), ['stragglers spot the player and turn hostile (were alert)', 'stragglers come into Loading Dock']);
  const frame = { startLoc: 'dock', startTime: E.fmtTime(state), stepId: 'moment', stepLabel: 'a few minutes', spanMinutes: 10 };
  assert.match(E.Prompts.narrate(state, [], 'Sneak.', frame, r2), /- CHANGED: stragglers come into Loading Dock/);
  assert.equal(guards(r1, 'noticed').length, 1);
});

// ---------- the update step ----------

test('the update step changes count, state and room within limits', () => {
  const { E, state } = inLot();
  const ctx = { startLoc: 'lot', endLoc: 'lot', turn: 1 };
  let rep = E.Engine.applyUpdate(state, { state: [
    { target: 'standee:stragglers', field: 'count', delta: -2 },
    { target: 'standee:stragglers', field: 'count', delta: 4 },
    { target: 'standee:stragglers', field: 'location', value: 'roof' },
    { target: 'standee:stragglers', field: 'mood', value: 'hungry' },
  ] }, [], ctx);
  assert.equal(state.standees.stragglers.count, 3);
  assert.deepEqual([...rep.rejected].map((r) => r.replace(/^.* — /, '')), [
    "a group only grows when one of this turn's events brings more", 'roof is not linked to lot', 'groups have only count, state and location']);
  E.Engine.applyUpdate(state, { state: [{ target: 'standee:stragglers', field: 'count', delta: 50 }] }, [], Object.assign({ involved: ['stragglers'] }, ctx));
  assert.equal(state.standees.stragglers.count, 5, 'an event brought more: at most half again');
  E.Engine.applyUpdate(state, { state: [{ target: 'standee:stragglers', field: 'state', value: 'alert' }, { target: 'standee:stragglers', field: 'location', value: 'dock' }] }, [], ctx);
  assert.deepEqual([state.standees.stragglers.state, state.standees.stragglers.location], ['alert', 'dock']);
  rep = E.Engine.applyUpdate(state, { state: [{ target: 'standee:stragglers', field: 'count', delta: -99 }] }, [], { startLoc: 'dock', endLoc: 'dock', turn: 2 });
  assert.ok(!state.standees.stragglers, 'wiped out: off the map');
  assert.deepEqual([...rep.standees], ['stragglers is down to no one']);
});

test('a group that flees leaves the map and folds back into its faction', () => {
  const { E, state } = inLot();
  state.standees.stragglers.faction = 'ridge';
  const rep = E.Engine.applyUpdate(state, { state: [{ target: 'standee:stragglers', field: 'state', value: 'fled' }] }, [], { startLoc: 'lot', endLoc: 'lot', turn: 1 });
  assert.ok(!state.standees.stragglers);
  assert.deepEqual([...rep.standees], ['stragglers fled; folded back into The Ridge']);
  const far = fresh();
  const r2 = far.E.Engine.applyUpdate(far.state, { state: [{ target: 'standee:stragglers', field: 'state', value: 'hostile' }] }, [], { startLoc: 'floor', endLoc: 'floor', turn: 1 });
  assert.equal(far.state.standees.stragglers.state, 'calm');
  assert.match([...r2.rejected][0], /nobody in the scene could have seen that/);
});

test('events can involve groups and move them one linked step', () => {
  const { E, state } = fresh();
  const res = resolve(E, state, { events: [
    { text: 'The stragglers drift to the dock door.', who: ['stragglers'], where: 'dock', visibility: 'heard', moves: [{ id: 'stragglers', to: 'dock' }] },
  ] }, 'Wait.', 'hour');
  assert.equal(state.standees.stragglers.location, 'dock');
  assert.ok(res.involved.includes('stragglers'));
  const bad = resolve(E, state, { events: [{ text: 'They climb up.', who: ['stragglers'], where: 'roof', visibility: 'heard', moves: [{ id: 'stragglers', to: 'roof' }] }] }, 'Wait.', 'hour');
  assert.deepEqual(guards(bad, 'standee move'), ['stragglers → roof: roof is not linked to dock']);
});

// ---------- patrols ----------

test('patrols walk one room an hour while calm or alert, and stop when hostile', () => {
  const { E, state } = fresh();
  Object.assign(state.standees.stragglers, { patrol: ['lot', 'dock', 'floor', 'dock'], location: 'lot' });
  E.Engine.advanceTime(state, 0.5, { events: [] });
  assert.equal(state.standees.stragglers.location, 'lot');
  E.Engine.advanceTime(state, 0.5, { events: [] });
  assert.equal(state.standees.stragglers.location, 'dock');
  E.Engine.advanceTime(state, 2, { events: [] });
  assert.equal(state.standees.stragglers.location, 'dock', 'floor, then back to the dock');
  state.standees.stragglers.state = 'hostile';
  E.Engine.advanceTime(state, 3, { events: [] });
  assert.equal(state.standees.stragglers.location, 'dock');
});

// ---------- singling one out ----------

test('singling one out makes a minor person and lowers the count, only when the player names the group', () => {
  const { E, state } = inLot();
  const res = resolve(E, state, { player: { summary: 'grabs one', single_out: { standee: 'stragglers', name: 'the one in the mail carrier uniform', role: 'a dead mail carrier' } } }, 'Grab the nearest straggler by the collar.');
  assert.equal(state.standees.stragglers.count, 4);
  const x = Object.values(state.extras).find((e) => e.from === 'standee');
  assert.deepEqual([x.name, x.role, x.location], ['the one in the mail carrier uniform', 'a dead mail carrier', 'lot']);
  assert.match(x.note, /singled out from stragglers/);
  assert.ok(res.standeeChanges.some((l) => /singled out from stragglers/.test(l)));
  const no = resolve(E, state, { player: { summary: 'x', single_out: { standee: 'stragglers', name: 'Bob' } } }, 'Look at the pickup.');
  assert.equal(state.standees.stragglers.count, 4);
  assert.deepEqual(guards(no, 'standee rejected'), ["single out: the player's action doesn't name stragglers"]);
  state.standees.stragglers.count = 1;
  resolve(E, state, { player: { summary: 'x', single_out: { standee: 'stragglers' } } }, 'Stop the last straggler.');
  assert.ok(!state.standees.stragglers, 'the last one singled out: the group is gone');
  assert.ok(Object.values(state.extras).some((e) => e.name === 'one of the stragglers'));
});

// ---------- saves ----------

test('saves round-trip standees; older saves turn group extras in a room into standees and drop the rest', () => {
  const { E, state } = inLot();
  state.standees.stragglers.state = 'alert';
  const loaded = E.Engine.migrate(plain(state));
  assert.deepEqual(plain(loaded.standees), plain(state.standees));
  const v7 = plain(state);
  v7.version = 7;
  delete v7.standees;
  v7.extras.herd = { id: 'herd', name: 'the herd', role: 'the dead', group: true, count: 'hundreds', location: null };
  v7.extras.pack = { id: 'pack', name: 'the dog pack', role: 'dogs', group: true, count: 'six', location: 'lot' };
  v7.pending = { pre: { characters: {}, extras: {} } };
  const up = E.Engine.migrate(v7);
  assert.equal(up.version, E.Engine.STATE_VERSION);
  assert.ok(!up.extras.herd && !up.extras.pack && up.extras.albee);
  assert.deepEqual([up.standees.pack.count, up.standees.pack.location], [6, 'lot']);
  assert.ok(!up.standees.herd);
  assert.deepEqual(plain(up.pending.pre.standees), {});
});

// ---------- playtest-stragglers-sneak ----------

test('a group next door that the player names can be dealt with: an intent, a roll target, and update changes', () => {
  const { E, state } = fresh();
  state.characters.pike.status.location = 'dock';
  const intent = E.Prompts.intent(state, [], 'Sneak past the stragglers.', 'a few minutes', 'moment', {});
  assert.match(intent, /- next door in Parking Lot \(named in the action\): stragglers: stragglers \(5, calm\)/);
  assert.match(intent, /"group_intents":\[\{"id":"stragglers"/);
  assert.doesNotMatch(E.Prompts.intent(state, [], 'Check the forklift.', 'a few minutes', 'moment', {}), /group_intents/, 'not named: not engaged');
  fixedRng(E, [0.5]);
  const res = resolve(E, state, { player: { summary: 'sneak', needs_roll: true, skill: 'stealth', difficulty: 'normal', against: 'stragglers' },
    group_intents: [{ id: 'stragglers', action: 'drift toward the dock door', move_to: 'dock' }] }, 'Sneak past the stragglers.');
  assert.equal(res.outcomes[0].roll.dc, 14, 'five of them: +2');
  assert.equal(state.standees.stragglers.location, 'dock');
  const far = fresh();
  far.state.characters.pike.status.location = 'dock';
  const rep = far.E.Engine.applyUpdate(far.state, { state: [{ target: 'standee:stragglers', field: 'state', value: 'alert' }] }, [], { startLoc: 'dock', endLoc: 'dock', engaged: ['stragglers'], turn: 1 });
  assert.equal(far.state.standees.stragglers.state, 'alert');
  assert.equal(rep.rejected.length, 0);
});

test('sneaking with a group close by always rolls stealth', () => {
  const { E, state } = fresh();
  state.characters.pike.status.location = 'dock';
  fixedRng(E, [0.9]);
  const res = resolve(E, state, { player: { summary: 'goes round the truck', needs_roll: false } }, 'I sneak around the side of the truck.');
  assert.deepEqual([res.outcomes[0].skill, res.outcomes[0].roll.dc], ['stealth', 12]);
  assert.deepEqual(guards(res, 'roll required'), ['the player sneaks with a group close by: stealth roll']);
  state.characters.pike.status.location = 'roof';
  const alone = resolve(E, state, { player: { summary: 'x', needs_roll: false } }, 'I sneak to the edge of the roof.');
  assert.equal(alone.outcomes[0].roll, null, 'nobody near: no roll');
});
