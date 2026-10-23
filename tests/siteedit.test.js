// Site maps drawn on images and the shared library (task 6-3): the format and
// its checks, measuring from the grid, spots, the library and matching,
// playing a drawn map, keeping a generated site as a map, and the image map
// with fog. The Sites tab's editing logic (js/siteedit.js) is at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { loadEngine, loadLibrary, readWorld, worldFiles, mockLLM, ROOT } = require('./helpers');
const { replies, stepOf } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));
const E = loadEngine();
const ST = E.Sites;
const diner = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'library', 'sites', 'diner.json'), 'utf8'));

// ---------- the format ----------

test('the bundled diner is a valid drawn map, with no warnings', () => {
  assert.deepEqual(plain(ST.mapProblems(diner(), 'diner')), []);
  assert.deepEqual(plain(ST.mapWarnings(diner(), 'diner')), []);
});

test('the image layer is checked: shapes, doors, spots, the grid and setting', () => {
  const m = diner();
  m.rooms[1].shape = [[0, 0], [900, 0], [900, 10]];
  m.rooms[0].links[0].at = [-5, 380];
  m.spots.push({ kind: 'treasure', room: 'kitchen' }, { kind: 'cover', room: 'attic' });
  m.grid = { square: 0 };
  m.setting = 'modern';
  const p = ST.mapProblems(m, 'diner').join('\n');
  assert.match(p, /room "dining-room": "shape" needs at least 3 points inside the image/);
  assert.match(p, /the door to "dining-room" must be "at" a point inside the image/);
  assert.match(p, /a spot's "kind" must be one of guard post, cover, hide, loot, spawn/);
  assert.match(p, /spot in unknown room "attic"/);
  assert.match(p, /"grid" must be/);
  assert.match(p, /"setting" must be a list/);
  const n = diner();
  delete n.image;
  assert.match(ST.mapProblems(n, 'diner').join('\n'), /"shape" needs at least 3 points inside the image/, 'shapes need the image');
});

test('the author is warned about a secure room with two ways in, overlapping shapes and doors between rooms that don\'t touch', () => {
  const m = diner();
  m.rooms.find((r) => r.id === 'storeroom').secure = true;
  m.rooms.find((r) => r.id === 'restroom').shape = [[100, 100], [300, 100], [300, 250], [100, 250]];
  m.rooms.find((r) => r.id === 'kitchen').links.push({ to: 'restroom', kind: 'door' });
  const w = ST.mapWarnings(m, 'diner').join('\n');
  assert.match(w, /room "storeroom" is secure \(one way in\) but has 3 ways in/);
  assert.match(w, /rooms "dining-room" and "restroom" overlap/);
  assert.match(w, /rooms "kitchen" and "restroom" are joined by a door, but their shapes don't touch/);
  assert.deepEqual(plain(ST.mapProblems(m, 'diner')), [], 'warnings never stop a map loading');
});

test('the grid measures rooms for the narrator; it is never squares to move on', () => {
  const grid = { square: 50, unit: '5 ft' };
  const dining = diner().rooms.find((r) => r.id === 'dining-room').shape;
  assert.equal(ST.dims(dining, grid), 'about 50 × 25 ft');
  assert.equal(ST.roomSize(dining, grid), 'large');
  assert.equal(ST.roomSize([[0, 0], [150, 0], [150, 150], [0, 150]], grid), 'small');
  assert.equal(ST.dims(dining, { square: 100, unit: '2 m' }), 'about 10 × 4 m');
  assert.equal(ST.dims(dining, null), null);
});

test('a door goes where the link says, else in the middle of the edge two rooms share', () => {
  const m = diner();
  assert.deepEqual(plain(ST.doorAt(m, 'parking-lot', 'dining-room')), [280, 380]);
  assert.deepEqual(plain(ST.doorAt(m, 'dining-room', 'kitchen')), [520, 220]);
  assert.deepEqual(plain(ST.doorAt(m, 'kitchen', 'dining-room')), [520, 220], 'from either side');
  assert.equal(ST.doorAt(m, 'restroom', 'storeroom'), null, 'shapes that don\'t touch');
});

// ---------- the library ----------

test('the shared library loads, and only worlds that ask for its setting get its maps, after their own', () => {
  const L = loadEngine();
  const lib = loadLibrary(L);
  assert.deepEqual(plain(lib.errors), []);
  assert.deepEqual(Object.keys(lib.maps).sort(), ['chop-shop', 'diner']);
  const zh = readWorld('zombie-holdout', L).starts[0].scenario;
  assert.deepEqual(Object.keys(zh.siteMaps), ['diner'], 'modern only: no cyberpunk chop shop in Harmon');
  assert.equal(zh.siteMaps.diner.library, true);
  assert.equal(readWorld('mars-station', L).starts[0].scenario.siteMaps, undefined, 'no generated sites, no library');
  // The chrome district has its own chop shop: its own wins over the shared one.
  const f = worldFiles(path.join(__dirname, 'fixtures', 'chrome-district'));
  f['world.json'].generatedSites.library = ['cyberpunk'];
  const cd = L.Scenario.prepareWorld('chrome', f).starts[0].scenario;
  assert.ok(!cd.siteMaps['chop-shop'].library, 'the world\'s own map, not the library copy');
});

test('an index entry that doesn\'t match a valid map is refused', () => {
  const out = E.Scenario.buildLibrary({ sites: [{ id: 'diner' }, { id: 'ghost' }, { id: 'broken' }] }, { diner: diner(), broken: { id: 'broken' } });
  assert.deepEqual(Object.keys(out.maps), ['diner']);
  assert.match(out.errors.join('\n'), /missing sites\/ghost\.json[\s\S]*sites\/broken\.json: needs a "type"/);
  assert.match(E.Scenario.buildLibrary({}, {}).errors[0], /"sites" list/);
  assert.deepEqual(plain(E.Scenario.libraryEntry(diner())), { id: 'diner', name: 'Roadside diner', type: 'diner', tags: ['restaurant', 'cafe', 'truck stop', 'roadside'], setting: ['modern'], rooms: 5 });
});

test('matching: a world\'s own maps first, then shared ones; the same pick every time', () => {
  const own = Object.assign(diner(), { id: 'harmon-diner' });
  const sc = { siteMaps: { diner: Object.assign(diner(), { library: true }), 'harmon-diner': own } };
  assert.deepEqual(plain(ST.libraryFits(sc, 'diner on Route 9').map((m) => m.id)), ['harmon-diner']);
  delete sc.siteMaps['harmon-diner'];
  assert.equal(ST.libraryMatch(sc, 'truck stop', 'x').id, 'diner', 'a tag matches');
  assert.equal(ST.libraryMatch(sc, 'cafes', 'x').id, 'diner', 'plurals too');
  assert.equal(ST.libraryMatch(sc, 'hospital', 'x'), null);
  assert.equal(ST.libraryMatch(sc, 'diner', 'a').id, ST.libraryMatch(sc, 'diner', 'a').id);
});

test('generatedSites.library is checked', () => {
  const f = worldFiles('zombie-holdout');
  f['world.json'].generatedSites.library = 'modern';
  assert.throws(() => E.Scenario.prepareWorld('zombie-holdout', f), /"library" must be a list of setting tags/);
});

// ---------- playing a drawn map ----------

function playDiner(over) {
  const L = loadEngine();
  loadLibrary(L);
  const state = L.Engine.newGame(L.Scenario.startScenario(readWorld('zombie-holdout', L)));
  const r = replies(over);
  const calls = mockLLM(L, (call) => {
    const step = stepOf(call.user);
    if (step) { const v = r[step]; return typeof v === 'function' ? v(call.user, call) : v; }
    if (call.kind === 'intent') return { player: { summary: 'go', new_place: { name: 'the diner', kind: 'diner', region: 'main-street' } }, intents: [], events: [] };
    if (call.kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    return '[+0m] You cross the lot to the diner.';
  });
  return { L, state, calls, run: () => L.Engine.runTurn(state, 'I head to the diner on Main Street.', 'hour') };
}

test('a story heading to a diner uses the shared drawn map: shapes, sizes, measurements and spots as features', async () => {
  const g = playDiner({ siteOccupants: { people: [{ name: 'Rita Kwan', role: 'diner owner holed up', note: 'counts the cans every night' }],
    groups: [{ label: 'the dead', count: 3, room: 'kitchen', state: 'calm' }], note: 'Cans in the storeroom.' } });
  await g.run();
  assert.deepEqual(g.calls.map((c) => c.kind).slice(0, 2), ['intent', 'worldbuild (site people: the diner)'], 'no layout call');
  const s = g.state.sites.diner;
  assert.equal(s.map, 'diner');
  const dining = g.state.locations['dining-room'];
  assert.equal(dining.site, 'diner');
  assert.equal(dining.shape.length, 4, 'the shape comes along for the image map');
  assert.equal(dining.size, 'large', 'size from the area');
  assert.equal(g.state.locations.restroom.size, 'small', 'the author\'s size wins');
  assert.match(dining.desc, /dead jukebox \(about 50 × 25 ft\)\.$/);
  assert.ok(dining.features.includes('booths'), 'a cover spot is a feature');
  assert.ok(g.state.locations.storeroom.features.includes('canned goods'));
  assert.ok(!JSON.stringify(g.state.locations['parking-lot'].features || []).includes('spawn'), 'a spawn point is not a feature');
  assert.equal(g.state.extras['rita-kwan'].location, 'parking-lot', 'someone the model didn\'t place starts at the spawn point');
  assert.deepEqual(plain(g.state.locations['parking-lot'].links.find((k) => k.to === 'dining-room')), { to: 'dining-room', kind: 'door', at: [280, 380] });
  assert.equal(ST.imageMap(g.state, 'diner').image, 'sites/diner.svg');
  assert.ok(g.calls[1].user.includes('booths'), 'the people step sees the spots');
});

test('a group put in a room the map marks as a guard post holds it', async () => {
  const L = loadEngine();
  const m = diner();
  m.spots.push({ kind: 'guard post', room: 'kitchen', at: [600, 200] });
  L.Scenario.library = L.Scenario.buildLibrary({ sites: [{ id: 'diner' }] }, { diner: m });
  const state = L.Engine.newGame(L.Scenario.startScenario(readWorld('zombie-holdout', L)));
  const built = L.Sites.fromMap(state, L.Scenario.library.maps.diner, 'diner');
  assert.deepEqual(plain(built.posts), ['kitchen']);
  const occ = L.Sites.checkOccupants(state, { groups: [{ label: 'raiders', count: 2, room: 'kitchen', state: 'alert' }, { label: 'the dead', count: 2, room: 'storeroom' }] }, built, 'diner', true);
  assert.equal(occ.standees[0].post, 'kitchen');
  assert.equal(occ.standees[1].post, undefined);
});

// ---------- keeping a generated site ----------

test('a site generated in play becomes a map without its route, people, live state or what play inferred', async () => {
  const L = loadEngine();
  const state = L.Engine.newGame(L.Scenario.startScenario(readWorld('zombie-holdout', L)));
  const r = replies();
  mockLLM(L, (call) => {
    const step = stepOf(call.user);
    if (step) return r[step];
    if (call.kind === 'intent') return { player: { summary: 'go', new_place: { name: 'the pharmacy', kind: 'pharmacy', region: 'main-street' } }, intents: [], events: [] };
    if (call.kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    return '[+0m] You go.';
  });
  await L.Engine.runTurn(state, 'I head to the pharmacy on Main Street for antibiotics.', 'hour');
  state.locations.storefront.features = (state.locations.storefront.features || []).concat([{ name: 'back window', inferred: true }]);
  state.locations.storefront.links.push({ to: 'drug-room', kind: 'window', inferred: true });
  state.locations.storefront.connects.push('drug-room');
  const m = L.Sites.toMap(state, 'pharmacy');
  assert.equal(m.id, 'pharmacy');
  assert.equal(m.type, 'pharmacy');
  assert.deepEqual(plain(m.rooms.map((x) => x.id)), ['storefront', 'behind-counter', 'drug-room']);
  const all = JSON.stringify(m);
  assert.ok(!/route|inferred|back window|"site"|"seen"|dale/i.test(all), all);
  assert.ok(!m.rooms[0].connects || !m.rooms[0].connects.includes('drug-room'));
  assert.equal(m.entry, 'storefront');
  // Filled in by the author, it is a valid map.
  Object.assign(m, { credit: 'me', license: 'CC0-1.0' });
  assert.deepEqual(plain(L.Sites.mapProblems(m, 'pharmacy')), []);
  assert.throws(() => L.Sites.toMap(state, 'nowhere'), /never built/);
});

// ---------- the image map in play ----------

test('the image map shows only rooms the player knows; unknown ones get a "?" past the door', () => {
  const m = diner();
  const rooms = {};
  m.rooms.forEach((r) => (rooms[r.id] = { name: r.name, shape: r.shape, outside: !!r.outside }));
  const links = [{ a: 'parking-lot', b: 'dining-room', kind: 'door', at: [280, 380] }, { a: 'dining-room', b: 'kitchen', kind: 'locked door' }, { a: 'kitchen', b: 'storeroom', kind: 'door' }];
  const svg = E.SiteDraw.renderImage({ url: 'sites/diner.svg', width: 800, height: 500 }, rooms, {
    inView: ['dining-room'], remembered: ['parking-lot'], here: 'dining-room', links, seed: 'diner',
    tokens: { 'dining-room': [{ id: 'pike' }], kitchen: [{ id: 'ghost' }] }, tokenSvg: (t) => `<g data-tok="${t.id}"></g>`,
  });
  assert.match(svg, /<image href="sites\/diner.svg"[^>]*mask="url\(#sdmask-diner\)"/);
  assert.match(svg, /data-room="dining-room"/);
  assert.match(svg, /class="map-room sd-remembered outside" [^>]*data-room="parking-lot"/);
  assert.ok(!/data-room="kitchen"|Kitchen|Storeroom|data-room="restroom"/.test(svg), 'unknown rooms are not drawn or named');
  assert.equal((svg.match(/sd-img-unknown/g) || []).length, 1, 'one "?" past the locked door to the kitchen');
  assert.match(svg, /sd-img-locked-door/);
  assert.equal((svg.match(/<polygon/g) || []).length, 4, 'two rooms in the mask, two drawn');
  assert.match(svg, /data-tok="pike"/);
  assert.ok(!/ghost/.test(svg), 'no token in a room the player doesn\'t know');
});

// ---------- the Sites tab's editing (js/siteedit.js) ----------

const SE = E.SiteEdit;

test('a map drawn from nothing: rooms, a door on the shared edge, an entrance, a spot; saved to the world only when valid', () => {
  const files = worldFiles('zombie-holdout');
  const id = SE.newMap(files, 'Old Tavern');
  assert.equal(id, 'old-tavern');
  const m = files['sites/old-tavern.json'];
  assert.ok(!(files['world.json'].sites || []).includes(id), 'a draft until saved');
  E.Scenario.prepareWorld('zombie-holdout', plain(files));
  SE.setImage(m, 'sites/old-tavern.png', 600, 400);
  const hall = SE.addRoom(m, 'Common Room', [[0, 0], [400, 0], [400, 400], [0, 400]]);
  const cellar = SE.addRoom(m, 'Cellar', [[400, 0], [600, 0], [600, 200], [400, 200]]);
  assert.equal(m.entry, 'common-room', 'the first room is the way in until changed');
  assert.equal(SE.roomAt(m, [100, 100]), 'common-room');
  const edge = SE.edgeAt(m, [401, 120], 10);
  assert.deepEqual([edge.a, edge.b].sort(), ['cellar', 'common-room']);
  assert.deepEqual(plain(edge.at), [401, 120]);
  SE.setLink(m, edge.a, edge.b, 'locked door', edge.at);
  const k = plain(SE.link(m, 'common-room', 'cellar'));
  assert.deepEqual([k.kind, k.at], ['locked door', [401, 120]]);
  SE.setLink(m, 'common-room', 'cellar', 'door');
  assert.equal(SE.links(m).length, 1, 'one link, whichever side');
  assert.deepEqual(plain(SE.link(m, 'cellar', 'common-room').at), [401, 120], 'its place is kept');
  assert.deepEqual(plain(SE.edgeAt(m, [0, 300], 10)), { room: 'common-room', at: [0, 300] });
  SE.addEntrance(m, 'common-room', [0, 300]);
  SE.addSpot(m, 'loot', 'cellar', [500, 100]);
  assert.match(SE.saveToWorld(files, id).error, /needs a "type"[\s\S]*credit/);
  Object.assign(m, { type: 'tavern', tags: ['inn', 'pub'], setting: ['modern'], credit: 'me', license: 'CC0-1.0' });
  m.rooms.forEach((r) => (r.desc = `The ${r.name.toLowerCase()}.`));
  assert.deepEqual(plain(SE.saveToWorld(files, id)), {});
  assert.ok(files['world.json'].sites.includes(id));
  const sc = E.Scenario.prepareWorld('zombie-holdout', plain(files)).starts[0].scenario;
  assert.ok(sc.siteMaps['old-tavern']);
  assert.equal(E.Sites.libraryMatch(sc, 'the tavern by the river', 'x').id, 'old-tavern', 'the lookup picks it');
  SE.removeRoom(m, hall);
  assert.ok(!JSON.stringify(m).includes('common-room'), 'every reference goes with the room');
  assert.equal(m.entry, cellar);
  SE.removeMap(files, id);
  assert.ok(!files['sites/old-tavern.json'] && !(files['world.json'].sites || []).includes(id));
});

test('snapping to the grid is a drawing aid, off unless asked', () => {
  assert.deepEqual(plain(SE.snap([123.4, 76], { square: 50 }, true)), [100, 100]);
  assert.deepEqual(plain(SE.snap([123.4, 76], { square: 50 }, false)), [123, 76]);
  assert.deepEqual(plain(SE.snap([123.4, 76], null, true)), [123, 76]);
});

test('a new image scales everything drawn on the old one', () => {
  const m = diner();
  SE.setImage(m, 'sites/diner-big.png', 1600, 1000);
  assert.deepEqual(plain(m.rooms[1].shape[1]), [1040, 280]);
  assert.deepEqual(plain(m.rooms[0].links[0].at), [560, 760]);
  assert.deepEqual(plain(m.spots[0].at), [260, 480]);
  assert.equal(m.grid.square, 100);
  assert.deepEqual(plain(ST.mapProblems(m, 'diner')), []);
});

test('a copy of a shared map gets its own id and image path; the library export is a folder the game reads', () => {
  const L = loadEngine();
  loadLibrary(L);
  const files = worldFiles('zombie-holdout');
  const id = L.SiteEdit.addCopy(files, L.Scenario.library.maps.diner);
  assert.equal(id, 'diner-2', 'not the shared id');
  assert.equal(files['sites/diner-2.json'].image, 'sites/diner-2.svg');
  assert.ok(!('library' in files['sites/diner-2.json']));
  const out = L.SiteEdit.libraryFiles(files['sites/diner-2.json']);
  const lib = L.Scenario.buildLibrary(out['index.json'], { 'diner-2': out['sites/diner-2.json'] });
  assert.deepEqual(plain(lib.errors), []);
  assert.deepEqual(Object.keys(lib.maps), ['diner-2']);
});

test('the matching box: the world\'s maps and the draft first, shared ones for the setting after', () => {
  const L = loadEngine();
  loadLibrary(L);
  const files = worldFiles('zombie-holdout');
  assert.deepEqual(plain(L.SiteEdit.testMatch(files, 'diner', ['modern'])), { fits: [{ id: 'diner', name: 'Roadside diner', library: true }], pick: 'diner', seed: 'diner' });
  assert.equal(L.SiteEdit.testMatch(files, 'diner', ['fantasy']).pick, null, 'another setting: nothing shared');
  const id = L.SiteEdit.addCopy(files, L.Scenario.library.maps.diner);
  assert.equal(L.SiteEdit.testMatch(files, 'diner', ['modern'], id).pick, id, 'the draft being edited wins over the shared one');
  assert.equal(L.SiteEdit.testMatch(files, 'diner', ['modern']).pick, 'diner', 'a draft not shown is not in the world');
});

test('a save file lists the sites built in it, and one is kept as a draft map', async () => {
  const L = loadEngine();
  const state = L.Engine.newGame(L.Scenario.startScenario(readWorld('zombie-holdout', L)));
  const r = replies();
  mockLLM(L, (call) => {
    const step = stepOf(call.user);
    if (step) return r[step];
    if (call.kind === 'intent') return { player: { summary: 'go', new_place: { name: 'the pharmacy', kind: 'pharmacy', region: 'main-street' } }, intents: [], events: [] };
    if (call.kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    return '[+0m] You go.';
  });
  await L.Engine.runTurn(state, 'I head to the pharmacy on Main Street for antibiotics.', 'hour');
  const save = JSON.parse(JSON.stringify(state));
  const found = L.SiteEdit.savedSites(save);
  assert.deepEqual(plain(found.sites), [{ id: 'pharmacy', name: 'the pharmacy', kind: 'pharmacy', rooms: 3 }]);
  const files = worldFiles('zombie-holdout');
  const id = L.SiteEdit.fromSave(files, found.state, 'pharmacy');
  assert.equal(id, 'pharmacy');
  assert.ok(files['sites/pharmacy.json'] && !(files['world.json'].sites || []).includes('pharmacy'), 'a draft to finish');
});
