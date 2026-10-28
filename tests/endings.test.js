// Endings: how a story can end besides the player's death. Ones the engine
// checks (a time, a timeline event, a pressure, conditions) close the scene
// they happen in; ones the model judges are ruled on in the memory update
// with a quote the engine finds in the scene, and a closing scene plays
// instead of the next action. The story then stops until the player keeps
// playing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, readScenario, loadEngine } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));
const SCENE = '[+0m] You lift the barricade bar and push the pickup out through the loading dock.\n\n[+20m] Ruth climbs into the cab beside you, and the two of you drive out past the junction and away from Harmon for good.';
// A model for whole turns: the intent call, the scene, the update (with a
// verdict), the closing scene. Returns the calls made.
function model(E, opts = {}) {
  return mockLLM(E, (call) => {
    if (call.kind === 'intent') return opts.intent || { player: { summary: 'acts' }, intents: [], events: [] };
    if (call.kind === 'update') return Object.assign({ facts: [], state: [], relations: [], player_attitude: [] }, opts.update || {});
    if (call.kind === 'narrate') return /That scene ended the story/.test(call.user) ? 'The road opens ahead of you.\n\nBehind you, Harmon shrinks to a smudge of smoke.' : opts.scene || '[+0m] The store creaks. Nobody speaks.';
    return { title: 'T', summary: 'S' };
  });
}
const holdout = (endings) => {
  const g = newGame('zombie-holdout');
  g.state.scenario.endings = endings;
  return g;
};

// ---------- the format ----------

test('endings are checked in plain words: triggers that exist, kinds, conditions, no secrets', () => {
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  const problems = (endings) => { sc.endings = endings; try { E.Scenario.validate(plain(sc)); return ''; } catch (err) { return err.message; } };
  assert.equal(problems([{ id: 'out', title: 'Out', kind: 'win', when: { judged: 'the player gets out of Harmon' } }]), '');
  assert.match(problems([{ id: 'x', when: { event: 'moon-landing' } }]), /ending "x": "when": no timeline event "moon-landing"/);
  assert.match(problems([{ id: 'x', when: { clock: 'nope' } }]), /no pressure \(clock\) "nope"/);
  assert.match(problems([{ id: 'x', when: { after: { day: 30 } } }]), /"after" must be \{day, hour\}/);
  assert.match(problems([{ id: 'x', when: { judged: 'x', after: { day: 1, hour: 1 } } }]), /"when" must be one of/);
  assert.match(problems([{ id: 'x', kind: 'tragic', when: { judged: 'x' } }]), /"kind" must be one of win, loss, bittersweet, neutral/);
  assert.match(problems([{ id: 'x' }]), /needs "when", or "if" conditions/);
  assert.match(problems([{ id: 'x', when: { judged: 'x' }, if: [{ alive: 'nobody' }] }]), /"if" 1: precondition "alive": unknown character "nobody"/);
  assert.match(problems([{ id: 'x', when: { judged: 'x' }, reward: 5 }]), /unknown field "reward"/);
  assert.match(problems([{ id: 'x', title: 'The bite', when: { judged: 'Dex admits something scratched his forearm on the supply run and he wrapped it' } }]), /ending "x" gives away Dex Coleman's secret/);
});

test('the bundled worlds each have an ending the engine checks and one the model judges', () => {
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const { E, state } = newGame(folder);
    const list = E.Engine.endingsOf(state);
    assert.ok(list.some((e) => e.when.judged), `${folder}: judged`);
    assert.ok(list.some((e) => e.when.event || e.when.after || e.when.clock), `${folder}: engine-checked`);
  }
});

// ---------- engine-checked ----------

test('an ending set for a time: the turn that reaches it closes the story in its own scene, and nothing plays after it', async () => {
  const { E, state } = holdout([{ id: 'dusk', title: 'Dusk', kind: 'loss', when: { after: { day: 23, hour: 11 } }, epilogue: 'The light goes, and so does hope.' }]);
  const calls = model(E, { scene: '[+0m] You wait by the window.\n\n[+150m] The light starts to change.' });
  await E.Engine.runTurn(state, 'Wait by the window.', 'moment');
  assert.equal(state.ending, undefined, 'not yet at 09:15');
  await E.Engine.runTurn(state, 'Keep waiting.', 'hours');
  assert.equal(state.ending.id, 'dusk');
  assert.match(state.ending.why, /it is past Day 23, 11:00/);
  const narrate = calls.filter((c) => c.kind === 'narrate').pop().user;
  assert.match(narrate, /=== THIS SCENE ENDS THE STORY ===\n"Dusk" \(a defeat\): it is past Day 23, 11:00\. The light goes, and so does hope\./);
  assert.ok(state.log.some((e) => e.type === 'ending' && e.id === 'dusk'));
  assert.ok(state.pending.res.guards.some((g) => g.type === 'ending'));
  await assert.rejects(E.Engine.runTurn(state, 'Go on.', 'hour'), /This story has reached an ending/);
  // Keep playing: the story goes on; the ending stays reached and isn't reached again.
  assert.ok(E.Engine.keepPlaying(state));
  await E.Engine.runTurn(state, 'Go on.', 'hour');
  assert.equal(state.ending.continued, true);
  assert.deepEqual([...state.endingsReached], ['dusk']);
  assert.equal(state.log.filter((e) => e.type === 'ending').length, 1);
});

test('an ending on a timeline event, on a pressure, or on conditions alone', async () => {
  // A timeline event that happens in the turn.
  const a = holdout([{ id: 'checkpoint', title: 'The checkpoint', when: { event: 'convoy-checkpoint' } }]);
  model(a.E);
  a.state.time.day = 26; a.state.time.hour = 8;
  await a.E.Engine.runTurn(a.state, 'Listen to the radio.', 'hour');
  assert.equal(a.state.ending && a.state.ending.id, 'checkpoint');
  // A pressure coming to a head.
  const b = holdout([{ id: 'overrun', title: 'Overrun', kind: 'loss', when: { clock: 'horde' } }]);
  model(b.E);
  const horde = b.state.clocks.find((c) => c.id === 'horde');
  horde.value = horde.max - 0.01;
  await b.E.Engine.runTurn(b.state, 'Hold the door.', 'hours');
  assert.equal(b.state.ending && b.state.ending.id, 'overrun');
  // Conditions alone: as soon as they all hold.
  const c = holdout([{ id: 'alone', title: 'Alone', if: [{ not: { alive: 'ferris' } }] }]);
  model(c.E);
  await c.E.Engine.runTurn(c.state, 'Look around.', 'moment');
  assert.equal(c.state.ending, undefined);
  c.state.characters.ferris.status.health = 'dead';
  await c.E.Engine.runTurn(c.state, 'Look around.', 'moment');
  assert.match(c.state.ending.why, /all of: /);
});

test('a skip stops at the time an ending is set for, and its scene closes the story', async () => {
  const { E, state } = holdout([{ id: 'a-week-on', title: 'A week on', kind: 'bittersweet', when: { after: { day: 30, hour: 9 } } }]);
  const plan = E.Engine.planMajorSkip(state, 'Keep to routine.');
  assert.ok(plan.reason === 'ending' || plan.hours < 7 * 24, 'something earlier may come first');
  state.clocks.forEach((c) => { c.perHour = 0; });
  Object.values(state.characters).forEach((c) => { c.agenda = null; });
  state.scenario.majorEventDays = 1000;
  state.scenario.timeline = [];
  const calls = mockLLM(E, (call) => (call.kind === 'intent' ? { montage: [{ after: '2d', text: 'The days pass.' }], positions: [], events: [], major_event: null }
    : call.kind === 'narrate' ? '[+0d] Days pass.\n\n[+7d] A week on, the store still stands.' : { facts: [], state: [], relations: [], player_attitude: [] }));
  const quiet = E.Engine.planMajorSkip(state, 'Keep to routine.');
  assert.deepEqual([quiet.reason, quiet.ending], ['ending', 'a-week-on']);
  await E.Engine.runTurn(state, 'Keep to routine.', 'major');
  assert.equal(state.ending && state.ending.id, 'a-week-on');
  assert.equal(E.fmtTime(state), 'Day 30, 09:00');
  assert.match(calls.find((c) => c.kind === 'intent').user, /The downtime ends at Day 30, 09:00, with no new event: the story reaches its ending here/);
  assert.match(calls.filter((c) => c.kind === 'narrate').pop().user, /THIS SCENE ENDS THE STORY/);
});

// ---------- judged ----------

test('a judged ending: the update quotes the scene, and a closing scene plays instead of the next action', async () => {
  const { E, state } = holdout([{ id: 'got-out', title: 'Out of Harmon', kind: 'win', when: { judged: 'the player gets out of Harmon for good' } }]);
  let calls = model(E, { scene: SCENE });
  await E.Engine.runTurn(state, 'Drive out with Ruth.', 'hour');
  assert.equal(state.ending, undefined, 'judged only once the scene is recorded');
  const turn = state.turn;
  calls = model(E, { update: { ending: { id: 'got-out', quote: 'drive out past the junction and away from Harmon for good' } } });
  const out = await E.Engine.runTurn(state, 'Look back at the town.', 'moment');
  assert.match(calls.find((c) => c.kind === 'update').user, /=== ENDINGS ===[\s\S]*- got-out: the player gets out of Harmon for good/);
  assert.deepEqual([out.ended, out.held, out.ending.id], [true, 'Look back at the town.', 'got-out']);
  assert.ok(!calls.some((c) => c.kind === 'intent'), 'the action is not played');
  assert.equal(state.turn, turn);
  const closing = state.log.find((e) => e.type === 'ending');
  assert.match(closing.text, /^The road opens ahead of you\./);
  assert.match(calls.find((c) => /That scene ended the story/.test(c.user)).user, /"Out of Harmon" \(a hard-won success\)\. It happened: the player gets out of Harmon for good\./);
  assert.ok(state.facts.some((f) => /reached an ending: Out of Harmon/.test(f.text)));
  // Undo goes back to before it, as for any turn.
  E.Engine.undo(state);
  assert.equal(state.ending, undefined);
});

test('a judged ending is refused without a real quote, for an unknown id, or when its conditions don\'t hold', async () => {
  const run = async (verdict, endings) => {
    const { E, state } = holdout(endings || [{ id: 'got-out', title: 'Out', when: { judged: 'the player gets out of Harmon for good' } }]);
    model(E, { scene: SCENE });
    await E.Engine.runTurn(state, 'Drive out with Ruth.', 'hour');
    const res = state.pending.res;
    const calls = model(E, { update: { ending: verdict } });
    await E.Engine.runTurn(state, 'Look back.', 'moment');
    return { state, guards: [...res.guards].filter((g) => g.type === 'ending refused').map((g) => g.detail), calls };
  };
  const made = await run({ id: 'got-out', quote: 'and they all lived happily ever after' });
  assert.equal(made.state.ending, undefined);
  assert.match(made.guards[0], /the quote isn't in the scene/);
  assert.match((await run({ id: 'got-out', quote: 'away' })).guards[0], /the quote isn't in the scene/, 'four words at least');
  assert.match((await run({ id: 'rescued', quote: 'drive out past the junction' })).guards[0], /"rescued" isn't an ending the story can reach now/);
  const gated = await run({ id: 'got-out', quote: 'drive out past the junction and away' }, [{ id: 'got-out', when: { judged: 'out' }, if: [{ not: { alive: 'han' } }] }]);
  assert.equal(gated.state.ending, undefined);
  assert.doesNotMatch(gated.calls.find((c) => c.kind === 'update').user, /=== ENDINGS ===/, 'not offered while its conditions fail');
});

test('the scene that ends the story plays out whole: no stepping in before its end; death is its own ending', async () => {
  const { E, state } = holdout([{ id: 'dusk', title: 'Dusk', when: { after: { day: 23, hour: 9 } } }]);
  model(E, { scene: '[+0m] One.\n\n[+20m] Two.\n\n[+40m] Three.' });
  state.time.hour = 8;
  await E.Engine.runTurn(state, 'Wait.', 'hour');
  assert.equal(state.ending.id, 'dusk');
  E.Engine.keepPlaying(state);
  await E.Engine.runTurn(state, 'Go on.', 'moment', null, 1);
  assert.equal(state.log.find((e) => e.type === 'scene' && e.turn === 1).cutAt, undefined, 'the step-in is ignored');
  // A dead player never reaches another ending.
  const d = holdout([{ id: 'later', when: { after: { day: 23, hour: 9 } } }]);
  d.state.flags.gameOver = true;
  assert.equal(d.E.Engine.checkEndings(d.state, { guards: [] }), null);
});
