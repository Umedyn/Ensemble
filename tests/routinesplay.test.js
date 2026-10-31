// Routines in play (task G-8): people leave and arrive in the player's scene,
// the player hands the hours to their routine, and skips place everyone by
// routine. Fixture: fixtures/routine-town/.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newGame, mockLLM } = require('./helpers');

const TOWN = path.join(__dirname, 'fixtures', 'routine-town');
const MONDAY = 5;
const game = (hour, room) => {
  const g = newGame(TOWN);
  g.state.time = { day: MONDAY, hour };
  g.state.characters.sora.status.location = room;
  return Object.assign(g, { Eng: g.E.Engine, where: (id) => g.state.characters[id].status.location });
};
const reply = (g, o = {}) => mockLLM(g.E, ({ kind, user }) => {
  if (kind.startsWith('intent')) return Object.assign({ player: { summary: 'waits', needs_roll: false, move_to: null }, intents: [], events: [], positions: [], player_where: null, montage: 'The hours pass.', major_event: null }, typeof o.intent === 'function' ? o.intent(user) : o.intent);
  if (kind.startsWith('update')) return { facts: [] };
  return o.scene || '[+5m] Sora looks around.\n\n[+50m] The afternoon wears on, and Sora waits by the wall.';
});
const narrate = (calls) => calls.find((c) => c.kind === 'narrate').user;
const aoiHere = (g) => { g.state.characters.aoi.status.location = g.state.characters.sora.status.location; };

test('someone with nowhere to stay leaves the scene, and the narrator is told when', async () => {
  const g = game(8.5, 'yard');
  aoiHere(g);
  const calls = reply(g);
  await g.Eng.runTurn(g.state, 'I wait by the wall.', 'hour');
  assert.equal(g.where('aoi'), 'classroom');
  assert.match(narrate(calls), /Aoi Mori leaves for Classroom around \[\+30m\]/);
  assert.equal(g.state.known.aoi.loc, 'classroom', 'the player saw where they went');
});

test('the scene settles no earlier than a move the narrator was told about', async () => {
  const g = game(8.5, 'yard');
  aoiHere(g);
  reply(g, { scene: '[+2m] Sora leans on the rack.' });
  await g.Eng.runTurn(g.state, 'I wait by the wall.', 'hours');
  assert.ok(g.state.time.hour > 9, `settled at ${g.state.time.hour}`);
  assert.equal(g.where('aoi'), 'classroom');
});

test('the person the player is dealing with stays, this turn and the next, then goes', async () => {
  const g = game(8.5, 'yard');
  aoiHere(g);
  const calls = reply(g);
  await g.Eng.runTurn(g.state, 'I ask Aoi about the test.', 'hour');
  assert.equal(g.where('aoi'), 'yard', 'the player can keep Aoi from class');
  assert.doesNotMatch(narrate(calls), /Aoi Mori leaves/);
  await g.Eng.runTurn(g.state, 'I ask what they mean.', 'minute');
  assert.equal(g.where('aoi'), 'yard');
  g.state.time.hour = 9.99;
  await g.Eng.runTurn(g.state, 'I look at the sky.', 'moment');
  await g.Eng.runTurn(g.state, 'I look at the sky.', 'moment');
  assert.equal(g.where('aoi'), 'classroom', 'nobody is keeping them now');
});

test('saying something on their own doesn\'t keep someone from their day', async () => {
  const g = game(8.5, 'yard');
  aoiHere(g);
  reply(g, { intent: { intents: [{ id: 'aoi', action: 'Says hello.', says: 'Morning!', reveals: null, visible: true, needs_roll: false, move_to: null }] } });
  await g.Eng.runTurn(g.state, 'I wait by the wall.', 'hour');
  assert.equal(g.where('aoi'), 'classroom');
});

test('the model can keep someone leaving when the scene demands it, with a reason, and only them', async () => {
  const g = game(8.5, 'yard');
  aoiHere(g);
  g.state.characters.gil.status.location = 'canteen';
  g.state.characters.ken.status.location = 'yard';
  const intent = (id, stays_for) => ({ id, action: 'Watches.', says: null, reveals: null, visible: true, needs_roll: false, move_to: null, stays_for });
  const calls = reply(g, { intent: { intents: [intent('aoi', 'breaking up the fight'), intent('ken', null)] } });
  await g.Eng.runTurn(g.state, 'I watch the two seniors shove each other.', 'hour');
  const user = calls.find((c) => c.kind === 'intent').user;
  assert.match(user, /Aoi Mori, Ken Oda, Rin Sato would normally leave during this time/);
  assert.match(user, /"stays_for"/);
  assert.equal(g.where('aoi'), 'yard');
  assert.equal(g.where('ken'), 'classroom', 'no reason, so they go');
});

test('nobody is offered a reason to stay unless their routine would take them', async () => {
  const g = game(9.1, 'yard');
  aoiHere(g);
  const calls = reply(g);
  await g.Eng.runTurn(g.state, 'I wait by the wall.', 'minute');
  assert.doesNotMatch(calls.find((c) => c.kind === 'intent').user, /stays_for/);
});

test('danger or someone badly hurt keeps everyone here, unasked', async () => {
  const hurt = game(8.5, 'yard');
  aoiHere(hurt);
  hurt.state.characters.sora.status.health = 'badly_hurt';
  reply(hurt);
  await hurt.Eng.runTurn(hurt.state, 'I sit down.', 'hour');
  assert.equal(hurt.where('aoi'), 'yard');
  const danger = game(8.5, 'yard');
  aoiHere(danger);
  danger.state.standees = { pack: { id: 'pack', label: 'a pack of dogs', count: 3, state: 'hostile', location: 'yard' } };
  reply(danger);
  await danger.Eng.runTurn(danger.state, 'I back away.', 'hour');
  assert.equal(danger.where('aoi'), 'yard');
});

test('a routine brings someone into the scene, and the narrator is told when', async () => {
  const g = game(8.5, 'classroom');
  const calls = reply(g);
  await g.Eng.runTurn(g.state, 'I wait at my desk.', 'hour');
  assert.equal(g.where('aoi'), 'classroom');
  assert.match(narrate(calls), /Aoi Mori around \[\+30m\], Ken Oda around \[\+30m\], Rin Sato around \[\+30m\] are there at the end/);
});

test('heading home: the frame doesn\'t say they stayed behind', async () => {
  const g = game(21.5, 'yard');
  g.state.characters.ken.status.location = 'yard';
  const calls = reply(g);
  await g.Eng.runTurn(g.state, 'I wait by the wall.', 'hour');
  assert.ok(g.Eng.isAway(g.state, 'ken'));
  assert.match(narrate(calls), /Ken Oda heads home around \[\+30m\]/);
});

test('stepping in before the bell keeps them in the scene', async () => {
  const g = game(8.5, 'yard');
  aoiHere(g);
  reply(g, { scene: '[+5m] Sora wipes the bench.\n\n[+10m] Sora sits down.\n\n[+50m] Sora stands up at last.' });
  await g.Eng.runTurn(g.state, 'I wait by the wall.', 'hour');
  await g.Eng.commitPending(g.state, 1, () => {});
  assert.ok(g.state.time.hour < 9);
  assert.equal(g.where('aoi'), 'yard');
});

test('"I sit through class" plays a planned day: the stops, the prompt, the relocation check', async () => {
  const g = game(11.5, 'classroom');
  const calls = reply(g, { scene: '[+5m] The lesson drags.\n\n[+40m] You head to the Canteen for lunch.\n\n[+170m] Back in the Classroom, the lesson drags on and Aoi yawns.' });
  const out = await g.Eng.runTurn(g.state, 'I sit through class.', 'hours');
  assert.deepEqual([...out.res.routineDay.stops].map((s) => s.room), ['classroom', 'canteen', 'classroom']);
  assert.match(narrate(calls), /The day \(planned by the engine, on Sora Ito's routine\): Classroom \+0m; Canteen \+\d+m; Classroom \+1h\d*m?/);
  assert.equal(g.where('sora'), 'classroom');
  assert.ok(!out.res.guards.some((x) => x.type === 'relocation regenerated'), 'the plan\'s rooms are allowed');
  assert.ok(g.state.time.hour >= 12.5, 'not before the last stop');
});

test('a routine day gets there first when the player isn\'t where it starts', async () => {
  const g = game(8, 'plaza');
  reply(g);
  const out = await g.Eng.runTurn(g.state, 'I go about my day.', 'hours');
  assert.equal(g.where('sora'), 'classroom');
  assert.ok(out.res.routineDay.stops[0].at <= 60, 'in class by nine');
});

test('stepping in puts the player where the plan had them then', async () => {
  const g = game(11.5, 'classroom');
  reply(g, { scene: '[+5m] The lesson drags.\n\n[+50m] Lunch is loud.\n\n[+60m] Still lunch.\n\n[+170m] The afternoon lesson drags on.' });
  await g.Eng.runTurn(g.state, 'I sit through class.', 'hours');
  await g.Eng.commitPending(g.state, 2, () => {});
  assert.equal(g.where('sora'), 'canteen');
});

test('a place or a person in the action wins, and the routine waits', async () => {
  const a = game(11.5, 'classroom');
  reply(a);
  const named = await a.Eng.runTurn(a.state, 'I sit through class with Aoi.', 'hours');
  assert.equal(named.res.routineDay, undefined);
  const b = game(11.5, 'classroom');
  reply(b);
  const place = await b.Eng.runTurn(b.state, 'I sit in the Workshop until the end of the school day.', 'hours');
  assert.equal(place.res.routineDay, undefined);
  const c = game(11.5, 'classroom');
  reply(c);
  const short = await c.Eng.runTurn(c.state, 'I sit through class.', 'moment');
  assert.equal(short.res.routineDay, undefined, 'only on steps of an hour or more');
});

test('a clock going off stops the day where it is', async () => {
  const g = game(11.5, 'classroom');
  g.state.clocks.push({ id: 'alarm', name: 'The alarm', value: 0, max: 1, perHour: 1, fired: false });
  const calls = reply(g);
  const out = await g.Eng.runTurn(g.state, 'I sit through class.', 'hours');
  assert.equal(g.where('sora'), 'canteen', 'an hour in: lunch, and no further');
  assert.ok(out.res.routineDay.stopped);
  assert.match(narrate(calls), /cuts the day short/);
});

test('an open emergency means no routine day', async () => {
  const g = game(11.5, 'classroom');
  g.state.crisis = { turn: g.state.turn, text: 'Fire!', who: [] };
  reply(g);
  const out = await g.Eng.runTurn(g.state, 'I sit through class.', 'hours');
  assert.equal(out.res.routineDay, undefined);
});

test('a skip keeps everyone to their routine; positions only move someone the story touches', async () => {
  const g = game(8, 'canteen');
  g.state.clocks.push({ id: 'bell', name: 'The storm', value: 0, max: 1, perHour: 0.5, fired: false, fireText: 'The storm breaks over Ken Oda at the yard.' });
  reply(g, { intent: { positions: [{ id: 'aoi', where: 'plaza', doing: 'waiting' }, { id: 'ken', where: 'yard', doing: 'running' }] } });
  const out = await g.Eng.runTurn(g.state, 'I keep to my routine.', 'major');
  assert.ok(out.res.guards.some((x) => x.type === 'position dropped' && /Aoi/.test(x.detail)));
  assert.equal(g.where('aoi'), 'classroom');
  assert.equal(g.where('ken'), 'yard', 'the event names them');
  assert.equal(g.where('sora'), 'classroom', 'a routine plan puts the player where their routine has them');
});

test('a skip plan that says something else leaves the player where they are', async () => {
  const g = game(8, 'canteen');
  g.state.clocks.push({ id: 'bell', name: 'The storm', value: 0, max: 1, perHour: 0.5, fired: false, fireText: 'The storm breaks.' });
  reply(g);
  await g.Eng.runTurn(g.state, 'I read and eat in the corner.', 'major');
  assert.equal(g.where('sora'), 'canteen');
});

test('offstage people held from their routine say where they usually are, in the user message only', async () => {
  const g = game(10, 'canteen');
  g.state.characters.aoi.status.location = 'plaza';
  g.state.characters.aoi.tier = 'local';
  const calls = reply(g);
  await g.Eng.runTurn(g.state, 'I wait.', 'moment');
  const intent = calls.find((c) => c.kind === 'intent');
  assert.match(intent.user, /Aoi Mori\), in Plaza: .*usually in Classroom now/);
  assert.doesNotMatch(intent.system, /usually in/);
});

// playtest-seiryo-bad-model: "I sit through class" from the gate at 07:09.
test('"I sit through class" from the gate at 07:09 goes to class', async () => {
  const g = newGame('seiryo-high', 'hayakawa');
  const { E, state } = g;
  state.scenario.routines = { student: { slots: [{ from: 8, to: 12, at: ['class'] }, { from: 12, to: 13, at: ['cafeteria'] }] } };
  Object.assign(state.characters.sora, { routine: 'student' });
  delete state.characters.sora.places;
  state.characters.sora.status.location = 'gate';
  state.time.hour = 7 + 9 / 60;
  reply(g, { scene: '[+45m] Sora finds a seat in Class 1-B.\n\n[+170m] The lesson drags on.' });
  const out = await E.Engine.runTurn(state, 'I sit through class.', 'hours');
  assert.equal(state.characters.sora.status.location, 'classroom-1b', 'the room their role names');
  assert.ok(out.res.routineDay.stops[0].at <= 51, 'there by the bell');
});
