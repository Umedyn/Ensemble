// Correcting your feelings (task 1-8): the player fixes their own attitude
// when the model misread their tone. Only the player's feelings change.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM } = require('./helpers');
const { replay } = require('./replay');

const quietModel = (E, prose = '[+0m] Teo shrugs.') => mockLLM(E, ({ kind }) => {
  if (kind === 'intent') return { player: { summary: 'x' }, intents: [], events: [] };
  if (kind === 'update') return { facts: [], state: [], player_attitude: [] };
  return prose;
});

test('a correction changes only your feelings, clamps, and replaces the note when you say why', () => {
  const { E, state } = newGame();
  const pc = state.characters.navarro;
  pc.attitudeNotes = { okafor: 'snapped at her (it was a joke)' };
  const teoBefore = JSON.stringify(state.characters.okafor.relations);
  let out = E.Engine.correctAttitude(state, 'okafor', 5, '');
  assert.equal(out.value, 15);
  assert.equal(pc.attitudeNotes.okafor, 'snapped at her (it was a joke)', 'no why: the note stays');
  out = E.Engine.correctAttitude(state, 'okafor', 5, '  I was teasing, we get along  ');
  assert.equal(pc.relations.okafor, 20);
  assert.equal(pc.attitudeNotes.okafor, 'I was teasing, we get along');
  assert.equal(JSON.stringify(state.characters.okafor.relations), teoBefore, "Okafor's feelings are hers");
  pc.relations.bauer = 98;
  E.Engine.correctAttitude(state, 'bauer', 5);
  assert.equal(pc.relations.bauer, 100, 'clamped');
  E.Engine.correctAttitude(state, 'bauer', 500);
  assert.equal(pc.relations.bauer, 100);
  assert.equal(E.Engine.correctAttitude(state, 'navarro', 5).error, 'unknown person', 'not toward yourself');
  assert.equal(E.Engine.correctAttitude(state, 'nobody', 5).error, 'unknown person');
  assert.equal(E.Engine.correctAttitude(state, 'okafor', 0, '').error, 'nothing to change');
  assert.deepEqual([...state.corrections.map((c) => [c.id, c.delta, c.value])], [['okafor', 5, 15], ['okafor', 5, 20], ['bauer', 5, 100], ['bauer', 20, 100]], 'logged for Debug');
});

test("the next turn's prompts use the corrected feeling and its note", async () => {
  const { E, state } = newGame();
  E.Engine.correctAttitude(state, 'bauer', -10, 'he lied to me about the log');
  const calls = quietModel(E);
  await E.Engine.runTurn(state, 'Watch Teo.', 'moment');
  assert.match(calls.find((c) => c.kind === 'intent').user, /feels toward: [^\n]*Teo Bauer neutral \(10; he lied to me about the log\)/);
});

test('a correction made while a turn is pending is not lost when it commits, plainly or after stepping in', async () => {
  for (const cutAt of [null, 1]) {
    const { E, state } = newGame();
    quietModel(E, '[+0m] You ask Teo. He shrugs.\n\n[+70m] Okafor heads for Ops.\n\n[+160m] Priya stomps in.');
    await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'hours');
    assert.ok(state.pending);
    E.Engine.correctAttitude(state, 'okafor', -5, 'she brushed me off');
    await E.Engine.runTurn(state, 'Wait.', 'moment', null, cutAt);
    assert.equal(state.characters.navarro.relations.okafor, 5, `cutAt ${cutAt}: still corrected`);
    assert.equal(state.characters.navarro.attitudeNotes.okafor, 'she brushed me off');
  }
});

test('undo goes back to before your last action, so it drops corrections made since; earlier ones stay', async () => {
  const { E, state } = newGame();
  quietModel(E);
  E.Engine.correctAttitude(state, 'okafor', 5, 'before acting');
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  E.Engine.correctAttitude(state, 'bauer', -5, 'after acting');
  E.Engine.undo(state);
  assert.equal(state.characters.navarro.relations.okafor, 15, 'made before the action: kept');
  assert.equal(state.characters.navarro.relations.bauer, 20, 'made after the action: undone with it');
});

test('a reroll keeps corrections', async () => {
  const { E, state } = newGame();
  quietModel(E);
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  E.Engine.correctAttitude(state, 'okafor', 10, 'fair point she made');
  await E.Engine.rerollNarration(state);
  assert.equal(state.characters.navarro.relations.okafor, 20);
});

test('corrections are recorded and replay as their own action', async () => {
  const { E, state } = newGame();
  quietModel(E);
  E.Recorder.start(state);
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  E.Engine.correctAttitude(state, 'okafor', -5, 'cold shoulder');
  const f = JSON.parse(JSON.stringify(E.Recorder.stop()));
  assert.deepEqual(f.actions[1], { type: 'correct', id: 'okafor', delta: -5, why: 'cold shoulder' });
  const r = await replay(f);
  assert.equal(r.state.characters.navarro.relations.okafor, 5);
  assert.equal(r.state.characters.navarro.attitudeNotes.okafor, 'cold shoulder');
});
