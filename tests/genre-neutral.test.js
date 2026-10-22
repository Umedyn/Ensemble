// A world with no survival in it (task 1-5): no needs, slice-of-life and
// comedy tags. It has to play turns, skips and chapters, and its prompts must
// not assume danger. Fixture: tests/fixtures/slice-of-life/.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newGame, mockLLM, fixedRng, loadEngine, readScenario } = require('./helpers');

const FLAT = path.join(__dirname, 'fixtures', 'slice-of-life');
const flat = () => newGame(FLAT);

// A model that answers every step of a turn, a skip and a chapter for the flat.
function flatModel(E) {
  return mockLLM(E, ({ kind, user }) => {
    if (kind === 'intent' && /MAJOR EVENT|comes to a head/.test(user)) {
      return { montage: [{ after: '1h', text: 'Dishes, slowly.' }], events: [], positions: [{ id: 'jo', where: 'kitchen', doing: 'drying plates' }], player_where: 'kitchen',
        major_event: { text: 'Ana sets off the smoke alarm making pancakes.', scope: 'local', who: ['ana'], where: 'kitchen', effects: {} } };
    }
    if (kind === 'intent') return { player: { summary: 'Sam washes up', needs_roll: true, skill: 'practical', difficulty: 'normal' },
      intents: [{ id: 'jo', action: 'dries the plates', says: 'Finally.', visible: true }], events: [] };
    if (kind === 'update') return { facts: [{ about: ['sam'], text: 'Sam washed the dishes.', known_by: ['sam', 'jo'], weight: 2 }], state: [], relations: [], player_attitude: [] };
    if (kind === 'chapter') return { title: 'Dishes', summary: 'Sam finally did the dishes.' };
    return '[+0m] You run the water. Jo hands you a sponge without a word.\n\n[+5m] Jo raises an eyebrow at the frying pan.';
  });
}

test('a world with no needs plays turns, a skip to the next major event and a chapter close', async () => {
  const { E, state } = flat();
  assert.deepEqual([...state.scenario.needs], []);
  assert.deepEqual({ ...state.characters.sam.needs }, {});
  E.settings.chapterLength = 2;
  const calls = flatModel(E);
  fixedRng(E, [0.5]);
  await E.Engine.runTurn(state, 'Wash the dishes.', 'moment');
  await E.Engine.runTurn(state, 'Keep washing.', 'hour');
  await E.Engine.runTurn(state, '', 'major');
  assert.equal(state.turn, 3);
  assert.ok(calls.some((c) => c.kind === 'chapter'), 'a chapter closed');
  assert.equal(state.chapters.length, 1);
  assert.match(state.chapters[0].summary, /dishes/);
  assert.ok(state.facts.some((f) => /Mr\. Petrov, right on time/.test(f.text)), 'the skip stopped at the landlord visit');
  assert.deepEqual({ ...state.characters.sam.needs }, {}, 'time passing adds no needs');
});

test('prompts for a world without needs or danger carry no survival assumptions', async () => {
  const { E, state } = flat();
  const calls = flatModel(E);
  await E.Engine.runTurn(state, 'Wash the dishes.', 'moment');
  await E.Engine.runTurn(state, 'Keep washing.', 'moment');
  const all = calls.map((c) => c.system + '\n' + c.user).join('\n');
  assert.match(all, /Failures cost something: embarrassment, strain, a setback\./, 'the mild rule line');
  assert.match(all, /Danger is low\./);
  assert.doesNotMatch(all, /Injuries and deaths are permanent|intercom|station|"field":"need"|\nneeds:|tracked as needs|Eating or resting/);
  const update = calls.find((c) => c.kind === 'update').user;
  assert.match(update, /Not feelings\.\n/);
  const skip = E.Prompts.skipIntent(state, '', { reason: 'random', hours: 30 }, { stepLabel: 'until something major happens', spanMinutes: 1800 }, { events: [] });
  assert.match(skip, /In this story a major event means a change in someone's life/);
  assert.doesNotMatch(skip, /equipment failure|Ideas: \./);
});

test('rolls in a world without fatigue take no fatigue penalty; health penalties stay', () => {
  const { E, state } = flat();
  const sam = state.characters.sam;
  fixedRng(E, [0.5]); // d20 = 11
  assert.equal(E.Engine.roll(sam, 'practical', 'normal', state.scenario).total, 11 + 4);
  sam.status.health = 'hurt';
  fixedRng(E, [0.5]);
  assert.equal(E.Engine.roll(sam, 'practical', 'normal', state.scenario).total, 11 + 4 - 2);
});

test('a world can set its own skill penalties and reveal pressure', () => {
  const { E, state } = newGame('zombie-holdout');
  const dex = state.characters.coleman;
  dex.needs.fatigue = 0.9;
  fixedRng(E, [0.5]);
  assert.equal(E.Engine.roll(dex, 'shooting', 'normal', state.scenario).total, 11 + 8 - 2, 'default: tired is -2');
  state.scenario.skillPenalties = { health: { hurt: -1 }, needs: [{ need: 'fear', at: 0.5, penalty: -3 }] };
  dex.needs.fear = 0.6;
  fixedRng(E, [0.5]);
  assert.equal(E.Engine.roll(dex, 'shooting', 'normal', state.scenario).total, 11 + 8 - 3, 'fatigue no longer counts, fear does');
});

test('secrets in a world without needs open through trust or a social roll, not pressure', async () => {
  const { E, state } = flat();
  const reveal = { player: { summary: 'Sam asks Ana about the mug' }, intents: [{ id: 'ana', action: 'admits it', says: 'I broke Jo\'s favourite mug and hid the pieces in the bin.', reveals: 'I broke the mug', visible: true }], events: [] };
  state.characters.ana.status.location = 'kitchen';
  state.characters.jo.status.location = 'living';
  state.characters.ana.relations.sam = 0;
  mockLLM(E, ({ kind }) => (kind === 'intent' ? reveal : '[+0m] Ana smiles too brightly.'));
  await E.Engine.runTurn(state, 'Nice weather.', 'moment');
  assert.equal(state.pending.res.outcomes.find((o) => o.id === 'ana').reveals, null, 'no pressure, no trust, not confronted: held back');
  state.characters.ana.relations.sam = 40;
  await E.Engine.runTurn(state, 'Nice weather.', 'moment');
  assert.ok(state.pending.res.outcomes.find((o) => o.id === 'ana').reveals, 'trust opens it');
});

test('validation checks needs, skillPenalties and revealPressure', () => {
  const E = loadEngine();
  const bad = (fields) => () => E.Scenario.validate(Object.assign(readScenario('zombie-holdout'), fields));
  assert.throws(bad({ needs: [{ label: 'x' }] }), /"needs" must be a list/);
  assert.throws(bad({ skillPenalties: { health: { dazed: -1 } } }), /skillPenalties\.health\.dazed/);
  assert.throws(bad({ skillPenalties: { needs: [{ need: 'thirst', at: 0.5, penalty: -1 }] } }), /entry for "thirst"/);
  assert.throws(bad({ revealPressure: ['stress'] }), /revealPressure "stress" is not one of the world's needs/);
  assert.doesNotThrow(bad({ revealPressure: ['fear'], skillPenalties: { health: { hurt: -1 }, needs: [{ need: 'fear', at: 0.9, penalty: -1 }] } }));
  const sc = readScenario('zombie-holdout');
  delete sc.needs;
  delete sc.playerSlot.needs; // the made character's starting needs name the world's needs
  assert.deepEqual([...E.Scenario.validate(sc).needs], [], 'no needs listed means none');
});
