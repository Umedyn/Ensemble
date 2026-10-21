// Suggested actions: ideas for the player's next action that fill the action
// box. The model sees only what the player knows, and nothing changes in the game.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM } = require('./helpers');

test('suggestions are cleaned: strings only, no list marks or quotes, no repeats, at most 4', () => {
  const { E } = newGame();
  const out = E.Engine.cleanSuggestions({ suggestions: [
    '1. Ask Teo about the rattle.', '"Check the logs."', { text: '- Go to Ops.' }, 42, '', '...', 'ask teo about the rattle', 'x'.repeat(200), 'Help Okafor.', 'One too many.',
  ] });
  assert.deepEqual([...out], ['Ask Teo about the rattle.', 'Check the logs.', 'Go to Ops.', 'Help Okafor.']);
  assert.deepEqual([...E.Engine.cleanSuggestions(null)], []);
});

test('the suggestion prompt holds only what the player knows, and the game is unchanged', async () => {
  const { E, state } = newGame();
  state.characters.sorensen.status.location = 'commons';
  const before = JSON.stringify(state);
  const calls = mockLLM(E, () => ({ suggestions: ['Ask Teo about the rattle.', 'Check the recycler.'] }));
  const list = await E.Engine.suggestActions(state);
  assert.deepEqual([...list], ['Ask Teo about the rattle.', 'Check the recycler.']);
  assert.equal(JSON.stringify(state), before);
  const call = calls[0];
  assert.equal(call.kind, 'suggest');
  assert.equal(call.system, E.Prompts.header(state), 'the shared header, for the cache');
  for (const id of state.order) {
    const c = state.characters[id];
    if (c.secret) assert.ok(!call.user.includes(c.secret), `${id}'s secret stays out`);
  }
  E.Memory.privateFacts(state, 'okafor').forEach((f) => assert.ok(!call.user.includes(f.text), 'private knowledge stays out'));
  assert.ok(!/feels toward Kit/.test(call.user), "others' feelings stay out");
});

test('suggestions see the scene only up to the step-in point', async () => {
  const { E, state } = newGame();
  state.recent = [{ turn: 1, text: 'Teo shrugs.\n\nLater, Okafor confesses everything.' }];
  const calls = mockLLM(E, () => ({ suggestions: ['Wait.'] }));
  await E.Engine.suggestActions(state, 'Teo shrugs.\n\n[Kit Navarro steps in here.]');
  assert.ok(calls[0].user.includes('Teo shrugs.'));
  assert.ok(!calls[0].user.includes('confesses'));
});

test('no usable suggestions is an error, not an empty list', async () => {
  const { E, state } = newGame();
  mockLLM(E, () => ({ suggestions: ['...', ''] }));
  await assert.rejects(E.Engine.suggestActions(state), /no usable suggestions/);
});

test('suggestions go to the backend routed for characters & events', () => {
  const { E } = newGame();
  E.settings.routing = Object.assign({}, E.settings.routing, { intent: 'external', narrate: 'local' });
  assert.equal(E.LLM.backendFor('suggest').id, 'external');
  assert.equal(E.LLM.backendFor('suggest (retry)').id, 'external');
});
