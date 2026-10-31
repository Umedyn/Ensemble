// Smaller calls for the local model (task L-3): the intent and the update as
// several short calls whose replies merge into the single call's object. The
// same replies, whole or in parts, give the same game; a part that fails
// costs only that part; the calls share their prefix; a split session records
// and replays; each part's grammar takes its own example.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, fixedRng, noRoutines } = require('./helpers');
const { replay } = require('./replay');
const { matches } = require('./gbnf');

const SCENE = '[+0m] You ask Okafor about the storm. She frowns at the screen.\n\n[+30m] Teo hovers by the recycler, pretending to work.\n\n[+50m] Okafor taps the forecast. "Twenty hours," she says.';
const INTENT = {
  player: { summary: 'ask Okafor about the storm', needs_roll: false, skill: null, difficulty: 'normal', move_to: null },
  intents: [
    { id: 'okafor', action: 'pulls up the storm forecast', says: 'Twenty hours, maybe less.', reveals: null, visible: true, needs_roll: false, skill: null, difficulty: 'normal', move_to: null },
    { id: 'bauer', action: 'pretends to work on the recycler', says: null, reveals: null, visible: true, needs_roll: false, skill: null, difficulty: 'normal', move_to: null },
  ],
  events: [{ text: 'Raman radios from the lab that the seed trays need power.', scope: 'local', who: ['raman'], where: 'lab', visibility: 'heard', moves: [] }],
};
const UPDATE = {
  facts: [{ about: ['okafor'], text: 'Okafor says the storm is about twenty hours out.', known_by: ['navarro', 'okafor', 'bauer'], weight: 2 }],
  state: [{ target: 'char:bauer', field: 'mood', value: 'jumpy, avoiding eye contact', reason: 'the storm talk' }],
  relations: [{ from: 'bauer', to: 'okafor', delta: -3, reason: 'she watched him' }],
  player_attitude: [{ to: 'okafor', delta: 3, reason: 'she answered straight' }],
};
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// Answers the single calls whole and the split ones with their part of the same reply.
function answer(E, opts = {}) {
  return ({ kind, user }) => {
    const step = kind.replace(/ \(.*\)$/, '');
    if (opts.fail && opts.fail(step, user)) throw new Error(`no reply for ${step}`);
    if (step === 'intent') return INTENT;
    if (step === 'intent:player') return pick(INTENT, ['player']);
    if (step === 'intent:char') return { intents: INTENT.intents.filter((i) => user.includes(`"id":"${i.id}"`)) };
    if (step === 'intent:events') return pick(INTENT, ['events']);
    if (step === 'update') return UPDATE;
    if (step.startsWith('update:')) return pick(UPDATE, E.Prompts.UPDATE_PARTS[step.split(':')[1]].keys);
    if (step === 'narrate') return SCENE;
    return { title: 'A chapter', summary: 'Things happened.' };
  };
}

async function play(smaller, opts = {}) {
  const { E, state } = newGame('mars-station');
  noRoutines(state);
  E.settings.backends.local.smallerCalls = smaller;
  if (opts.setup) opts.setup(E, state);
  fixedRng(E, [0.4, 0.6, 0.3, 0.7, 0.5]);
  const calls = mockLLM(E, answer(E, opts));
  await E.Engine.runTurn(state, 'Ask Okafor about the storm.', 'hour');
  await E.Engine.runTurn(state, 'Keep listening.', opts.second || 'hour', null, opts.cutAt);
  return { E, state, calls };
}
// The game without what records how it was played (call logs, timings).
const gameOf = (state) => {
  const s = JSON.parse(JSON.stringify(state));
  delete s.undo;
  (s.log || []).forEach((e) => { delete e.ms; delete e.report; });
  return s;
};

test('the same replies, whole or in parts, give the same game', async () => {
  const one = await play(false);
  const parts = await play(true);
  assert.deepEqual([...new Set(one.calls.map((c) => c.kind))].sort(), ['intent', 'narrate', 'update']);
  assert.deepEqual([...new Set(parts.calls.map((c) => c.kind))].sort(), ['intent:char', 'intent:events', 'intent:player', 'narrate', 'update:facts', 'update:feelings', 'update:state']);
  assert.deepEqual(gameOf(parts.state), gameOf(one.state));
  assert.ok(parts.state.facts.some((f) => /^Okafor says the storm/.test(f.text)), 'the facts part landed');
  assert.match((parts.state.characters.bauer.mood || {}).text || '', /jumpy/, 'the state part landed');
  assert.ok(parts.state.characters.okafor.relations.navarro != null, 'the feelings part landed');
});

test('a step-in records the same way whole or in parts', async () => {
  const one = await play(false, { cutAt: 1 });
  const parts = await play(true, { cutAt: 1 });
  assert.deepEqual(gameOf(parts.state), gameOf(one.state));
});

test('one call per person, two to a call in a big scene; the events call only when something can happen', async () => {
  const { calls } = await play(true, { second: 'moment' });
  const turn2 = calls.slice(calls.findIndex((c, i) => i > 0 && c.kind === 'intent:player' && calls.slice(0, i).some((x) => x.kind === 'intent:player')));
  assert.deepEqual(turn2.filter((c) => c.kind.startsWith('intent')).map((c) => c.kind), ['intent:player', 'intent:char', 'intent:char'], 'a quiet moment: no events call');
  const big = await play(true, { setup: (E) => { E.Engine.PAIR_ABOVE = 1; } });
  const chars = big.calls.filter((c) => c.kind === 'intent:char');
  assert.equal(chars.length, 2, 'one call for the pair, each turn');
  assert.match(chars[0].user, /Decide what Dr\. Imani Okafor and Teo Bauer actually each try/);
});

test('each person\'s call sees only their own secret, and what the player is doing', async () => {
  const { calls } = await play(true);
  const [okafor, bauer] = calls.filter((c) => c.kind === 'intent:char');
  assert.match(okafor.user, /=== WHAT KIT NAVARRO IS DOING ===\nask Okafor about the storm/);
  assert.ok(okafor.user.includes("Dr. Imani Okafor's secret:"), 'her own secret');
  assert.ok(!okafor.user.includes("Teo Bauer's secret:"), "not Teo's");
  assert.ok(bauer.user.includes("Teo Bauer's secret:") && !bauer.user.includes("Dr. Imani Okafor's secret:"), "his own, not Okafor's");
  assert.ok(!calls.find((c) => c.kind === 'intent:player').user.includes("'s secret:"), 'the player call sees no secrets');
});

test('every call of a split turn has the same header, and the intent and update parts share their opening', async () => {
  const { calls } = await play(true);
  const firstTurn = calls.slice(0, calls.findIndex((c) => c.kind === 'narrate') + 1);
  assert.equal(new Set(firstTurn.map((c) => c.system)).size, 1, 'one header for every call in the turn');
  const common = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); };
  const intents = firstTurn.filter((c) => c.kind.startsWith('intent:')).map((c) => c.user);
  const sharedIntent = intents.reduce(common);
  assert.match(sharedIntent, /=== PLAYER ACTION \(time passing: about an hour\) ===\n"Ask Okafor about the storm\."/);
  const updates = calls.filter((c) => c.kind.startsWith('update:')).map((c) => c.user);
  assert.match(updates.reduce(common), /=== SCENE AS NARRATED ===[\s\S]*Twenty hours/);
});

test('a person\'s or the events part failing costs that part, not the turn', async () => {
  const { state } = await play(true, { fail: (step, user) => (step === 'intent:char' && /Decide what Teo Bauer/.test(user)) || step === 'intent:events' });
  assert.ok(state.log.filter((e) => e.type === 'scene').length >= 2, 'both turns played');
  const res = state.pending.res;
  assert.ok(res.guards.some((g) => g.type === 'intent part failed' && /bauer/.test(g.detail)));
  assert.ok(res.guards.some((g) => g.type === 'intent part failed' && /events/.test(g.detail)));
  assert.ok(res.outcomes.some((o) => o.id === 'bauer' && /watching/.test(o.action)), 'Teo stays where he is, watching');
});

test('an update part failing loses that part; all three failing falls back like a failed update', async () => {
  const some = await play(true, { fail: (step) => step === 'update:feelings' });
  assert.ok(some.state.facts.some((f) => /^Okafor says the storm/.test(f.text)), 'facts still recorded');
  assert.equal(some.state.characters.okafor.relations.bauer, newGame('mars-station').state.characters.okafor.relations.bauer, 'no feelings changed');
  const guards = (E) => E.Engine.telemetry[E.Engine.telemetry.length - 1].guards;
  assert.ok(guards(some.E).some((g) => g.type === 'update part failed' && /^feelings/.test(g.detail)));
  const all = await play(true, { fail: (step) => step.startsWith('update:') });
  assert.ok(!all.state.facts.some((f) => /^Okafor says the storm/.test(f.text)));
  assert.ok(guards(all.E).some((g) => g.type === 'update failed'), 'the turn goes on as after a failed update');
});

test('the player\'s part failing fails the turn, as the single intent does', async () => {
  await assert.rejects(play(true, { fail: (step) => step === 'intent:player' }), /didn't return valid JSON|no reply/);
});

test('a split session records with its setting and replays split; old recordings replay whole', async () => {
  const { E, state } = newGame('mars-station');
  E.settings.backends.local.smallerCalls = true;
  fixedRng(E, [0.4, 0.6, 0.3, 0.7, 0.5]);
  mockLLM(E, answer(E));
  E.Recorder.start(state);
  await E.Engine.runTurn(state, 'Ask Okafor about the storm.', 'hour');
  await E.Engine.runTurn(state, 'Keep listening.', 'hour');
  const fixture = JSON.parse(JSON.stringify(E.Recorder.stop()));
  assert.equal(fixture.settings.backends.local.smallerCalls, true);
  assert.ok(fixture.actions[1].calls.some((c) => c.kind === 'update:facts'));
  const { steps } = await replay(fixture);
  assert.equal(steps.length, 2);
  // An old recording (no smallerCalls) replays with single calls.
  const old = await replay('mock-session');
  assert.ok(old.steps.length > 0);
});

test('each part\'s grammar takes its own example, and the update grammar takes a judged ending', () => {
  const { E, state } = newGame('mars-station');
  const P = E.Prompts;
  const present = E.Engine.present(state);
  const res = { outcomes: [], events: [] };
  const due = { regional: true };
  const texts = {
    player: P.intentPart(state, present, 'Look.', 'about an hour', 'hour', due, present, { part: 'player' }),
    chars: P.intentPart(state, present, 'Look.', 'about an hour', 'hour', due, present, { part: 'chars', who: present.slice(0, 1), player: INTENT.player }),
    events: P.intentPart(state, present, 'Look.', 'about an hour', 'hour', due, present, { part: 'events', player: INTENT.player, intents: INTENT.intents }),
  };
  Object.keys(P.UPDATE_PARTS).forEach((k) => { texts['update ' + k] = P.updatePart(state, 'Look.', res, SCENE, present, false, k); });
  for (const [k, t] of Object.entries(texts)) {
    const shape = P.shapeFor(t);
    assert.ok(shape, k);
    assert.ok(t.includes(E.Shape.example(shape)), `${k} shows its example`);
    assert.ok(matches(E.Shape.gbnf(shape), E.Shape.sample(shape)), `${k} grammar takes its example`);
  }
  assert.deepEqual([...E.Shape.keys(P.shapeFor(texts.chars))], ['intents']);
  assert.match(texts.chars, /"id":"okafor"/);
  assert.ok(!/"id":"bauer"/.test(texts.chars), 'only the person the call is for');
  // The ending (an L-1 gap): asked for outside the example, allowed by the grammar.
  const end = { id: 'the-report', quote: 'the report is sent to Earth' };
  const g = E.Shape.gbnf(P.shapeFor(texts['update state']));
  const sample = JSON.parse(E.Shape.sample(P.shapeFor(texts['update state'])));
  assert.ok(matches(g, JSON.stringify(Object.assign({}, sample, { ending: end }))));
  assert.match(texts['update state'], /=== ENDINGS ===/);
  assert.ok(!/=== ENDINGS ===/.test(texts['update facts']), 'only the state part judges an ending');
  const whole = P.update(state, 'Look.', res, SCENE, present, false);
  assert.ok(matches(E.Shape.gbnf(P.shapeFor(whole)), JSON.stringify(Object.assign(JSON.parse(E.Shape.sample(P.shapeFor(whole))), { ending: end }))));
});

test('"Smaller calls" defaults: on for KoboldCpp and for 16K or less, off for a bigger API', () => {
  const { E } = newGame('mars-station');
  const L = E.LLM;
  assert.deepEqual([L.smallerDefault('kobold-local', 32768), L.smallerDefault('kobold-remote', 0), L.smallerDefault('openrouter', 16384), L.smallerDefault('openrouter', 32768), L.smallerDefault('custom', 8192)], [true, true, true, false, true]);
  assert.equal(L.stepOf('intent:char (retry)'), 'intent');
  E.settings.routing.update = 'external';
  Object.assign(E.settings.backends.external, { preset: 'openrouter', context: 32768 });
  assert.equal(E.Engine.smallerCalls('update'), false);
});
