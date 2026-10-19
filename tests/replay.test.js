// Recordings replayed without a model. The sample fixture comes from the mock
// servers (`npm run fixture:mock`); real playtest fixtures go next to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { replay, loadFixture } = require('./replay');
const { newGame, mockLLM } = require('./helpers');

const json = (o) => JSON.stringify(o);
const withoutUndo = (s) => { const c = JSON.parse(json(s)); delete c.undo; return json(c); };
const fresh = () => JSON.parse(json(loadFixture('mock-session')));

test('the sample session replays turn by turn, the same way every time', async () => {
  const a = await replay('mock-session');
  const b = await replay('mock-session');
  assert.equal(json(a.state), json(b.state), 'deterministic');
  const [t1, t2, reroll, t3, undo, t3again] = a.steps;
  const roll = t1.state.pending.res.outcomes[0].roll;
  assert.ok(roll, 'turn 1: the tech roll is replayed from the recorded dice');
  assert.equal(t1.state.characters.okafor.status.location, 'ops', 'turn 1: Okafor left for Ops');
  assert.equal(t2.state.log.find((e) => e.type === 'scene' && e.turn === 1).cutAt, 2, 'turn 2 stepped in after beat 2');
  assert.equal(reroll.state.pending.turn, 2);
  assert.equal(t3.state.turn, 3);
  assert.equal(withoutUndo(undo.state), withoutUndo(reroll.state), 'undo went back to before turn 3');
  assert.equal(t3again.state.turn, 3);
  assert.equal(t3again.state.log.find((e) => e.type === 'action' && e.turn === 3).text, 'Ask Teo what he wiped from the log.');
  for (const s of a.steps) {
    const res = s.state.pending && s.state.pending.res;
    assert.ok(!res || !res.outcomes.some((o) => o.id === 'bauer' && o.reveals), `action ${s.index}: Teo's secret stays hidden`);
  }
  assert.ok(a.state.facts.some((f) => /sensor issue/.test(f.text)), 'memory recorded from the replayed update calls');
});

test('until stops after that many actions', async () => {
  const r = await replay('mock-session', { until: 2 });
  assert.equal(r.steps.length, 2);
  assert.equal(r.state.turn, 2);
});

test('replay fails clearly when the engine makes a different call than recorded', async () => {
  const f = fresh();
  f.actions[0].calls[1].kind = 'narrate (retry)';
  await assert.rejects(replay(f), (err) => err.name === 'ReplayError' &&
    /Replay mismatch at action 1 \(turn "I open up the recycler\."\), call 2: engine made "narrate", recording has "narrate \(retry\)"/.test(err.message));
});

test('replay fails when the engine makes fewer or more calls than recorded', async () => {
  const fewer = fresh();
  fewer.actions[0].calls.push(JSON.parse(json(fewer.actions[0].calls[1])));
  await assert.rejects(replay(fewer), /the engine made 2 call\(s\); the recording has 3/);
  const more = fresh();
  more.actions[0].calls.pop();
  await assert.rejects(replay(more), /made a "narrate" call, but the recording has only 1/);
});

test('replay fails when the dice are drawn differently', async () => {
  const short = fresh();
  short.actions[0].rng = short.actions[0].rng.slice(0, 1);
  await assert.rejects(replay(short), /drew more random numbers than recorded \(1\)/);
  const long = fresh();
  long.actions[0].rng.push(0.5);
  await assert.rejects(replay(long), /drew 3 random number\(s\); the recording has 4/);
});

test('a recorded failure must fail again, and an unrecorded one is reported', async () => {
  const f = fresh();
  f.actions[0].error = { name: 'Error', message: 'boom' };
  await assert.rejects(replay(f), /the recording failed here \("boom"\) but the replay didn't/);
  const g = fresh();
  g.actions[0].calls[0].response.text = 'not json at all';
  g.actions[0].calls[0].kind = 'intent';
  await assert.rejects(replay(g), /call 2: engine made "intent \(retry\)", recording has "narrate"/);
});

test('a recorded network failure replays as the same failure', async () => {
  const f = fresh();
  f.actions = [{ type: 'turn', action: 'Look around.', stepId: 'hour', cutAt: null, rng: f.actions[0].rng.slice(0, 2), calls: [
    { kind: 'intent', backend: 'local', request: {}, error: { name: 'TypeError', message: 'Failed to fetch' } }],
  error: { name: 'Error', message: "Couldn't reach KoboldCpp" }}];
  const r = await replay(f);
  assert.match(r.steps[0].error.message, /Couldn't reach KoboldCpp/);
  assert.equal(r.state.turn, 0, 'the failed turn rolled back');
});

test('the recorder keeps calls and dice per action, and never keys or URLs', async () => {
  const { E, state } = newGame();
  E.settings.backends.external.key = 'sk-secret';
  E.settings.backends.external.url = 'https://private.example/v1';
  const calls = mockLLM(E, ({ kind }) => kind === 'intent'
    ? { player: { needs_roll: true, skill: 'tech' }, intents: [], events: [] } : 'Teo shrugs.');
  const transport = E.LLM.transport, rng = E.rng;
  E.Recorder.start(state);
  await E.Engine.runTurn(state, 'Fix it.', 'moment');
  E.Engine.undo(state);
  const f = E.Recorder.stop();
  assert.equal(E.LLM.transport, transport, 'stop puts the transport back');
  assert.equal(E.rng, rng);
  assert.deepEqual([...f.actions.map((a) => a.type)], ['turn', 'undo']);
  assert.deepEqual([...f.actions[0].calls.map((c) => c.kind)], ['intent', 'narrate']);
  assert.ok(f.actions[0].rng.length >= 2, 'tier roll and the tech roll');
  assert.equal(f.actions[0].calls[1].response.text, 'Teo shrugs.');
  assert.equal(f.start.turn, 0);
  assert.ok(!json(f).includes('sk-secret') && !json(f).includes('private.example'));
  assert.equal(calls.length, 2);
  // and it replays
  const r = await replay(JSON.parse(json(f)));
  assert.equal(r.state.turn, 0);
  assert.equal(r.steps[0].state.turn, 1);
});
