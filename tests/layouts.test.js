// The local map (task 3-3): site layout data, deterministic layouts
// (js/layouts.js), seen rooms and where the player last saw everyone. The
// map and the cards show only that, so a covert move never shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, loadEngine, readScenario } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const planOf = (E, state) => E.Layouts.plan(state.locations, { type: state.scenario.site && state.scenario.site.type, seed: `${state.scenario.worldId}:${state.scenario.startId}` });
const intentOf = (obj) => Object.assign({ player: { summary: 'x' }, intents: [], events: [] }, obj);

// ---------- layouts ----------

test('a layout is the same every time, in a fresh engine and after a save round-trip', () => {
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const a = newGame(folder), b = newGame(folder);
    const first = plain(planOf(a.E, a.state));
    assert.deepEqual(plain(planOf(b.E, b.state)), first, `${folder}: fresh engine`);
    const loaded = a.E.Engine.migrate(plain(a.state));
    assert.deepEqual(plain(planOf(a.E, loaded)), first, `${folder}: after a save`);
  }
});

test('people moving never moves the rooms', () => {
  const { E, state } = newGame('zombie-holdout');
  const before = plain(planOf(E, state));
  state.characters.pike.status.location = 'lot';
  state.characters.coleman.status.location = 'roof';
  state.standees.stragglers.location = 'dock';
  assert.deepEqual(plain(planOf(E, state)), before);
});

test('rooms never overlap, and linked rooms on a level share a wall where the link is drawn', () => {
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const { E, state } = newGame(folder);
    const plan = planOf(E, state);
    const rooms = Object.entries(plan.rooms);
    assert.equal(rooms.length, Object.keys(state.locations).length, `${folder}: every room placed`);
    rooms.forEach(([a, r], i) => rooms.slice(i + 1).forEach(([b, o]) => {
      const hit = r.level === o.level && r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
      assert.ok(!hit, `${folder}: ${a} overlaps ${b}`);
    }));
    plan.links.forEach((k) => {
      const a = plan.rooms[k.a], b = plan.rooms[k.b];
      if (a.level !== b.level) return assert.ok(k.remote, `${k.a}–${k.b} crosses levels`);
      assert.ok(!k.remote, `${folder}: ${k.a}–${k.b} has a shared wall`);
      const onEdge = (r) => (k.orient === 'v' ? (k.x === r.x || k.x === r.x + r.w) && k.y > r.y && k.y < r.y + r.h : (k.y === r.y || k.y === r.y + r.h) && k.x > r.x && k.x < r.x + r.w);
      assert.ok(onEdge(a) && onEdge(b), `${folder}: ${k.a}–${k.b} sits on both walls`);
    });
  }
});

test('bundled worlds pick their style and link kinds; levels stack, ground floor first', () => {
  const z = newGame('zombie-holdout');
  const zp = planOf(z.E, z.state);
  assert.equal(zp.style, 'hall');
  const floor = zp.rooms.floor;
  assert.ok(Object.values(zp.rooms).every((r) => r.w * r.h <= floor.w * floor.h), 'the sales floor is the hall');
  assert.equal(zp.links.find((k) => k.a === 'office' && k.b === 'roof').kind, 'hatch');
  assert.equal(zp.links.find((k) => [k.a, k.b].sort().join() === 'dock,lot').kind, 'door');
  assert.deepEqual([...zp.levels.map((b) => b.level)], [0, 1]);
  assert.ok(zp.rooms.roof.y > zp.rooms.floor.y + zp.rooms.floor.h, 'the roof is drawn below the ground floor');
  const m = newGame();
  assert.equal(planOf(m.E, m.state).style, 'corridor');
  assert.equal(planOf(m.E, m.state).rooms.commons.h, 2, 'the Commons is the corridor');
});

// ---------- site data ----------

test('site fields validate; a link is also a connection', () => {
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  const L = (id) => sc.locations.find((l) => l.id === id);
  Object.assign(L('floor'), { size: 'huge', level: 9, features: ['x'.repeat(31)] });
  L('office').links.push({ to: 'attic', kind: 'door' }, { to: 'floor', kind: 'portal' });
  Object.assign(L('stockroom'), { secure: true });
  sc.site = { type: 'castle' };
  sc.localMap = { image: 'maps/store.png', width: 100, height: 100, rooms: { dock: { x: 90, y: 0, w: 20, h: 10 }, cellar: { x: 0, y: 0, w: 1, h: 1 } } };
  assert.throws(() => E.Scenario.validate(sc), (err) => [
    '"size" must be small, medium or large', '"level" must be a whole number', '"features" must be a list',
    'link to unknown room "attic"', 'link to "floor" needs a kind', 'is secure, so it needs exactly one way in (it has 2)',
    '"site" must be {type}', 'localMap: room "dock" needs x, y, w and h inside the image', 'localMap: unknown room "cellar"',
  ].every((m) => err.message.includes(m)));
  const ok = readScenario('zombie-holdout');
  ok.locations.find((l) => l.id === 'roof').connects = [];
  ok.locations.find((l) => l.id === 'office').connects = ['floor'];
  E.Scenario.validate(ok);
  assert.ok(ok.locations.find((l) => l.id === 'office').connects.includes('roof'), 'the hatch link adds the connection');
});

// ---------- what the player knows ----------

test('seen rooms: authored rooms start seen unless they say otherwise; walking in or seeing through an open way reveals them', () => {
  const E = loadEngine();
  const sc = readScenario('zombie-holdout');
  sc.locations.find((l) => l.id === 'lot').seen = false;
  sc.locations.find((l) => l.id === 'roof').seen = false;
  const state = E.Engine.newGame(E.Scenario.validate(sc));
  assert.ok(!state.seenRooms.includes('lot') && !state.seenRooms.includes('roof'));
  state.characters.pike.status.location = 'dock';
  E.Engine.noteSeen(state, null, 1);
  assert.ok(!state.seenRooms.includes('lot'), 'the roller door is shut: a door, not an open way');
  state.characters.pike.status.location = 'office';
  E.Engine.noteSeen(state, null, 2);
  assert.ok(!state.seenRooms.includes('roof'), 'a hatch hides the roof');
  state.characters.pike.status.location = 'roof';
  E.Engine.noteSeen(state, null, 3);
  assert.ok(state.seenRooms.includes('roof'), 'been there');
});

test('a covert move never shows: the card and map keep the last place you saw them', () => {
  const { E, state } = newGame('zombie-holdout');
  assert.deepEqual(plain(E.Engine.knownWhere(state, 'ferris')), { loc: 'office', turn: 0, now: false }, 'everyone starts known; Gil is out of sight');
  assert.equal(E.Engine.knownWhere(state, 'coleman').now, true, 'Dex is with you');
  const res = E.Engine.resolve(state, intentOf({ intents: [{ id: 'coleman', action: 'slips away to the stockroom', visible: false, move_to: 'stockroom' }, { id: 'han', action: 'heads to the dock', visible: true, move_to: 'dock' }] }),
    E.Engine.present(state), 'Look at the windows.', 'moment');
  E.Engine.noteSeen(state, res, 1);
  assert.equal(state.characters.coleman.status.location, 'stockroom');
  assert.deepEqual([E.Engine.knownWhere(state, 'coleman').loc, E.Engine.knownWhere(state, 'coleman').now], ['floor', false], 'Dex slipped away unseen: still on the floor as far as you know');
  assert.deepEqual([E.Engine.knownWhere(state, 'han').loc, E.Engine.knownWhere(state, 'han').turn], ['dock', 1], 'seen leaving for the dock');
});

test('seen and heard events say where people are; hidden ones do not', () => {
  const { E, state } = newGame('zombie-holdout');
  const res = E.Engine.resolve(state, intentOf({ events: [
    { text: 'Marlene calls from the dock.', who: ['ortiz'], where: 'dock', visibility: 'heard', moves: [{ id: 'ortiz', to: 'dock' }] },
    { text: 'Gil slips up to the roof.', who: ['ferris'], where: 'roof', visibility: 'hidden', moves: [{ id: 'ferris', to: 'roof' }] },
  ] }), E.Engine.present(state), 'Wait.', 'hours');
  E.Engine.noteSeen(state, res, 1);
  assert.equal(E.Engine.knownWhere(state, 'ortiz').loc, 'dock');
  assert.equal(E.Engine.knownWhere(state, 'ferris').loc, 'office');
});

test('groups show where you can see them, else where you last saw them', () => {
  const { E, state } = newGame('zombie-holdout');
  state.characters.pike.status.location = 'dock';
  E.Engine.noteSeen(state, null, 1);
  assert.equal(E.Engine.knownWhere(state, 'stragglers').now, false, 'the roller door is shut');
  state.characters.pike.status.location = 'lot';
  E.Engine.noteSeen(state, null, 2);
  assert.deepEqual(plain(E.Engine.knownWhere(state, 'stragglers')), { loc: 'lot', turn: 2, now: true });
  state.standees.stragglers.location = 'dock';
  state.characters.pike.status.location = 'roof';
  E.Engine.noteSeen(state, null, 3);
  assert.equal(E.Engine.knownWhere(state, 'stragglers').loc, 'lot', 'they moved while you were on the roof');
});

test('older saves get every room seen and everyone where they are now', () => {
  const { E, state } = newGame('zombie-holdout');
  const v8 = plain(state);
  v8.version = 8;
  delete v8.seenRooms;
  delete v8.known;
  v8.characters.ferris.status.location = 'roof';
  const up = E.Engine.migrate(v8);
  assert.equal(up.version, E.Engine.STATE_VERSION);
  assert.deepEqual([...up.seenRooms].sort(), Object.keys(up.locations).sort());
  assert.equal(up.known.ferris.loc, 'roof');
});

// ---------- irregular rooms (task 7-2) ----------

test('irregular rooms: a big room, open ground or a corridor may grow into a gap beside it, never over anything, the same every time', () => {
  const { E, state } = newGame('seiryo-high');
  const plan = () => plain(E.Engine.sitePlan(state, 'gate'));
  const p = plan();
  const grown = Object.entries(p.rooms).filter(([, r]) => r.extra);
  assert.ok(grown.length >= 3, 'some of the school grows');
  grown.forEach(([id]) => {
    const l = state.locations[id];
    assert.ok(l.size === 'large' || l.outside || E.Layouts.GROWS.test(l.name), `${id} may grow`);
  });
  const parts = Object.entries(p.rooms).flatMap(([id, r]) => E.Layouts.parts(r).map((x) => Object.assign({ id, level: r.level }, x)));
  parts.forEach((a, i) => parts.slice(i + 1).forEach((b) => {
    const hit = a.level === b.level && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert.ok(!hit, `${a.id} and ${b.id} overlap`);
  }));
  assert.deepEqual(plan(), p, 'seeded: the same every time');
  // A wall shared through a room's growth is a wall: a door can sit on it.
  const a = { x: 0, y: 0, w: 4, h: 3 }, b = { x: 6, y: 0, w: 3, h: 3 };
  assert.ok(!E.Layouts.sharesWall(a, b));
  assert.ok(E.Layouts.sharesWall(Object.assign({}, a, { extra: [{ x: 4, y: 0, w: 2, h: 2 }] }), b));
});

test('a room that grew is drawn as one outline, with no seam where its parts meet', () => {
  const { E, state } = newGame('seiryo-high');
  const plan = E.Engine.sitePlan(state, 'gate');
  const id = Object.keys(plan.rooms).find((k) => plan.rooms[k].extra && !state.locations[k].outside);
  const rooms = { [id]: { name: state.locations[id].name, outside: false, features: [] } };
  const svg = E.SiteDraw.render(plan, rooms, { inView: [id], remembered: [], here: id, seed: 't' });
  assert.match(svg, /<path class="sd-wall-inner" d="M/);
  assert.equal((svg.match(/class="sd-floor"/g) || []).length, 1 + plan.rooms[id].extra.length, 'a floor for each part');
});
