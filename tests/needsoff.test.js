// Needs per character (task G-5): any character can go without some or all
// of the world's needs (a droid doesn't eat or sleep). Fixture:
// fixtures/droid-ship/ (a pilot, the ship's droid, and an android role).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, readWorld, newGame, mockLLM } = require('./helpers');

const SHIP = path.join(__dirname, 'fixtures', 'droid-ship');
const keys = (o) => [...Object.keys(o)].sort();

test('a droid without hunger or fatigue: they never grow, show or reach the prompts; its stress still does', async () => {
  const { E, state } = newGame(SHIP);
  const droid = state.characters.unit7;
  assert.deepEqual(keys(droid.needs), ['stress']);
  assert.deepEqual(keys(state.characters.mara.needs), ['fatigue', 'hunger', 'stress']);
  const before = droid.needs.stress;
  E.Engine.advanceTime(state, 20, { events: [] });
  assert.deepEqual(keys(droid.needs), ['stress'], 'twenty hours on, still no hunger or fatigue');
  assert.notEqual(droid.needs.stress, before, 'the needs it has still move');
  const header = E.Prompts.header(state);
  assert.match(header, /- unit7: Unit Seven \(it\/its\), maintenance droid\. .*Never feels: hunger, fatigue\./);
  assert.doesNotMatch(header.split('\n').find((l) => l.startsWith('- mara')), /Never feels/);
  // In a turn: the droid's status line has no hunger or fatigue.
  state.characters.unit7.status.location = 'galley';
  const calls = mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { needs_roll: false }, intents: [{ id: 'unit7', action: 'Reports the pump.', says: null, reveals: null, visible: true }], events: [] } : kind === 'update' ? {} : 'The pump whines.'));
  await E.Engine.runTurn(state, 'Ask about the pump.', 'moment');
  const status = calls.find((c) => c.kind === 'intent').user.split('\n').find((l) => l.startsWith('- Unit Seven'));
  assert.ok(status && !/hunger|fatigue/.test(status), status);
  assert.match(status, /stress/);
});

test('the update step can\'t give a character a need they don\'t have', () => {
  const { E, state } = newGame(SHIP);
  const r = E.Engine.applyUpdate(state, { state: [{ target: 'char:unit7', field: 'need', need: 'hunger', delta: 0.3 }, { target: 'char:unit7', field: 'need', need: 'stress', delta: 0.2 }] }, ['unit7'], {});
  assert.ok(r.rejected.some((x) => /Unit Seven doesn't have that need/.test(x)), JSON.stringify(r.rejected));
  assert.equal(state.characters.unit7.needs.hunger, undefined);
});

test('an android player\'s skip plan needn\'t eat or sleep, and its body never gives out from them', () => {
  const { E, state } = newGame(SHIP);
  state.characters.mara.needsOff = ['hunger', 'fatigue'];
  assert.deepEqual([...E.Engine.unmetNeeds(state, 'Keep working on the pump for three days.')], ['stress']);
  state.characters.mara.needsOff = true;
  assert.deepEqual([...E.Engine.unmetNeeds(state, 'Keep working on the pump for three days.')], []);
  state.characters.mara.needsOff = undefined;
  assert.deepEqual([...E.Engine.unmetNeeds(state, 'Keep working on the pump for three days.')].sort(), ['fatigue', 'hunger', 'stress']);
});

test('"needsOff" is checked in plain words, on a character, a cast entry or a role', () => {
  const E = loadEngine();
  const sc = { needs: [{ id: 'hunger' }, { id: 'fatigue' }] };
  assert.deepEqual([...E.Scenario.needsOffProblems(['hunger'], sc, 'x')], []);
  assert.deepEqual([...E.Scenario.needsOffProblems(true, sc, 'x')], []);
  assert.match(E.Scenario.needsOffProblems(['sleep'], sc, 'character "x"')[0], /"needsOff" names "sleep", which isn't one of this world's needs \(hunger, fatigue\)/);
  assert.match(E.Scenario.needsOffProblems('hunger', sc, 'x')[0], /must be true \(no needs at all\) or a list/);
  // A cast entry can switch them off for one start; a role in a player slot too.
  const files = require('./helpers').worldFiles(SHIP);
  files['starts/galley.json'].cast[0].needsOff = ['thirst'];
  assert.match(E.Scenario.prepareWorld('droid-ship', files).starts[0].error, /"needsOff" names "thirst"/);
  const roleFiles = require('./helpers').worldFiles(SHIP);
  roleFiles['starts/galley.json'].playerSlot.roles[1].needsOff = ['oil'];
  assert.match(E.Scenario.prepareWorld('droid-ship', roleFiles).starts[0].error, /roles "android": "needsOff" names "oil"/);
  assert.deepEqual([...readWorld(SHIP).warnings], []);
});

test('making a character: a role brings its needs off, the form can change them, and the made character plays without them', () => {
  const { E, state } = newGame(SHIP);
  const sc = state.scenario;
  const CM = E.CharMaker;
  const f = Object.assign(CM.defaults(sc), { name: 'Iris', role: 'android', want: 'keep the ship flying', traits: ['calm'] });
  f.needsOff = CM.roleNeedsOff(sc, 'android');
  assert.deepEqual([...f.needsOff], ['hunger', 'fatigue']);
  const made = CM.build(sc, f).character;
  assert.deepEqual([...made.needsOff], ['hunger', 'fatigue']);
  f.needsOff = ['hunger', 'fatigue', 'stress'];
  assert.equal(CM.build(sc, f).character.needsOff, true, 'all of them is true');
  f.needsOff = [];
  assert.equal(CM.build(sc, f).character.needsOff, undefined, 'none is left out of the file');
  // Played: the made android has stress only.
  const game = E.Engine.newGame(CM.withPlayer(sc, made));
  assert.deepEqual(keys(game.characters[game.player].needs), ['stress']);
  // The author form round-trips it.
  const back = CM.formFrom(sc, { id: 'unit7', name: 'Unit Seven', needsOff: true });
  assert.deepEqual([...back.needsOff], ['hunger', 'fatigue', 'stress']);
});
