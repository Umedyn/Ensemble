// Chapters free context: a chapter closes when the facts it would roll up
// are worth it, not on a dramatic moment (chapters were closing after one or
// two turns), with a long length as a backstop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, loadEngine } = require('./helpers');

// n minor facts the player knows, in the current chapter.
function addFacts(E, state, n, words = 20) {
  for (let i = 0; i < n; i++) E.Memory.addFact(state, { about: [state.player], text: `Note ${i}: ${'word '.repeat(words).trim()}.`, known_by: ['all'], weight: 1 });
}
const atTurn = (state, n) => { state.turn = state.chapterStartTurn + n - 1; };

test('a dramatic moment no longer closes a chapter after a turn or two', () => {
  const { E, state } = newGame('mars-station');
  atTurn(state, 2);
  state.flags.chapterWorthy = true;
  E.Memory.addFact(state, { about: [state.player], text: 'The recycler failed for good.', known_by: ['all'], weight: 3 });
  assert.equal(E.Memory.needsChapter(state), false);
});

test('a chapter closes by size: when its facts would free a good share of the budget, after a few turns', () => {
  const { E, state } = newGame('mars-station');
  const budget = E.Memory.budgets().facts;
  // Enough minor facts to free a third of the budget.
  let n = 0;
  while (E.Memory.freeable(state) < budget * E.Memory.CHAPTER.share) { addFacts(E, state, 1); n++; }
  assert.ok(n > 1);
  atTurn(state, E.Memory.CHAPTER.minTurns - 1);
  assert.equal(E.Memory.needsChapter(state), false, 'not before a few turns');
  atTurn(state, E.Memory.CHAPTER.minTurns);
  assert.equal(E.Memory.needsChapter(state), 'size');
  // Weight-3 facts stay after a chapter closes, so they don't count toward it.
  const big = newGame('mars-station');
  const before = big.E.Memory.freeable(big.state);
  for (let i = 0; i < n; i++) big.E.Memory.addFact(big.state, { about: [big.state.player], text: `Major ${i}: ${'word '.repeat(20).trim()}.`, known_by: ['all'], weight: 3 });
  atTurn(big.state, big.E.Memory.CHAPTER.minTurns);
  assert.equal(big.E.Memory.freeable(big.state), before);
});

test('facts over the budget close a chapter from its second turn; a long chapter closes at the backstop', () => {
  const { E, state } = newGame('mars-station');
  const budget = E.Memory.budgets().facts;
  while (E.estTokens(E.Memory.headerFacts(state).map((f) => `- [T${f.turn}] ${f.text}`).join('\n')) <= budget) addFacts(E, state, 5);
  atTurn(state, 1);
  assert.equal(E.Memory.needsChapter(state), false);
  atTurn(state, 2);
  assert.equal(E.Memory.needsChapter(state), 'size');
  const quiet = newGame('mars-station');
  assert.equal(quiet.E.settings.chapterLength, 12, 'the default backstop');
  atTurn(quiet.state, 11);
  assert.equal(quiet.E.Memory.needsChapter(quiet.state), false);
  atTurn(quiet.state, 12);
  assert.equal(quiet.E.Memory.needsChapter(quiet.state), 'length');
});

test('settings saved with the old 5-turn default move to the new backstop; a length the player chose stays', () => {
  const load = (saved) => {
    const store = { 'ensemble.settings': JSON.stringify(saved) };
    const E = loadEngine({ localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } } });
    E.loadSettings();
    return E.settings.chapterLength;
  };
  assert.equal(load({ chapterLength: 5 }), 12);
  assert.equal(load({ chapterLength: 8 }), 8);
  assert.equal(load({ chapterLength: 5, chapterRule: 2 }), 5, 'chosen after the change');
});
