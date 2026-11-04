// Positions change beat by beat (task G-11): while a scene is read, the map
// and the people panel show where everyone is at that beat, the player too.
// Fixture: fixtures/routine-town/.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newGame, mockLLM } = require('./helpers');

const TOWN = path.join(__dirname, 'fixtures', 'routine-town');
const MONDAY = 5;
const game = (hour, room) => {
  const g = newGame(TOWN);
  g.state.time = { day: MONDAY, hour };
  g.state.characters.sora.status.location = room;
  g.E.Engine.knowAll(g.state, 0);
  return Object.assign(g, { Eng: g.E.Engine });
};
const play = (g, scene, o = {}) => {
  mockLLM(g.E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: Object.assign({ summary: 'goes', needs_roll: false, move_to: null }, o.player), intents: [], events: [] };
    return kind.startsWith('update') ? { facts: [] } : scene;
  });
  return g.Eng.runTurn(g.state, o.action || 'I wait.', o.step || 'hour');
};

test('a routine move shows at the beat that reaches its minute', async () => {
  const g = game(8.5, 'aoi-room');
  g.state.characters.aoi.status.location = 'aoi-room';
  g.state.characters.sora.status.location = 'aoi-room';
  await play(g, '[+0m] Sora waits by the window.\n\n[+20m] The kettle clicks off.\n\n[+50m] The street outside is busy now.', { step: 'hour' });
  const moves = [...g.Eng.sceneMoves(g.state)].find((m) => m.id === 'aoi');
  assert.ok(moves, 'Aoi leaves for class at nine');
  assert.equal(moves.beat, 1, 'the beat that runs to +35m covers +30m; no beat names them');
  assert.equal(g.Eng.sceneAt(g.state, 0).people.aoi, 'aoi-room', 'still home in the first beat');
  assert.equal(g.Eng.sceneAt(g.state, 1).people.aoi, undefined, 'gone by the second, where the turn ends');
});

test('the player walking somewhere is shown along the way', async () => {
  const g = game(8, 'aoi-room');
  await play(g, '[+0m] You set off.\n\n[+40m] The bus rattles out of town.\n\n[+170m] The City rises ahead.', { step: 'hours', action: 'I take the bus to The City.', player: { move_to: 'city' } });
  assert.equal(g.state.characters.sora.status.location, 'city', 'the turn ends there');
  assert.equal(g.Eng.sceneAt(g.state, 0).player, 'plaza', 'past the door, waiting for the bus');
  assert.equal(g.Eng.sceneAt(g.state, 1).player, 'plaza');
  assert.equal(g.Eng.sceneAt(g.state, 2).player, 'city');
});

test('a routine day shows the stop the plan has reached', async () => {
  const g = game(11.5, 'classroom');
  await play(g, '[+5m] The lesson drags.\n\n[+50m] Lunch is loud.\n\n[+60m] Still lunch.\n\n[+170m] The afternoon lesson drags on.', { step: 'hours', action: 'I sit through class.' });
  assert.equal(g.Eng.sceneAt(g.state, 0).player, 'classroom');
  assert.equal(g.Eng.sceneAt(g.state, 1).player, 'canteen');
  assert.equal(g.Eng.sceneAt(g.state, 3).player, 'classroom');
});

test('stepping in after a beat leaves things as that beat showed them', async () => {
  const g = game(11.5, 'classroom');
  await play(g, '[+5m] The lesson drags.\n\n[+50m] Lunch is loud.\n\n[+60m] Still lunch.\n\n[+170m] The afternoon lesson drags on.', { step: 'hours', action: 'I sit through class.' });
  const shown = g.Eng.sceneAt(g.state, 1).player;
  await g.Eng.commitPending(g.state, 2, () => {});
  assert.equal(g.state.characters.sora.status.location, shown);
  const h = game(8.5, 'aoi-room');
  h.state.characters.aoi.status.location = 'aoi-room';
  await play(h, '[+0m] Sora waits by the window.\n\n[+20m] The kettle clicks off.\n\n[+50m] The street outside is busy now.');
  const before = h.Eng.sceneAt(h.state, 0).people.aoi;
  await h.Eng.commitPending(h.state, 1, () => {});
  assert.equal(h.state.characters.aoi.status.location, before, 'still home at the step-in, as shown');
});

test('with no scene being read there is nothing to show', () => {
  const g = game(10, 'classroom');
  assert.equal(g.Eng.sceneAt(g.state, 0), null);
});
