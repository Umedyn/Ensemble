// The creator's DOM-free parts (task 3-5): the store-only zip it exports,
// map editing (ids, neighbours from shared edges, vertex edits, renaming and
// deleting regions with their references), and the world map renderer the
// game and the creator share.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { newGame, loadEngine, worldFiles } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const E = loadEngine();

// ---------- zip ----------

test('CRC-32 matches the standard check value', () => {
  assert.equal(E.Zip.crc32(E.Zip.utf8('123456789')), 0xcbf43926);
});

test('a zip round-trips its entries, names in UTF-8, and is the same every time', () => {
  const entries = [
    { name: 'world/world.json', data: E.Zip.utf8('{"title":"Café"}\n') },
    { name: 'world/maps/town.svg', data: new Uint8Array([60, 115, 118, 103, 62]) },
    { name: 'world/characters/zoë.json', data: E.Zip.utf8('{}') },
  ];
  const zip = E.Zip.build(entries);
  assert.deepEqual([...E.Zip.build(entries)], [...zip], 'deterministic');
  const back = [...E.Zip.read(zip)];
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  assert.equal(E.Zip.text(back[0].data), '{"title":"Café"}\n');
  assert.deepEqual([...back[1].data], [60, 115, 118, 103, 62]);
  // Node's own CRC agrees, when it has one.
  if (zlib.crc32) assert.equal(E.Zip.crc32(entries[0].data), zlib.crc32(Buffer.from(entries[0].data)));
  zip[30 + 16 + 3] ^= 0xff; // damage the first file's data (after its 30-byte header and 16-byte name)
  assert.throws(() => E.Zip.read(zip), /damaged/);
});

// ---------- map editing ----------

test('region ids come from names and never clash', () => {
  assert.equal(E.MapEdit.slug('The Old Quarter'), 'old-quarter');
  assert.equal(E.MapEdit.slug('Docks', ['docks', 'docks-2']), 'docks-3');
  assert.equal(E.MapEdit.slug('!!!'), 'region');
});

test('neighbours are suggested where outlines touch', () => {
  const map = { regions: {
    a: { polygon: [[0, 0], [100, 0], [100, 100], [0, 100]] },
    b: { polygon: [[104, 0], [200, 0], [200, 100], [104, 100]] }, // 4px gap: touching
    c: { polygon: [[300, 300], [400, 300], [400, 400]] }, // far away
    d: { point: [101, 50] }, // points never count
  } };
  assert.deepEqual(plain(E.MapEdit.suggestNeighbours(map)), [['a', 'b']]);
  assert.deepEqual(plain(E.MapEdit.suggestNeighbours(map, 2)), [], 'tighter tolerance');
  const town = worldFiles('zombie-holdout')['world.json'];
  const s = plain(E.MapEdit.suggestNeighbours(town.map)).map((p) => p.join('|'));
  assert.ok(s.includes('highway-strip|junction') && s.includes('junction|ridge-town') && s.includes('highway-strip|residential'), 'the bundled town map');
});

test('hit tests and vertex edits', () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.ok(E.MapEdit.inPolygon([50, 50], sq) && !E.MapEdit.inPolygon([150, 50], sq));
  assert.equal(E.MapEdit.regionAt({ regions: { a: { polygon: sq }, p: { point: [300, 300] } } }, [310, 300]), 'p');
  const e = E.MapEdit.nearestEdge(sq, [50, 103]);
  assert.deepEqual([e.index, e.dist], [2, 3]);
  assert.deepEqual(plain(E.MapEdit.insertVertex(sq, 2, [50.4, 103.6])), [[0, 0], [100, 0], [100, 100], [50, 104], [0, 100]]);
  assert.equal(E.MapEdit.removeVertex(sq, 0).length, 3);
  assert.equal(E.MapEdit.removeVertex(sq.slice(0, 3), 0).length, 3, 'never below a triangle');
});

test('renaming a region moves every reference; deleting one cleans them up', () => {
  const f = worldFiles('zombie-holdout');
  const world = f['world.json'];
  const starts = { herd: f['starts/herd.json'] };
  E.MapEdit.renameRegion(world, starts, 'highway-strip', 'strip', f);
  assert.ok(world.map.regions.strip && !world.map.regions['highway-strip']);
  const stripLore = () => f['lore/town.json'].find((e) => e.id === 'highway-strip');
  assert.equal(stripLore().ref, 'strip', 'region lore in lore/ files follows the rename');
  const pumps = () => world.timeline.find((ev) => ev.id === 'pumps-dry');
  assert.equal(pumps().region, 'strip', 'and so do timeline events');
  assert.equal(starts.herd.region, 'strip');
  assert.ok(world.regions.find((r) => r.id === 'junction').neighbours.includes('strip'));
  const notes = E.MapEdit.deleteRegion(world, starts, 'strip', f);
  assert.ok(!world.regions.some((r) => r.id === 'strip' || (r.neighbours || []).includes('strip')));
  assert.ok(!world.map.regions.strip);
  assert.equal(starts.herd.region, 'main-street', 'falls back to the first region left');
  assert.deepEqual([...notes], ['start "herd" now starts in main-street', 'lore "highway-strip" is now a topic (it only comes up by its keywords)', 'timeline "pumps-dry" now happens in main-street']);
  assert.equal(pumps().region, 'main-street');
  // A precondition about who holds a region follows a rename and goes with a delete.
  const convoy = () => world.timeline.find((ev) => ev.id === 'convoy-checkpoint');
  E.MapEdit.renameRegion(world, starts, 'junction', 'crossing', f);
  assert.equal(convoy().preconditions[0].controls.region, 'crossing');
  assert.ok(E.MapEdit.deleteRegion(world, starts, 'crossing', f).includes('timeline "convoy-checkpoint" lost a precondition about who holds crossing'));
  assert.equal(convoy().preconditions.length, 0);
  assert.equal(stripLore().level, 'topic', 'the lore text is kept');
  assert.equal(stripLore().ref, undefined);
  // The edited world still loads.
  const w = E.Scenario.prepareWorld('zombie-holdout', Object.assign({}, f, { 'world.json': world, 'starts/herd.json': starts.herd }));
  assert.ok(w.starts[0].scenario, w.starts[0].error);
});

test('neighbour links are set both ways', () => {
  const world = plain(worldFiles('mars-station')['world.json']);
  E.MapEdit.setNeighbour(world, 'station', 'relay-mast', true);
  assert.ok(E.MapEdit.areNeighbours(world, 'relay-mast', 'station'));
  E.MapEdit.setNeighbour(world, 'relay-mast', 'station', false);
  assert.ok(!E.MapEdit.areNeighbours(world, 'station', 'relay-mast'));
});

// ---------- the shared renderer ----------

test('the world map renderer shows public state only: names, who holds what, tags', () => {
  const { E: G, state } = newGame('zombie-holdout');
  const g = G.MapDraw.geometry(state.scenario.regions, state.scenario.map, state.scenario.worldId);
  state.regions.junction.controller = 'convoy';
  const svg = G.MapDraw.worldSvg({ g, regions: state.scenario.regions, now: state.regions, factions: state.factions, mine: 'highway-strip', imageUrl: 'x.svg' });
  assert.match(svg, /data-region="junction" aria-label="Highway junction, held by Coastal rescue convoy"><polygon class="region-shape fc-2/);
  assert.match(svg, /region-shape none none here/, 'your region, held by no one');
  assert.match(svg, />fortified</);
  assert.doesNotMatch(svg, /walled off|trucks seen/, 'lore and status stay in the info strip');
  // The creator draws the definitions (no runtime state) with the same code.
  const def = G.MapDraw.worldSvg({ g, regions: state.scenario.regions, factions: state.factions });
  assert.match(def, /data-region="ridge-town" aria-label="Ridge, held by The Ridge"><polygon class="region-shape fc-1/);
});
