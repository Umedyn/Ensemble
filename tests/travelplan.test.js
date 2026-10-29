// Travel plans (task R-10): the model says where; the engine finds the way
// and the minutes for each part. A short trip arrives partway through the
// step and the scene goes on there; a long one stops where the step runs out,
// says what is left, and "keep going" (or the major step) picks it up.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newGame, mockLLM, loadEngine, worldFiles } = require('./helpers');
const { replay } = require('./replay');

// The mock: the intent moves the player (and maybe others), the scene is a few beats.
function travelMock(E, o = {}) {
  return mockLLM(E, ({ kind, user }) => {
    if (kind === 'intent' && /=== DOWNTIME/.test(user)) return { montage: [{ after: '30m', text: 'The train runs south.' }], events: [], major_event: null, positions: [], player_where: null };
    if (kind === 'intent') return { player: { summary: o.summary || 'go', move_to: o.to === undefined ? null : o.to }, intents: o.intents || [], events: [] };
    if (kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    if (kind === 'narrate') return o.scene || '[+0m] You set off.\n\n[+20m] The streets go by.\n\n[+50m] You are there.';
    return { title: 'x', summary: 'y' };
  });
}
const guards = (out, type) => out.res.guards.filter((g) => g.type === type).map((g) => g.detail);
const seiryo = () => {
  const g = newGame('seiryo-high');
  // The player, looked up each time: a step-in replaces the whole state.
  Object.defineProperty(g, 'pc', { get: () => g.state.characters[g.state.player] });
  return g;
};

// ---------- the plan ----------

test('the plan: the rooms on the way with their minutes, from link times, region legs and defaults', () => {
  const { E, state } = seiryo();
  const plan = E.Engine.travelPlan(state, 'hayakawa-living', 'gate', 'sora');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.steps.map((s) => [s.to, s.kind, s.at]))), [
    ['hayakawa-entry', 'open', 1], ['street-south', 'door', 2], ['station-plaza', 'trip', 10], ['shopping-street', 'open', 11], ['lake-senba', 'trip', 26], ['gate', 'trip', 36]]);
  assert.equal(plan.minutes, 36);
  assert.equal(plan.blocked, null);
  // Without the authored times: a trip across free borders takes the border default by label.
  state.locations['street-south'].links.forEach((k) => { delete k.time; });
  assert.equal(E.Engine.linkMinutes(state, 'street-south', 'station-plaza'), E.Scenario.BORDER_MINUTES.neighbourhood, 'Station South → Downtown: a neighbourhood border');
  // A timed route is the whole way: the rail to Tokyo, not a border default on top.
  delete state.locations['station-plaza'].links.find((k) => k.to === 'tokyo-campus').time;
  assert.equal(E.Engine.linkMinutes(state, 'station-plaza', 'tokyo-campus'), 80);
  // A world's own defaults.
  state.scenario.travelTimes = { links: { door: 3 }, borders: { neighbourhood: 20 } };
  assert.equal(E.Engine.linkMinutes(state, 'hayakawa-entry', 'street-south'), 3);
  assert.equal(E.Engine.linkMinutes(state, 'street-south', 'station-plaza'), 20);
});

test('a door onto the next region is the step through it, not a border default (Mars: the airlock has its own time)', () => {
  const { E, state } = newGame('mars-station');
  assert.equal(E.Engine.linkMinutes(state, 'suitroom', 'surface'), 10, 'the airlock cycle, authored');
  delete state.locations.suitroom.links[0].time;
  assert.equal(E.Engine.linkMinutes(state, 'suitroom', 'surface'), 1, 'a door is a minute, whatever regions it joins');
});

test('link times and travelTimes are checked in plain words', () => {
  const E = loadEngine();
  const f = worldFiles(path.join(__dirname, 'fixtures', 'slice-of-life'));
  const st = f['starts/sunday.json'];
  st.locations[0].links = [{ to: st.locations[0].connects[0], kind: 'door', time: 'soon' }];
  f['world.json'].travelTimes = { links: { door: 'two', teleport: 1 }, borders: { city: -5 }, speed: 2 };
  const w = E.Scenario.prepareWorld('t', f);
  const err = String(w.starts[0].error || '') + JSON.stringify(w.problems || []);
  assert.match(err, /"time" must be like "1m", "15m" or "1h20m" \(got "soon"\)/);
  assert.match(err, /travelTimes\.links\.door must be a number of minutes/);
  assert.match(err, /travelTimes\.links: "teleport" is not a kind of link/);
  assert.match(err, /travelTimes\.borders\.city must be a number of minutes/);
  assert.match(err, /travelTimes: unknown field "speed"/);
});

// ---------- the turn ----------

test('home to the School gate arrives partway through the hour, and the scene setup says when', async () => {
  const g = seiryo();
  const { E, state } = g;
  const calls = travelMock(E, { to: 'gate' });
  const out = await E.Engine.runTurn(state, 'I go to Seiryo High.', 'hour');
  assert.equal(g.pc.status.location, 'gate');
  const t = out.res.travel;
  assert.equal(t.arriveAt, 36);
  assert.deepEqual(JSON.parse(JSON.stringify(t.stops.map((s) => [s.name, s.at]))), [['Mito Station plaza', 10], ['Lake Senba lakeside path', 26], ['School gate and the cherry slope', 36]]);
  const narrate = calls.find((c) => c.kind === 'narrate').user;
  assert.match(narrate, /The way \(planned by the engine\): leaves \+0m; Mito Station plaza \+10m; Lake Senba lakeside path \+26m; arrives at School gate and the cherry slope \+36m\. Tell the trip briefly in the beats before \[\+36m\]; from \[\+36m\] the scene is at School gate and the cherry slope/);
  assert.equal(state.travel, undefined, 'nothing left to go');
  assert.equal(state.log.filter((e) => e.type === 'scene').pop().travel, undefined);
});

// playtest-seiryo-bad-model: "I take the bus to Seiryo High" and "I join the
// others in the gym" came back with no move, and nothing in the engine knew
// them as going somewhere; "I go to Seiryo High" did.
test('a ride or joining people somewhere goes there: the bus to Seiryo High, the others in the gym', async () => {
  const g = seiryo();
  const { E, state } = g;
  const Eng = E.Engine;
  assert.equal(Eng.placeInWords(state, 'I take the bus to Seiryo High.'), 'gate');
  assert.equal(Eng.placeInWords(state, 'I catch the train to Tokyo campus.'), Eng.placeInWords(state, 'I go to Tokyo campus.'));
  assert.equal(Eng.placeInWords(state, 'I join the others in the gym.'), 'gym', 'the room id is a name too (the Gymnasium)');
  assert.equal(Eng.placeInWords(state, 'I take the photo for Mom.'), null, 'a ride needs a place');
  travelMock(E, { to: null });
  await Eng.runTurn(state, 'I take the bus to Seiryo High.', 'hour');
  assert.equal(g.pc.status.location, 'gate');
});

// playtest-seiryo-bad-model: "I go to class" went to Class 1-A, and Sora is in 1-B.
test('going to class or to my room goes to the player\'s own, over the model\'s guess next door', async () => {
  const g = seiryo();
  const { E, state } = g;
  const Eng = E.Engine;
  assert.deepEqual([...Eng.ownRooms(state).map((l) => l.id)].sort(), ['classroom-1b', 'sora-room', 'street-south'], 'the role names Class 1-B; "Your room" and "Your street" are his');
  assert.equal(Eng.ownPlaceInWords(state, 'I go to class.'), 'classroom-1b');
  assert.equal(Eng.ownPlaceInWords(state, 'I head up to my room.'), 'sora-room');
  assert.equal(Eng.ownPlaceInWords(state, 'I go to the classroom.'), null, 'only the own room\'s words');
  assert.equal(Eng.placeInWords(state, 'I go to Class 1-A.'), 'classroom-1a', 'a room named in full still wins');
  g.pc.status.location = 'gate';
  travelMock(E, { to: 'classroom-1a' });
  const out = await Eng.runTurn(state, 'I go to class', 'hour');
  assert.equal(g.pc.status.location, 'classroom-1b');
  assert.match(guards(out, 'move resolved')[0], /"classroom-1a" → Class 1-B/);
});

// playtest-seiryo-bad-model: the scene had no time markers, so the hour
// settled at +6m and Sora stood at the gate at 07:09, half an hour before
// the plan could get him there.
test('a scene with no time markers does not settle a planned trip before it arrives', async () => {
  const g = seiryo();
  const { E, state } = g;
  const start = state.time.day * 1440 + state.time.hour * 60;
  travelMock(E, { to: 'gate', scene: 'You walk down to the station and up the lake path. The gate is still shut.' });
  const out = await E.Engine.runTurn(state, 'I go to Seiryo High.', 'hour');
  assert.equal(out.res.travel.arriveAt, 36);
  const now = state.time.day * 1440 + state.time.hour * 60;
  assert.equal(Math.round(now - start), 42, 'the arrival, and a little for the scene there');
  // A trip the step can't finish takes the whole step.
  const h = seiryo();
  const t0 = h.state.time.day * 1440 + h.state.time.hour * 60;
  travelMock(h.E, { to: 'tokyo-campus', scene: 'You ride the train south.' });
  await h.E.Engine.runTurn(h.state, 'I go to Tokyo.', 'hour');
  assert.equal(Math.round(h.state.time.day * 1440 + h.state.time.hour * 60 - t0), 60);
});

test('stepping in before the arrival puts the player where the plan has them then', async () => {
  const g = seiryo();
  const { E, state } = g;
  travelMock(E, { to: 'gate' });
  await E.Engine.runTurn(state, 'I go to Seiryo High.', 'hour');
  travelMock(E, { to: null });
  await E.Engine.runTurn(state, 'I look at the station clock.', 'moment', null, 1);
  assert.equal(g.pc.status.location, 'station-plaza', 'cut at +10m: at the plaza');
  assert.equal(state.travel.dest, 'gate');
  assert.equal(state.log.filter((e) => e.type === 'scene' && e.turn === 1)[0].travel, 'School gate and the cherry slope is still about 26m away.');
});

test('Station South to Tokyo on a short step stops at the station plaza with the time left, and goes on next turn', async () => {
  const g = seiryo();
  const { E, state } = g;
  g.pc.status.location = 'street-south';
  travelMock(E, { to: 'tokyo-campus' });
  const out = await E.Engine.runTurn(state, 'I take the train to Tokyo.', 'moment');
  assert.equal(g.pc.status.location, 'station-plaza', 'the last room reached: 7 minutes into the train is still the plaza');
  assert.match(guards(out, 'travel')[0], /University district, Bunkyo is 1h 43m away; the step ends at Mito Station plaza, 1h 28m short/);
  assert.equal(state.log.filter((e) => e.type === 'scene').pop().travel, 'University district, Bunkyo is still about 1h 28m away.');
  assert.deepEqual({ ...state.travel }, { dest: 'tokyo-campus', destName: 'University district, Bunkyo', turn: 1 });
  // Next turn: "keep going" sets the move, whatever the model said.
  const calls = travelMock(E, { to: null });
  const on = await E.Engine.runTurn(state, 'Keep going.', 'hour');
  assert.match(guards(on, 'travel resumed')[0] || on.res.guards.map((g) => g.type).join(), /on to University district/);
  assert.match(g.pc.status.location, /^on-the-way/, 'an hour into a 95-minute ride: on the train');
  assert.match(calls.find((c) => c.kind === 'narrate').user, /The time runs out on the way: at the end Sora Hayakawa is still travelling, about 35m from University district, Bunkyo/);
  travelMock(E, { to: null });
  await E.Engine.runTurn(state, 'Carry on.', 'hour');
  assert.equal(g.pc.status.location, 'tokyo-campus');
  assert.equal(state.travel, undefined);
});

test('heading somewhere else drops the unfinished trip', async () => {
  const g = seiryo();
  const { E, state } = g;
  g.pc.status.location = 'street-south';
  travelMock(E, { to: 'tokyo-campus' });
  await E.Engine.runTurn(state, 'I take the train to Tokyo.', 'moment');
  travelMock(E, { to: 'ramen-stall' });
  const out = await E.Engine.runTurn(state, 'Forget it, I go to the ramen stall.', 'moment');
  assert.match(out.res.guards.find((g) => g.type === 'travel dropped').detail, /instead of University district/);
  assert.equal(state.travel, undefined);
});

test('the "until something major happens" step runs the whole journey, and Tokyo by name finds its place', async () => {
  const g = seiryo();
  const { E, state } = g;
  g.pc.status.location = 'street-south';
  const calls = travelMock(E);
  const out = await E.Engine.runTurn(state, 'I take the train to Tokyo.', 'major');
  assert.equal(g.pc.status.location, 'tokyo-campus');
  assert.match(guards(out, 'journey').join(' '), /arrived at University district, Bunkyo after 1h 45m/);
  assert.ok(calls.some((c) => /The downtime is a journey/.test(c.user)));
});

test('a locked door on the way stops the trip at the room before it, with the reason', async () => {
  const { E, state } = newGame('zombie-holdout');
  const pc = state.characters[state.player];
  pc.status.location = 'dock';
  travelMock(E, { to: 'roof' });
  const out = await E.Engine.runTurn(state, 'I climb up to the roof.', 'moment');
  assert.equal(pc.status.location, 'floor', 'as far as the sales floor');
  assert.match(guards(out, 'move blocked')[0], /the door between Sales Floor and Manager's Office is locked; stops at Sales Floor/);
  assert.equal(state.travel, undefined, 'nothing to go on with');
  assert.match(state.log.filter((e) => e.type === 'scene').pop().travel, /The way to Roof is blocked/);
});

test('people taken along travel on the same plan', async () => {
  const { E, state } = newGame('mars-station');
  const pc = state.characters[state.player];
  travelMock(E, { to: 'surface', intents: [{ id: 'okafor', action: 'suits up to come along', move_to: null }, { id: 'bauer', action: 'stays by the recycler', move_to: null }] });
  const out = await E.Engine.runTurn(state, 'I suit up and go out to the rim with Okafor.', 'moment');
  assert.equal(pc.status.location, 'surface');
  assert.equal(out.res.travel.arriveAt, 11, 'a minute to the suit room, ten for the airlock');
  assert.equal(state.characters.okafor.status.location, 'surface', 'she comes along');
  assert.equal(state.characters.bauer.status.location, 'commons');
});

test('a world without regions or times plays as before: a room next door is a minute away', async () => {
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('flat', worldFiles(path.join(__dirname, 'fixtures', 'slice-of-life')));
  const state = E.Engine.newGame(E.Scenario.startScenario(w));
  const pc = state.characters[state.player];
  const next = E.Engine.linkedRooms(state, pc.status.location)[0];
  travelMock(E, { to: next });
  const out = await E.Engine.runTurn(state, `I go to the ${state.locations[next].name}.`, 'moment');
  assert.equal(pc.status.location, next);
  assert.equal(out.res.travel.arriveAt, 1);
});

test('old saves load: no trip to go on with, and a pending turn from before still steps in', async () => {
  const { E } = newGame('mars-station');
  const fixture = require('./fixtures/mock-session.json');
  const old = E.Engine.migrate(JSON.parse(JSON.stringify(fixture.start)));
  assert.equal(old.travel, undefined);
  const { steps } = await replay('mock-session');
  assert.ok(steps.length > 0, 'an older recording plays');
});

test('both Seiryo recordings replay, with the new arrival time in the scene setup', async () => {
  for (const name of ['playtest-seiryo-goes-to-school', 'playtest-seiryo-goes-downtown']) {
    const frames = [];
    await replay(name, { onCall: ({ kind, body }) => { if (kind === 'narrate') frames.push(body.messages[1].content); } });
    assert.ok(frames.some((u) => /The way \(planned by the engine\): leaves \+0m; [^\n]*arrives at School gate and the cherry slope \+\d+m\. Tell the trip briefly/.test(u)), name);
  }
});
