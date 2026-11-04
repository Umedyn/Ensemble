// Moving pieces on the map (task A-10): which tokens walk on a revealed beat,
// along which rooms and doors, what pulses, and how much motion is wanted.
// Only what the player saw moves; a path never crosses a room they haven't seen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM } = require('./helpers');

const SCENE = '[+0m] You pry the panel off.\n\n[+30m] Okafor gathers her tablet and heads for Ops.\n\n[+55m] Teo hands you a spanner.';
// Ares Deep after a turn where Okafor walks to Ops on the second beat.
async function played(o = {}) {
  const g = newGame('mars-station');
  mockLLM(g.E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'inspect', needs_roll: false, move_to: o.playerTo || null },
      intents: [{ id: 'okafor', action: 'heads to Ops', visible: o.covert ? false : true, move_to: 'ops' }], events: [] };
    return kind.startsWith('update') ? { facts: [] } : SCENE;
  });
  await g.E.Engine.runTurn(g.state, 'I open up the recycler.', 'hour');
  return g;
}
// A drawing as the map would record it.
const drawing = (state, shown, rooms, extra) => Object.assign({ key: 'home|detailed', turn: state.turn, shown, cut: null, rooms, links: {}, features: {}, groups: {} }, extra);

test('map motion: on, reduced or off, and Reduce motion caps it at reduced', () => {
  const { E } = newGame('mars-station');
  assert.equal(E.Motion.mode({}), 'on', 'on by default');
  assert.equal(E.Motion.mode({ mapMotion: 'off' }), 'off');
  assert.equal(E.Motion.mode({ mapMotion: 'on', motion: 'on' }), 'reduced', 'Reduce motion: on');
  assert.equal(E.Motion.mode({ mapMotion: 'on', motion: 'system' }, true), 'reduced', 'the device asks for less motion');
  assert.equal(E.Motion.mode({ mapMotion: 'on', motion: 'off' }, true), 'on', 'Reduce motion: off overrides the device');
  assert.equal(E.Motion.mode({ mapMotion: 'off', motion: 'on' }), 'off', 'off stays off');
});

test('a seen move walks on the beat that shows it, through the door', async () => {
  const { E, state } = await played();
  const beat0 = drawing(state, 1, { navarro: 'commons', okafor: 'commons' });
  const beat1 = drawing(state, 2, { navarro: 'commons', okafor: 'ops' });
  assert.deepEqual([...E.Motion.moves(state, beat0, beat0)], [], 'nothing new');
  const moves = E.Motion.moves(state, beat0, beat1);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].id, 'okafor');
  assert.deepEqual([...moves[0].path], ['commons', 'ops']);
  // Revealed two beats at once (Next pressed twice before a redraw) still counts.
  assert.equal(E.Motion.moves(state, drawing(state, 1, { okafor: 'commons' }), drawing(state, 3, { okafor: 'ops' })).length, 1);
  // A beat that doesn't show the move: no walk, even if the room changed.
  assert.equal(E.Motion.moves(state, drawing(state, 2, { okafor: 'commons' }), drawing(state, 3, { okafor: 'ops' })).length, 0);
});

test('covert moves never walk', async () => {
  const { E, state } = await played({ covert: true });
  assert.deepEqual([...E.Motion.moves(state, drawing(state, 1, { okafor: 'commons' }), drawing(state, 2, { okafor: 'ops' }))], []);
});

test('undo, a step-in, a load, another place and a reroll place tokens without walking', async () => {
  const { E, state } = await played();
  const a = drawing(state, 1, { okafor: 'commons' }), b = drawing(state, 2, { okafor: 'ops' });
  assert.equal(E.Motion.moves(state, b, a).length, 0, 'back a beat');
  assert.equal(E.Motion.moves(state, a, Object.assign({}, b, { cut: 1 })).length, 0, 'a step-in point chosen');
  assert.equal(E.Motion.moves(state, null, b).length, 0, 'the first drawing (a load)');
  assert.equal(E.Motion.moves(state, a, Object.assign({}, b, { key: 'elsewhere|detailed' })).length, 0, 'another place');
  assert.equal(E.Motion.moves(state, Object.assign({}, a, { turn: state.turn - 1, shown: 3 }), drawing(state, 2, { okafor: 'ops' })).length, 0, 'a new turn starts at its first beat');
});

test('the player walks along their own move', async () => {
  const { E, state } = await played({ playerTo: 'ops' });
  const moves = E.Motion.moves(state, drawing(state, 1, { navarro: 'commons' }, { turn: state.turn - 1 }), drawing(state, 1, { navarro: 'ops' }));
  assert.equal(JSON.stringify(moves.map((m) => [m.id, m.path])), JSON.stringify([['navarro', ['commons', 'ops']]]));
});

test('a path never crosses a room the player has not seen: it fades out at the door, and in at the next', async () => {
  const { E, state } = await played();
  const geom = { rooms: { commons: { x: 0, y: 0 }, suitroom: { x: 100, y: 0 }, garage: { x: 200, y: 0 } }, doors: { 'commons|suitroom': { x: 50, y: 0 }, 'garage|suitroom': { x: 150, y: 0 } } };
  const walk = (seen, start, end) => [...E.Motion.points(geom, { path: ['commons', 'suitroom', 'garage'], seen }, start, end)].map((p) => [p.x, p.o, p.pause]);
  assert.deepEqual(walk([true, true, true], { x: 5, y: 0 }, { x: 205, y: 0 }), [[5, 1, false], [50, 1, true], [100, 1, false], [150, 1, true], [205, 1, false]], 'through both doors, pausing, and the room between');
  assert.deepEqual(walk([true, true, false], { x: 5, y: 0 }, null), [[5, 1, false], [50, 1, true], [100, 1, false], [150, 1, false], [150, 0, false]], 'out of sight: to the door, then gone');
  assert.deepEqual(walk([false, true, true], null, { x: 205, y: 0 }), [[50, 0, false], [50, 1, false], [100, 1, false], [150, 1, true], [205, 1, false]], 'in from an unseen room at its door');
  const across = walk([true, false, true], { x: 5, y: 0 }, { x: 205, y: 0 });
  assert.ok(!across.some(([x]) => x === 100), 'never through the middle of the unseen room');
  assert.deepEqual(across, [[5, 1, false], [50, 1, false], [50, 0, false], [150, 0, false], [150, 1, false], [205, 1, false]]);
  assert.deepEqual(walk([false, false, false], null, null), [], 'nothing seen: nothing moves');
  // The seen flags come from the game: Ops unseen, Okafor walks to its door and is gone.
  state.seenRooms = state.seenRooms.filter((r) => r !== 'ops');
  const m = E.Motion.moves(state, drawing(state, 1, { okafor: 'commons' }), drawing(state, 2, {}))[0];
  assert.equal(JSON.stringify([m.path, m.seen]), JSON.stringify([['commons', 'ops'], [true, false]]));
});

test('doors, features and groups pulse once when they change after a turn, and new features too', async () => {
  const { E, state } = await played();
  const prev = drawing(state, 3, {}, { turn: state.turn - 1, links: { 'a|b': 'door', 'b|c': 'open' }, features: { 'a|camera': 'on', 'a|desk': '' }, groups: { horde: 'calm' } });
  const now = drawing(state, 1, {}, { links: { 'a|b': 'open', 'b|c': 'open', 'c|d': 'door' }, features: { 'a|camera': 'off', 'a|desk': '', 'a|window': '', 'z|crate': '' }, groups: { horde: 'alert', other: 'calm' } });
  const p = E.Motion.pulses(prev, now);
  assert.deepEqual([...p.links], ['a|b'], 'a door that opened; a door first seen is not a change');
  assert.deepEqual([...p.features], ['a|camera', 'a|window'], 'a camera turned off, a new window; a room first seen is not');
  assert.deepEqual([...p.groups], ['horde']);
  assert.equal(JSON.stringify(E.Motion.pulses(prev, Object.assign({}, now, { key: 'elsewhere|detailed' }))), JSON.stringify({ links: [], features: [], groups: [] }), 'another place');
  assert.equal(E.Motion.pulses(now, Object.assign({}, now, { shown: 2 })).links.length, 0, 'reading on in the same turn changes nothing');
});

test('a snapshot reads the tokens as drawn and the state in view', async () => {
  const { E, state } = await played();
  const s = E.Motion.snapshot(state, { key: 'home|detailed', tokens: { commons: [{ id: 'navarro' }, { id: 'bauer' }], ops: [{ id: 'okafor' }] }, inView: ['commons'], shown: 2 });
  assert.deepEqual({ ...s.rooms }, { navarro: 'commons', bauer: 'commons', okafor: 'ops' });
  assert.equal(s.shown, 2);
  assert.ok('commons|ops' in s.links, 'the ways out of a room in view');
  assert.equal(s.turn, state.turn);
});
