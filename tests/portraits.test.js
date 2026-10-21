// Portraits and card details (task 1-7): stand-ins picked by id, monograms,
// validation, what the player knows about someone, and saves without images.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, loadEngine, readScenario, mockLLM } = require('./helpers');

test('a character with a portrait uses it', () => {
  const { E, state } = newGame();
  state.characters.okafor.portrait = 'portraits/okafor.png';
  assert.deepEqual({ ...E.Engine.portrait(state, 'okafor') }, { path: 'portraits/okafor.png' });
});

test('stand-in portraits are picked from the world set by id: always the same, spread across the set', () => {
  const { E, state } = newGame();
  state.scenario.portraitSet = ['portraits/set/a.png', 'portraits/set/b.png', 'portraits/set/c.png'];
  const pick = (id) => E.Engine.portrait(state, id).path;
  const first = Object.keys(state.characters).map(pick);
  assert.deepEqual(Object.keys(state.characters).map(pick), first, 'same every time');
  assert.ok(E.Engine.portrait(state, 'bauer').standIn);
  assert.equal(pick('bauer'), state.scenario.portraitSet[E.hash('bauer') % 3], 'hash of the id');
  const E2 = loadEngine();
  assert.equal(E2.hash('bauer'), E.hash('bauer'), 'the same in a fresh engine (no randomness)');
  assert.ok(new Set(first).size > 1, 'five people do not all get the same face');
});

test('without a portrait or a set, a monogram: initials (titles skipped) on a hue from the id', () => {
  const { E, state } = newGame();
  const m = (id) => ({ ...E.Engine.portrait(state, id) });
  assert.deepEqual(m('sorensen'), { monogram: 'LS', hue: E.hash('sorensen') % 360 });
  assert.equal(m('navarro').monogram, 'KN');
  state.characters.raman.name = 'Priya';
  assert.equal(m('raman').monogram, 'PR', 'one name: first two letters');
});

test('what you know about someone lists only facts the player knows, newest first', () => {
  const { E, state } = newGame();
  const add = (text, known_by) => E.Memory.addFact(state, { about: ['bauer'], text, known_by, weight: 2 });
  add('Teo blamed the rattle on a sensor issue.', ['navarro', 'bauer']);
  add('Teo wiped the night log.', ['bauer']);
  add('Teo was on the late shift.', ['all']);
  E.Memory.addFact(state, { about: ['okafor'], text: 'Okafor wants the arrays secured.', known_by: ['all'], weight: 2 });
  assert.deepEqual([...E.Engine.knownAbout(state, 'bauer').map((f) => f.text)], ['Teo was on the late shift.', 'Teo blamed the rattle on a sensor issue.']);
  assert.ok(!E.Engine.knownAbout(state, 'sorensen').some((f) => /lab time/.test(f.text)), "Okafor's private note about Lev stays hidden");
});

test('validation: portrait and portraitSet are image paths inside the world folder; description and appearance are short text', () => {
  const E = loadEngine();
  const bad = (edit) => () => { const sc = readScenario('mars-station'); edit(sc); return E.Scenario.validate(sc); };
  for (const p of ['../okafor.png', '/okafor.png', 'https://example.com/okafor.png', 'portraits/okafor.exe', 'data:image/png;base64,AAAA']) {
    assert.throws(bad((sc) => { sc.characterData[1].portrait = p; }), /portrait must be an image path inside the world folder/, p);
  }
  assert.throws(bad((sc) => { sc.portraitSet = ['portraits/a.png', '../b.png']; }), /"portraitSet" must be a list of image paths/);
  assert.throws(bad((sc) => { sc.characterData[1].description = 'x'.repeat(601); }), /description must be text of at most 600/);
  assert.throws(bad((sc) => { sc.characterData[1].appearance = 42; }), /appearance must be text/);
  assert.doesNotThrow(bad((sc) => {
    Object.assign(sc.characterData[1], { portrait: 'portraits/okafor.webp', description: 'Station lead.', appearance: 'Tall, close-cropped grey hair.' });
    sc.portraitSet = ['portraits/stand-ins/01.png'];
  }));
});

test('saves keep portrait paths only, never image data or object URLs', () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  sc.characterData[1].portrait = 'portraits/okafor.png';
  sc.portraitSet = ['portraits/set/a.png'];
  const state = E.Engine.newGame(E.Scenario.validate(sc));
  const json = JSON.stringify(state);
  assert.ok(json.includes('"portraits/okafor.png"'));
  assert.doesNotMatch(json, /blob:|data:image/);
});

test('a world opened from a folder keeps its image files for the page, outside the scenario', async () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  const files = [['world/scenario.json', JSON.stringify(Object.assign({}, sc, { characterData: undefined, folder: undefined }))]]
    .concat(sc.characterData.map((c) => [`world/characters/${c.id}.json`, JSON.stringify(c)]))
    .concat([['world/portraits/okafor.png', 'PNG'], ['world/notes.txt', 'x']])
    .map(([p, body]) => ({ webkitRelativePath: p, name: p.split('/').pop(), text: async () => body }));
  const { worlds } = await E.Scenario.loadFromFiles(files);
  assert.deepEqual(Object.keys(worlds[0].assets), ['portraits/okafor.png']);
  assert.ok(!('assets' in worlds[0].starts[0].scenario));
});

// One sentence of appearance per person, only for the people in the scene,
// in the narrator's user message (never the cached header).
test('the narrator sees how the people in the scene look, and no one else', async () => {
  const { E, state } = newGame();
  state.characters.bauer.appearance = 'Gangly and freckled. Second sentence that stays out.';
  const calls = mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { summary: 'x' }, intents: [], events: [] } : '[+0m] Teo fidgets.'));
  await E.Engine.runTurn(state, 'Look at Teo.', 'moment');
  const narrate = calls.find((c) => c.kind === 'narrate');
  assert.match(narrate.user, /\[bauer\]: health unhurt; looks: Gangly and freckled;/);
  assert.doesNotMatch(narrate.user, /Second sentence/);
  assert.match(narrate.user, /\[okafor\]: health unhurt; looks: Tall and straight-backed/, 'Okafor is in the room');
  assert.doesNotMatch(narrate.user, /Lanky and stooped/, 'Lev is in the lab');
  for (const c of calls) assert.doesNotMatch(c.system, /looks:|Gangly/, `${c.kind}: not in the header`);
  assert.doesNotMatch(calls.find((c) => c.kind === 'intent').user, /looks:/, 'the intent call does not need it');
});
