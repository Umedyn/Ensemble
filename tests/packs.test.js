// Add-on lore packs (task 5-7): a pack loads over its world and its entries
// are picked; a pack for another world or naming what the world lacks is
// refused in plain words; ids don't clash; replacing needs the world's
// leave; saves keep their packs; the creator round-trips a pack zip.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, packFiles, readPacks, worldFiles } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));
const ids = (picks) => [...picks].map((p) => p.id);

function holdout() {
  const E = loadEngine();
  return { E, w: readWorld('zombie-holdout', E), files: plain(packFiles('harmon-county')) };
}
// The bundled pack with changes to its pack.json.
const packWith = (E, files, edit) => {
  const f = plain(files);
  edit(f['pack.json'], f);
  return E.Packs.read('harmon-county', f);
};

test('a pack loads over its world: its entries are picked like the world\'s, and Debug says which pack', () => {
  const { E, w } = holdout();
  const [pack] = readPacks(E);
  assert.equal(pack.id, 'harmon-county');
  assert.deepEqual(plain(E.Packs.check(pack, w)), { problems: [], warnings: [] });
  const sc = E.Scenario.validate(E.Packs.apply(w.starts[0].scenario, [pack]));
  assert.deepEqual(plain(sc.packs), [{ id: 'harmon-county', title: 'Harmon County life', version: '1.0', credit: 'Ensemble (an example pack to copy)' }]);
  assert.ok(sc.lore.some((e) => e.id === 'the-dead'), "the world's own lore stays");
  assert.ok(['harmon-county:friday-football', 'harmon-county:first-baptist', 'harmon-county:feed-store-coop', 'harmon-county:sheriffs-office'].every((id) => sc.lore.some((e) => e.id === id)), 'inline and from its lore/ file');
  const state = E.Engine.newGame(sc);
  const picks = E.Lore.select(state, { action: 'I ask about the sheriff.', scene: '' });
  const sheriff = picks.find((p) => p.id === 'harmon-county:sheriffs-office');
  assert.equal(sheriff.why, '"sheriff" in the action (from the pack "Harmon County life")');
  assert.ok(picks.some((p) => p.id === 'harmon-county:feed-store-coop' && /the player's region/.test(p.why)), 'the region it is about');
  // Its own topic counts (farming), and its past event is part of the story's past.
  assert.ok(sc.loreTopics.farming.includes('harvest'));
  assert.ok(state.facts.some((f) => /Friday game against Ridge was called off/.test(f.text)));
  assert.equal(sc.timeline.find((ev) => ev.id === 'harmon-county:game-called-off').pack, 'harmon-county');
  // Without the pack, none of it.
  assert.ok(!E.Lore.select(E.Engine.newGame(w.starts[0].scenario), { action: 'I ask about the sheriff.', scene: '' }).some((p) => p.id.startsWith('harmon-county:')));
});

test('a pack for another world, or about a region, room or person the world lacks, is refused in plain words', () => {
  const { E, w, files } = holdout();
  const problems = (edit) => [...E.Packs.check(packWith(E, files, edit), w).problems];
  assert.deepEqual(problems((p) => { p.world = 'mars-station'; }), ['pack "harmon-county" is for the world "mars-station", not "Holdout at Harmon\'s" (zombie-holdout)']);
  const entry = (more) => (p) => { p.lore.push(Object.assign({ id: 'extra', title: 'Extra', level: 'region', text: 'Text.' }, more)); };
  assert.match(problems(entry({ ref: 'atlantis' })).join(), /lore "harmon-county:extra" is about the region "atlantis", which "Holdout at Harmon's" doesn't have/);
  assert.match(problems(entry({ level: 'character', ref: 'okafor' })).join(), /about the person "okafor", which "Holdout at Harmon's" doesn't have/);
  assert.deepEqual(E.Packs.check(packWith(E, files, entry({ level: 'location', ref: 'chop-shop' })), w).warnings.length, 1, 'a room no start has is a warning, as for world lore');
  assert.match(problems(entry({ topics: ['astrology'] })).join(), /"astrology" is not a topic this world knows/);
  assert.match(problems(entry({ text: 'Ruth fixed a handheld radio and heard a rescue convoy broadcast heading for the coastal safe zone.' })).join(), /gives away Ruth Han's secret/);
  assert.match(problems((p) => { delete p.credit; p.license = ''; }).join(), /"credit" must say who made it[\s\S]*"license" must name the license/);
  assert.match(problems((p) => { p.cast = []; }).join(), /unknown field "cast"/);
  assert.match(problems((p) => { p.lore.push('missing'); }).join(), /missing lore\/missing\.json/);
  assert.match(problems((p) => { p.timeline[0].region = 'atlantis'; }).join(), /timeline "game-called-off": unknown region "atlantis"/);
  // A pack's own topic is fine; without its loreTopics it isn't.
  assert.match(problems((p) => { delete p.loreTopics; }).join(), /"farming" is not a topic this world knows/);
});

test('pack ids never clash: a pack\'s ids are namespaced, so the same id in the world or another pack is a different entry', () => {
  const { E, w, files } = holdout();
  const a = packWith(E, files, (p) => { p.lore.push({ id: 'main-street', title: 'Main Street at night', level: 'region', ref: 'main-street', text: 'After dark the square empties.' }); });
  const b = packWith(E, files, (p) => { p.id = 'county-two'; p.title = 'Second pack'; });
  assert.deepEqual([...E.Packs.check(a, w).problems], []);
  const sc = E.Scenario.validate(E.Packs.apply(w.starts[0].scenario, [a, b]));
  const mains = [...sc.lore.filter((e) => /(^|:)main-street$/.test(e.id)).map((e) => e.id)];
  assert.deepEqual(mains, ['main-street', 'harmon-county:main-street']);
  assert.ok(sc.lore.some((e) => e.id === 'county-two:sheriffs-office') && sc.lore.some((e) => e.id === 'harmon-county:sheriffs-office'));
  assert.deepEqual(plain(sc.packs.map((p) => p.id)), ['harmon-county', 'county-two'], 'in the order chosen');
});

test("a pack can replace one of the world's entries only when the world allows it", () => {
  const E = loadEngine();
  const files = plain(packFiles('harmon-county'));
  files['pack.json'].lore.push({ id: 'main-street-now', title: 'Main Street', level: 'region', ref: 'main-street', replaces: 'main-street', text: 'A pack writer\'s Main Street.' });
  const pack = E.Packs.read('harmon-county', files);
  const strict = readWorld('zombie-holdout', E);
  assert.match(E.Packs.check(pack, strict).problems.join(), /replaces "main-street", but "Holdout at Harmon's" doesn't let packs replace its lore \(it would need "lorePacks": \{"replace": true\}\)/);
  const open = worldFiles('zombie-holdout');
  open['world.json'].lorePacks = { replace: true };
  const w = E.Scenario.prepareWorld('zombie-holdout', open);
  assert.deepEqual([...E.Packs.check(pack, w).problems], []);
  const sc = E.Scenario.validate(E.Packs.apply(w.starts[0].scenario, [pack]));
  assert.ok(!sc.lore.some((e) => e.id === 'main-street'), 'the world\'s entry is gone');
  assert.equal(sc.lore.find((e) => e.id === 'harmon-county:main-street-now').text, 'A pack writer\'s Main Street.');
  files['pack.json'].lore[files['pack.json'].lore.length - 1].replaces = 'nothing-here';
  assert.match(E.Packs.check(E.Packs.read('harmon-county', files), w).problems.join(), /replaces "nothing-here", which isn't one of the world's lore entries/);
  open['world.json'].lorePacks = { replace: 'yes' };
  assert.match(E.Scenario.prepareWorld('zombie-holdout', open).starts[0].error, /"lorePacks" must be \{"replace": true or false\}/);
});

test('a save keeps the packs its game started with', () => {
  const { E, w } = holdout();
  const [pack] = readPacks(E);
  const state = E.Engine.newGame(E.Scenario.validate(E.Packs.apply(w.starts[0].scenario, [pack])));
  const loaded = E.Engine.migrate(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(plain(loaded.scenario.packs.map((p) => p.id)), ['harmon-county']);
  const pick = (s) => plain(E.Lore.select(s, { action: 'I ask about the football team.', scene: '' }));
  assert.deepEqual(pick(loaded), pick(state));
  assert.ok(pick(loaded).some((p) => p.id === 'harmon-county:friday-football'));
});

test('a pack\'s own timeline events are namespaced, with their "known" preconditions', () => {
  const { E, w, files } = holdout();
  const pack = packWith(E, files, (p) => {
    p.timeline.push({ id: 'replay', when: { day: 30, hour: 19 }, scope: 'regional', region: 'town', text: 'Someone turns the stadium lights on for one night.', preconditions: [{ known: 'game-called-off' }, { not: { known: 'game-called-off' } }] });
  });
  assert.deepEqual([...E.Packs.check(pack, w).problems], []);
  const ev = E.Packs.apply(w.starts[0].scenario, [pack]).timeline.find((x) => x.id === 'harmon-county:replay');
  assert.deepEqual(plain(ev.preconditions), [{ known: 'harmon-county:game-called-off' }, { not: { known: 'harmon-county:game-called-off' } }]);
});

test('packs are found in a picked folder and in a zip', async () => {
  const E = loadEngine();
  const files = packFiles('harmon-county');
  const file = (p, j) => ({ webkitRelativePath: p, text: async () => JSON.stringify(j) });
  const found = await E.Packs.readFolderFiles([file('mods/harmon-county/pack.json', files['pack.json']), file('mods/harmon-county/lore/town-life.json', files['lore/town-life.json']), file('mods/readme.txt', 'x')]);
  assert.equal(found.length, 1);
  assert.equal(found[0].entries.length, 4);
  assert.deepEqual([...found[0].problems], []);
  const zip = E.Zip.read(E.Zip.build(Object.entries(files).map(([p, j]) => ({ name: `harmon-county/${p}`, data: E.Zip.utf8(JSON.stringify(j)) }))));
  const z = E.Packs.fromZip(zip, 'x');
  assert.equal(z.folder, 'harmon-county');
  assert.deepEqual(Object.keys(z.files).sort(), ['lore/town-life.json', 'pack.json']);
  assert.throws(() => E.Packs.fromZip(E.Zip.read(E.Zip.build([{ name: 'world.json', data: E.Zip.utf8('{}') }]))), /No pack\.json in that zip/);
});

// ---------- the creator ----------

test('the creator round-trips a pack zip: import, edit its entries under the pack, test them, export only the pack', () => {
  const E = loadEngine();
  const LE = E.LoreEdit;
  const files = plain(worldFiles('zombie-holdout'));
  const zip = E.Zip.read(E.Zip.build(Object.entries(packFiles('harmon-county')).map(([p, j]) => ({ name: `harmon-county/${p}`, data: E.Zip.utf8(JSON.stringify(j)) }))));
  const pid = LE.importPack(files, E.Packs.fromZip(zip));
  assert.equal(pid, 'harmon-county');
  assert.deepEqual([...LE.packIds(files)], ['harmon-county']);
  assert.ok(!Object.keys(LE.worldFiles(files)).some((p) => p.startsWith('packs/')), 'the world export leaves it out');
  assert.deepEqual(plain(LE.packItems(files, pid).map((x) => x.key)), ['harmon-county:friday-football', 'harmon-county:first-baptist', 'harmon-county:feed-store-coop', 'harmon-county:sheriffs-office']);
  assert.ok(!LE.loreItems(files).some((x) => x.pack), "not among the world's own entries");
  // Edited like any entry, found by the game's name for it.
  const it = LE.findLore(files, 'harmon-county:sheriffs-office');
  it.entry.title = 'The sheriff';
  const key = LE.addPackLore(files, pid, 'region', 'junction');
  assert.equal(key, 'harmon-county:new-entry');
  assert.equal(LE.addTopic(files, 'hunting: deer, rifle', pid), 'hunting');
  assert.ok(files[`packs/${pid}/pack.json`].loreTopics.hunting && !(files['world.json'].loreTopics || {}).hunting, "the pack's own topic");
  assert.ok([...LE.topics(files, pid)].includes('hunting') && ![...LE.topics(files)].includes('hunting'));
  assert.deepEqual([...LE.packCheck(files, 'zombie-holdout', pid).problems], []);
  // The test box includes it.
  const r = LE.testSelection(files, 'zombie-holdout', { action: 'Ask about the sheriff.' });
  assert.ok(r.picks.some((p) => p.id === 'harmon-county:sheriffs-office' && p.title === 'The sheriff'));
  // Removing an entry from a lore/ file, and one inline.
  assert.ok(LE.removeLore(files, 'harmon-county:first-baptist'));
  assert.ok(LE.removeLore(files, key));
  // Exported as the pack's folder only, it reads back the same.
  const out = LE.packFiles(files, pid);
  assert.deepEqual(Object.keys(out).sort(), ['lore/town-life.json', 'pack.json']);
  const again = E.Packs.read(pid, plain(out));
  assert.equal(again.entries.find((e) => e.id === 'sheriffs-office').title, 'The sheriff');
  assert.equal(again.entries.length, 3);
  assert.deepEqual([...E.Packs.check(again, readWorld('zombie-holdout', E)).problems], []);
  // A new pack names this world; a problem names the entry the way the editor selects it.
  const np = LE.addPack(files, 'School life', 'zombie-holdout');
  const k2 = LE.addPackLore(files, np, 'region', 'atlantis');
  assert.match(LE.packCheck(files, 'zombie-holdout', np).problems.join(), new RegExp(`lore "${k2}" is about the region "atlantis"`));
  LE.removePack(files, np);
  assert.deepEqual([...LE.packIds(files)], ['harmon-county']);
});
