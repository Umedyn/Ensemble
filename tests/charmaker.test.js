// Character creator (task 4-1): a start's playerSlot, point-buy, the made
// character (checked like an authored file) and Suggest.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, mockLLM } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));

// A small world whose one start has a slot. edit() changes the files first.
function slotWorld(edit) {
  const files = {
    'world.json': {
      format: 2, id: 'harbor', title: 'Grey Harbor', setting: 'A cold fishing town.', skills: ['social', 'physical', 'boats'], needs: [{ id: 'hunger', label: 'Hunger', perHour: 0.02 }],
      locations: [{ id: 'dock', name: 'The dock', desc: 'Wet planks.', connects: ['bar'] }, { id: 'bar', name: 'The bar', desc: 'Warm.', connects: ['dock'] }],
      portraitSet: ['portraits/a.png', 'portraits/b.png'],
      characters: ['mara', 'jonah'], starts: ['morning'],
    },
    'starts/morning.json': {
      id: 'morning', title: 'Morning catch', start: { day: 1, hour: 6 }, player: 'mara', cast: ['mara', 'jonah'], opening: 'Gulls overhead.',
      playerSlot: {
        location: 'bar', knows: ['The co-op owes the bank.'], needs: { hunger: 0.5 },
        roles: [{ id: 'deckhand', label: 'Deckhand', desc: 'Works the boats.', skills: { boats: 2, physical: 1 }, suggestedTraits: ['tough'] }, { id: 'clerk', label: 'Co-op clerk' }],
        peoples: [{ id: 'local', label: 'Harbor-born', suggestedTraits: ['wry'] }],
        skillPoints: 5, maxSkill: 3, relationsDefault: { jonah: 20 }, castFeelings: -10,
      },
    },
    'characters/mara.json': { id: 'mara', name: 'Mara', status: { location: 'dock' }, relations: { jonah: 10 } },
    'characters/jonah.json': { id: 'jonah', name: 'Jonah', role: 'fisher', want: 'a boat', status: { location: 'dock' }, relations: { mara: 5 } },
  };
  if (edit) edit(files);
  return files;
}
const load = (edit, E = loadEngine()) => ({ E, w: E.Scenario.prepareWorld('harbor', slotWorld(edit)) });
const slotOf = (f) => f['starts/morning.json'].playerSlot;
const startError = (edit) => load(edit).w.starts[0].error || '';
const form = (E, sc, more) => Object.assign(E.CharMaker.defaults(sc), { name: 'Ana Reyes', want: 'buy her own boat', traits: ['patient', 'proud'] }, more);

// ---------- the slot ----------

test('playerSlot: a start offers "Play as" and "Make my own"; a start without one only its own character', () => {
  const w = readWorld('mars-station');
  const recycler = w.starts.find((s) => s.id === 'recycler');
  const garage = w.starts.find((s) => s.id === 'garage');
  assert.equal(recycler.slot, true);
  assert.equal(recycler.defaultPlayer, 'Kit Navarro');
  assert.match(recycler.slotSummary, /your own crew member/);
  assert.equal(garage.slot, undefined);
  assert.equal(garage.defaultPlayer, 'Priya Raman');
  assert.equal(readWorld('zombie-holdout').starts[0].slot, true, 'the holdout start has a slot too');
});

test('playerSlot validation: rooms, skills, limits, roles and feelings are checked', () => {
  assert.equal(startError(), '');
  assert.match(startError((f) => { slotOf(f).location = 'boat'; }), /"location" must be one of the start's rooms/);
  assert.match(startError((f) => { slotOf(f).roles[0].skills = { sailing: 1 }; }), /skill "sailing" is not one of the world's skills/);
  assert.match(startError((f) => { slotOf(f).maxSkill = 5; }), /"maxSkill" must be a whole number from 1 to 4/);
  assert.match(startError((f) => { slotOf(f).roles[0].skills = { boats: 3, physical: 3 }; }), /use 6 points, more than skillPoints \(5\)/);
  assert.match(startError((f) => { slotOf(f).roles[0].skills = { boats: 4 }; slotOf(f).maxSkill = 3; }), /from 0 to maxSkill \(3\)/);
  assert.match(startError((f) => { slotOf(f).roles = []; }), /at least one entry in "roles", or "freeform": true/);
  assert.equal(startError((f) => { slotOf(f).roles = []; slotOf(f).freeform = true; }), '', 'freeform needs no roles');
  assert.match(startError((f) => { slotOf(f).roles.push({ id: 'deckhand', label: 'Again' }); }), /roles "deckhand" is listed twice/);
  assert.match(startError((f) => { slotOf(f).peoples[0].skills = { boats: 1 }; }), /only roles have "skills"/);
  assert.match(startError((f) => { slotOf(f).relationsDefault = { ghost: 10 }; }), /names "ghost", who isn't in this start's cast/);
  assert.match(startError((f) => { slotOf(f).castFeelings = 300; }), /"castFeelings" must be from -100 to 100/);
  assert.match(startError((f) => { slotOf(f).needs = { thirst: 0.2 }; }), /"needs" must map the world's needs/);
  assert.match(startError((f) => { slotOf(f).colour = 'red'; }), /playerSlot: unknown field "colour"/);
  assert.match(startError((f) => { slotOf(f).relationsDefault = { mara: 10 }; }), /names "mara"/, 'the authored player leaves the cast, so feelings about them are a mistake');
  assert.equal(startError((f) => { slotOf(f).relationsDefault = { mara: 10 }; slotOf(f).keepDefault = true; }), '', '…unless the slot keeps them');
});

test('playerSlot: a start may leave out "player"; without a slot it may not', () => {
  const { E, w } = load((f) => { delete f['starts/morning.json'].player; });
  const st = w.starts[0];
  assert.equal(st.error, undefined);
  assert.equal(st.defaultPlayer, null);
  assert.throws(() => E.Scenario.startScenario(w, 'morning'), /choose Make my own/);
  const c = E.CharMaker.build(st.scenario, form(E, st.scenario)).character;
  assert.equal(E.Scenario.startScenario(w, 'morning', c).player, 'ana-reyes');
  assert.throws(() => load((f) => { delete f['starts/morning.json'].player; delete slotOf(f).location; delete f['starts/morning.json'].playerSlot; }),
    /"player" must be in the cast \(or give the start a "playerSlot"/);
});

// ---------- point-buy ----------

test('point-buy: the role fills in its skills; going over the points or the cap is refused, not clamped', () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const CM = E.CharMaker;
  assert.deepEqual(plain(CM.defaults(sc).skills), { social: 0, physical: 1, boats: 2 }, 'the first role\'s skills, every world skill listed');
  assert.deepEqual(plain(CM.roleSkills(sc, 'clerk')), { social: 0, physical: 0, boats: 0 });
  assert.equal(CM.pointsLeft(sc, { boats: 2, physical: 1 }), 2);
  assert.deepEqual([...CM.skillProblems(sc, { boats: 3, physical: 2 })], []);
  assert.deepEqual([...CM.skillProblems(sc, { boats: 3, physical: 3 })], ['skills use 6 points; you have 5']);
  assert.deepEqual([...CM.skillProblems(sc, { boats: 4 })], ['boats must be from 0 to 3']);
  assert.deepEqual([...CM.skillProblems(sc, { sailing: 1 })], ['"sailing" is not one of this world\'s skills']);
  const out = CM.build(sc, form(E, sc, { skills: { boats: 3, physical: 3 } }));
  assert.match(out.errors.join(' '), /Skills use 6 points; you have 5/);
});

// ---------- the made character ----------

test('the made character: same shape as a character file, an id from the name, checked like one', () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const CM = E.CharMaker;
  const out = CM.build(sc, form(E, sc, { age: '34', people: 'local', description: 'Grew up on the docks.', voice: 'Short sentences.', secret: 'She sold the co-op\'s quota.', guard: 'high', portrait: 'portraits/b.png' }));
  assert.equal(out.errors, undefined);
  assert.deepEqual(plain(out.character), {
    id: 'ana-reyes', name: 'Ana Reyes', pronouns: 'they/them', role: 'Deckhand', people: 'Harbor-born', age: 34, traits: ['patient', 'proud'], want: 'buy her own boat',
    skills: { social: 0, physical: 1, boats: 2 }, relations: { jonah: 20 }, status: { health: 'ok', location: 'bar' },
    description: 'Grew up on the docks.', voice: 'Short sentences.', secret: 'She sold the co-op\'s quota.', guard: 'high', portrait: 'portraits/b.png',
    needs: { hunger: 0.5 }, knows: ['The co-op owes the bank.'],
  });
  assert.deepEqual([...E.Scenario.characterProblems(out.character, sc, new Set(['dock', 'bar']), ['jonah', 'ana-reyes'])], []);
});

test('the made character: missing or too-long answers come back as plain-language errors', () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const errs = E.CharMaker.build(sc, Object.assign(E.CharMaker.defaults(sc), { role: 'pirate', people: '' })).errors;
  assert.deepEqual([...errs], ['Give your character a name.', 'Pick a role.', 'Pick a people.', 'Say what your character wants.', 'Add at least one trait.']);
  const long = E.CharMaker.build(sc, form(E, sc, { traits: ['a'.repeat(31)], appearance: 'x'.repeat(401), age: 300, portrait: 'elsewhere.png' })).errors;
  assert.deepEqual([...long], ['Appearance can be at most 400 characters.', 'Each trait can be at most 30 characters.', 'Age must be a number from 1 to 129, or left empty.', 'Pick a portrait from the list.']);
});

test('the made character: freeform slots take a written role and people', () => {
  const { E, w } = load((f) => { slotOf(f).freeform = true; });
  const sc = w.starts[0].scenario;
  const c = E.CharMaker.build(sc, form(E, sc, { role: '', roleText: 'lighthouse keeper', people: '', peopleText: 'from up the coast' })).character;
  assert.equal(c.role, 'lighthouse keeper');
  assert.equal(c.people, 'from up the coast');
});

test('the made character: ids are slugs, made unique against people, rooms and groups', () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const CM = E.CharMaker;
  assert.equal(CM.slugId(sc, 'Dr. Ana Núñez'), 'ana-nunez');
  assert.equal(CM.slugId(sc, 'Jonah'), 'jonah-2');
  assert.equal(CM.slugId(sc, 'Bar'), 'bar-2');
  assert.equal(CM.slugId(sc, '!!!'), 'me');
});

test('the made character: portrait choices are a picture from the set, the stand-in, or initials only', () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const play = (portrait) => {
    const c = E.CharMaker.build(sc, form(E, sc, { portrait })).character;
    const state = E.Engine.newGame(E.Scenario.startScenario(w, 'morning', c));
    return plain(E.Engine.portrait(state, c.id));
  };
  assert.deepEqual(play('portraits/a.png'), { path: 'portraits/a.png' });
  assert.equal(play('standin').standIn, true);
  assert.equal(play('none').monogram, 'AR');
});

test('the made character starts the game: the authored player leaves, feelings both ways come from the slot', () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const c = E.CharMaker.build(sc, form(E, sc, { feelings: { jonah: -40 } })).character;
  const state = E.Engine.newGame(E.Scenario.startScenario(w, 'morning', c));
  assert.equal(state.player, 'ana-reyes');
  assert.deepEqual([...state.order], ['ana-reyes', 'jonah']);
  assert.equal(state.characters.mara, undefined, 'Mara leaves the cast');
  assert.deepEqual(plain(state.characters.jonah.relations), { 'ana-reyes': -10 }, 'castFeelings; feelings about Mara are gone');
  assert.equal(state.characters['ana-reyes'].relations.jonah, -40, 'the player\'s own setting wins over relationsDefault');
  assert.equal(state.characters['ana-reyes'].status.location, 'bar');
  assert.equal(state.scenario.madePlayer, 'ana-reyes');
  assert.ok(state.facts.some((f) => f.text === 'The co-op owes the bank.' && [...f.known_by].join() === 'ana-reyes'), 'the slot\'s knows are their private facts');
});

test('the made character: keepDefault keeps the authored player on as someone else in the cast', () => {
  const { E, w } = load((f) => { slotOf(f).keepDefault = true; });
  const sc = w.starts[0].scenario;
  const c = E.CharMaker.build(sc, form(E, sc)).character;
  assert.deepEqual(Object.keys(c.relations).sort(), ['jonah', 'mara']);
  const state = E.Engine.newGame(E.Scenario.startScenario(w, 'morning', c));
  assert.deepEqual([...state.order], ['ana-reyes', 'mara', 'jonah']);
  assert.equal(state.characters.mara.relations['ana-reyes'], -10);
  assert.equal(state.characters.mara.relations.jonah, 10);
});

test('the made character plays a turn in a bundled world, and is saved with the game', async () => {
  const E = loadEngine();
  const w = readWorld('zombie-holdout', E);
  const sc = w.starts[0].scenario;
  const c = E.CharMaker.build(sc, Object.assign(E.CharMaker.defaults(sc), { name: 'Sam Whitlock', want: 'get to the coast', traits: ['blunt'], role: 'trucker' })).character;
  const state = E.Engine.newGame(E.Scenario.startScenario(w, 'herd', c));
  assert.equal(state.characters.pike, undefined);
  assert.match(E.Prompts.header(state), /- sam-whitlock \(PLAYER\): Sam Whitlock \(they\/them\), Long-haul trucker\./);
  assert.doesNotMatch(E.Prompts.header(state), /Jordan Pike/);
  mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { summary: 'look around' }, intents: [], events: [] }
    : kind === 'update' ? { facts: [], state: [], relations: [], player_attitude: [] }
      : '[+0m] Marlene looks up from the cans.'));
  await E.Engine.runTurn(state, 'Look around the floor.', 'moment');
  assert.equal(state.turn, 1);
  const loaded = E.Engine.migrate(JSON.parse(JSON.stringify(state)));
  assert.equal(loaded.characters['sam-whitlock'].name, 'Sam Whitlock');
  assert.equal(loaded.scenario.characterData[0].id, 'sam-whitlock', 'the save embeds the scenario with the made character');
});

test('a saved character file loads back into the form', () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const CM = E.CharMaker;
  const c = CM.build(sc, form(E, sc, { role: 'clerk', skills: { social: 2 }, portrait: 'none', feelings: { jonah: 35 } })).character;
  const file = CM.toFile(Object.assign({}, c, { lastSeen: 3, tags: [] }));
  assert.equal(file.lastSeen, undefined, 'no play state in the file');
  assert.equal(file.status, undefined);
  const f = CM.formFrom(sc, JSON.parse(JSON.stringify(file)));
  assert.equal(f.role, 'clerk');
  assert.equal(f.portrait, 'none');
  assert.equal(f.feelings.jonah, 35);
  assert.deepEqual(plain(CM.build(sc, f).character), plain(c));
  const odd = CM.formFrom(sc, { name: 'Bo', role: 'smuggler', traits: ['quiet', 3] });
  assert.equal(odd.role, '');
  assert.equal(odd.roleText, 'smuggler');
  assert.deepEqual([...odd.traits], ['quiet']);
});

// ---------- Suggest ----------

test('Suggest: one field from the model, cleaned, returned to the page and never applied', async () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const f = form(E, sc, { traits: ['patient'] });
  const before = JSON.stringify(f);
  const calls = mockLLM(E, ({ user }) => (user.includes('personality traits') ? { traits: ['Patient', 'sharp-eyed', '"weathered."', 'x'.repeat(40), 'sharp-eyed'] } : { voice: 'Low and slow, like she\'s reading tide tables.' }));
  assert.deepEqual([...(await E.CharMaker.suggest(sc, 'traits', f))], ['sharp-eyed', 'weathered'], 'new traits only, short, no repeats');
  assert.equal(await E.CharMaker.suggest(sc, 'voice', f), 'Low and slow, like she\'s reading tide tables.');
  assert.equal(JSON.stringify(f), before, 'the form is untouched');
  assert.equal(calls[0].kind, 'worldbuild (character)', 'routed with world building');
  assert.match(calls[0].user, /=== MAKING A CHARACTER ===[\s\S]*Name: Ana Reyes[\s\S]*Role: Deckhand — Works the boats\./);
  assert.match(calls[0].system, /- ana-reyes \(PLAYER\): Ana Reyes/, 'the header is the one the game will use');
  await assert.rejects(E.CharMaker.suggest(sc, 'secret', f), /Nothing to suggest/);
});

test('Suggest: a reply that does not fit is refused; an unfinished form still gets a prompt', async () => {
  const { E, w } = load();
  const sc = w.starts[0].scenario;
  const CM = E.CharMaker;
  assert.equal(CM.cleanSuggestion('description', { description: 'x'.repeat(700) }).error, 'longer than 600 characters');
  assert.equal(CM.cleanSuggestion('voice', {}).error, 'no "voice"');
  assert.equal(CM.cleanSuggestion('traits', { traits: ['patient'] }, { traits: ['Patient'] }).error, 'no usable traits');
  const calls = mockLLM(E, () => ({ description: 'Worked the boats since she was twelve.' }));
  assert.equal(await CM.suggest(sc, 'description', CM.defaults(sc)), 'Worked the boats since she was twelve.');
  assert.match(calls[0].system, /the new character/);
  assert.doesNotMatch(calls[0].user, /Secret/);
});
