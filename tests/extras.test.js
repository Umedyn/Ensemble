// Extras (task 2-3): minor people and groups as one-line stubs outside the
// cast, which events and facts can involve, the model can add (in worlds that
// allow it), and which become full characters once they matter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, readScenario, loadEngine } = require('./helpers');

const intentOf = (o) => JSON.parse(JSON.stringify(o));
const guards = (res, type) => [...(res.guards || [])].filter((g) => g.type === type).map((g) => g.detail);
const lastReport = (E) => E.Engine.telemetry[E.Engine.telemetry.length - 1];

const ALBEE_SHEET = {
  pronouns: 'she/her', age: 81, role: 'elderly neighbour', traits: ['sharp', 'stubborn', 'deaf in one ear'],
  want: 'outlive the dead out of spite', secret: 'The shotgun is loaded, and she has used it.', guard: 'medium',
  voice: 'Loud, dry, and never finishes a sentence she thinks is obvious.', appearance: 'Tiny and bent, in a quilted housecoat over rubber boots.',
  skills: { shooting: 9, persuasion: 2, nonsense: 3 }, relations: { pike: 40, ortiz: 5, nobody: 10 },
  agenda: { goal: 'make the trailer safe', steps: ['nails boards over the trailer windows'], hours: 8, contact_step: null },
};

function model(E, over = {}) {
  return mockLLM(E, (call) => {
    if (over[call.kind]) return over[call.kind](call);
    if (call.kind.startsWith('intent (agenda)')) return { routine: true };
    if (call.kind.startsWith('intent')) return { player: { summary: 'x' }, intents: [], events: [] };
    if (call.kind.startsWith('narrate')) return '[+0m] Mrs. Albee squints at you from the trailer step.';
    if (call.kind.startsWith('update')) return { facts: [], state: [], relations: [] };
    if (call.kind === 'worldbuild') return ALBEE_SHEET;
    return { title: 'T', summary: 'S' };
  });
}

// ---------- authoring ----------

test('bundled extras load as minor people outside the cast; groups are standees (task 3-2)', () => {
  const { E, state } = newGame('zombie-holdout');
  assert.equal(state.extras.albee.name, 'Mrs. Albee');
  assert.equal(state.extras.albee.location, 'dock');
  assert.ok(!state.extras.herd && Object.values(state.extras).every((x) => !x.group));
  assert.equal(state.standees.stragglers.count, 5);
  assert.ok(!state.order.includes('albee') && !state.characters.albee);
  assert.doesNotMatch(E.Prompts.header(state), /Albee|the herd/, 'never in the header');
  assert.equal(newGame().state.extras.capcom.role, 'Mission Control CAPCOM');
});

test('validation catches bad extras', () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  sc.extras = [
    { id: 'Bad Id', name: 'X', role: 'y', location: 'ops' },
    { id: 'okafor', name: 'Twin', role: 'clone', location: 'ops' },
    { id: 'ghost', name: 'Ghost', role: 'rumour', location: 'attic' },
    { id: 'nameless', role: 'nobody', location: null },
    { id: 'pair', name: 'Two', role: 'twins', location: 'ops', count: 'two' },
    { id: 'pair', name: 'Two again', role: 'twins', location: 'ops' },
  ];
  sc.inventExtras = 'yes';
  assert.throws(() => E.Scenario.validate(sc), (err) => ['"id" must be lowercase', 'already used by a character', 'unknown location "attic"',
    'extra "nameless": "name"', '"count" is a short phrase, for groups only', 'listed twice', '"inventExtras" must be true or false'].every((m) => err.message.includes(m)));
});

// ---------- in prompts ----------

test('minor people here are in the intent call with their notes; the narrator gets name and role only', async () => {
  const { E, state } = newGame('zombie-holdout');
  state.characters.pike.status.location = 'dock';
  const calls = model(E);
  await E.Engine.runTurn(state, 'Knock on the trailer.', 'moment');
  const intent = calls.find((c) => c.kind === 'intent').user;
  assert.match(intent, /Also here \(minor people\): Mrs\. Albee \(she\/her\), elderly neighbour/);
  assert.match(intent, /- here: albee: Mrs\. Albee \(she\/her\), elderly neighbour — Has been living in the trailer/);
  assert.match(intent, /"new_extras":\[\]/, 'this world lets the model add minor people');
  const narrate = calls.find((c) => c.kind === 'narrate').user;
  assert.match(narrate, /Also around \(minor people, they may appear\): Mrs\. Albee \(she\/her\), elderly neighbour\./);
  assert.doesNotMatch(narrate, /deaf in one ear/, 'the note stays out of the narrator');
});

test('Mars does not invite invented minor people', () => {
  const { E, state } = newGame();
  const intent = E.Prompts.intent(state, E.Engine.present(state), 'Look around.', 'a few minutes', 'moment', {});
  assert.doesNotMatch(intent, /new_extras/);
  assert.match(intent, /- elsewhere: capcom \(Dana Ruiz, Ops & Comms\)/);
  assert.doesNotMatch(E.Prompts.update(state, 'x', { outcomes: [], events: [] }, 'x', [], false), /new_extras/);
});

// ---------- events, facts and the update step ----------

test('events can involve and move minor people', () => {
  const { E, state } = newGame('zombie-holdout');
  const res = E.Engine.resolve(state, intentOf({ player: { summary: 'x' }, intents: [], events: [
    { text: 'Mrs. Albee walks out to the parking lot.', who: ['albee'], where: 'lot', visibility: 'heard', moves: [{ id: 'albee', to: 'lot' }] },
  ] }), [], 'Wait.', 'hour');
  assert.equal(state.extras.albee.location, 'lot');
  assert.ok(res.involved.includes('albee'));
  assert.deepEqual([...res.director[0].moved], ['Mrs. Albee → Parking Lot']);
});

test('facts can be about or known by minor people who were there; they have no feelings, moods or needs', () => {
  const { E, state } = newGame('zombie-holdout');
  state.characters.pike.status.location = 'dock';
  const report = E.Engine.applyUpdate(state, {
    facts: [
      { about: ['albee'], text: 'Mrs. Albee says she saw lights on the highway two nights ago.', known_by: ['pike', 'albee'], weight: 1 },
      { about: ['albee'], text: 'Mrs. Albee keeps the trailer key on a string.', known_by: ['ferris'], weight: 1 },
    ],
    state: [
      { target: 'char:albee', field: 'mood', value: 'suspicious' },
      { target: 'char:albee', field: 'location', value: 'lot' },
    ],
    relations: [{ from: 'albee', to: 'pike', delta: 5 }],
    player_attitude: [{ to: 'albee', delta: 5, reason: 'she was kind' }],
  }, [], { startLoc: 'dock', endLoc: 'dock', extrasPresent: ['albee'], turn: 1 });
  assert.deepEqual([...state.facts.find((f) => /lights on the highway/.test(f.text)).known_by], ['pike', 'albee']);
  assert.ok(report.rejected.some((r) => /dropped ferris: not in the scene/.test(r)));
  assert.ok(report.rejected.some((r) => /mood.*minor people have only a location/.test(r)));
  assert.equal(state.extras.albee.location, 'lot', 'seen leaving the dock');
  assert.equal(report.rejected.filter((r) => /minor people have no feelings tracked/.test(r)).length, 2);
});

// ---------- new minor people from the model ----------

test('the model may add one minor person a turn in a world that allows it, with an engine-made id', () => {
  const { E, state } = newGame('zombie-holdout');
  const res = E.Engine.resolve(state, intentOf({ player: { summary: 'x' }, intents: [], events: [], new_extras: [
    { name: 'Sergeant Okoye', role: 'convoy radio operator', location: 'roof' },
    { name: 'Another One', role: 'stranger' },
  ] }), [], 'Wait.', 'hour');
  assert.equal(state.extras['sergeant-okoye'].location, 'roof');
  assert.equal(state.extras['sergeant-okoye'].from, 'model');
  assert.ok(guards(res, 'extra added').some((d) => /\+Sergeant Okoye, convoy radio operator in Roof \(sergeant-okoye\)/.test(d)));
  assert.ok(guards(res, 'extra rejected').some((d) => /only 1 new minor person per turn/.test(d)));
  assert.ok(!Object.values(state.extras).some((x) => x.name === 'Another One'));
});

test('a proposed name already in use is that person; a proposed group is a standee in a room; Mars accepts none', () => {
  const z = newGame('zombie-holdout');
  const r1 = z.E.Engine.proposeExtra(z.state, { name: 'Mrs. Albee', role: 'neighbour' }, 1, 'floor');
  assert.deepEqual([r1.id, Object.keys(z.state.extras).length], ['albee', 1]);
  const r2 = z.E.Engine.proposeExtra(z.state, { name: 'The Ridge scouts', role: 'armed scavengers', group: true, count: 'six', location: 'Parking Lot' }, 1, 'floor');
  assert.equal(r2.id, 'ridge-scouts');
  assert.ok(!z.state.extras['ridge-scouts']);
  assert.deepEqual([z.state.standees['ridge-scouts'].label, z.state.standees['ridge-scouts'].count, z.state.standees['ridge-scouts'].location], ['The Ridge scouts', 6, 'lot']);
  assert.match(z.E.Engine.proposeExtra(z.state, { name: 'Bob', role: 'x', location: 'moon' }, 2, 'floor').error, /unknown location "moon"/);
  const m = newGame();
  assert.match(m.E.Engine.proposeExtra(m.state, { name: 'Stowaway', role: 'surprise' }, 1, 'commons').error, /no invented minor people/);
});

// ---------- promotion ----------

test('named on two turns, a minor person becomes a full character who keeps what is known about them', async () => {
  const { E, state } = newGame('zombie-holdout');
  const calls = model(E, {
    update: () => ({ facts: [{ about: ['albee'], text: 'Mrs. Albee keeps a shotgun by the trailer door.', known_by: ['pike', 'albee'], weight: 1 }], state: [], relations: [] }),
  });
  state.characters.pike.status.location = 'dock';
  const before = E.Prompts.header(state);
  await E.Engine.runTurn(state, 'Ask Mrs. Albee how she is holding up.', 'moment');
  await E.Engine.runTurn(state, 'Thank Albee and offer her some water.', 'moment');
  assert.ok(state.extras.albee.promote);
  assert.ok(!calls.some((c) => c.kind === 'worldbuild'), 'promotion happens when that turn is committed');
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  const wb = calls.filter((c) => c.kind === 'worldbuild');
  assert.equal(wb.length, 1);
  assert.match(wb[0].user, /=== MRS\. ALBEE \(albee\) ===[^]*keeps a shotgun by the trailer door/);
  const c = state.characters.albee;
  assert.ok(c && !state.extras.albee);
  assert.equal(state.order[state.order.length - 1], 'albee');
  assert.deepEqual([c.name, c.tier, c.joined, c.status.location, c.guard], ['Mrs. Albee', 'local', 2, 'dock', 'medium']);
  assert.equal(c.skills.shooting, 4, 'skills clamped to 0–4');
  assert.ok(!('nonsense' in c.skills));
  assert.deepEqual([c.relations.pike, c.relations.nobody], [30, undefined], 'relations clamped, unknown ids dropped');
  assert.equal(c.agenda.goal, 'make the trailer safe');
  assert.ok(E.Engine.knownAbout(state, 'albee').some((f) => /shotgun/.test(f.text)), 'facts about her still hold');
  const after = E.Prompts.header(state);
  // Everything before the live blocks (newcomers, then the story so far and facts) is unchanged.
  const live = (h) => Math.min(...['\n\n=== STORY SO FAR', '\n\n=== ESTABLISHED FACTS'].map((m) => h.indexOf(m)).filter((i) => i >= 0));
  assert.ok(after.startsWith(before.slice(0, live(before))), 'the cached part of the header is unchanged');
  assert.match(after, /=== CAST: JOINED DURING THE STORY ===\n- albee: Mrs\. Albee \(she\/her\), elderly neighbour, 81\./);
  assert.ok(lastReport(E).guards.some((g) => g.type === 'extra promoted' && /Mrs\. Albee \(she\/her\)/.test(g.detail)));
});

test('a notable fact about an individual makes them due for promotion', () => {
  const { E, state } = newGame('zombie-holdout');
  const report = E.Engine.applyUpdate(state, { facts: [
    { about: ['albee'], text: 'Mrs. Albee shot one of the dead at the dock gate.', known_by: ['all'], weight: 2 },
  ] }, [], { turn: 1 });
  assert.ok(state.extras.albee.promote);
  assert.ok(report.extras.some((l) => /Mrs\. Albee: in a notable fact/.test(l)));
});

test('a bad sheet leaves them a minor person; one retry, then no more calls', async () => {
  const { E, state } = newGame('zombie-holdout');
  state.extras.albee.promote = true;
  const calls = model(E, { worldbuild: () => ({ pronouns: 'she/her', traits: [] }) });
  for (let i = 0; i < 4; i++) await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal(calls.filter((c) => c.kind === 'worldbuild').length, 2);
  assert.ok(state.extras.albee && !state.characters.albee);
  const all = E.Engine.telemetry.flatMap((t) => [...t.guards]).filter((g) => g.type === 'promotion rejected').map((g) => g.detail);
  assert.ok(all.some((d) => /no "want"; will try again/.test(d)) && all.some((d) => /stays a minor person/.test(d)));
});

// ---------- saves and routing ----------

test('extras survive a save round trip, and older saves get none (v5→v6)', () => {
  const { E, state } = newGame('zombie-holdout');
  E.Engine.proposeExtra(state, { name: 'Sergeant Okoye', role: 'radio operator', location: 'roof' }, 1, 'floor');
  const loaded = E.Engine.migrate(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.extras)), JSON.parse(JSON.stringify(state.extras)));
  const v5 = JSON.parse(JSON.stringify(state));
  v5.version = 5;
  delete v5.extras;
  v5.pending = { pre: { characters: {} } };
  const v6 = E.Engine.migrate(v5);
  assert.equal(v6.version, E.Engine.STATE_VERSION);
  assert.deepEqual(JSON.parse(JSON.stringify(v6.extras)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(v6.pending.pre.extras)), {});
});

test('promotion calls are their own routable step, World building', () => {
  const { E } = newGame();
  assert.ok(E.routeSteps.some((r) => r.id === 'worldbuild'));
  assert.equal(E.defaults.routing.worldbuild, 'local');
  E.settings.routing = Object.assign({}, E.settings.routing, { worldbuild: 'external' });
  assert.equal(E.LLM.backendFor('worldbuild').id, 'external');
  assert.equal(E.LLM.backendFor('worldbuild (retry)').id, 'external');
});
