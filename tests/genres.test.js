// Genre tags (js/genres.js): guidance in the static header, default pacing,
// freeform tags and validation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, fixedRng, loadEngine, readScenario } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));
const header = (E, state) => E.Prompts.header(state);
const genreBlock = (h) => (h.includes('=== GENRE AND TONE ===') ? h.slice(h.indexOf('=== GENRE AND TONE ==='), h.indexOf('=== RULES ===')) : '');

test('the genre block lists each known tag, the first tag leads on major and danger, and the tone note is included', () => {
  const { E, state } = newGame();
  Object.assign(state.scenario, { tags: ['Cozy', 'horror'], toneNote: 'Warm, with something under the floor.' });
  const block = genreBlock(header(E, state));
  assert.match(block, /This story is: cozy, horror\. Blend them; where they pull apart, the first leads\./);
  assert.ok(block.includes(`- cozy: ${E.Genres.table.cozy.tone}`));
  assert.ok(block.includes(`- horror: ${E.Genres.table.horror.tone}`));
  assert.ok(block.includes(`A major event here means: ${E.Genres.table.cozy.major}.`), 'cozy leads');
  assert.match(block, /Danger is low\./, 'cozy + horror stays gentle');
  assert.match(block, /Tone: Warm, with something under the floor\./);
  state.scenario.tags = ['horror', 'cozy'];
  assert.match(genreBlock(header(E, state)), /Danger is lethal\./, 'horror first: lethal');
});

test('the genre block sits in the static header, before the rules and the live blocks', () => {
  const { E, state } = newGame();
  const h = header(E, state);
  assert.ok(h.indexOf('=== SETTING') < h.indexOf('=== GENRE AND TONE') && h.indexOf('=== GENRE AND TONE') < h.indexOf('=== RULES'));
});

test('unknown tags pass through as freeform text', () => {
  const { E, state } = newGame();
  Object.assign(state.scenario, { tags: ['survival', 'found family', '1970s', 'survival'], toneNote: undefined });
  const block = genreBlock(header(E, state));
  assert.match(block, /This story is: survival, found family, 1970s\./);
  assert.equal((block.match(/^- /gm) || []).length, 1, 'only known tags get a guidance line');
  state.scenario.tags = ['found family'];
  const only = genreBlock(header(E, state));
  assert.match(only, /This story is: found family\./);
  assert.doesNotMatch(only, /Danger|major event/, 'no known tag: no danger or major line');
});

test('a world with no tags and no tone note gets no genre block', () => {
  const { E, state } = newGame();
  delete state.scenario.tags;
  delete state.scenario.toneNote;
  assert.ok(!header(E, state).includes('GENRE AND TONE'));
  state.scenario.toneNote = 'Dry.';
  assert.match(genreBlock(header(E, state)), /^=== GENRE AND TONE ===\nTone: Dry\.\n/);
});

test('genre pacing defaults apply only when the world does not set the value', () => {
  const E = loadEngine();
  const p = (sc) => plain(E.Genres.pacing(sc));
  assert.deepEqual(p({}), { eventRates: { regional: 18, world: 96 }, majorEventDays: 9 }, 'engine defaults');
  assert.deepEqual(p({ tags: ['cozy'] }), { eventRates: { regional: 72, world: 336 }, majorEventDays: 14 });
  assert.deepEqual(p({ tags: ['cozy'], eventRates: { world: 0 }, majorEventDays: 3 }), { eventRates: { regional: 72, world: 0 }, majorEventDays: 3 }, 'world values win, tier by tier');
  assert.deepEqual(p({ tags: ['adventure', 'political'] }), { eventRates: { regional: 12, world: 48 }, majorEventDays: 9 }, 'each tier from the first tag that sets it');
  assert.deepEqual(p({ tags: ['romance', 'war'] }), { eventRates: { regional: 12, world: 48 }, majorEventDays: 5 }, 'tags without numbers are skipped');
});

test('the engine paces events by the genre defaults', () => {
  const { E, state } = newGame();
  delete state.scenario.eventRates;
  state.scenario.tags = ['cozy'];
  state.tierLast = {};
  // P(regional in 1h) = 1 - e^(-1/72) ≈ 0.0138: a draw of 0.02 misses under cozy, hits at the old 18h rate.
  fixedRng(E, [0.02, 0.99]);
  assert.equal(E.Engine.tiersDue(state, 1).regional, false);
  state.scenario.tags = ['survival'];
  fixedRng(E, [0.02, 0.99]);
  assert.equal(E.Engine.tiersDue(state, 1).regional, true);
});

test('the header with genre guidance is identical across a turn\'s calls', async () => {
  const { E, state } = newGame();
  assert.ok(header(E, state).includes('GENRE AND TONE'), 'Ares Deep is tagged');
  const calls = mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { needs_roll: false }, intents: [], events: [] } : 'Teo shrugs.'));
  await E.Engine.runTurn(state, 'Look around.', 'hour');
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  const turn2 = calls.slice(calls.findIndex((c, i) => i > 0 && c.kind === 'intent'));
  assert.ok(turn2.length >= 2);
  const systems = new Set(turn2.map((c) => c.system));
  assert.equal(systems.size, 1, 'every call in the turn shares one header');
  assert.ok([...systems][0].includes('=== GENRE AND TONE ==='));
});

test('validation rejects malformed tags and tone notes', () => {
  const E = loadEngine();
  const bad = (fields) => { const sc = Object.assign(readScenario('mars-station'), fields); return () => E.Scenario.validate(sc); };
  assert.throws(bad({ tags: 'survival' }), /"tags" must be a list/);
  assert.throws(bad({ tags: ['survival', 3] }), /"tags" must be a list/);
  assert.throws(bad({ tags: Array(9).fill('x') }), /at most 8/);
  assert.throws(bad({ tags: ['x'.repeat(41)] }), /40 characters/);
  assert.throws(bad({ toneNote: 'x'.repeat(301) }), /"toneNote" must be text of at most 300/);
  assert.doesNotThrow(bad({ tags: ['survival', 'found family'], toneNote: 'Fine.' }));
});
