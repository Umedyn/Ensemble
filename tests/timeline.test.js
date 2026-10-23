// The canon timeline (task 5-2): preconditions, events firing as written,
// dropped or rewritten, the past at New game, the downtime skip, stepping in,
// projected events, validation and saves.
const test = require('node:test');
const assert = require('node:assert');
const { loadEngine, worldFiles, newGame, mockLLM, fixedRng } = require('./helpers');

const plain = (x) => JSON.parse(JSON.stringify(x));
const guardsOf = (res, type) => (res.guards || []).filter((g) => g.type === type).map((g) => g.detail);
const lastReport = (E) => E.Engine.telemetry[E.Engine.telemetry.length - 1];
const reportGuards = (E, type) => lastReport(E).guards.filter((g) => g.type === type).map((g) => g.detail);
const SCENE = '[+0m] You keep watch.\n\n[+20m] The radio hisses.\n\n[+50m] Ortiz looks up. "Did you hear that?"';
const UPDATE = { facts: [], state: [], relations: [], player_attitude: [] };

// A mock model: intent replies come from `intent` (an object or a function of
// the call), the scene is SCENE, the update records nothing; `other` answers
// the rest (projection, chapters).
function model(E, { intent, skip, other } = {}) {
  return mockLLM(E, (call) => {
    if (call.kind.startsWith('intent') && call.user.includes('=== DOWNTIME:')) return typeof skip === 'function' ? skip(call) : skip || { montage: [{ after: '1d', text: 'Days pass.' }], events: [], major_event: null, positions: [] };
    if (call.kind.startsWith('intent')) return typeof intent === 'function' ? intent(call) : intent || { player: { summary: 'keeps watch', needs_roll: false }, intents: [], events: [] };
    if (call.kind.startsWith('narrate')) return SCENE;
    if (call.kind.startsWith('update')) return UPDATE;
    if (other) return other(call);
    return { title: 'A chapter', summary: 'Things happened.' };
  });
}
// The holdout one hour before the Ridge closes its road (Day 25, 09:00).
function beforeRidge() {
  const g = newGame('zombie-holdout');
  g.state.time = { day: 25, hour: 8.5 };
  return g;
}

// ---------- preconditions ----------

test('each precondition is checked by the engine: alive, controls, clock, world, known, not', () => {
  const { E, state } = newGame('zombie-holdout');
  const TL = E.Timeline;
  const h = (p) => TL.holds(state, p);
  assert.ok(h({ alive: 'ortiz' }));
  state.characters.ortiz.status.health = 'dead';
  assert.ok(!h({ alive: 'ortiz' }));
  assert.ok(h({ controls: { group: 'ridge', region: 'ridge-town' } }));
  assert.ok(!h({ controls: { group: 'convoy', region: 'junction' } }));
  assert.ok(h({ controls: { group: null, region: 'junction' } }), 'null: no one holds it');
  const horde = state.clocks.find((c) => c.id === 'horde');
  horde.value = 5;
  assert.ok(!h({ clock: 'horde', atLeast: 6 }));
  horde.value = 6;
  assert.ok(h({ clock: 'horde', atLeast: 6 }));
  assert.ok(!h({ clock: 'not-started-yet', atLeast: 1 }), 'a clock that does not exist yet does not hold');
  assert.ok(h({ world: 'barricades', is: 'holding, front windows weak' }));
  assert.ok(!h({ world: 'barricades', is: 'down' }));
  assert.ok(h({ known: 'evacuation' }), 'the fact a past canon event made');
  assert.ok(!h({ known: 'ridge-road-closed' }));
  E.Memory.addFact(state, { about: ['han'], text: 'Ruth heard a convoy on the radio heading for the coast.', known_by: ['han'], weight: 2 });
  assert.ok(!h({ known: { words: ['convoy', 'coast'] } }), 'the player does not know it');
  assert.ok(h({ known: { words: ['Convoy', 'COAST'] }, by: 'han' }), 'Ruth does (whole words, any case)');
  assert.ok(!h({ known: { words: ['convoy', 'boats'] }, by: 'han' }), 'every word must be there');
  assert.ok(h({ not: { alive: 'ortiz' } }));
  assert.ok(!h({ not: { not: { alive: 'ortiz' } } }));
  const ev = { preconditions: [{ alive: 'ortiz' }, { controls: { group: 'ridge', region: 'ridge-town' } }] };
  assert.deepEqual(plain(TL.status(state, ev)), [{ text: 'Marlene Ortiz is alive', ok: false }, { text: 'The Ridge holds Ridge', ok: true }]);
});

// ---------- in a turn ----------

test('a due canon event happens as written: effects, news, a public fact, the narrator hears it; it does not use or reset the event rationing', async () => {
  const { E, state } = beforeRidge();
  const calls = model(E);
  await E.Engine.runTurn(state, 'Keep watch from the roof.', 'hour');
  assert.equal(state.canon['ridge-road-closed'].status, 'fired');
  assert.ok(state.regions['ridge-town'].tags.includes('road blocked'));
  assert.equal(state.factions.find((f) => f.id === 'ridge').stance, 'closed to outsiders; trades at the barricade');
  assert.ok(state.news.some((n) => /Ridge closes the ridge road/.test(n.text) && n.region === 'ridge-town'));
  const fact = state.facts.find((f) => f.canon === 'ridge-road-closed');
  assert.deepEqual([...fact.known_by], ['all']);
  assert.equal(fact.weight, 3);
  const narrate = calls.find((c) => c.kind === 'narrate');
  assert.match(narrate.user, /EVENT: \(heard from elsewhere[^)]*\) \[regional\] Ridge closes the ridge road/);
  assert.deepEqual(plain(state.tierLast), {}, 'outside the rationing');
  assert.ok(!calls.find((c) => c.kind === 'intent').user.includes('Ridge closes'), 'the intent call never sees a future event');
  assert.equal(reportGuards(E, 'canon fired').length, 1);
});

test('a broken canon event with onBroken "drop" never happens, and Debug says what broke', async () => {
  const { E, state } = beforeRidge();
  state.regions['ridge-town'].controller = null;
  model(E);
  await E.Engine.runTurn(state, 'Keep watch.', 'hour');
  assert.equal(state.canon['ridge-road-closed'].status, 'dropped');
  assert.ok(!state.regions['ridge-town'].tags.includes('road blocked'));
  assert.ok(!state.facts.some((f) => f.canon === 'ridge-road-closed'));
  assert.ok(!state.news.some((n) => /ridge road/.test(n.text)));
  assert.deepEqual(reportGuards(E, 'canon dropped'), ['ridge-road-closed: The Ridge holds Ridge']);
});

test('a broken canon event with onBroken "diverge" is rewritten by the intent call, its effects checked like any other', async () => {
  const { E, state } = newGame('zombie-holdout');
  state.time = { day: 26, hour: 8.5 };
  state.regions.junction.controller = 'ridge';
  const calls = model(E, { intent: { player: { summary: 'waits', needs_roll: false }, intents: [], events: [],
    canon: [{ id: 'convoy-checkpoint', text: 'The convoy reaches the junction, finds Ridge trucks across the ramp, and the two sides settle into a tense standoff.', effects: { add_tag: [{ region: 'junction', tag: 'standoff' }], control: [{ region: 'narnia', to: 'convoy' }] } },
      { id: 'made-up', text: 'Something else.' }] } });
  await E.Engine.runTurn(state, 'Listen to the radio.', 'hour');
  const intent = calls.find((c) => c.kind === 'intent');
  assert.match(intent.user, /EXPECTED EVENTS THE STORY HAS CHANGED/);
  assert.match(intent.user, /- convoy-checkpoint: was "The rescue convoy reaches the highway junction[^"]*" Changed: no one holds Highway junction\./);
  assert.match(intent.user, /"canon":\[\{"id":"convoy-checkpoint"/);
  assert.equal(state.canon['convoy-checkpoint'].status, 'diverged');
  assert.ok(state.regions.junction.tags.includes('standoff'));
  assert.equal(state.regions.junction.controller, 'ridge', 'an unknown region in the effects is rejected');
  assert.ok(lastReport(E).guards.some((g) => g.type === 'effect rejected' && /narnia/.test(g.detail)));
  assert.ok(state.news.some((n) => /tense standoff/.test(n.text)));
  assert.equal(reportGuards(E, 'canon rejected').length, 1, 'an id that is not being rewritten');
  assert.equal(reportGuards(E, 'canon diverged').length, 1);
});

test('a diverging event the model leaves out is dropped; one that gives away a secret is dropped too', async () => {
  for (const canon of [undefined, [{ id: 'convoy-checkpoint', text: 'Ruth fixed a handheld radio and heard the rescue convoy broadcast: the coastal safe zone can take three more people.' }]]) {
    const { E, state } = newGame('zombie-holdout');
    state.time = { day: 26, hour: 8.5 };
    state.regions.junction.controller = 'ridge';
    model(E, { intent: { player: { summary: 'waits', needs_roll: false }, intents: [], events: [], canon } });
    await E.Engine.runTurn(state, 'Listen to the radio.', 'hour');
    assert.equal(state.canon['convoy-checkpoint'].status, 'dropped');
    assert.equal(reportGuards(E, 'canon diverge missing').length, 1);
    assert.ok(!state.news.some((n) => /convoy/i.test(n.text)));
  }
});

test('a hidden canon event changes nothing public: private facts for the people in it only', async () => {
  const { E, state } = beforeRidge();
  state.scenario.timeline.push({ id: 'ferris-count', when: { day: 25, hour: 9 }, scope: 'regional', region: 'highway-strip', visibility: 'hidden', who: ['ferris'],
    text: 'Gil quietly recounts the stock in the stockroom.', effects: { world: [{ key: 'food', value: 'gone' }] } });
  model(E);
  await E.Engine.runTurn(state, 'Keep watch.', 'hour');
  const f = state.facts.find((x) => x.canon === 'ferris-count');
  assert.deepEqual([...f.known_by], ['ferris']);
  assert.equal(state.world.food, 'about four days for five people', 'hidden events have no public effects');
  assert.ok(!state.news.some((n) => /recounts/.test(n.text)));
});

test('stepping in before the end rewinds a canon event that fired in the turn; it comes due again', async () => {
  const { E, state } = beforeRidge();
  model(E);
  await E.Engine.runTurn(state, 'Keep watch.', 'hour');
  assert.equal(state.canon['ridge-road-closed'].status, 'fired');
  // Stepping in after the first beat rewinds to 08:30 plus ten minutes; the
  // next hour brings the event round again.
  await E.Engine.runTurn(state, 'Wait, what was that?', 'hour', null, 1);
  assert.equal(state.canon['ridge-road-closed'].status, 'fired', 'due again, and fired again');
  assert.equal(state.facts.filter((f) => f.canon === 'ridge-road-closed').length, 1, 'once');
  assert.equal(state.regions['ridge-town'].tags.filter((t) => t === 'road blocked').length, 1);
});

// ---------- the past ----------

test('past events become public facts and chapter zero at New game; they are not repeated in the facts block, and their effects are not applied', () => {
  const E = loadEngine();
  const sc = E.Scenario.startScenario(require('./helpers').readWorld('mars-station', E));
  sc.timeline.push({ id: 'old-blackout', when: { day: 100, hour: 3 }, scope: 'world', text: 'A blackout hit the old relay network.', effects: { world: [{ key: 'power', value: 'offline' }] } });
  sc.timeline.push({ id: 'secret-past', when: { day: 150, hour: 3 }, scope: 'world', visibility: 'hidden', who: ['raman'], text: 'Priya signed a side contract.' });
  const state = E.Engine.newGame(sc);
  ['landing', 'sol-120-storm', 'lander-launch', 'old-blackout', 'secret-past'].forEach((id) => assert.equal(state.canon[id].status, 'past', id));
  const landing = state.facts.find((f) => f.canon === 'landing');
  assert.deepEqual([...landing.known_by], ['all']);
  assert.equal(landing.chapter, 0);
  assert.deepEqual([...state.facts.find((f) => f.canon === 'secret-past').known_by], ['raman'], 'hidden past: private');
  assert.equal(state.world.power, 'solar arrays nominal', 'past effects are not applied');
  assert.equal(state.chapters[0].n, 0);
  assert.equal(state.chapters[0].title, 'Before the story');
  assert.match(state.chapters[0].summary, /^Sol 1: The Ares crew landed[^]*Sol 100: A blackout[^]*Sol 120: A regional dust storm[^]*Sol 190: /);
  assert.ok(!state.chapters[0].summary.includes('side contract'));
  const header = E.Prompts.header(state);
  assert.match(header, /=== STORY SO FAR ===\nChapter 0 — Before the story: Sol 1:/);
  assert.equal(header.split('The Ares crew landed').length, 2, 'once, in chapter zero, not again in the facts');
  assert.ok(!header.includes('halvorsen') && !header.includes('quarterly review'), 'future events are not in the header');
});

// ---------- the downtime skip ----------

test('the downtime skip stops at the next canon event before a later clock, and the event as written ends it', async () => {
  const { E, state } = newGame('mars-station');
  fixedRng(E, [0.999]);
  Object.values(state.characters).forEach((c) => { c.agenda = null; });
  state.clocks.forEach((c) => { c.perHour = 0.05; }); // the storm well after the review
  const plan = E.Engine.planMajorSkip(state);
  assert.deepEqual([plan.reason, plan.hours, plan.canon.id], ['canon', 55, 'halvorsen-review']);
  const calls = model(E);
  const out = await E.Engine.runTurn(state, 'Keep to routine.', 'major');
  assert.equal(state.canon['halvorsen-review'].status, 'fired');
  assert.equal(out.res.major.scope, 'canon');
  assert.match(out.res.major.text, /quarterly review/);
  const skip = calls.find((c) => c.user.includes('=== DOWNTIME:'));
  assert.match(skip.user, /The downtime ends with an expected event: "Halvorsen Aerospace's quarterly review/);
  assert.match(calls.find((c) => c.user.includes('=== DOWNTIME FRAME ===')).user, /=== WHAT ENDS IT ===\nHalvorsen Aerospace's quarterly review/);
  assert.equal(state.factions.find((f) => f.id === 'sponsor').stance, 'pleased in public; wants footage and good news for the campaign');
});

test('a skip that stops at a broken event: "diverge" has the model write the altered version; "drop" falls back to a major event of the model\'s own', async () => {
  const setup = () => {
    const g = newGame('mars-station');
    fixedRng(g.E, [0.999]);
    Object.values(g.state.characters).forEach((c) => { c.agenda = null; });
    g.state.clocks.forEach((c) => { c.perHour = 0.05; });
    g.state.world.comms = 'down';
    return g;
  };
  let { E, state } = setup();
  let calls = model(E, { skip: { montage: [{ after: '1d', text: 'Days pass.' }], events: [], positions: [],
    major_event: { text: 'With the link down, Halvorsen\'s review arrives days late as a terse text burst demanding to know why the station went silent.', scope: 'world', effects: { groups: [{ id: 'sponsor', stance: 'alarmed by the silence' }] } } } });
  let out = await E.Engine.runTurn(state, 'Keep to routine.', 'major');
  assert.match(calls.find((c) => c.user.includes('=== DOWNTIME:')).user, /something long expected was due: "Halvorsen Aerospace's quarterly review[^]*But the story has changed things: comms is "online, 14-minute delay"\./);
  assert.equal(state.canon['halvorsen-review'].status, 'diverged');
  assert.match(out.res.major.text, /terse text burst/);
  assert.equal(state.factions.find((f) => f.id === 'sponsor').stance, 'alarmed by the silence');

  ({ E, state } = setup());
  state.scenario.timeline.find((ev) => ev.id === 'halvorsen-review').onBroken = 'drop';
  calls = model(E, { skip: { montage: [{ after: '1d', text: 'Days pass.' }], events: [], positions: [], major_event: { text: 'A pressure seal in the lab blows.', scope: 'local' } } });
  out = await E.Engine.runTurn(state, 'Keep to routine.', 'major');
  assert.equal(state.canon['halvorsen-review'].status, 'dropped');
  assert.match(calls.find((c) => c.user.includes('=== DOWNTIME:')).user, /ends with a MAJOR EVENT that you choose/);
  assert.equal(out.res.major.text, 'A pressure seal in the lab blows.');
});

// ---------- projected events ----------

const projectReply = (day) => ({ events: [
  { when: { day, hour: 10 }, scope: 'regional', region: 'main-street', text: 'The church bell rings once at noon, as it does every Sunday now.', visibility: 'heard', effects: null },
  { when: { day: day + 9, hour: 10 }, scope: 'world', text: 'Too far ahead.' },
  { when: { day, hour: 12 }, scope: 'world', text: 'A handheld radio picks up a rescue convoy broadcast: the coastal safe zone can take three more people.' },
  { when: { day, hour: 14 }, scope: 'regional', region: 'narnia', text: 'Somewhere else entirely.' },
  { when: { day, hour: 15 }, scope: 'regional', region: 'residential', text: 'Marlene Ortiz is seen walking the houses.' },
] });

test('with nothing planned for the next few days, the model projects likely events; they are checked like authored ones', async () => {
  const { E, state } = newGame('zombie-holdout');
  state.scenario.timeline = state.scenario.timeline.filter((ev) => E.Timeline.at(ev.when) < 23 * 24 + 9).concat([
    { id: 'far-future', when: { day: 40, hour: 9 }, scope: 'world', text: 'The power grid fails for good across the state.' }]);
  state.scenario.projectTimeline = { days: 3, max: 5 };
  state.characters.ortiz.status.health = 'dead';
  const calls = model(E, { other: (call) => (call.kind === 'worldbuild (timeline)' ? projectReply(24) : { title: 'x', summary: 'y' }) });
  await E.Engine.runTurn(state, 'Keep watch.', 'moment');
  const proj = calls.find((c) => c.kind === 'worldbuild (timeline)');
  assert.ok(proj, 'one projection call');
  assert.equal(calls.indexOf(proj), 0, 'before the intent call (turn 1 has no scene to record yet)');
  assert.match(proj.user, /=== PLANNING AHEAD: Day 23/);
  assert.match(proj.user, /=== THE TIMELINE SO FAR ===\n- Day 1, 12:00: The first cases/);
  assert.ok(!proj.user.includes('fixed a handheld radio') && !proj.user.includes('scratched'), 'no secrets');
  assert.ok(!proj.user.includes('power grid'), 'no future canon');
  assert.equal(proj.system, calls.find((c) => c.kind === 'intent').system, 'the turn header, so the cache holds');
  assert.equal(state.timeline.length, 1);
  assert.deepEqual(plain(state.timeline[0]), { id: 'projected-0-1', when: { day: 24, hour: 10 }, scope: 'regional', region: 'main-street', text: 'The church bell rings once at noon, as it does every Sunday now.', visibility: 'heard', effects: null, projected: true, planned: 0 });
  const rejected = reportGuards(E, 'timeline rejected');
  assert.equal(rejected.length, 4);
  assert.match(rejected.join('\n'), /dated outside the next 3 days[^]*gives away Ruth Han's secret[^]*unknown region "narnia"[^]*names Marlene Ortiz, who is dead/);
  // Planned: no new call until the window is empty again; then it happens like a canon event.
  await E.Engine.runTurn(state, 'Keep watch.', 'moment');
  assert.equal(calls.filter((c) => c.kind === 'worldbuild (timeline)').length, 1);
  state.time = { day: 24, hour: 9.5 };
  await E.Engine.runTurn(state, 'Keep watch.', 'hour');
  assert.equal(state.canon['projected-0-1'].status, 'fired');
  assert.ok(state.news.some((n) => /church bell/.test(n.text)));
});

test('projection waits after a failed or empty call, and is off for worlds that turn it off and for older saves', async () => {
  const { E, state } = newGame('zombie-holdout');
  state.scenario.timeline = [];
  const calls = model(E, { other: () => 'not json at all' });
  await E.Engine.runTurn(state, 'Keep watch.', 'moment');
  assert.ok(reportGuards(E, 'timeline failed').length);
  await E.Engine.runTurn(state, 'Keep watch.', 'moment');
  assert.equal(calls.filter((c) => c.kind.startsWith('worldbuild (timeline)')).length, 2, 'one call and its JSON retry, then a wait');

  const off = newGame('zombie-holdout');
  off.state.scenario.timeline = [];
  off.state.scenario.projectTimeline = false;
  const offCalls = model(off.E);
  await off.E.Engine.runTurn(off.state, 'Keep watch.', 'moment');
  assert.ok(!offCalls.some((c) => c.kind.startsWith('worldbuild')));

  const old = newGame('zombie-holdout');
  const v12 = plain(old.state);
  v12.version = 12;
  delete v12.canon; delete v12.timeline; delete v12.projection;
  v12.scenario.timeline = [];
  const migrated = old.E.Engine.migrate(v12);
  assert.deepEqual([migrated.version, plain(migrated.canon), plain(migrated.timeline), migrated.projection], [old.E.Engine.STATE_VERSION, {}, [], false]);
  assert.ok(!old.E.Timeline.needsProjection(migrated));
});

// ---------- validation ----------

const zombieFiles = () => plain(worldFiles('zombie-holdout'));
function load(edit) {
  const E = loadEngine();
  const f = zombieFiles();
  edit(f);
  try { return { world: E.Scenario.prepareWorld('zombie-holdout', f), problems: [] }; } catch (err) { return { problems: err.message.split('\n- ').slice(1) }; }
}
const withEvent = (more) => load((f) => f['world.json'].timeline.push(Object.assign({ id: 'x', when: { day: 30, hour: 9 }, scope: 'world', text: 'Something happens.' }, more)));

test('timeline validation names bad events and preconditions', () => {
  const p = (more) => withEvent(more).problems.join('\n');
  assert.match(p({ when: { day: 30, hour: 24 } }), /"when" must be \{day, hour\}/);
  assert.match(p({ scope: 'galaxy' }), /"scope" must be regional or world/);
  assert.match(p({ scope: 'regional' }), /a regional event needs a "region"/);
  assert.match(p({ region: 'narnia' }), /unknown region "narnia"/);
  assert.match(p({ text: 'x'.repeat(241) }), /"text" must be text of at most 240/);
  assert.match(p({ onBroken: 'explode' }), /"onBroken" must be drop or diverge/);
  assert.match(p({ visibility: 'loud' }), /"visibility" must be seen, heard or hidden/);
  assert.match(p({ effects: { teleport: [] } }), /unknown effect "teleport"/);
  assert.match(p({ who: ['nobody'] }), /"who" must be a list of character ids/);
  assert.match(p({ preconditions: [{ maybe: true }] }), /precondition must be one of/);
  assert.match(p({ preconditions: [{ alive: 'nobody' }] }), /"alive": unknown character "nobody"/);
  assert.match(p({ preconditions: [{ controls: { group: 'pirates', region: 'junction' } }] }), /"controls": unknown group "pirates"/);
  assert.match(p({ preconditions: [{ not: { controls: { group: 'ridge', region: 'atlantis' } } }] }), /"controls": unknown region "atlantis"/);
  assert.match(p({ preconditions: [{ clock: 'horde' }] }), /"clock" needs a clock id and "atLeast"/);
  assert.match(p({ preconditions: [{ world: 'food' }] }), /"world" needs a world key and "is"/);
  assert.match(p({ preconditions: [{ known: { words: [] } }] }), /"known" must be an event id or \{words/);
  assert.match(p({ id: 'evacuation' }), /timeline "evacuation" is listed twice/);
  assert.match(p({ text: 'Ruth fixed a handheld radio and heard a rescue convoy broadcast about the coastal safe zone.' }), /timeline "x" gives away Ruth Han's secret/);
  assert.deepEqual(withEvent({ visibility: 'hidden', who: ['han'], text: 'Ruth fixed a handheld radio and heard a rescue convoy broadcast about the coastal safe zone.' }).problems, [], 'hidden events may hold private things');
  assert.match(load((f) => { f['world.json'].projectTimeline = { days: 30 }; }).problems.join(), /"projectTimeline" must be false, or \{days: 1–14, max: 1–5\}/);
});

test('an unknown clock and effects on a past event are warnings; a start adds or replaces timeline events by id', () => {
  const { world } = withEvent({ preconditions: [{ clock: 'later-clock', atLeast: 2 }] });
  assert.ok([...world.warnings].some((w) => /precondition clock "later-clock" is not a clock/.test(w)));
  const past = withEvent({ when: { day: 2, hour: 9 }, effects: { world: [{ key: 'food', value: 'none' }] } });
  assert.ok([...past.world.warnings].some((w) => /"effects" is ignored on an event before the start/.test(w)));
  const { world: w2 } = load((f) => {
    f['starts/herd.json'].timeline = [
      { id: 'pumps-dry', when: { day: 6, hour: 15 }, scope: 'regional', region: 'highway-strip', text: 'As this start tells it, the pumps ran dry.' },
      { id: 'herd-only', when: { day: 24, hour: 9 }, scope: 'world', text: 'Only in this start.' },
    ];
  });
  const tl = w2.starts[0].scenario.timeline;
  assert.equal(tl.find((ev) => ev.id === 'pumps-dry').text, 'As this start tells it, the pumps ran dry.');
  assert.ok(tl.find((ev) => ev.id === 'herd-only'));
  assert.equal(tl.filter((ev) => ev.id === 'pumps-dry').length, 1);
});

test('bundled worlds have a past, future events with preconditions, and one that diverges', () => {
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const { E, state } = newGame(folder);
    const tl = E.Timeline.all(state);
    assert.ok(tl.some((ev) => state.canon[ev.id] && state.canon[ev.id].status === 'past'), `${folder}: a past`);
    const future = E.Timeline.pending(state);
    assert.ok(future.length >= 2, `${folder}: future events`);
    assert.ok(future.every((ev) => (ev.preconditions || []).length && E.Timeline.broken(state, ev).length === 0), `${folder}: every future event holds at the start`);
    assert.ok(future.some((ev) => ev.onBroken === 'diverge'), `${folder}: one diverges`);
    assert.ok(!E.Timeline.needsProjection(state), `${folder}: something planned in the first days`);
  }
});
