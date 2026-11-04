// Remote library lists (task A-8): a list added on the library page, its
// worlds downloaded into the library and played offline. Remote content is
// untrusted: lists and zips are capped and checked, and a failure says why
// and changes nothing. A fake list server stands in for the web.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { Blob } = require('node:buffer');
const { loadEngine, worldFiles } = require('./helpers.js');
const { fakeIndexedDB, fakeLocalStorage } = require('./fakeidb.js');

const HOST = 'https://lists.example.org/ensemble/';
const LIST = HOST + 'list.json';
// A fake server: url → bytes (or a status number); everything else is unreachable.
function server(files) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (!(url in files)) throw new TypeError('Failed to fetch');
    const body = files[url];
    if (typeof body === 'number') return { ok: false, status: body, headers: { get: () => null } };
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    return { ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? String(bytes.length) : null) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  return { fetch, calls };
}
const visit = async (idb, fetch) => {
  const E = loadEngine({ indexedDB: idb, localStorage: fakeLocalStorage({}), Blob, fetch, location: { protocol: 'https:' },
    DecompressionStream: globalThis.DecompressionStream, ReadableStream: globalThis.ReadableStream });
  await E.Store.ready();
  return E;
};
// A zip of a world folder, deflated (as most zip tools make them), or stored.
function zipOf(files, { stored = false, lie = null } = {}) {
  const E = loadEngine();
  const locals = [], central = [];
  let at = 0;
  Object.entries(files).forEach(([name, data]) => {
    const raw = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
    const packed = stored ? raw : zlib.deflateRawSync(raw);
    const crc = E.Zip.crc32(new Uint8Array(raw));
    const n = Buffer.from(name);
    const size = lie != null ? lie : raw.length;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(size, 22); head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(stored ? 0 : 8, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(size, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(at, 42);
    locals.push(head, n, packed);
    central.push(dir, n);
    at += 30 + n.length + packed.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat(locals.concat([cd, end])));
}
const holdoutZip = (o) => zipOf(Object.fromEntries(Object.entries(worldFiles('zombie-holdout')).map(([k, v]) => [`holdout/${k}`, JSON.stringify(v)]).concat([['holdout/portraits/a.png', 'PNGDATA']])), o);
const entry = (o) => Object.assign({ id: 'harmon', title: 'Holdout at Harmon\'s', summary: 'Five strangers.', tags: ['survival'], credit: 'Ensemble', license: 'CC BY 4.0', url: 'harmon.zip', version: '1.0' }, o);
const list = (worlds, o) => JSON.stringify(Object.assign({ format: 'ensemble-list', version: 1, title: 'Community worlds', worlds }, o));

test('a fresh install has no list', async () => {
  const E = await visit(fakeIndexedDB(), server({}).fetch);
  assert.deepEqual([...E.Remote.lists()], []);
  assert.deepEqual([...(await E.Library.list('remote'))], []);
});

test('a list is added, its worlds checked, its addresses made whole; a world with a problem is skipped and said', async () => {
  const s = server({ [LIST]: list([entry(), entry({ id: 'Bad Id' }), entry({ id: 'nolicense', license: '' }), entry({ id: 'evil', url: 'javascript:alert(1)' }), entry({ id: 'huge', size: 999999999 }), entry()]) });
  const E = await visit(fakeIndexedDB(), s.fetch);
  const l = await E.Remote.add(LIST);
  assert.equal(l.title, 'Community worlds');
  assert.equal(JSON.stringify(l.worlds.map((w) => [w.id, w.url])), JSON.stringify([['harmon', HOST + 'harmon.zip']]));
  const skipped = l.skipped.join('\n');
  assert.match(skipped, /"id" must be lowercase letters/);
  assert.match(skipped, /"license" must name the license/);
  assert.match(skipped, /"url" must be a web address/);
  assert.match(skipped, /downloads are at most 50\.0 MB/);
  assert.match(skipped, /"harmon" is listed twice/);
  assert.equal(E.Remote.lists().length, 1);
  const cards = [...(await E.Library.list('remote'))];
  assert.equal(JSON.stringify(cards.map((c) => [c.kind, c.folder, c.list.title])), JSON.stringify([['remote', 'harmon', 'Community worlds']]));
  assert.ok(![...(await E.Library.list('world'))].some((w) => w.source === 'remote'), 'the game never sees a list\'s worlds');
  await assert.rejects(E.Remote.add(LIST), /already in your library/);
});

test('a bad list explains itself and adds nothing', async () => {
  const s = server({ [HOST + 'html']: '<html>', [HOST + 'other.json']: '{"format":"something"}', [HOST + 'gone.json']: 404, [HOST + 'big.json']: 'x'.repeat(600 * 1024) });
  const E = await visit(fakeIndexedDB(), s.fetch);
  await assert.rejects(E.Remote.add(HOST + 'html'), /isn't an Ensemble list \(it isn't JSON\)/);
  await assert.rejects(E.Remote.add(HOST + 'other.json'), /needs "format": "ensemble-list"/);
  await assert.rejects(E.Remote.add(HOST + 'gone.json'), /answered "HTTP 404" \(not found\)/);
  await assert.rejects(E.Remote.add(HOST + 'big.json'), /The list is 600 KB; at most 512 KB/);
  await assert.rejects(E.Remote.add('https://nowhere.example/list.json'), /Couldn't reach nowhere\.example[\s\S]*allow other sites to read it/);
  await assert.rejects(E.Remote.add('ftp://x/list.json'), /starts with https:\/\//);
  await assert.rejects(E.Remote.add('my list'), /isn't a web address/);
  assert.equal(E.Remote.lists().length, 0);
});

test('a world downloads into the library and plays offline afterwards', async () => {
  const idb = fakeIndexedDB();
  const s = server({ [LIST]: list([entry()]), [HOST + 'harmon.zip']: holdoutZip() });
  const E = await visit(idb, s.fetch);
  const l = await E.Remote.add(LIST);
  assert.equal(E.Remote.status(l.worlds[0], LIST, [...(await E.Library.list('world'))]), 'download');
  const out = await E.Remote.download(l.worlds[0], LIST);
  assert.equal(out.id, 'stored:harmon');
  assert.equal(E.Remote.status(l.worlds[0], LIST, [...(await E.Library.list('world'))]), 'downloaded');
  // Next visit, with no network at all.
  const offline = await visit(idb, () => { throw new Error('no network during play'); });
  const w = await offline.Library.load('stored:harmon');
  assert.equal(w.title, "Holdout at Harmon's");
  assert.ok(w.assets['portraits/a.png'], 'its pictures came too');
  const state = offline.Engine.newGame(offline.Scenario.startScenario(w));
  assert.ok(state.characters[state.player], 'a game starts');
  // A stored (uncompressed) zip works the same.
  const s2 = server({ [LIST]: list([entry({ id: 'plain', url: 'plain.zip' })]), [HOST + 'plain.zip']: holdoutZip({ stored: true }) });
  const E2 = await visit(fakeIndexedDB(), s2.fetch);
  await E2.Remote.download((await E2.Remote.add(LIST)).worlds[0], LIST);
  assert.ok(await E2.Library.load('stored:plain'));
});

test('a new version on the list is an update; refreshing a list that fails keeps what it had', async () => {
  const files = { [LIST]: list([entry()]), [HOST + 'harmon.zip']: holdoutZip() };
  const s = server(files);
  const E = await visit(fakeIndexedDB(), s.fetch);
  const l = await E.Remote.add(LIST);
  await E.Remote.download(l.worlds[0], LIST);
  files[LIST] = list([entry({ version: '1.1' })]);
  const again = await E.Remote.refresh(LIST);
  assert.equal(again.error, '');
  assert.equal(E.Remote.status(again.worlds[0], LIST, [...(await E.Library.list('world'))]), 'update');
  assert.equal((await E.Remote.download(again.worlds[0], LIST)).status, 'updated');
  assert.equal(E.Remote.status(again.worlds[0], LIST, [...(await E.Library.list('world'))]), 'downloaded');
  files[LIST] = 500;
  const failed = await E.Remote.refresh(LIST);
  assert.match(failed.error, /HTTP 500/);
  assert.equal(failed.worlds.length, 1, 'the worlds fetched before stay');
  await E.Remote.remove(LIST);
  assert.equal(E.Remote.lists().length, 0);
});

test('a bad zip, an oversized file, a zip bomb and a broken world are refused, and nothing is stored', async () => {
  const idb = fakeIndexedDB();
  const files = {
    [HOST + 'junk.zip']: new Uint8Array(400).fill(7),
    [HOST + 'big.zip']: new Uint8Array(51 * 1048576),
    [HOST + 'bomb.zip']: holdoutZip({ lie: 10 }),
    [HOST + 'broken.zip']: zipOf({ 'broken/world.json': JSON.stringify({ setting: 'no title' }) }),
    [HOST + 'many.zip']: zipOf(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`m/f${i}.txt`, 'x']))),
  };
  const E = await visit(idb, server(files).fetch);
  const w = (id) => entry({ id, url: HOST + id + '.zip' });
  await assert.rejects(E.Remote.download(w('junk'), LIST), /isn't a zip Ensemble can read: not a zip file/);
  await assert.rejects(E.Remote.download(w('big'), LIST), /is 51\.0 MB; at most 50\.0 MB/);
  await assert.rejects(E.Remote.download(Object.assign(w('big'), { size: 60 * 1048576 }), LIST), /downloads are at most 50\.0 MB/, 'a declared size refused before fetching');
  await assert.rejects(E.Remote.download(w('bomb'), LIST), /unpacks to more than the zip says/);
  await assert.rejects(E.Remote.download(w('broken'), LIST), /doesn't load, so it wasn't added:[\s\S]*missing "title"/);
  await assert.rejects(E.Remote.download(w('many'), LIST), /holds 2001 files; at most 2000/);
  assert.deepEqual([...idb.data.keys()].filter((k) => k.startsWith('bundle')), []);
  // A file that unpacks bigger than the cap, by its own word: refused before unpacking.
  const big = zipOf({ 'x/world.json': '{}' }, { lie: 21 * 1048576 });
  await assert.rejects(E.Zip.readAsync(big, E.Remote.LIMITS), /unpacks to 21 MB; at most 20 MB a file/);
});

test('a world of the same name from somewhere else is never replaced by a download', async () => {
  const s = server({ [HOST + 'harmon.zip']: holdoutZip() });
  const E = await visit(fakeIndexedDB(), s.fetch);
  await E.Library.keep('world', { folder: 'harmon', files: worldFiles('zombie-holdout') });
  await assert.rejects(E.Remote.download(entry({ url: HOST + 'harmon.zip' }), LIST), /already a world called "harmon" in your library from somewhere else/);
  assert.equal(s.calls.filter((u) => u.startsWith(HOST)).length, 0, 'the zip was never fetched');
});
