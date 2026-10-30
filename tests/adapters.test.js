// E.Backend, E.Voice and E.Library (task A-2).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, worldFiles } = require('./helpers.js');

// A Response with what llm.js reads, plain or as server-sent events.
const jsonResponse = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
const streamResponse = (parts) => {
  const lines = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  let i = 0, cancelled = false;
  return {
    ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    cancelled: () => cancelled,
    body: { getReader: () => ({
      read: async () => (i < lines.length ? { value: new TextEncoder().encode(lines[i++]), done: false } : { done: true }),
      cancel: async () => { cancelled = true; },
    }) },
  };
};
const reply = (text) => jsonResponse({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
const external = (E) => {
  E.settings.backends.external = Object.assign({}, E.settings.backends.external, { key: 'sk-player', model: 'test/model' });
  E.settings.routing.narrate = 'external';
};

test('the direct backend sends the key and calls fetch, as before', async () => {
  const sent = [];
  const E = loadEngine({ fetch: async (url, init) => { sent.push({ url, init }); return reply('A scene.'); } });
  external(E);
  assert.equal(await E.LLM.chat({ kind: 'narrate', system: 's', user: 'u' }), 'A scene.');
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer sk-player');
  assert.equal(sent[0].init.headers['Content-Type'], 'application/json');
  assert.equal(E.LLM.calls[0].promptTokens, 11, 'usage still read');
});

test('a fake backend takes every request with no other code changed: chat, ping, perf, abort', async () => {
  const E = loadEngine({ AbortController, TextDecoder, fetch: () => { throw new Error('direct fetch used'); } });
  const urls = [];
  E.Backend.use({
    async fetch(b, url) {
      urls.push(url);
      if (url.endsWith('/api/v1/model')) return jsonResponse({ result: 'koboldcpp/fake' });
      if (url.endsWith('/true_max_context_length')) return jsonResponse({ value: 4096 });
      if (url.endsWith('/perf')) return jsonResponse({ last_process_time: 1, last_eval_time: 2 });
      if (url.endsWith('/abort')) return jsonResponse({});
      return streamResponse(['First paragraph.\n\n', 'Second paragraph.\n\n', 'Third.']);
    },
  });
  assert.deepEqual({ ...(await E.LLM.ping('local')) }, { model: 'fake', context: 4096 });
  const text = await E.LLM.chat({ kind: 'narrate', system: 's', user: 'u', stopAt: (t) => (t.includes('Second') ? { at: t.indexOf('Second'), why: 'test' } : null) });
  assert.equal(text.trim(), 'First paragraph.', 'the soft stop works through it');
  assert.ok(urls.some((u) => u.endsWith('/chat/completions')));
  assert.ok(urls.some((u) => u.endsWith('/api/extra/abort')), 'KoboldCpp is told to stop');
  assert.ok(E.LLM.calls[0].perf, 'perf read through it');
});

test('JSON mode\'s 400 fallback works through a swapped backend', async () => {
  const E = loadEngine();
  external(E);
  E.settings.routing.intent = 'external';
  const bodies = [];
  E.Backend.use({
    async fetch(b, url, init) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.response_format) return { ok: false, status: 400, text: async () => 'no' };
      return reply('{"a":1}');
    },
  });
  assert.equal((await E.LLM.chat({ kind: 'intent', system: 's', user: 'u', shape: {} })).trim(), '{"a":1}');
  assert.deepEqual(bodies.map((b) => !!b.response_format), [true, false]);
});

test('the proxy gets the target and never the player\'s key', async () => {
  const sent = [];
  const E = loadEngine({ fetch: async (url, init) => { sent.push({ url, init }); return reply('Hi.'); } });
  external(E);
  E.Backend.use(E.proxyBackend('https://proxy.example/send'));
  assert.equal(await E.LLM.chat({ kind: 'narrate', system: 's', user: 'u' }), 'Hi.');
  assert.equal(sent[0].url, 'https://proxy.example/send');
  assert.equal(sent[0].init.headers['X-Ensemble-Target'], 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent[0].init.headers.Authorization, undefined);
  assert.ok(!JSON.stringify(sent[0].init).includes('sk-player'));
  E.Backend.use(null);
  await E.LLM.chat({ kind: 'narrate', system: 's', user: 'u' });
  assert.equal(sent[1].init.headers.Authorization, 'Bearer sk-player', 'back to direct');
});

test('voice is off by default and swappable', async () => {
  const E = loadEngine();
  assert.equal(E.Voice.available, false);
  await E.Voice.speak('Hello.');
  E.Voice.stop();
  const said = [];
  E.Voice.use({ available: true, async speak(t) { said.push(t); }, stop() {} });
  assert.equal(E.Voice.available, true);
  await E.Voice.speak('Hello.');
  assert.deepEqual(said, ['Hello.']);
  E.Voice.use(null);
  assert.equal(E.Voice.available, false);
});

// scenarios/, library/ and packs/ from a fake server.
const serverFiles = () => {
  const world = worldFiles('mars-station');
  const files = { 'scenarios/index.json': { scenarios: [{ folder: 'mars-station', title: 'Ares Deep' }] }, 'packs/index.json': { packs: ['extra'] }, 'packs/extra/pack.json': { id: 'extra', title: 'Extra', world: 'mars-station', credit: 'me', license: 'CC0', lore: [] }, 'library/index.json': { sites: [] } };
  Object.keys(world).forEach((p) => { files['scenarios/mars-station/' + p] = world[p]; });
  return files;
};
const server = (files) => async (url) => (url in files ? jsonResponse(files[url]) : { ok: false, status: 404 });

test('the library lists and loads the bundled worlds, packs and shared maps', async () => {
  const E = loadEngine({ fetch: server(serverFiles()) });
  const worlds = [...(await E.Library.list('world'))];
  assert.deepEqual(worlds.map((w) => [w.id, w.kind, w.source, w.title]), [['server:mars-station', 'world', 'server', 'Ares Deep']]);
  const world = await E.Library.load(worlds[0].id);
  assert.ok(world.starts && world.title);
  const raw = await E.Library.load(worlds[0].id, { raw: true });
  assert.ok(raw['world.json'], 'the creator gets the files as they are');
  const [pack] = await E.Library.list('pack');
  assert.equal(pack.id, 'pack:server:extra');
  assert.equal((await E.Library.load(pack.id)).id, 'extra');
  const [shared] = await E.Library.list('library');
  assert.ok((await E.Library.load(shared.id)).maps);
  assert.deepEqual([...(await E.Library.list('table'))], [], 'no tables yet');
});

test('opened worlds and packs join the list and load as they were opened', async () => {
  const E = loadEngine({ fetch: server(serverFiles()) });
  const world = { folder: 'mine', title: 'Mine', files: { 'world.json': { title: 'Mine' } } };
  const id = E.Library.open('world', 'mine', 'Mine', world);
  assert.equal(id, 'disk:mine');
  assert.deepEqual([...(await E.Library.list('world'))].map((w) => w.id), ['server:mars-station', 'disk:mine']);
  assert.equal(await E.Library.load(id), world);
  assert.equal(await E.Library.load(id, { raw: true }), world.files);
  assert.equal(E.Library.open('pack', 'p', 'P', { id: 'p' }), 'pack:disk:p');
  assert.equal([...(await E.Library.list('pack'))].length, 2);
});

test('from disk the bundled source lists nothing, with no request made', async () => {
  const E = loadEngine({ location: { protocol: 'file:' }, fetch: () => { throw new Error('fetched'); } });
  for (const kind of ['world', 'pack', 'library']) assert.equal((await E.Library.list(kind)).length, 0);
});

test('a missing index fails the list, so the page can say so', async () => {
  const E = loadEngine({ fetch: server({}) });
  await assert.rejects(() => E.Library.list('world'));
});

test('a fake library and an added source are used with no other code changed', async () => {
  const E = loadEngine({ fetch: () => { throw new Error('direct fetch used'); } });
  const fake = (id) => ({ id, async list(kind) { return kind === 'world' ? [{ id: id + ':w', kind, source: id, title: id, folder: 'w' }] : []; }, async load(x) { return { loadedFrom: x }; } });
  E.Library.use(fake('fake'));
  E.Library.addSource(fake('remote'));
  assert.deepEqual([...(await E.Library.list('world'))].map((w) => w.id), ['fake:w', 'remote:w']);
  assert.equal((await E.Library.load('remote:w')).loadedFrom, 'remote:w');
  await assert.rejects(() => E.Library.load('nowhere:w'), /Nothing in the library/);
});
