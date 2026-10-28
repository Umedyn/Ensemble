// Vesper Station (task 7-3): a research station at Saturn, six hours from its
// reactor breaching. The player gets out, or gets others out, by the pods or
// the Petrel; or finds out, the hard way, that the reactor can be shut down.
// Tracked features with their own states and what a state needs first, the
// "feature" condition, and pressures that only time moves or that stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, readWorld, readScenario, loadEngine } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));
const vesper = (start) => newGame('vesper-station', start);
// A model for whole turns, with a given update and scene.
function model(E, opts = {}) {
  return mockLLM(E, (call) => {
    if (call.kind === 'intent') return opts.intent || { player: { summary: 'acts' }, intents: [], events: [] };
    if (call.kind === 'update') return Object.assign({ facts: [], state: [], relations: [], player_attitude: [] }, opts.update || {});
    if (call.kind === 'narrate') return /That scene ended the story/.test(call.user) ? 'The station goes quiet around you.\n\nWhat comes next can wait for morning.' : opts.scene || '[+0m] The klaxons keep on. Nobody speaks.';
    return { title: 'T', summary: 'S' };
  });
}
const put = (state, id, room) => { state.characters[id].status.location = room; };
const intentUser = (E, state, action) => E.Prompts.intent(state, E.Engine.present(state), action, 'a few minutes', 'moment', {});
const update = (E, state, upd, room) => E.Engine.applyUpdate(state, Object.assign({ facts: [], state: [], relations: [], player_attitude: [] }, upd), [], { startLoc: room, endLoc: room, prose: '', turn: state.turn });

// ---------- the world ----------

test('Vesper Station plays from every start: Yuki in Ops, Felix in the galley, Sophia in the Core room, and a person of your own', async () => {
  const w = readWorld('vesper-station');
  assert.deepEqual(w.starts.map((s) => [s.id, s.error]), [['ops', undefined], ['galley', undefined], ['sophia', undefined]]);
  for (const [start, who, room] of [['ops', 'yuki', 'ops'], ['galley', 'felix', 'galley'], ['sophia', 'sophia', 'core']]) {
    const { E, state } = vesper(start);
    assert.deepEqual([state.player, state.characters[state.player].status.location, E.fmtTime(state)], [who, room, 'Mission day 412, 02:00']);
    model(E);
    await E.Engine.runTurn(state, 'Look around.', 'moment');
    assert.equal(state.turn, 1, start);
  }
  // Make your own: in Ops beside the commander, with Yuki still aboard (her
  // night shift is how the player can hear about the reactor's interlock).
  const E = loadEngine();
  const world = readWorld('vesper-station', E);
  const sc = world.starts.find((s) => s.id === 'ops').scenario;
  const made = E.CharMaker.build(sc, Object.assign(E.CharMaker.defaults(sc), { name: 'Ama Boateng', want: 'get off alive', traits: ['steady'], role: 'contractor' })).character;
  const state = E.Engine.newGame(E.Scenario.startScenario(world, 'ops', made));
  assert.equal(state.player, 'ama-boateng');
  assert.equal(state.characters['ama-boateng'].status.location, 'ops');
  assert.ok(state.characters.yuki, 'Yuki stays aboard');
  mockLLM(E, (call) => (call.kind === 'intent' ? { player: { summary: 'acts' }, intents: [], events: [] } : call.kind === 'narrate' ? '[+0m] Varga looks at you.' : { facts: [], state: [], relations: [], player_attitude: [] }));
  await E.Engine.runTurn(state, 'Ask the commander what to do.', 'moment');
  assert.equal(state.turn, 1);
});

test('Sophia is a machine: no hunger or fatigue, only the strain; and she holds the keys the crew don\'t all have', () => {
  const { E, state } = vesper('sophia');
  const s = state.characters.sophia;
  assert.deepEqual(Object.keys(s.needs), ['stress']);
  assert.match(E.Prompts.header(state), /Never feels: hunger, fatigue\./);
  assert.ok(E.Engine.passable(state, 'engineering', 'reactor', 'sophia'));
  assert.ok(E.Engine.passable(state, 'hub', 'core', 'sophia'));
  assert.ok(!E.Engine.passable(state, 'engineering', 'reactor', 'felix'), 'the pilot has no key to Reactor Control');
  E.Engine.advanceTime(state, 3, { events: [] });
  assert.deepEqual(Object.keys(s.needs), ['stress']);
});

// ---------- the clock ----------

test('six hours: only time moves the reactor\'s clock, and at 08:00 the station is lost with everyone aboard', async () => {
  const { E, state } = vesper('ops');
  const breakup = state.clocks.find((c) => c.id === 'breakup');
  const report = update(E, state, { state: [{ target: 'clock:breakup', delta: -6 }] }, 'ops');
  assert.match(report.rejected.join(' '), /only time moves this pressure/);
  const res = { events: [], guards: [] };
  E.Engine.applyEffects(state, { clocks: [{ id: 'breakup', delta: -5 }] }, res, 'regional');
  assert.equal(breakup.value, 0, 'an event can\'t buy time either');
  // Five and a half hours on, the reactor still holds; at eight it doesn't.
  model(E);
  E.Engine.advanceTime(state, 5.5, { events: [] });
  assert.equal(breakup.fired, false);
  await E.Engine.runTurn(state, 'Keep working on the clamps.', 'hour');
  assert.equal(breakup.fired, true);
  assert.equal(state.ending && state.ending.id, 'lost');
  assert.equal(state.world.reactor, 'breached; the station is breaking up');
});

test('the longer steps run into the deadline: next morning is an hour short of it; something major stops at the first smaller pressure', async () => {
  const { E, state } = vesper('galley');
  // The first to go off is the fire or the aft spine, long before the reactor.
  const plan = E.Engine.planMajorSkip(state, 'Wait in the galley.');
  assert.ok(plan.hours <= 4, `stops at ${plan.hours}h`);
  // Until next morning: 02:00 to 07:00, an hour before the breach.
  model(E);
  await E.Engine.runTurn(state, 'Wait it out in the galley.', 'morning');
  assert.equal(E.fmtTime(state), 'Mission day 412, 07:00');
  assert.equal(state.ending, undefined);
  assert.ok(['fire', 'aft-air', 'window'].every((id) => state.clocks.find((c) => c.id === id).fired), 'the smaller pressures came first');
  model(E);
  await E.Engine.runTurn(state, 'Keep waiting.', 'morning');
  assert.equal(state.ending && state.ending.id, 'lost');
});

// ---------- the hidden save ----------

test('the reactor won\'t shut down while its rod interlock is bypassed, and the scene is told why; reset, it will', () => {
  const { E, state } = vesper('sophia');
  put(state, 'sophia', 'reactor');
  const things = intentUser(E, state, 'Shut the reactor down.');
  assert.match(things, /Things here: local panel, radiation alarm, rod interlock \(bypassed\), reactor \(running; shutdown commands don't take here either: the rods won't drop\)/);
  let report = update(E, state, { state: [{ target: 'feature:reactor|reactor', field: 'state', value: 'shut down' }] }, 'reactor');
  assert.match(report.rejected.join(' '), /the reactor can't be shut down yet: needs the rod interlock in Reactor Control is "reset"/);
  assert.equal(state.features['reactor|reactor'], 'running');
  report = update(E, state, { state: [{ target: 'feature:reactor|rod interlock', field: 'state', value: 'switched off' }] }, 'reactor');
  assert.match(report.rejected.join(' '), /the rod interlock can only be: bypassed, reset/);
  // The update step is shown what each thing can become now.
  assert.match(E.Prompts.update(state, 'Look at the panel.', { outcomes: [], events: [] }, '[+0m] The panel glows.', ['sophia'], false), /reactor\|reactor \(running; can become: nothing else now\)/);
  // Interlock reset, then the reactor, in one scene.
  report = update(E, state, { state: [{ target: 'feature:reactor|rod interlock', field: 'state', value: 'reset' }, { target: 'feature:reactor|reactor', field: 'state', value: 'shut down' }] }, 'reactor');
  assert.deepEqual([...report.rejected], []);
  assert.equal(state.features['reactor|reactor'], 'shut down');
  // Only someone in the scene can do it: nobody shuts it down from Ops.
  const other = vesper('ops');
  const r2 = update(other.E, other.state, { state: [{ target: 'feature:reactor|rod interlock', field: 'state', value: 'reset' }] }, 'ops');
  assert.match(r2.rejected.join(' '), /nobody in the scene was there/);
});

test('Vesper holds: the shutdown closes the story before the next action, the clock stops for good, and keeping on never blows the station', async () => {
  const { E, state } = vesper('sophia');
  put(state, 'sophia', 'reactor');
  put(state, 'maren', 'reactor');
  model(E, { scene: '[+0m] You pull the jumper from the interlock. [+2m] The rods drop with a sound like a door closing.' });
  await E.Engine.runTurn(state, 'Reset the interlock and drop the rods.', 'moment');
  assert.equal(state.ending, undefined, 'recorded with the next action');
  const calls = model(E, { update: { state: [{ target: 'feature:reactor|rod interlock', field: 'state', value: 'reset' }, { target: 'feature:reactor|reactor', field: 'state', value: 'shut down' }] } });
  const out = await E.Engine.runTurn(state, 'Listen to the pumps.', 'moment');
  assert.deepEqual([out.ended, out.held, out.ending.id, out.ending.kind], [true, 'Listen to the pumps.', 'vesper-holds', 'win']);
  assert.ok(!calls.some((c) => c.kind === 'intent'), 'the next action is not played');
  assert.match(calls.find((c) => /That scene ended the story/.test(c.user)).user, /"Vesper holds" \(a hard-won success\)\. It happened: all of: the reactor in Reactor Control is "shut down"\./);
  const breakup = state.clocks.find((c) => c.id === 'breakup');
  assert.equal(breakup.stopped, true);
  assert.ok(!E.Engine.liveClocks(state).includes(breakup), 'gone from the Situation panel and the prompts');
  // Keep playing: hours go by and the station is still there.
  E.Engine.keepPlaying(state);
  E.Engine.advanceTime(state, 10, { events: [] });
  assert.equal(breakup.fired, false);
  assert.deepEqual([...state.endingsReached], ['vesper-holds']);
  assert.equal(E.Engine.planMajorSkip(state, 'Rest.').id === 'breakup', false);
});

test('nothing gives the save away: no prompt names it before it happens, and the update step only weighs the judged endings', () => {
  // The clues are Yuki's own night shift (hers when she is the player), Maren's
  // secret, and the panel in Reactor Control itself.
  for (const start of ['galley', 'sophia']) {
    const g = vesper(start);
    assert.doesNotMatch(g.E.Prompts.header(g.state), /interlock|Vesper holds/i, start);
  }
  const yuki = vesper('ops');
  assert.match(yuki.E.Prompts.header(yuki.state), /jumper cable across the rod interlock/, 'Yuki knows what she saw');
  const { E, state } = vesper('galley');
  assert.doesNotMatch(intentUser(E, state, 'Look around.'), /interlock|Vesper holds/i);
  const upd = E.Prompts.update(state, 'Look around.', { outcomes: [], events: [] }, '[+0m] The galley is dark.', ['felix'], false);
  assert.match(upd, /- nobody-left: /);
  assert.match(upd, /- left-behind: /);
  assert.doesNotMatch(upd, /vesper-holds|pod-one|shut down/);
});

// ---------- the ways out ----------

test('each way out ends the story: pod one, pod two once its clamps are freed, and the Petrel only inside its window', async () => {
  // Pod one.
  let { E, state } = vesper('ops');
  put(state, 'yuki', 'pod-1');
  update(E, state, { state: [{ target: 'feature:pod-1|launch clamps', field: 'state', value: 'released' }] }, 'pod-1');
  assert.equal(E.Engine.checkEndings(state, { guards: [] }).id, 'pod-one');
  // Pod two: jammed, the lever does nothing until the clamps are freed.
  ({ E, state } = vesper('ops'));
  put(state, 'yuki', 'pod-2');
  let report = update(E, state, { state: [{ target: 'feature:pod-2|launch clamps', field: 'state', value: 'released' }] }, 'pod-2');
  assert.match(report.rejected.join(' '), /can't be released yet: needs the launch clamps in Escape pod two is "locked"/);
  assert.match(intentUser(E, state, 'Pull the lever.'), /launch clamps \(jammed; the clamps are jammed in the buckled collar/);
  update(E, state, { state: [{ target: 'feature:pod-2|launch clamps', field: 'state', value: 'locked' }] }, 'pod-2');
  update(E, state, { state: [{ target: 'feature:pod-2|launch clamps', field: 'state', value: 'released' }] }, 'pod-2');
  assert.equal(E.Engine.checkEndings(state, { guards: [] }).id, 'pod-two');
  // The Petrel: away inside the window; once the dock faces the debris, not at all.
  ({ E, state } = vesper('galley'));
  put(state, 'felix', 'petrel');
  update(E, state, { state: [{ target: 'feature:petrel|docking clamps', field: 'state', value: 'released' }] }, 'petrel');
  assert.equal(E.Engine.checkEndings(state, { guards: [] }).id, 'petrel-away');
  ({ E, state } = vesper('galley'));
  put(state, 'felix', 'petrel');
  E.Engine.advanceTime(state, 4, { events: [] });
  assert.equal(state.world.shuttle, 'launch window closed: the dock faces the debris stream');
  report = update(E, state, { state: [{ target: 'feature:petrel|docking clamps', field: 'state', value: 'released' }] }, 'petrel');
  assert.match(report.rejected.join(' '), /can't be released yet/);
  assert.equal(E.Engine.checkEndings(state, { guards: [] }), null);
});

test('leaving people behind, or bringing them all out, is the model\'s call with a quote from the scene', async () => {
  const { E, state } = vesper('galley');
  put(state, 'felix', 'petrel');
  const scene = '[+0m] You seal the hatch with Noor and the contractors strapped in behind you.\n\n[+5m] The Petrel drops away from the dock, and on the intercom Varga is still calling for anyone in the hub.';
  model(E, { scene });
  await E.Engine.runTurn(state, 'Seal the hatch and go.', 'moment');
  model(E, { update: { ending: { id: 'left-behind', quote: 'Varga is still calling for anyone in the hub' } } });
  const out = await E.Engine.runTurn(state, 'Look back.', 'moment');
  assert.deepEqual([out.ended, out.ending.id, out.ending.kind], [true, 'left-behind', 'loss']);
});

// ---------- the parts, checked in plain words ----------

test('feature states, what a state requires, the "feature" condition, and fixed or stopping pressures are checked in plain words', () => {
  const E = loadEngine();
  const sc = readScenario('vesper-station', 'ops');
  const problems = (edit) => { const c = plain(sc); edit(c); try { E.Scenario.validate(c); return ''; } catch (err) { return err.message; } };
  const room = (c, id) => c.locations.find((l) => l.id === id);
  const feat = (c, id, name) => room(c, id).features.find((f) => f.name === name);
  assert.equal(problems(() => {}), '');
  assert.match(problems((c) => { feat(c, 'spine-aft', 'hull patch').states = ['sealed']; }), /feature "hull patch": "states" must be a list of 2 to 8/);
  assert.match(problems((c) => { feat(c, 'spine-aft', 'hull patch').state = 'gone'; }), /its "state" "gone" isn't one of its "states"/);
  assert.match(problems((c) => { feat(c, 'reactor', 'reactor').requires = { melted: { if: [{ alive: 'maren' }] } }; }), /"requires" names "melted", which isn't one of its "states"/);
  assert.match(problems((c) => { feat(c, 'reactor', 'reactor').requires['shut down'].if = [{ feature: 'reactor|rods', is: 'down' }]; }), /no tracked feature "reactor\|rods"/);
  assert.match(problems((c) => { c.endings.find((e) => e.id === 'vesper-holds').if = [{ feature: 'reactor|reactor', is: 'melted' }]; }), /"reactor\|reactor" can't be "melted" \(its states: running, shut down\)/);
  assert.match(problems((c) => { c.clocks[0].fixed = 'yes'; }), /"fixed" must be true or false/);
  assert.match(problems((c) => { c.clocks[0].stopIf = { feature: 'reactor|reactor', is: 'shut down' }; }), /"stopIf" must be a list of conditions/);
  assert.match(problems((c) => { c.clocks[0].stopIf = [{ feature: 'reactor' }]; }), /"feature" needs "room\|name" and "is"/);
});

test('the bundled examples use them: Ares Deep\'s recycler stops once repaired and the storm only comes with time; the holdout\'s pickup needs its keys', () => {
  // Ares Deep.
  let { E, state } = newGame('mars-station');
  const recycler = state.clocks.find((c) => c.id === 'recycler');
  put(state, 'navarro', 'hydro');
  let report = update(E, state, { state: [{ target: 'clock:storm', delta: -5 }, { target: 'feature:hydro|water recycler', field: 'state', value: 'repaired' }] }, 'hydro');
  assert.match(report.rejected.join(' '), /clock:storm.* only time moves this pressure/);
  E.Engine.advanceTime(state, 1, { events: [] });
  assert.equal(recycler.stopped, true);
  E.Engine.advanceTime(state, 100, { events: [] });
  assert.equal(recycler.fired, false);
  // The holdout: the pickup won't start until someone knows where its keys are.
  ({ E, state } = newGame('zombie-holdout'));
  put(state, state.player, 'lot');
  report = update(E, state, { state: [{ target: 'feature:lot|the pickup', field: 'state', value: 'running' }] }, 'lot');
  assert.match(report.rejected.join(' '), /the pickup can't be running yet/);
  E.Memory.addFact(state, { about: [state.player], text: 'The pickup\'s keys are in the office desk.', known_by: [state.player], weight: 2 });
  report = update(E, state, { state: [{ target: 'feature:lot|the pickup', field: 'state', value: 'running' }] }, 'lot');
  assert.deepEqual([...report.rejected], []);
});
