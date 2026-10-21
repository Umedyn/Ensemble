// Mood and tags (task 1-6): the update step proposes them, the engine checks
// length, feelings, duplicates, the cap, expiry and secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, loadEngine, readScenario } = require('./helpers');

const PRESENT = ['okafor', 'bauer'];
const texts = (c) => [...(c.tags || []).map((t) => t.text)];
const update = (E, state, items, turn = 1) => E.Engine.applyUpdate(state, { state: items }, PRESENT, { turn });
const tag = (id, value, extra) => Object.assign({ target: `char:${id}`, field: 'add_tag', value }, extra);

test('a tag lasts its turns, is refreshed when proposed again, and expires after', () => {
  const { E, state } = newGame();
  update(E, state, [tag('bauer', 'grease on his sleeves', { turns: 2, reason: 'fixed the pump' })], 1);
  const t = state.characters.bauer.tags[0];
  assert.deepEqual({ text: t.text, set: t.set, until: t.until, reason: t.reason }, { text: 'grease on his sleeves', set: 1, until: 3, reason: 'fixed the pump' });
  update(E, state, [tag('bauer', 'Grease on his sleeves', { turns: 2 })], 2);
  assert.equal(state.characters.bauer.tags.length, 1);
  assert.equal(state.characters.bauer.tags[0].until, 4, 'refreshed');
  assert.deepEqual([...E.Engine.expireTags(state, 4)], []);
  assert.deepEqual([...E.Engine.expireTags(state, 5)], ['Teo Bauer: "grease on his sleeves" expired']);
  assert.deepEqual(texts(state.characters.bauer), []);
});

test('turns default to 6 and are clamped to 1–30', () => {
  const { E, state } = newGame();
  update(E, state, [tag('bauer', 'on night shift'), tag('okafor', 'in her flight suit', { turns: 99 })], 2);
  assert.equal(state.characters.bauer.tags[0].until, 8);
  assert.equal(state.characters.okafor.tags[0].until, 32);
});

// Playtest 2026-10-19: "dust pneumonitis, on oxygen" and "on oxygen,
// saturation 91 and drifting" both stuck to Raman.
test('a near-duplicate tag replaces the old one instead of piling up', () => {
  const { E, state } = newGame();
  state.characters.raman.status.location = 'commons';
  const r = E.Engine.applyUpdate(state, { state: [tag('raman', 'on oxygen'), tag('raman', 'saturation 91, on oxygen')] }, ['raman'], { turn: 1 });
  assert.deepEqual(texts(state.characters.raman), ['saturation 91, on oxygen']);
  assert.ok(r.tags.some((x) => /replaces "on oxygen"/.test(x)));
  update(E, state, [tag('bauer', 'avoiding Okafor'), tag('bauer', 'helping Okafor')]);
  assert.deepEqual(texts(state.characters.bauer), ['avoiding Okafor', 'helping Okafor'], 'sharing only a name is not a duplicate');
});

test('at most 4 tags: the oldest expiring one is dropped and reported', () => {
  const { E, state } = newGame('zombie-holdout'); // Dex starts with a lasting "bandaged left forearm"
  const dex = state.characters.coleman;
  const present = ['coleman'];
  const add = (v, turn) => E.Engine.applyUpdate(state, { state: [tag('coleman', v)] }, present, { turn });
  add('muddy boots', 1); add('shotgun slung', 2); add('radio on his belt', 3);
  const r = add('sitting by the door', 4);
  assert.deepEqual(texts(dex), ['bandaged left forearm', 'shotgun slung', 'radio on his belt', 'sitting by the door']);
  assert.ok(r.tags.some((x) => /dropped "muddy boots" \(at most 4\)/.test(x)));
});

test('feelings, need names and long phrases are rejected as tags, and reported', () => {
  const { E, state } = newGame();
  const r = update(E, state, [
    tag('bauer', 'anxious'), tag('bauer', 'high stress'),
    tag('bauer', 'covered in recycler grease from elbow to wrist'), tag('bauer', '"[on edge]"'),
    // playtest-id-tags-in-prose: a feeling with a subject is still a feeling
    tag('bauer', 'anxious about recycler'), tag('bauer', 'worried for Priya'),
  ]);
  assert.deepEqual(texts(state.characters.bauer), []);
  assert.equal(r.rejected.length, 6);
  assert.ok(r.rejected.some((x) => /too long/.test(x)) && r.rejected.some((x) => /a feeling, not a tag/.test(x)));
});

test('remove_tag removes a tag; removing one that is not there is reported', () => {
  const { E, state } = newGame();
  update(E, state, [tag('bauer', 'alone at the console')]);
  const r = update(E, state, [{ target: 'char:bauer', field: 'remove_tag', value: 'Alone at the console' }, { target: 'char:bauer', field: 'remove_tag', value: 'asleep' }], 2);
  assert.deepEqual(texts(state.characters.bauer), []);
  assert.equal(r.rejected.length, 1);
});

test('mood is set with its turn and reason, cut at a word, and never for the player', () => {
  const { E, state } = newGame();
  const r = update(E, state, [
    { target: 'char:okafor', field: 'mood', value: 'clipped and distant, keeps glancing at the weather relay and not at anyone in the room', reason: 'the storm' },
    { target: 'char:navarro', field: 'mood', value: 'annoyed' },
  ], 3);
  const m = state.characters.okafor.mood;
  assert.ok(m.text.length <= 60 && m.text.endsWith('…') && m.turn === 3 && m.reason === 'the storm');
  assert.equal(state.characters.navarro.mood, undefined);
  assert.ok(r.rejected.some((x) => /the player's mood comes from the player/.test(x)));
});

test('a mood that gives away the secret is rejected (the card shows it to the player)', () => {
  const { E, state } = newGame();
  const r = update(E, state, [{ target: 'char:bauer', field: 'mood', value: 'guilty about running the recycler past its rated cycle' }]);
  assert.equal(state.characters.bauer.mood, undefined);
  assert.ok(r.rejected.some((x) => /gives away their secret/.test(x)));
  update(E, state, [{ target: 'char:bauer', field: 'mood', value: 'jumpy, talking too fast' }]);
  assert.equal(state.characters.bauer.mood.text, 'jumpy, talking too fast');
});

test('derived tags come from needs and health at thresholds, and a world can override them', () => {
  const { E, state } = newGame();
  const teo = state.characters.bauer;
  const derived = () => [...E.Engine.derivedTags(state, teo)];
  teo.needs.stress = 0.79;
  assert.deepEqual(derived(), []);
  teo.needs.stress = 0.8;
  teo.needs.fatigue = 0.95;
  teo.status.health = 'hurt';
  assert.deepEqual(derived(), ['hurt', 'exhausted', 'on edge']);
  state.scenario.tagThresholds = { stress: { at: 0.9, tag: 'frayed' }, hunger: { at: 0.1, tag: 'peckish' } };
  assert.deepEqual(derived(), ['hurt', 'peckish', 'exhausted']);
  teo.status.health = 'dead';
  assert.deepEqual(derived(), ['dead']);
});

test('moods and tags appear in the status lines of the user message, never the header', async () => {
  const { E, state } = newGame();
  update(E, state, [tag('bauer', 'grease on his sleeves'), { target: 'char:bauer', field: 'mood', value: 'jumpy, talking too fast' }]);
  const calls = mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { summary: 'x' }, intents: [], events: [] } : '[+0m] Teo fidgets.'));
  await E.Engine.runTurn(state, 'Look at Teo.', 'moment');
  for (const c of calls) {
    // (the narrator's line also has "looks:", task 1-7, and no id)
    assert.match(c.user, /Teo Bauer \(he\/him\)( \[bauer\])?: health unhurt;( looks: [^;]+;)? mood: jumpy, talking too fast; tags: grease on his sleeves/, c.kind);
    assert.doesNotMatch(c.system, /jumpy|grease on his sleeves/);
  }
});

test('the turn commit expires old tags and lists tag and mood changes in Debug', async () => {
  const { E, state } = newGame();
  update(E, state, [tag('bauer', 'grease on his sleeves', { turns: 1 })], 0);
  mockLLM(E, ({ kind }) => {
    if (kind === 'intent') return { player: { summary: 'x' }, intents: [], events: [] };
    if (kind === 'update') return { facts: [], state: [{ target: 'char:okafor', field: 'mood', value: 'brisk', reason: 'storm prep' }] };
    return '[+0m] Teo fidgets.';
  });
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.deepEqual(texts(state.characters.bauer), []);
  const guards = E.Engine.telemetry.flatMap((t) => [...t.guards]).filter((g) => g.type === 'tags & mood').map((g) => g.detail);
  assert.ok(guards.includes('Teo Bauer: "grease on his sleeves" expired'));
  assert.ok(guards.includes('Dr. Imani Okafor: mood "brisk" (storm prep)'));
});

test('character-file conditions and tags start as lasting tags', () => {
  const { state } = newGame('zombie-holdout');
  const dex = state.characters.coleman;
  assert.deepEqual([...dex.tags.map((t) => [t.text, t.until])], [['bandaged left forearm', null]]);
  assert.equal(dex.status.conditions, undefined);
  const E = loadEngine();
  const sc = readScenario('mars-station');
  sc.characterData[1].tags = ['reading glasses'];
  const s2 = E.Engine.newGame(E.Scenario.validate(sc));
  assert.deepEqual(texts(s2.characters[sc.characterData[1].id]), ['reading glasses']);
});

test('save migration v2→v3 turns conditions into lasting tags, in the pending step-in copy too', () => {
  const { E, state } = newGame('zombie-holdout');
  const v2 = JSON.parse(JSON.stringify(state));
  v2.version = 2;
  for (const c of Object.values(v2.characters)) { c.status.conditions = c.tags.map((t) => t.text); delete c.tags; }
  v2.characters.ortiz.status.conditions = ['flour on her hands'];
  v2.pending = { pre: { characters: JSON.parse(JSON.stringify(v2.characters)) } };
  const v3 = E.Engine.migrate(v2);
  assert.equal(v3.version, E.Engine.STATE_VERSION);
  assert.deepEqual([...v3.characters.coleman.tags.map((t) => [t.text, t.until])], [['bandaged left forearm', null]]);
  assert.deepEqual(texts(v3.characters.ortiz), ['flour on her hands']);
  assert.equal(v3.characters.ortiz.status.conditions, undefined);
  assert.deepEqual(texts(v3.pending.pre.characters.ortiz), ['flour on her hands']);
});

test('validation checks character tags and tagThresholds', () => {
  const E = loadEngine();
  const bad = (edit) => () => { const sc = readScenario('mars-station'); edit(sc); return E.Scenario.validate(sc); };
  assert.throws(bad((sc) => { sc.characterData[1].tags = 'reading glasses'; }), /tags must be a list of short phrases/);
  assert.throws(bad((sc) => { sc.characterData[1].status.conditions = ['x'.repeat(33)]; }), /status\.conditions must be a list/);
  assert.throws(bad((sc) => { sc.tagThresholds = { thirst: { at: 0.8, tag: 'parched' } }; }), /tagThresholds\.thirst/);
  assert.throws(bad((sc) => { sc.tagThresholds = { stress: { at: 2, tag: 'x' } }; }), /tagThresholds\.stress/);
  assert.doesNotThrow(bad((sc) => { sc.tagThresholds = { stress: { at: 0.7, tag: 'frayed' } }; sc.characterData[1].tags = ['reading glasses']; }));
});
