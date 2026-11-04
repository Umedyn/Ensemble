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

// ---------- territory (task A-11) ----------
// The holdout: the Ridge takes the junction, next to Ridge town it holds.
const TAKE = { text: 'Ridge militia trucks roll into the junction and take the crossroads.', scope: 'regional', region: 'junction', visibility: 'heard',
  effects: { control: [{ region: 'junction', to: 'ridge' }], add_tag: [{ region: 'junction', tag: 'checkpoint' }] } };
const SHIFT = '[+0m] You check the boards on the front windows.\n\n[+20m] Gunfire carries from the junction: the Ridge militia has taken the crossroads.\n\n[+40m] Dex swears quietly.';
async function holdout(event, scene = SHIFT) {
  const g = newGame('zombie-holdout');
  g.E.rng = () => 0.0001; // a regional event is due
  mockLLM(g.E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'check', needs_roll: false, move_to: null }, intents: [], events: event ? [event] : [] };
    return kind.startsWith('update') ? { facts: [] } : scene;
  });
  await g.E.Engine.runTurn(g.state, 'I check the windows.', 'hour');
  return g;
}

test('a region change shows on the beat that tells it, and the old holder before', async () => {
  const { E, state } = await holdout(TAKE);
  assert.equal(state.regions.junction.controller, 'ridge', 'the turn has played');
  const sr = E.Engine.sceneRegions(state, 0);
  const c = sr.changes.find((x) => x.region === 'junction');
  assert.ok(c, 'the junction changed');
  assert.equal(JSON.stringify(c.controller), JSON.stringify([null, 'ridge']));
  assert.equal(JSON.stringify(c.tagsAdded), JSON.stringify(['checkpoint']));
  assert.equal(c.beat, 1, 'the beat that names the junction');
  assert.equal(sr.regions.junction.controller, null, 'before that beat, still no one\'s');
  assert.ok(!sr.regions.junction.tags.includes('checkpoint'));
  assert.equal(E.Engine.sceneRegions(state, 1).regions.junction.controller, 'ridge', 'from it on, the Ridge');
  assert.equal(E.Engine.sceneRegions(state, -1).regions.junction.controller, null, 'the turn\'s start');
  // Not named in any beat: the first, as the news says it from the start.
  const quiet = await holdout(TAKE, '[+0m] You check the boards.\n\n[+30m] Dex swears quietly.');
  assert.equal(quiet.E.Engine.sceneRegions(quiet.state, 0).changes.find((x) => x.region === 'junction').beat, 0);
});

test('a hidden event changes nothing on the map, and no change is no change', async () => {
  const hidden = await holdout(Object.assign({}, TAKE, { visibility: 'hidden' }));
  assert.equal(hidden.state.regions.junction.controller, null);
  assert.equal(hidden.E.Engine.sceneRegions(hidden.state, 2).changes.length, 0);
  const none = await holdout(null);
  assert.equal(none.E.Engine.sceneRegions(none.state, 0).changes.length, 0);
  assert.equal(newGame('zombie-holdout').E.Engine.sceneRegions(newGame('zombie-holdout').state, 0), null, 'no scene being read');
});

test('an unknown region, and one found this turn, never animate', async () => {
  const g = newGame('mars-station');
  const tube = 'lava-tube';
  assert.ok(g.state.regions[tube] && g.state.regions[tube].known === false, 'Ares Deep has a hidden lava tube');
  g.E.rng = () => 0.0001;
  mockLLM(g.E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'look', needs_roll: false, move_to: null }, intents: [],
      events: [{ text: 'The lava tube shifts.', scope: 'regional', region: tube, visibility: 'hidden', effects: { add_tag: [{ region: tube, tag: 'collapsed' }] } }] };
    return kind.startsWith('update') ? { facts: [] } : '[+0m] Dust settles.\n\n[+30m] The lava tube groans somewhere below.';
  });
  await g.E.Engine.runTurn(g.state, 'I look around.', 'hour');
  assert.ok(!g.E.Engine.sceneRegions(g.state, 1).changes.some((c) => c.region === tube), 'unknown: nothing shows');
  // Found this turn by an effect: it just appears.
  g.state.pending.pre.regions[tube].known = false;
  g.state.regions[tube].known = undefined;
  g.state.regions[tube].tags.push('found');
  assert.ok(!g.E.Engine.sceneRegions(g.state, 1).changes.some((c) => c.region === tube), 'found: no animation');
});

test('territory plays on the beat just revealed, with the front it sweeps from', async () => {
  const { E, state } = await holdout(TAKE);
  const d = (shown, turn = state.turn) => ({ key: 'level:root', turn, shown, cut: null, rooms: {}, links: {}, features: {}, groups: {} });
  assert.equal(E.Motion.regionChanges(state, d(1, state.turn - 1), d(1)).length, 0, 'first beat: not yet');
  const ch = E.Motion.regionChanges(state, d(1), d(2));
  assert.equal(ch.length, 1);
  assert.equal(ch[0].region, 'junction');
  assert.equal(E.Motion.regionChanges(state, d(2), d(1)).length, 0, 'back a beat');
  assert.equal(E.Motion.regionChanges(state, d(1), Object.assign(d(2), { cut: 1 })).length, 0, 'a step-in');
  assert.equal(E.Motion.regionChanges(state, d(1), Object.assign(d(2), { key: 'home|detailed' })).length, 1, 'whichever map is up');
  assert.equal(E.Motion.front(state, 'junction', 'ridge'), 'ridge-town', 'from Ridge town, which the Ridge holds');
  assert.equal(E.Motion.front(state, 'junction', 'convoy'), null, 'the convoy holds nothing next door: a crossfade');
  assert.equal(E.Motion.level(state, ['junction']), null, 'drawn on the world');
  assert.equal(E.Motion.level(state, ['main-street', 'residential']), 'town', 'inside the town');
});

test('outlines: resampled evenly, and morphed without twisting', () => {
  const { E } = newGame('mars-station');
  const G = E.Geo;
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const r = G.resample(square, 8);
  assert.equal(r.length, 8);
  assert.equal(JSON.stringify(r), JSON.stringify([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]), 'every 5 units along the edge');
  assert.equal(G.resample(square.concat([[0, 0]]), 4).length, 4, 'a closed ring is the same ring');
  // A triangle to a wider square, opposite winding: same count both ends.
  const tri = [[0, 0], [0, 12], [12, 0]];
  const f = G.morph(square, tri, 12);
  assert.equal(f(0).length, 12);
  assert.equal(JSON.stringify(f(0)), JSON.stringify(G.resample(square, 12)), 't = 0 is the first');
  const end = f(1);
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
  G.resample(tri.slice().reverse(), 12).forEach((p) => assert.ok(end.some((q) => near(p, q)), 't = 1 is the second, resampled'));
  assert.ok(Math.hypot(end[0][0], end[0][1]) < 41 / 12, 'started next to where the first starts, so it does not twist');
  const half = f(0.5);
  half.forEach((p, i) => { assert.ok(near(p, [(f(0)[i][0] + end[i][0]) / 2, (f(0)[i][1] + end[i][1]) / 2])); });
  assert.ok(G.area(half) > 0);
});
