// E.Store, the move from localStorage, and the list of saves (task A-1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadEngine, newGame } = require('./helpers.js');
const { fakeIndexedDB, fakeLocalStorage } = require('./fakeidb.js');

const ROOT = path.join(__dirname, '..');
const OLD_GAME = JSON.stringify({ scenario: { worldId: 'mars-station', worldTitle: 'Ares Deep', startId: 'arrival', startTitle: 'Arrival' }, player: 'p', turn: 7, characters: { p: { name: 'Mina' } } });
const OLD_KEYS = {
  'ensemble.settings': JSON.stringify({ temperature: 0.5, appearance: { theme: 'light' }, backends: { external: { key: 'sk-secret' } } }),
  'ensemble.setupDone': '1',
  'ensemble.pick': '{"world":"server:mars-station"}',
  'ensemble.packs': '{"zombie-holdout":["harmon-county"]}',
  'ensemble.makerDraft': '{"key":"k","form":{}}',
  'ensemble.genJob': '{"key":"k","job":{}}',
  'ensemble.mapview': '{"w":"local"}',
  'ensemble.view': '{"w":"map"}',
  'ensemble.cards.elsewhere': '{"w":true}',
  'ensemble.cards.min': '{"w":{"a":true}}',
  'ensemble.section.local': '1',
  'ensemble.creator.harbor': '{"files":{"world.json":{"title":"Harbor"}}}',
};
const boot = async (globals) => {
  const E = loadEngine(globals);
  await E.Store.ready();
  return E;
};
const browser = (items) => ({ indexedDB: fakeIndexedDB(), localStorage: fakeLocalStorage(items) });

for (const key of Object.keys(OLD_KEYS)) {
  test(`migration moves ${key} and removes the old copy`, async () => {
    const globals = browser({ [key]: OLD_KEYS[key] });
    const E = await boot(globals);
    assert.equal(await E.Store.get(key), OLD_KEYS[key]);
    assert.equal(E.Prefs.get(key), OLD_KEYS[key], 'readable at once');
    assert.equal(globals.localStorage.getItem(key), null);
  });
}

test('migration run twice gives the same result, and what the store has stays', async () => {
  const globals = browser({ ...OLD_KEYS, 'ensemble.autosave': OLD_GAME });
  await boot(globals);
  const after = new Map(globals.indexedDB.data);
  await boot(globals);
  assert.deepEqual([...globals.indexedDB.data], [...after]);
  // A key that stayed behind doesn't overwrite newer data.
  globals.indexedDB.data.set('ensemble.pick', 'newer');
  globals.localStorage.setItem('ensemble.pick', 'older');
  const E = await boot(globals);
  assert.equal(await E.Store.get('ensemble.pick'), 'newer');
  assert.equal(globals.localStorage.getItem('ensemble.pick'), null);
});

test('a key stays readable in localStorage until its move is confirmed', async () => {
  const globals = browser({ 'ensemble.pick': 'x' });
  const put = globals.indexedDB.open;
  globals.indexedDB.open = () => {
    const req = put();
    const real = req.result.transaction;
    req.result = Object.assign({}, req.result, {
      transaction() { const t = real(); const os = t.objectStore(); t.objectStore = () => Object.assign({}, os, { put: () => { throw new Error('quota'); } }); return t; },
    });
    return req;
  };
  await boot(globals);
  assert.equal(globals.localStorage.getItem('ensemble.pick'), 'x', 'not lost');
});

test('an old autosave appears as a save, and plays', async () => {
  const globals = browser({ 'ensemble.autosave': OLD_GAME });
  const E = await boot(globals);
  const [only, ...rest] = [...(await E.Saves.list())];
  assert.equal(rest.length, 0);
  assert.deepEqual([only.id, only.world, only.worldTitle, only.start, only.player, only.turn], ['autosave', 'mars-station', 'Ares Deep', 'arrival', 'Mina', 7]);
  assert.equal((await E.Saves.load(only.id)).turn, 7);
  assert.equal(globals.localStorage.getItem('ensemble.autosave'), null);
});

test('settings stay synchronous after the wait at page start, and move with their old fixes', async () => {
  const globals = browser({ 'ensemble.settings': JSON.stringify({ endpoint: 'http://192.168.1.20:5001', narrateTokens: 420 }) });
  const E = await boot(globals);
  E.loadSettings();
  assert.equal(E.settings.backends.local.url, 'http://192.168.1.20:5001/v1');
  E.settings.temperature = 0.3;
  await E.saveSettings();
  await new Promise((r) => setTimeout(r, 20));
  const again = await boot({ indexedDB: globals.indexedDB, localStorage: globals.localStorage });
  again.loadSettings();
  assert.equal(again.settings.temperature, 0.3);
  assert.equal(again.contextTier().id, 'compact');
});

test('API keys leave localStorage; only the appearance stays there, for the theme script', async () => {
  const globals = browser({ 'ensemble.settings': OLD_KEYS['ensemble.settings'] });
  const E = await boot(globals);
  assert.deepEqual(Object.keys(globals.localStorage.items), ['ensemble.appearance']);
  assert.equal(JSON.parse(globals.localStorage.items['ensemble.appearance']).theme, 'light');
  E.loadSettings();
  E.settings.appearance.theme = 'contrast';
  E.saveSettings();
  assert.equal(JSON.parse(globals.localStorage.items['ensemble.appearance']).theme, 'contrast');
  assert.ok(!JSON.stringify(globals.localStorage.items).includes('sk-secret'));
});

test('both pages read the appearance copy before first paint, and the old settings on the very first', () => {
  for (const page of ['index.html', 'creator.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(html, /localStorage\.getItem\('ensemble\.appearance'\)\) \|\| \(JSON\.parse\(localStorage\.getItem\('ensemble\.settings'\)\)/, page);
    assert.ok(html.indexOf('js/util.js') < html.indexOf('js/adapters.js'), page);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'storecheck.html')), 'the frame the page check loads');
});

test('a fake store swapped in is used with no other code changed', async () => {
  const E = loadEngine({ localStorage: fakeLocalStorage({ 'ensemble.setupDone': '1' }) });
  const calls = [];
  const inner = E.memoryStore();
  E.Store.use({
    get: (k) => { calls.push('get'); return inner.get(k); },
    set: (k, v) => { calls.push('set'); return inner.set(k, v); },
    remove: (k) => { calls.push('remove'); return inner.remove(k); },
    list: (p) => { calls.push('list'); return inner.list(p); },
  });
  await E.Store.ready();
  assert.equal(E.Store.kept, true);
  assert.equal(E.Prefs.get('ensemble.setupDone'), '1', 'old keys reach it too');
  const { state } = newGame();
  await E.Saves.save('g1', state);
  assert.equal([...(await E.Saves.list())][0].turn, state.turn);
  assert.equal((await E.Saves.load('g1')).player, state.player);
  await E.saveSettings();
  assert.ok(await inner.get('ensemble.settings'));
  assert.ok(calls.includes('set') && calls.includes('list') && calls.includes('get'));
});

test('IndexedDB unavailable still plays, says so, and leaves localStorage alone', async () => {
  const items = { ...OLD_KEYS, 'ensemble.autosave': OLD_GAME };
  const before = JSON.stringify(Object.keys(items).sort());
  const failing = { open() { throw new Error('private window'); } };
  for (const globals of [{ localStorage: fakeLocalStorage(items) }, { localStorage: fakeLocalStorage(items), indexedDB: failing }]) {
    const E = await boot(globals);
    assert.equal(E.Store.kept, false);
    assert.equal(E.Prefs.get('ensemble.pick'), OLD_KEYS['ensemble.pick'], 'the old data still reads');
    assert.equal((await E.Saves.last()).turn, 7, 'so does the old game');
    await new Promise((r) => setTimeout(r, 5));
    await E.Saves.save('new', Object.assign(JSON.parse(OLD_GAME), { turn: 8 }));
    assert.equal((await E.Saves.last()).turn, 8);
  }
  assert.equal(JSON.stringify(Object.keys(items).filter((k) => k !== 'ensemble.appearance').sort()), before);
});

test('saves have ids: each game its own, newest first, removable', async () => {
  const E = await boot(browser({}));
  const a = newGame().state, b = newGame('zombie-holdout').state;
  await E.Saves.save('a', a);
  await new Promise((r) => setTimeout(r, 5));
  await E.Saves.save('b', b);
  assert.deepEqual([...(await E.Saves.list())].map((s) => s.id), ['b', 'a']);
  assert.equal((await E.Saves.last()).world, 'zombie-holdout');
  await new Promise((r) => setTimeout(r, 5));
  a.turn = 3;
  await E.Saves.save('a', a);
  const list = [...(await E.Saves.list())];
  assert.deepEqual(list.map((s) => [s.id, s.turn]), [['a', 3], ['b', b.turn]], 'autosaving a game updates its entry');
  await E.Saves.remove('a');
  assert.deepEqual([...(await E.Saves.list())].map((s) => s.id), ['b']);
  assert.equal(await E.Saves.load('a'), null);
  assert.notEqual(E.Saves.newId(), E.Saves.newId());
});

test('no API key in a save', async () => {
  const globals = browser({});
  const E = await boot(globals);
  E.settings.backends.external.key = 'sk-secret';
  await E.saveSettings();
  await E.Saves.save('g', newGame().state);
  const text = await E.Store.get('save.g');
  const meta = await E.Store.get('savemeta.g');
  assert.ok(text.length > 100);
  assert.ok(!text.includes('sk-secret') && !meta.includes('sk-secret'));
});

test('a refused write is reported and never throws', async () => {
  const E = loadEngine();
  const inner = E.memoryStore();
  E.Store.use(Object.assign({}, inner, { set: async () => { throw new Error('quota'); } }));
  await E.Store.ready();
  const fails = [];
  E.Store.onFail = (e) => fails.push(e.message);
  assert.equal(await E.Store.set('x', '1'), false);
  assert.equal(await E.Saves.save('g', newGame().state), false);
  assert.ok(fails.includes('quota'));
});

test('saves move to no other key: nothing writes the old autosave or settings keys to localStorage', () => {
  for (const f of ['ui.js', 'creator.js', 'util.js']) {
    assert.ok(!/localStorage\./.test(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')), f);
  }
});
