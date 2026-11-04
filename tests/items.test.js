// Items people carry (task B-6): a list on characters, { name, amount? }, the
// amount a loose word and never a number. The update step adds, changes and
// removes items for people in the scene; the engine only drops a clear
// contradiction. A world without items is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, readWorld, loadEngine } = require('./helpers');

const PRESENT = ['okafor', 'bauer'];
// One update in the commons with Okafor and Teo, the player's room.
function update(E, state, items) {
  const here = state.characters[state.player].status.location;
  return E.Engine.applyUpdate(state, { items }, PRESENT, { startLoc: here, endLoc: here, prose: 'Things change hands.' });
}
const names = (c) => (c.items || []).map((i) => (i.amount ? `${i.name} (${i.amount})` : i.name));
function game() {
  const g = newGame();
  ['okafor', 'bauer'].forEach((id) => { g.state.characters[id].status.location = g.state.characters[g.state.player].status.location; });
  return g;
}

test('authored items start the game, cleaned, and the bundled worlds carry some', () => {
  const { state } = newGame();
  assert.deepEqual([...names(state.characters.navarro)], ['multitool', 'spare recycler seals (a few)']);
  const z = newGame('zombie-holdout');
  assert.ok(Object.values(z.state.characters).every((c) => c.items.length));
});

test('an item added in a scene persists, and the intent and narrator see what the people here carry', () => {
  const { E, state } = game();
  const r = update(E, state, [{ who: 'bauer', item: 'wrench from the garage' }]);
  assert.ok(r.applied.includes('item: Teo Bauer has wrench from the garage'));
  update(E, state, []);
  assert.ok(names(state.characters.bauer).includes('wrench from the garage'));
  const intent = E.Prompts.intent(state, PRESENT, 'Ask Teo for the wrench.');
  const user = typeof intent === 'string' ? intent : intent.user || JSON.stringify(intent);
  assert.match(user, /Teo Bauer \(he\/him\) \[bauer\]:[^\n]*carries: pruning shears, seed packets \(some\), wrench from the garage/);
  const here = state.characters[state.player].status.location;
  const narr = E.Prompts.narrate(state, PRESENT, 'Ask Teo for the wrench.', { startLoc: here, startTime: 'Sol 214, 07:15', stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 }, { outcomes: [], events: [] });
  assert.match(narr, /Teo Bauer[^\n]*carries: [^\n]*wrench from the garage/);
  // The update keeps to what is carried, and may change it.
  const upd = E.Prompts.update(state, 'Ask Teo.', { outcomes: [], events: [], guards: [] }, 'Teo hands it over.', PRESENT, false);
  assert.match(JSON.stringify(upd), /carried: navarro: multitool/);
});

test('giving away what you do not hold is dropped and reported; giving what you hold moves it', () => {
  const { E, state } = game();
  const r = update(E, state, [{ who: 'okafor', item: 'pruning shears', to: 'bauer' }, { who: 'bauer', item: 'penlight', gone: true }]);
  assert.deepEqual([...r.rejected], [
    'item "pruning shears" — Dr. Imani Okafor gives away pruning shears, which they don\'t hold',
    'item "penlight" — Teo Bauer loses or uses up penlight, which they don\'t hold',
  ]);
  const ok = update(E, state, [{ who: 'bauer', item: 'pruning shears', to: 'navarro' }, { who: 'bauer', item: 'seed packets', gone: true }]);
  assert.deepEqual([...ok.applied], ['item: Teo Bauer gives pruning shears to Kit Navarro', 'item: Teo Bauer no longer has seed packets']);
  assert.ok(names(state.characters.navarro).includes('pruning shears'));
  assert.deepEqual([...names(state.characters.bauer)], []);
});

test('two people never hold the one named thing; things with an amount can be shared', () => {
  const { E, state } = game();
  const r = update(E, state, [{ who: 'bauer', item: 'the multitool' }, { who: 'bauer', item: 'spare recycler seals', amount: 'a couple' }]);
  assert.deepEqual([...r.rejected], ['item "the multitool" — Kit Navarro holds the multitool; it would need giving']);
  assert.ok(names(state.characters.bauer).includes('spare recycler seals (a couple)'));
});

test('only people in the scene, and the player too', () => {
  const { E, state } = game();
  const r = update(E, state, [{ who: 'raman', item: 'helmet' }, { who: 'navarro', item: 'scrap of wiring' }]);
  assert.deepEqual([...r.rejected], ['item "helmet" — raman is not in the scene']);
  assert.ok(names(state.characters.navarro).includes('scrap of wiring'));
});

test('amounts stay words: a number from the model becomes one, and an authored number is refused', () => {
  const { E, state } = game();
  update(E, state, [{ who: 'bauer', item: 'seed packets', amount: 40 }, { who: 'okafor', item: 'ration bars', amount: '3' }, { who: 'okafor', item: 'flare', amount: 1 }]);
  assert.ok(names(state.characters.bauer).includes('seed packets (a lot)'));
  assert.ok(names(state.characters.okafor).includes('ration bars (a few)'));
  assert.ok(names(state.characters.okafor).includes('flare'));
  assert.ok(state.characters.okafor.items.every((i) => i.amount == null || !/\d/.test(i.amount)));
  const E2 = loadEngine();
  const w = readWorld('mars-station', E2);
  const sc = E2.Scenario.startScenario(w);
  sc.characterData.find((c) => c.id === 'bauer').items = [{ name: 'seed packets', amount: '12' }, { name: '' }, { name: 'shears', count: 2 }];
  assert.throws(() => E2.Scenario.validate(sc), (err) => /"amount" must be a short word/.test(err.message) && /item 2 needs a "name"/.test(err.message) && /unknown field "count"/.test(err.message));
});

test("cards show the player's things, and others' once the player shares a scene with them", () => {
  const { E, state } = game();
  assert.equal(E.Engine.shownItems(state, 'navarro').length, 2);
  assert.equal(E.Engine.shownItems(state, 'raman').length, 0, 'not seen yet');
  update(E, state, []);
  assert.equal(E.Engine.shownItems(state, 'bauer').length, 2, 'seen in a scene');
  assert.equal(E.Engine.shownItems(state, 'raman').length, 0, 'still elsewhere');
});

test('a world without items is unchanged: no shape, no prompt lines, and item changes refused', () => {
  const { E, state } = game();
  Object.values(state.characters).forEach((c) => { delete c.items; });
  assert.equal(E.Engine.itemsOn(state), false);
  assert.ok(!('items' in E.Prompts.shapes.update(state).props));
  const upd = JSON.stringify(E.Prompts.update(state, 'Ask Teo.', { outcomes: [], events: [], guards: [] }, 'Teo nods.', PRESENT, false));
  assert.ok(!/carried|carries|items:/.test(upd));
  const r = update(E, state, [{ who: 'bauer', item: 'wrench' }]);
  assert.deepEqual([...r.rejected], ['items — this world has no items']);
  assert.equal(state.characters.bauer.items, undefined);
});
