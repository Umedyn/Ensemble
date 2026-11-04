// Everyone has a schedule (task G-10): built-in routines, wandering, people
// and worlds that stay put, the fallback, the update step giving a routine,
// and generated people. Fixture: fixtures/droid-ship/ (no routines of its own).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, newGame, worldFiles, mockLLM } = require('./helpers');

const SHIP = path.join(__dirname, 'fixtures', 'droid-ship');
const TOWN = path.join(__dirname, 'fixtures', 'routine-town');
const advance = (g, hours) => { for (let i = 0; i < hours; i++) g.E.Engine.advanceTime(g.state, 1, { events: [] }); };

test('someone without a routine follows a worker\'s day from where they began', () => {
  const g = newGame(SHIP);
  const unit7 = g.state.characters.unit7;
  assert.equal(unit7.routine, undefined);
  g.state.time = { day: 12, hour: 7 };
  g.state.characters.mara.status.location = 'galley';
  advance(g, 1);
  assert.equal(unit7.routineState.home, 'engine', 'home is where they began');
  assert.equal(g.E.Engine.routineAt(g.state, 'unit7', { day: 12, hour: 10 }), unit7.routineState.work);
  assert.equal(g.E.Engine.routineAt(g.state, 'unit7', { day: 12, hour: 23 }), 'engine');
  assert.equal(g.E.Engine.routineAt(g.state, 'mara', { day: 12, hour: 10 }), null, 'never the player\'s, unless they have one');
});

test('a fixed person and a fixed world stay where the story puts them', () => {
  const g = newGame(SHIP);
  g.state.characters.unit7.routine = 'fixed';
  assert.equal(g.E.Engine.routineAt(g.state, 'unit7', { day: 12, hour: 10 }), null);
  const h = newGame('zombie-holdout');
  assert.ok(h.E.Engine.fixedWorld(h.state));
  const before = Object.fromEntries(Object.values(h.state.characters).map((c) => [c.id, c.status.location]));
  h.E.Engine.advanceTime(h.state, 30, { events: [] });
  Object.values(h.state.characters).forEach((c) => assert.equal(c.status.location, before[c.id], c.id));
  assert.ok(newGame('vesper-station').E.Engine.fixedWorld(newGame('vesper-station').state));
  assert.deepEqual([...h.E.Engine.routineGaps(h.state)], [], 'the update step asks for none');
});

test('wandering steps into a room next door now and then, the same in every game', () => {
  const a = newGame(SHIP), b = newGame(SHIP);
  [a, b].forEach((g) => { g.state.characters.unit7.routine = 'wander'; g.state.characters.mara.status.location = 'galley'; g.E.rng = () => { throw new Error('dice'); }; });
  const seen = new Set();
  for (let h = 0; h < 30; h++) {
    advance(a, 1);
    advance(b, 1);
    assert.equal(a.state.characters.unit7.status.location, b.state.characters.unit7.status.location);
    seen.add(a.state.characters.unit7.status.location);
  }
  assert.ok(seen.size > 1, 'they did wander');
  [...seen].forEach((r) => assert.ok(['engine', 'galley'].includes(r)));
});

test('a built-in routine fills its own place words in, so a world can use one with no places', () => {
  const E = loadEngine();
  const files = JSON.parse(JSON.stringify(worldFiles(SHIP)));
  files['characters/unit7.json'].routine = 'night-shift';
  const world = E.Scenario.prepareWorld('droid-ship', files);
  assert.equal(world.starts[0].error, undefined);
  files['characters/unit7.json'].routine = 'nap-time';
  assert.match(E.Scenario.prepareWorld('droid-ship', files).starts[0].error, /routine "nap-time" doesn't exist/);
  files['characters/unit7.json'].routine = 'fixed';
  assert.equal(E.Scenario.prepareWorld('droid-ship', files).starts[0].error, undefined);
  files['world.json'].routines = 'sometimes';
  assert.match(E.Scenario.prepareWorld('droid-ship', files).starts[0].error, /or be "fixed"/);
});

test('the first turn\'s update gives a routine to someone without one, checked like any other', async () => {
  const g = newGame(SHIP);
  const calls = mockLLM(g.E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'waits', needs_roll: false, move_to: null }, intents: [], events: [] };
    if (kind.startsWith('update')) return { facts: [], routines: [{ id: 'unit7', routine: 'night-shift', home: 'engine', work: 'galley' }, { id: 'mara', routine: 'worker' }, { id: 'unit7', routine: 'brunch' }] };
    return 'The pump whines.';
  });
  await g.E.Engine.runTurn(g.state, 'I wait.', 'moment');
  const update = await g.E.Engine.runTurn(g.state, 'I wait.', 'moment');
  const ask = calls.find((c) => c.kind.startsWith('update'));
  assert.match(ask.user, /routines: a usual day for unit7 \(maintenance droid, in Engine Room\)/);
  assert.equal(g.state.characters.unit7.routine, 'night-shift');
  assert.equal(g.state.characters.unit7.places.work, 'galley');
  const rejected = JSON.stringify(update.report || {}) + JSON.stringify(g.state.pending ? g.state.pending.res.guards : []) + JSON.stringify(g.E.Engine.telemetry.map((t) => t.guards));
  assert.match(rejected, /routine for mara — they need no routine/);
  assert.ok(!calls.filter((c) => c.kind.startsWith('update')).slice(1).some((c) => /routines: a usual day/.test(c.user)), 'not asked again');
});

test('a world whose people all have routines asks nothing of the update step', () => {
  const g = newGame(TOWN);
  assert.deepEqual([...g.E.Engine.routineGaps(g.state)], []);
  assert.doesNotMatch(g.E.Prompts.update(g.state, 'I wait.', { outcomes: [], events: [] }, 'The pump whines.', []), /routines: a usual day/);
});

test('a generated person always gets a routine, home in their own room', () => {
  const E = loadEngine();
  const sc = E.Scenario.startScenario(E.Scenario.prepareWorld('droid-ship', worldFiles(SHIP)), 'galley');
  const rooms = [{ id: 'farmhouse', name: 'Farmhouse', desc: 'x', connects: ['fields'] }, { id: 'fields', name: 'Fields', desc: 'x', connects: ['farmhouse'] }];
  const ctx = { sc, job: { steps: { rooms: { rooms, playerRoom: 'farmhouse' }, plan: { people: [] } }, cast: [] }, taken: { ids: new Set(), names: new Set(), people: [] } };
  const sheet = { want: 'a good harvest', traits: ['steady'], secret: 'owes the bank', room: 'farmhouse' };
  const out = E.StartGen.cleanPerson(Object.assign({}, sheet, { routine: 'farmhand', places: [{ word: 'work', room: 'fields' }] }), { name: 'Ada Holt', role: 'farmer' }, ctx, new Set());
  assert.equal(out.character.routine, 'farmhand');
  assert.deepEqual(JSON.parse(JSON.stringify(out.character.places)), { home: 'farmhouse', work: 'fields' });
  const bare = E.StartGen.cleanPerson(sheet, { name: 'Ben Holt', role: 'farmer' }, ctx, new Set());
  assert.equal(bare.character.routine, 'worker');
  assert.equal(bare.character.places.home, 'farmhouse');
});

test('a card says a wandering slot is nearby', () => {
  const g = newGame(SHIP);
  g.state.characters.unit7.routine = 'wander';
  assert.equal(g.E.Engine.routineWords(g.state, 'unit7'), '0–24 nearby');
  g.state.characters.unit7.routine = 'worker';
  assert.match(g.E.Engine.routineWords(g.state, 'unit7'), /8–17 .*; 17–22 Engine Room or nearby/);
});
