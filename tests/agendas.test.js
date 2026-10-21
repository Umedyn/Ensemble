// Agendas (task 2-2): background characters pursue their own goals, step by
// step, while the player is elsewhere. The engine advances them and says when
// a step is due; the model only writes it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, fixedRng, readScenario, loadEngine } = require('./helpers');

const guards = (res, type) => [...(res.guards || [])].filter((g) => g.type === type).map((g) => g.detail);
const intentOf = (o) => JSON.parse(JSON.stringify(o));
const PRESENT = ['okafor', 'bauer'];
const agendaEvents = (res) => [...res.director].filter((d) => d.agenda);

// A model that answers every step plainly; extra per-kind answers override.
function model(E, over = {}) {
  return mockLLM(E, (call) => {
    const { kind } = call;
    if (over[kind]) return over[kind](call);
    if (kind.startsWith('intent (agenda)')) return { routine: true };
    if (kind.startsWith('intent')) return { player: { summary: 'waits' }, intents: [], events: [] };
    if (kind.startsWith('narrate')) return '[+0m] Okafor nods.\n\n[+30m] Teo hums at the counter.';
    if (kind.startsWith('update')) return { facts: [], state: [], relations: [] };
    return { title: 'T', summary: 'S' };
  });
}

// ---------- authoring ----------

test('bundled characters start with their authored agenda, normalized', () => {
  const { state } = newGame();
  const a = state.characters.sorensen.agenda;
  assert.equal(a.goal, 'prove the deep-ice cultures are alive');
  assert.deepEqual([...a.steps.map((s) => s.contact)], [false, false, true]);
  assert.equal(a.hours, 14);
  assert.equal(a.visibility, 'hidden');
  assert.deepEqual([a.step, a.progress, a.due, a.done], [0, 0, false, false]);
  assert.ok(!('agenda' in state.characters.navarro), 'the player has none');
});

test('validation catches bad authored agendas', () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  sc.characterData[1].agenda = { goal: 'fix it', steps: [] };
  sc.characterData[2].agenda = { goal: 'x', steps: ['a'], hours: 500 };
  sc.characterData[3].agenda = { goal: 'x', steps: ['a'], visibility: 'loud' };
  assert.throws(() => E.Scenario.validate(sc), (err) =>
    /has no steps/.test(err.message) && /between 1 and 240/.test(err.message) && /hidden or heard/.test(err.message));
  const ok = readScenario('mars-station');
  ok.characterData[1].agenda = { goal: 'keep routine' };
  ok.characterData[2].agenda = null;
  E.Scenario.validate(ok);
});

test('model-proposed agendas: steps and pace are checked, hours clamped, contact_step marks a step', () => {
  const { E } = newGame();
  const ok = E.Engine.cleanAgenda({ goal: 'find the keys', steps: ['searches the office', 'asks Han about wiring'], hours: 200, contact_step: 1, visibility: 'heard' }, true).agenda;
  assert.equal(ok.hours, 72);
  assert.deepEqual([...ok.steps.map((s) => s.contact)], [false, true]);
  assert.equal(ok.visibility, 'hidden', 'proposals are always hidden');
  assert.equal(E.Engine.cleanAgenda({ routine: true }, true).agenda, null);
  for (const bad of [{ goal: '', steps: ['a'] }, { goal: 'x', steps: 'a' }, { goal: 'x', steps: ['a', 'b', 'c', 'd', 'e'] }, { goal: 'x', steps: ['one sentence'] }, { goal: 'x', steps: ['a'], hours: 'soon' }, 'plan', null && 1]) {
    if (bad == null) continue;
    assert.ok(E.Engine.cleanAgenda(bad, true).error, JSON.stringify(bad));
  }
});

// ---------- advancing ----------

test('agendas advance for secondary characters only during turns, and wait when due', () => {
  const { E, state } = newGame();
  E.Engine.advanceTime(state, 7, { events: [] });
  assert.equal(state.characters.sorensen.agenda.progress, 0.5, 'secondary: half of a 14-hour step');
  assert.equal(state.characters.okafor.agenda.progress, 0, 'local: paused');
  E.Engine.advanceTime(state, 8, { events: [] });
  assert.equal(state.characters.sorensen.agenda.due, true);
  assert.equal(state.characters.sorensen.agenda.step, 0, 'due until it is written');
  assert.deepEqual([...E.Engine.agendasDue(state)], ['sorensen', 'raman'], "Priya's 12-hour step too");
});

test('a downtime runs everyone\'s agenda through several steps and stops at a contact step', () => {
  const { E, state } = newGame();
  const res = { events: [], guards: [] };
  const done = E.Engine.runAgendas(state, 44, null, res);
  const lev = state.characters.sorensen.agenda;
  assert.deepEqual([lev.step, lev.due], [2, true], 'two steps (28 h), then the contact step (14 h) is due and waits');
  assert.equal(state.characters.okafor.agenda.step, 2, 'locals advance during downtime too (16 h steps)');
  assert.ok(guards(res, 'agenda step').some((d) => /comes to you next/.test(d)));
  assert.ok(done.some((d) => d.id === 'sorensen' && /^Sorensen runs a second culture/.test(d.text)));
  const fact = state.facts.find((f) => /^Sorensen runs a second culture/.test(f.text));
  assert.deepEqual([...fact.known_by], ['sorensen'], 'hidden steps are private');
});

test('time wound back to the end of a short scene winds agendas back too', () => {
  const { E, state } = newGame();
  const p = state.characters.sorensen.agenda;
  const before = { time: JSON.parse(JSON.stringify(state.time)), needs: E.Engine.cast(state).map((id) => JSON.parse(JSON.stringify(state.characters[id].needs))), clocks: state.clocks.map((c) => ({ value: c.value, fired: c.fired })), agendas: E.Engine.cast(state).map((id) => JSON.parse(JSON.stringify(state.characters[id].agenda || null))) };
  E.Engine.advanceTime(state, 1, { events: [] });
  assert.ok(E.Engine.settleSceneTime(state, [{ at: 0 }], 60, before, { events: [] }));
  assert.ok(Math.abs(state.characters.sorensen.agenda.progress - 0.1 / 14) < 1e-9, `${p.progress}`);
});

// ---------- due steps become events ----------

test('a due step becomes exactly one event: the model\'s tagged one, duplicates dropped, hidden stays hidden', () => {
  const { E, state } = newGame();
  state.characters.sorensen.agenda.due = true;
  const res = E.Engine.resolve(state, intentOf({ player: { summary: 'x' }, intents: [], events: [
    { text: 'In the lab, Lev starts a second culture and logs nothing.', agenda: 'sorensen', who: ['sorensen'], where: 'lab', visibility: 'seen' },
    { text: 'Lev does it again.', agenda: 'sorensen' },
  ] }), PRESENT, 'Wait.', 'hour');
  const evs = agendaEvents(res);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].visibility, 'hidden', 'a hidden agenda cannot be seen');
  assert.ok(!res.events.some((e) => /second culture/.test(e)), 'not narrated');
  assert.deepEqual([...state.facts.find((f) => /second culture/.test(f.text)).known_by], ['sorensen']);
  assert.equal(state.characters.sorensen.agenda.step, 1);
  assert.equal(state.characters.sorensen.agenda.due, false);
  assert.ok(guards(res, 'event dropped').some((d) => /not due or already written/.test(d)));
  assert.ok(guards(res, 'agenda step').some((d) => /Dr. Lev Sorensen: step 1\/3/.test(d)));
});

test('a due step the model left out is written by the engine from the step text', () => {
  const { E, state } = newGame();
  state.characters.sorensen.agenda.due = true;
  const res = E.Engine.resolve(state, intentOf({ player: { summary: 'x' }, intents: [], events: [] }), PRESENT, 'Wait.', 'hour');
  assert.equal(agendaEvents(res)[0].text, 'Sorensen runs a second culture from the deep core in the unlogged incubator.');
  assert.ok(guards(res, 'agenda step').some((d) => /written by the engine/.test(d)));
});

test('an agenda event for someone whose step is not due is dropped, and does not count against the local cap', () => {
  const { E, state } = newGame();
  state.characters.sorensen.agenda.due = true;
  const res = E.Engine.resolve(state, intentOf({ player: { summary: 'x' }, intents: [], events: [
    { text: 'Priya files something.', agenda: 'raman' },
    { text: 'Lev cultures.', agenda: 'sorensen' },
    { text: 'The intercom crackles.', who: [], where: 'commons', visibility: 'heard' },
  ] }), PRESENT, 'Wait.', 'moment');
  assert.equal(agendaEvents(res).length, 1);
  assert.ok(res.director.some((d) => /intercom/.test(d.text)), 'the one local event still fits a moment');
  assert.equal(state.characters.raman.agenda.step, 0);
});

test('a contact step brings the person into the scene, and the commit makes them local', async () => {
  const { E, state } = newGame();
  Object.assign(state.characters.sorensen.agenda, { step: 2, due: true });
  const calls = model(E);
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal(state.characters.sorensen.status.location, 'commons');
  assert.ok(state.pending.res.events.some((e) => /^Sorensen comes to find Kit/.test(e)), 'seen, so the narrator gets it');
  assert.match(calls.find((c) => c.kind === 'narrate').user, /Dr. Lev Sorensen is there at the end/);
  assert.equal(state.characters.sorensen.agenda.done, true);
  await E.Engine.runTurn(state, 'Hi, Lev.', 'moment');
  assert.equal(state.characters.sorensen.tier, 'local');
});

test('the intent call lists due steps, and a step-in leaves the step due for the next turn', async () => {
  const { E, state } = newGame();
  state.characters.sorensen.agenda.due = true;
  const calls = model(E);
  await E.Engine.runTurn(state, 'Wait.', 'hour');
  assert.match(calls[0].user, /=== AGENDA STEPS DUE[^\n]*\n- sorensen \(Dr. Lev Sorensen\), working toward "prove the deep-ice cultures are alive": runs a second culture/);
  assert.equal(state.characters.sorensen.agenda.step, 1);
  await E.Engine.runTurn(state, 'Wait.', 'moment', null, 1);
  const intents = calls.filter((c) => c.kind === 'intent');
  assert.match(intents[1].user, /AGENDA STEPS DUE[^\n]*\n- sorensen/, 'rewound: written again');
});

test('the header does not change when agendas advance', () => {
  const { E, state } = newGame();
  const before = E.Prompts.header(state);
  E.Engine.advanceTime(state, 13, { events: [] });
  assert.ok(state.characters.raman.agenda.due);
  assert.equal(E.Prompts.header(state), before);
});

// ---------- downtime skip ----------

test('a skip stops at the first contact step when it comes before the clocks', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]);
  ['okafor', 'raman', 'bauer'].forEach((id) => { state.characters[id].agenda = null; });
  Object.assign(state.characters.sorensen.agenda, { step: 2, progress: 0 });
  const plan = E.Engine.planMajorSkip(state);
  assert.deepEqual([plan.reason, plan.hours, plan.agenda.id], ['agenda', 14, 'sorensen']);
  state.characters.sorensen.agenda.step = 0;
  assert.equal(E.Engine.planMajorSkip(state).reason, 'clock', '42 hours away: the storm comes first');

  Object.assign(state.characters.sorensen.agenda, { step: 2, progress: 0 });
  const calls = model(E, {
    intent: () => ({ montage: [{ after: '6h', text: 'The station hums.' }], events: [], major_event: null, positions: [{ id: 'sorensen', where: 'lab', doing: 'working' }], player_where: 'commons' }),
    narrate: () => '[+0h] Hours pass.\n\n[+14h] Lev hovers at the hatch. "Kit? Got a minute?"',
  });
  const out = await E.Engine.runTurn(state, '', 'major');
  assert.equal(out.plan.reason, 'agenda');
  assert.match(calls.find((c) => c.kind === 'intent').user, /The downtime ends when Dr. Lev Sorensen comes to find Kit Navarro/);
  assert.equal(state.characters.sorensen.status.location, 'commons', 'with the player, whatever the positions say');
  assert.equal(state.characters.sorensen.agenda.done, true);
  assert.equal(out.res.major.scope, 'agenda');
  assert.ok(state.facts.some((f) => /^Sorensen comes to find Kit/.test(f.text) && f.known_by.includes('navarro')));
});

// ---------- proposals ----------

test('someone in the background with no agenda gets one from the model, one person per turn', async () => {
  const { E, state } = newGame();
  delete state.characters.raman.agenda;
  delete state.characters.sorensen.agenda;
  const calls = model(E, {
    'intent (agenda)': () => ({ goal: 'get the Mule ready for the storm', steps: ['tops up the Mule\'s batteries', 'comes to ask Kit for help with the hatch seal'], hours: 6, contact_step: 1 }),
  });
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  const proposals = calls.filter((c) => c.kind === 'intent (agenda)');
  assert.equal(proposals.length, 1, 'one per turn');
  assert.match(proposals[0].user, /=== DR. LEV SORENSEN \(sorensen\) ===[^]*Secret \(private\): Cultures/);
  assert.ok(!proposals[0].system.includes('Cultures from the deep ice core'), 'the secret stays out of the header');
  assert.equal(state.characters.sorensen.agenda.goal, 'get the Mule ready for the storm');
  assert.equal(state.characters.sorensen.agenda.steps[1].contact, true);
  assert.ok(!('agenda' in state.characters.raman), 'next turn');
  const report = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  assert.ok(report.guards.some((g) => g.type === 'agenda set' && /comes to you/.test(g.detail)));
});

test('an invalid proposal is rejected and the person keeps to routine', async () => {
  const { E, state } = newGame();
  delete state.characters.sorensen.agenda;
  model(E, { 'intent (agenda)': () => ({ goal: 'everything', steps: 'all of it' }) });
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal(state.characters.sorensen.agenda, null);
  const report = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  assert.ok(report.guards.some((g) => g.type === 'agenda rejected' && /must be a list/.test(g.detail)));
});

test('a finished agenda gets one follow-up, then routine', async () => {
  const { E, state } = newGame();
  Object.assign(state.characters.sorensen.agenda, { step: 3, done: true });
  const calls = model(E, { 'intent (agenda)': () => ({ goal: 'write it up', steps: ['drafts a paper'], hours: 10 }) });
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.match(calls.find((c) => c.kind === 'intent (agenda)').user, /Just finished working toward: prove the deep-ice cultures are alive/);
  assert.equal(state.characters.sorensen.agenda.followUp, true);
  Object.assign(state.characters.sorensen.agenda, { step: 1, done: true });
  assert.equal(E.Engine.needsAgenda(state), undefined);
});

// ---------- saves ----------

test('save migration v4→v5: people in older saves keep to routine', () => {
  const { E, state } = newGame();
  const v4 = JSON.parse(JSON.stringify(state));
  v4.version = 4;
  for (const c of Object.values(v4.characters)) delete c.agenda;
  v4.pending = { pre: { characters: JSON.parse(JSON.stringify(v4.characters)) } };
  const v5 = E.Engine.migrate(v4);
  assert.equal(v5.version, E.Engine.STATE_VERSION);
  assert.equal(v5.characters.sorensen.agenda, null);
  assert.equal(v5.pending.pre.characters.sorensen.agenda, null);
  assert.ok(!('agenda' in v5.characters.navarro));
  assert.equal(E.Engine.needsAgenda(v5), undefined, 'no proposal calls');
});
