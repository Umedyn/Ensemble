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

// ---------- lore and timeline editing (task 5-3) ----------

const LE = E.LoreEdit;
const loads = (folder, files) => E.Scenario.prepareWorld(folder, plain(files)).starts.every((s) => s.scenario);

test('lore items come from world.json, lore/ files (packets and single entries) and starts, grouped by what they are about', () => {
  const f = plain(worldFiles('zombie-holdout'));
  f['world.json'].lore.push('single');
  f['lore/single.json'] = { title: 'Single', level: 'topic', text: 'One entry in its own file.' };
  f['starts/herd.json'].lore = [{ id: 'herd-note', title: 'Herd', level: 'region', ref: 'junction', text: 'Only in this start.' }];
  const items = LE.loreItems(f);
  assert.equal(items.find((x) => x.entry.id === 'the-dead').file, 'lore/town.json');
  assert.equal(items.find((x) => x.entry.id === 'single').index, null);
  assert.equal(items.find((x) => x.entry.id === 'herd-note').file, 'starts/herd.json');
  const groups = LE.loreGroups(f);
  const group = (level, ref) => groups.find((g) => g.level === level && g.ref === (ref || null));
  const ids = (g) => [...g.items].map((x) => x.entry.id);
  assert.deepEqual(ids(group('world')), ['the-dead']);
  assert.deepEqual(ids(group('region', 'junction')), ['junction', 'herd-note']);
  assert.ok(group('region', 'residential'), 'every region has a group, even an empty one');
  assert.deepEqual(ids(group('location', 'roof')), ['the-roof']);
  assert.deepEqual(ids(group('character', 'ferris')), ['ferris-store']);
  assert.deepEqual(ids(group('topic')), ['evacuation', 'single']);
});

test('adding, re-levelling, keywords and removing lore keep the world loadable', () => {
  const f = plain(worldFiles('zombie-holdout'));
  const id = LE.addLore(f, 'region', 'junction');
  const e = LE.findLore(f, id).entry;
  assert.deepEqual([e.level, e.ref, LE.findLore(f, id).file], ['region', 'junction', 'world.json']);
  assert.ok(loads('zombie-holdout', f), 'a new entry is valid as it is');
  LE.addKeywords(e, 'Overpass, checkpoint, overpass ,  ');
  assert.deepEqual([...e.keywords], ['Overpass', 'checkpoint'], 'split on commas, no repeats in any case');
  LE.setLevel(f, e, 'topic');
  assert.equal(e.ref, undefined, 'topics have no ref');
  LE.setLevel(f, e, 'character');
  assert.equal(e.ref, 'pike', 'the first person');
  e.alwaysOn = true;
  LE.setLevel(f, e, 'location');
  assert.equal(e.alwaysOn, undefined, 'always-on is for world entries only');
  assert.ok(loads('zombie-holdout', f));
  // Removing: inline, from a packet, and a single-entry file with its id.
  assert.ok(LE.removeLore(f, id) && !LE.findLore(f, id));
  assert.ok(LE.removeLore(f, 'the-roof'));
  assert.ok(!f['lore/store.json'].some((x) => x.id === 'the-roof'));
  f['world.json'].lore.push('single');
  f['lore/single.json'] = { title: 'Single', level: 'topic', text: 'One entry in its own file.' };
  assert.ok(LE.removeLore(f, 'single'));
  assert.ok(!f['lore/single.json'] && !f['world.json'].lore.includes('single'));
  assert.ok(loads('zombie-holdout', f));
});

test('the lore test box shows what the game would include for a room and an action, with tokens and the budget', () => {
  const f = plain(worldFiles('zombie-holdout'));
  const at = (room, action, scene) => LE.testSelection(f, 'zombie-holdout', { room, action, scene });
  const roof = at('roof', 'Ask about the evacuation buses.');
  assert.deepEqual([...roof.picks].map((p) => p.id), ['the-roof', 'highway-strip', 'evacuation']);
  assert.match(roof.picks[2].why, /"evacuation" in the action/);
  assert.equal(roof.used, roof.picks.reduce((n, p) => n + p.tokens, 0));
  assert.ok(roof.budget > 0);
  assert.deepEqual([...roof.always].map((a) => a.id), ['the-dead']);
  assert.ok(at('floor', '', 'Smoke rises over Main Street.').picks.some((p) => p.id === 'main-street' && /last scene/.test(p.why)));
  f['world.json'].lore.push({ id: 'broken', title: 'Broken', level: 'galaxy', text: 'x' });
  assert.match(at('roof', '').error, /lore "broken"/);
});

test('timeline events split at the start, are added after the latest, and a rename moves the conditions that know them', () => {
  const f = plain(worldFiles('zombie-holdout'));
  const { past, future } = LE.splitEvents(f);
  assert.deepEqual([...past].map((x) => x.ev.id), ['first-cases', 'evacuation', 'pumps-dry']);
  assert.deepEqual([...future].map((x) => x.ev.id), ['ridge-road-closed', 'convoy-checkpoint']);
  const id = LE.addEvent(f);
  const ev = LE.findEvent(f, id).ev;
  assert.deepEqual(plain(ev.when), { day: 27, hour: 9 }, 'a day after the latest event');
  assert.ok(loads('zombie-holdout', f));
  ev.preconditions = [LE.preOf({ kind: 'event', negate: false, a: 'ridge-road-closed', by: 'han' })];
  LE.renameEvent(f, 'ridge-road-closed', 'ridge-closes');
  assert.deepEqual(plain(ev.preconditions), [{ known: 'ridge-closes', by: 'han' }]);
  assert.ok(loads('zombie-holdout', f));
  assert.ok(LE.removeEvent(f, id) && !LE.findEvent(f, id));
});

test('precondition rows round-trip every kind, with "not", and new rows use real ids', () => {
  const refs = LE.refs(plain(worldFiles('zombie-holdout')));
  const pres = [
    { alive: 'ortiz' },
    { not: { controls: { group: 'ridge', region: 'ridge-town' } } },
    { controls: { group: null, region: 'junction' } },
    { clock: 'horde', atLeast: 6 },
    { world: 'food', is: 'gone' },
    { known: 'evacuation', by: 'han' },
    { not: { known: { words: ['convoy', 'coast'] } } },
  ];
  pres.forEach((p) => assert.deepEqual(plain(LE.preOf(LE.rowOf(p))), p));
  assert.deepEqual(plain(LE.rowOf({ not: { not: { alive: 'pike' } } })), { kind: 'alive', negate: false, a: 'pike', b: '' }, 'two nots cancel');
  LE.PRE_ROWS.forEach((k) => assert.equal(LE.newRow(k, refs).kind, k));
  assert.deepEqual(plain(LE.preOf(LE.newRow('controls', refs))), { controls: { group: 'convoy', region: 'highway-strip' } });
  assert.deepEqual(plain(LE.preOf(LE.newRow('clock', refs))), { clock: 'horde', atLeast: 1 });
});

test('effects added from templates use real ids and pass validation; the projection setting is written only when it differs', () => {
  const f = plain(worldFiles('zombie-holdout'));
  const ev = LE.findEvent(f, 'convoy-checkpoint').ev;
  const refs = LE.refs(f);
  Object.keys(E.Engine.EFFECTS).forEach((k) => LE.addEffect(ev, k, refs));
  assert.equal(ev.effects.control.length, 2, 'lists grow');
  assert.deepEqual(plain(ev.effects.add_tag[1]), { region: 'highway-strip', tag: 'short tag' });
  assert.ok(loads('zombie-holdout', f));
  LE.setProjection(f, false);
  assert.equal(f['world.json'].projectTimeline, false);
  LE.setProjection(f, true, 3, 3);
  assert.ok(!('projectTimeline' in f['world.json']), 'the defaults need nothing');
  LE.setProjection(f, true, 5, '');
  assert.deepEqual(plain(f['world.json'].projectTimeline), { days: 5 });
  assert.ok(loads('zombie-holdout', f));
});

test('the map links a region to its lore and timeline events', () => {
  const f = plain(worldFiles('zombie-holdout'));
  assert.deepEqual(plain(LE.regionUse(f, 'junction')), { lore: 1, events: 1 });
  assert.deepEqual(plain(LE.regionUse(f, 'ridge-town')), { lore: 1, events: 1 });
  assert.ok(LE.eventMentions({ preconditions: [{ not: { controls: { group: 'x', region: 'junction' } } }] }, 'junction'));
});
