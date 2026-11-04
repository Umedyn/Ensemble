// World bundles (task A-5): worlds and lore packs opened from a folder or zip
// are kept in E.Store, once each, readable by every page, and removable
// without breaking a save of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Blob } = require('node:buffer');
const { loadEngine, worldFiles, packFiles } = require('./helpers.js');
const { fakeIndexedDB, fakeLocalStorage } = require('./fakeidb.js');

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
// A second visit (another page, or a reload) is a new engine on the same database.
const visit = async (idb) => {
  // As from disk, so the bundled source lists nothing and only what was kept shows.
  const E = loadEngine({ indexedDB: idb, localStorage: fakeLocalStorage({}), Blob, location: { protocol: 'file:' } });
  await E.Store.ready();
  return E;
};
const holdout = () => ({ folder: 'zombie-holdout', files: worldFiles('zombie-holdout'), assets: { 'portraits/marta.png': new Blob([PNG], { type: 'image/png' }) } });
const keys = (idb, prefix) => [...idb.data.keys()].filter((k) => k.startsWith(prefix)).sort();

test('a world opened from a folder is there on the next visit, with its pictures', async () => {
  const idb = fakeIndexedDB();
  const E = await visit(idb);
  const r = await E.Library.keep('world', holdout());
  assert.equal(r.id, 'stored:zombie-holdout');
  assert.equal(r.status, 'added');
  const again = await visit(idb);
  const list = [...(await again.Library.list('world'))].filter((w) => w.source === 'stored');
  assert.deepEqual(list.map((w) => [w.id, w.title]), [['stored:zombie-holdout', "Holdout at Harmon's"]]);
  assert.equal(list[0].meta.starts, r.world.starts.length);
  assert.ok(list[0].meta.size > 0 && list[0].meta.hash.length === 16);
  const w = await again.Library.load('stored:zombie-holdout');
  assert.equal(w.title, "Holdout at Harmon's");
  assert.ok(w.starts.every((s) => !s.error), 'every start composes');
  assert.deepEqual([...new Uint8Array(await w.assets['portraits/marta.png'].arrayBuffer())], [...PNG]);
  assert.equal(w.assets['portraits/marta.png'].type, 'image/png');
  const raw = await again.Library.load('stored:zombie-holdout', { raw: true });
  assert.equal(raw['world.json'].title, "Holdout at Harmon's", 'the creator gets the files');
});

test('the same world opened twice is stored once', async () => {
  const idb = fakeIndexedDB();
  const E = await visit(idb);
  await E.Library.keep('world', holdout());
  const before = new Map(idb.data);
  const r = await E.Library.keep('world', holdout());
  assert.equal(r.status, 'same');
  assert.deepEqual([...idb.data.keys()].sort(), [...before.keys()].sort());
  assert.equal(idb.data.get('bundlemeta.zombie-holdout'), before.get('bundlemeta.zombie-holdout'), 'not even rewritten');
  assert.equal([...(await E.Library.list('world'))].filter((w) => w.source === 'stored').length, 1);
});

test('a changed copy replaces the old one and its pictures that went', async () => {
  const idb = fakeIndexedDB();
  const E = await visit(idb);
  await E.Library.keep('world', holdout());
  const added = JSON.parse(idb.data.get('bundlemeta.zombie-holdout')).added;
  const next = holdout();
  next.files['world.json'].summary = 'Edited.';
  next.assets = { 'portraits/other.png': new Blob([PNG.slice(0, 9)]) };
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await E.Library.keep('world', next)).status, 'updated');
  assert.deepEqual(keys(idb, 'bundleblob.'), ['bundleblob.zombie-holdout/portraits/other.png']);
  const meta = JSON.parse(idb.data.get('bundlemeta.zombie-holdout'));
  assert.equal(meta.summary, 'Edited.');
  assert.equal(meta.added, added, 'still the date it was first added');
  assert.equal((await E.Library.load('stored:zombie-holdout')).summary, 'Edited.');
});

test('a folder and a zip of the same world are the same bundle', async () => {
  const idb = fakeIndexedDB();
  const E = await visit(idb);
  await E.Library.keep('world', holdout());
  const w = holdout();
  const entries = Object.entries(w.files).map(([name, json]) => ({ name: 'zombie-holdout/' + name, data: E.Zip.utf8(JSON.stringify(json)) }))
    .concat({ name: 'zombie-holdout/portraits/marta.png', data: PNG }, { name: 'zombie-holdout/notes.txt', data: E.Zip.utf8('not kept') });
  const z = E.Scenario.readZip(E.Zip.read(E.Zip.build(entries)));
  assert.equal(z.folder, 'zombie-holdout');
  assert.deepEqual(Object.keys(z.assets), ['portraits/marta.png'], 'images only');
  assert.equal((await E.Library.keep('world', z)).status, 'same');
});

test('removing a world frees its space, and a save of it still loads and plays on', async () => {
  const idb = fakeIndexedDB();
  const E = await visit(idb);
  const { world } = await E.Library.keep('world', holdout());
  const state = E.Engine.newGame(E.Scenario.startScenario(world));
  await E.Saves.save('g', state);
  assert.equal(E.Library.isStored('stored:zombie-holdout'), true);
  assert.equal(E.Library.isStored('server:zombie-holdout'), false);
  await E.Library.remove('stored:zombie-holdout');
  assert.deepEqual(keys(idb, 'bundle'), []);
  assert.equal(await E.Library.load('stored:zombie-holdout'), null);
  const again = await visit(idb);
  const saved = again.Engine.migrate(await again.Saves.load('g'));
  assert.equal(saved.scenario.folder, 'zombie-holdout');
  assert.ok(saved.scenario.characterData.length && saved.scenario.locations.length, 'the scenario travels in the save');
  assert.equal(JSON.stringify(saved.characters), JSON.stringify(state.characters));
});

test('a world that does not load is refused and nothing is stored', async () => {
  const idb = fakeIndexedDB();
  const E = await visit(idb);
  const bad = holdout();
  delete bad.files['world.json'].title;
  await assert.rejects(E.Library.keep('world', bad), (e) => /missing "title"/.test(e.message));
  assert.deepEqual(keys(idb, 'bundle'), []);
  await assert.rejects(E.Library.keep('world', { folder: '', files: {} }), (e) => /folder name/.test(e.message));
});

test('lore packs opened from a folder are kept the same way', async () => {
  const idb = fakeIndexedDB();
  const E = await visit(idb);
  const raw = { folder: 'harmon-county', files: packFiles('harmon-county') };
  const r = await E.Library.keep('pack', raw);
  assert.deepEqual([r.id, r.status], ['pack:stored:harmon-county', 'added']);
  assert.equal((await E.Library.keep('pack', raw)).status, 'same');
  const again = await visit(idb);
  const list = [...(await again.Library.list('pack'))].filter((p) => p.source === 'stored');
  assert.deepEqual(list.map((p) => p.id), ['pack:stored:harmon-county']);
  const pack = await again.Library.load('pack:stored:harmon-county');
  assert.equal(pack.world, 'zombie-holdout');
  assert.deepEqual([...pack.problems], []);
  assert.ok(pack.entries.length > 0);
  await again.Library.remove('pack:stored:harmon-county');
  assert.equal([...(await again.Library.list('pack'))].filter((p) => p.source === 'stored').length, 0);
});

test('the card fields: author, credit, license and cover, checked in plain words', () => {
  const E = loadEngine();
  const files = worldFiles('mars-station');
  Object.assign(files['world.json'], { author: 'Someone', credit: 'Written for Ensemble', license: 'CC BY 4.0', cover: 'cover.png' });
  const w = E.Scenario.prepareWorld('mars-station', files);
  assert.deepEqual([w.author, w.credit, w.license, w.cover], ['Someone', 'Written for Ensemble', 'CC BY 4.0', 'cover.png']);
  assert.ok(!w.warnings.some((m) => /unknown field/.test(m)));
  for (const [k, v, msg] of [['cover', '../x.png', /"cover" must be the path of an image/], ['cover', 'cover.txt', /"cover"/], ['author', 'x'.repeat(81), /"author" must be text of at most 80/], ['license', 3, /"license"/]]) {
    const f = worldFiles('mars-station');
    f['world.json'][k] = v;
    assert.throws(() => E.Scenario.prepareWorld('mars-station', f), (e) => msg.test(e.message), k);
  }
});

test('the bundled examples say who made them', () => {
  const E = loadEngine();
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const w = E.Scenario.prepareWorld(folder, worldFiles(folder));
    assert.ok(w.author && w.credit && w.license, folder);
  }
});
