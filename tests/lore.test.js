// Lore entries (task 5-1): selection order and budget, keyword matching, the
// header staying put, region lore following the player, and validation.
const test = require('node:test');
const assert = require('node:assert');
const { loadEngine, worldFiles, newGame, mockLLM } = require('./helpers');

const plain = (x) => JSON.parse(JSON.stringify(x));
const ids = (picks) => [...picks].map((p) => p.id);
const entry = (id, more) => Object.assign({ id, title: id, level: 'topic', text: `About ${id}.` }, more);

// A Mars game with a lore list of our own. Kit is in the commons (station
// region) with Okafor and Bauer.
function marsWith(lore) {
  const g = newGame('mars-station');
  g.state.scenario.lore = lore;
  return g;
}

// ---------- selection ----------

test('lore selection ranks the room and people present, then the region, then keywords in the action, then in the last scene', () => {
  const { E, state } = marsWith([
    entry('scene-kw', { keywords: ['dust storm'], priority: 5 }),
    entry('action-kw', { keywords: ['recycler'] }),
    entry('region', { level: 'region', ref: 'station' }),
    entry('person', { level: 'character', ref: 'okafor' }),
    entry('room', { level: 'location', ref: 'commons' }),
    entry('elsewhere', { level: 'location', ref: 'lab' }),
    entry('absent', { level: 'character', ref: 'sorensen' }),
  ]);
  state.recent = [{ text: 'Okafor mentions the dust storm on the way.' }];
  const picks = E.Lore.select(state, { action: 'I ask about the recycler.' });
  assert.deepEqual(ids(picks), ['room', 'person', 'region', 'action-kw', 'scene-kw']);
  assert.deepEqual([...picks].map((p) => p.why), ['the player is here', 'Dr. Imani Okafor is present', "the player's region", '"recycler" in the action', '"dust storm" in the last scene']);
});

test('within a trigger, higher priority comes first, then the more specific level, then the order written', () => {
  const { E, state } = marsWith([
    entry('topic-a', { keywords: ['ice'] }),
    entry('world-a', { level: 'world', keywords: ['ice'] }),
    entry('region-a', { level: 'region', ref: 'crater-rim', keywords: ['ice'] }),
    entry('topic-b', { keywords: ['ice'] }),
    entry('urgent', { keywords: ['ice'], priority: 5 }),
    entry('minor', { keywords: ['ice'], priority: 1 }),
  ]);
  assert.deepEqual(ids(E.Lore.select(state, { action: 'Check the ice.' })), ['urgent', 'region-a', 'topic-a', 'topic-b', 'world-a', 'minor']);
});

test('lore stays within its budget: lower-ranked entries are dropped, and a smaller one later can still fit', () => {
  const { E, state } = marsWith([
    entry('first', { keywords: ['ice'], priority: 5, text: 'x'.repeat(300) }),
    entry('too-big', { keywords: ['ice'], priority: 4, text: 'y'.repeat(300) }),
    entry('small', { keywords: ['ice'], priority: 3, text: 'Short.' }),
  ]);
  const line = (id) => E.estTokens(E.Lore.line(state.scenario.lore.find((e) => e.id === id)));
  E.Memory.budgets = () => ({ facts: 1000, story: 1000, lore: line('first') + line('small') });
  const picks = E.Lore.select(state, { action: 'ice' });
  assert.deepEqual(ids(picks), ['first', 'small']);
  assert.ok(picks.reduce((n, p) => n + p.tokens, 0) <= line('first') + line('small'));
});

test('the lore budget is about a tenth of the memory context', () => {
  const E = loadEngine();
  E.settings.backends.local.context = 8192;
  assert.equal(E.Memory.budgets().lore, Math.floor(8192 * 0.1));
});

test('an entry triggered twice is included once with both reasons; always-on entries never repeat in the user message', () => {
  const { E, state } = marsWith([
    entry('both', { level: 'region', ref: 'station', keywords: ['modules'] }),
    entry('always', { level: 'world', alwaysOn: true, keywords: ['modules'] }),
  ]);
  const picks = E.Lore.select(state, { action: 'Walk the modules.' });
  assert.deepEqual(ids(picks), ['both']);
  assert.equal(picks[0].why, `the player's region; "modules" in the action`);
  assert.match(E.Prompts.header(state), /=== WORLD LORE ===\n- always: About always\./);
  const user = E.Prompts.intent(state, E.Engine.present(state), 'Walk the modules.', 'a moment', 'moment');
  assert.ok(!user.includes('About always.'), 'always-on lore stays in the header');
  assert.equal(user.split('About both.').length, 2, 'once');
});

// ---------- keywords ----------

test('lore keywords match whole words and phrases, ignoring case', () => {
  const { E } = newGame();
  const m = (k, t) => E.Lore.matches(k, t);
  assert.ok(m('Mule', 'we take the mule out'), 'case');
  assert.ok(m('mule', "The Mule's battery"), 'possessive');
  assert.ok(m('rover', '(rover)'), 'punctuation');
  assert.ok(m('ash', 'Ash, everywhere.'), 'start of text');
  assert.ok(!m('ash', 'the crash'), 'not inside a word');
  assert.ok(!m('ash', 'ashes'), 'not the start of a longer word');
  assert.ok(m('dust storm', 'a DUST  storm is coming'), 'a phrase, any spacing');
  assert.ok(!m('dust storm', 'dust stormy'), 'a phrase ends at a word edge');
  assert.ok(m('Zoë', 'ask zoë'), 'non-English letters');
  assert.ok(!m('Zoë', 'Zoëy'), 'non-English letters are word characters too');
  assert.ok(m('C++', 'learn c++ now'), 'regex characters are plain text');
  assert.ok(!m('', 'anything') && !m('word', ''), 'empty never matches');
});

test('lore keywords come from the player action and the last scene, not from anywhere else in the prompt', () => {
  const { E, state } = marsWith([entry('hellas', { keywords: ['Hellas'] })]);
  // The setting names Hellas, but only the action and the last scene count.
  state.recent = [];
  assert.deepEqual(ids(E.Lore.select(state, { action: 'Look around.' })), []);
  state.recent = [{ text: 'The wind comes up from Hellas.' }];
  assert.deepEqual(ids(E.Lore.select(state, { action: 'Look around.' })), ['hellas']);
});

// ---------- prompts and the cache ----------

test('the header is unchanged when the lore selection changes', () => {
  const { E, state } = newGame('mars-station');
  const header = E.Prompts.header(state);
  const present = E.Engine.present(state);
  const a = E.Prompts.intent(state, present, 'Ask about the Mule.', 'a moment', 'moment');
  const b = E.Prompts.intent(state, present, 'Ask about the cargo lander and the uplink.', 'a moment', 'moment');
  assert.notEqual(a.match(/=== LORE[\s\S]*?\n\n/)[0], b.match(/=== LORE[\s\S]*?\n\n/)[0], 'the selection differs');
  assert.match(a, /- The Mule:/);
  assert.match(b, /- The cargo lander:/);
  state.characters[state.player].status.location = 'surface';
  assert.equal(E.Prompts.header(state), header, 'and the header does not');
  assert.ok(!header.includes('The Mule:') && !header.includes('Life in the modules:'));
});

test('region lore swaps when the player changes region, within the same turn', async () => {
  const { E, state } = newGame('mars-station');
  state.characters[state.player].status.location = 'suitroom';
  const calls = mockLLM(E, ({ kind }) => {
    if (kind === 'intent') return { player: { summary: 'Kit steps out', needs_roll: false, move_to: 'surface' }, intents: [], events: [] };
    if (kind === 'update') return { facts: [], relations: [], needs: [], world: [], moves: [] };
    return '[+0m] You cycle the airlock and step out onto the rim.';
  });
  await E.Engine.runTurn(state, 'I cycle the airlock and step out.', 'moment');
  assert.equal(state.characters[state.player].status.location, 'surface');
  const intent = calls.find((c) => c.kind === 'intent');
  const narrate = calls.find((c) => c.kind === 'narrate');
  assert.match(intent.user, /- Life in the modules:/, 'the intent call is made where the player starts');
  assert.ok(!intent.user.includes('Working on the rim:'));
  assert.match(narrate.user, /- Working on the rim:/, 'the scene is told where the player ends up');
  assert.ok(!narrate.user.includes('Life in the modules:'));
  assert.equal(intent.system, narrate.system, 'one header for the turn');
  // Debug: the turn report says what each call included and why.
  const tel = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  assert.deepEqual(plain(tel.lore.filter((l) => l.id === 'station-life' || l.id === 'rim-work')), [
    { call: 'intent', id: 'station-life', title: 'Life in the modules', why: "the player's region" },
    { call: 'narrate', id: 'rim-work', title: 'Working on the rim', why: "the player's region" },
  ]);
  assert.match(E.Engine.turnReport(tel), /Lore included \(\d+\):\n- intent · station-life \(Life in the modules\): the player's region/);
});

// ---------- data and validation ----------

const zombieFiles = () => plain(worldFiles('zombie-holdout'));
const prepare = (E, files) => E.Scenario.prepareWorld('zombie-holdout', files);

test('lore loads from lore/ files (one entry or a packet) and inline, and a start adds or replaces entries by id', () => {
  const E = loadEngine();
  const f = zombieFiles();
  f['world.json'].lore.push('single', { id: 'inline', title: 'Inline', level: 'topic', text: 'Written in world.json.' });
  f['lore/single.json'] = { title: 'Single', level: 'topic', text: 'One entry, its id from the file name.' };
  f['starts/herd.json'].lore = [
    { id: 'evacuation', title: 'The evacuation', level: 'topic', keywords: ['buses'], text: 'As this start tells it.' },
    { id: 'herd-only', title: 'Herd only', level: 'topic', text: 'Only in this start.' },
  ];
  const w = prepare(E, f);
  const lore = w.starts[0].scenario.lore;
  const byId = (id) => lore.find((e) => e.id === id);
  assert.ok(byId('the-dead') && byId('ferris-store'), 'both packets');
  assert.equal(byId('single').text, 'One entry, its id from the file name.');
  assert.equal(byId('inline').text, 'Written in world.json.');
  assert.equal(byId('evacuation').text, 'As this start tells it.');
  assert.ok(byId('herd-only'));
  assert.equal(lore.filter((e) => e.id === 'evacuation').length, 1);
  assert.ok([...w.bundle.world.lore].every((e) => typeof e === 'object'), 'generated starts compose from resolved entries');
});

test('lore validation names missing files, bad entries and unknown refs', () => {
  const E = loadEngine();
  const problems = (edit) => {
    const f = zombieFiles();
    edit(f);
    try { prepare(E, f); return []; } catch (err) { return err.message.split('\n- ').slice(1); }
  };
  assert.deepEqual(problems((f) => f['world.json'].lore.push('nope')), ['missing lore/nope.json']);
  const bad = (more) => problems((f) => f['world.json'].lore.push(Object.assign({ id: 'bad', title: 'Bad', level: 'topic', text: 'Text.' }, more)));
  assert.match(bad({ level: 'galaxy' }).join(), /"level" must be one of world, region, location, character, topic/);
  assert.match(bad({ ref: 'junction' }).join(), /"ref" is only for region, location, character entries/);
  assert.match(bad({ level: 'region' }).join(), /"ref" must name the region/);
  assert.match(bad({ alwaysOn: true }).join(), /"alwaysOn" is for world entries only/);
  assert.match(bad({ priority: 9 }).join(), /"priority" must be a whole number from 1 to 5/);
  assert.match(bad({ text: 'x'.repeat(801) }).join(), /"text" must be text of at most 800/);
  assert.match(bad({ keywords: 'ice' }).join(), /"keywords" must be a list/);
  assert.match(bad({ sources: [{ title: 'Wiki' }] }).join(), /"sources" must be a list of \{title, url\}/);
  assert.match(bad({ level: 'region', ref: 'atlantis' }).join(), /lore "bad" is about unknown region "atlantis"/);
  assert.match(bad({ level: 'character', ref: 'nobody' }).join(), /lore "bad" is about unknown character "nobody"/);
  assert.match(bad({ id: 'the-dead' }).join(), /lore "the-dead" is listed twice/);
  assert.match(problems((f) => { f['starts/herd.json'].lore = ['town']; }).join(), /lore file ids work in world.json only/);
  assert.deepEqual(bad({ sources: [{ title: 'Wiki', url: 'https://example.org/page' }] }), [], 'sources are fine');
});

test('lore about a room no start has is a warning, since generated starts and sites make rooms of their own', () => {
  const E = loadEngine();
  const f = zombieFiles();
  f['world.json'].lore.push({ id: 'chop-shop', title: 'The chop shop', level: 'location', ref: 'chop-shop', keywords: ['chop shop'], text: 'Where cars go to disappear.' });
  const w = prepare(E, f);
  assert.ok(w.starts[0].scenario);
  assert.ok([...w.warnings].some((m) => /lore "chop-shop" is about "chop-shop", a room no start has/.test(m)));
});

test('lore that gives away a secret fails validation: lore is public and reaches the narrator', () => {
  const E = loadEngine();
  const f = zombieFiles();
  f['lore/town.json'].push({ id: 'gossip', title: 'Radio talk', level: 'topic', text: 'Somebody fixed a handheld radio and heard a rescue convoy broadcast heading for the coastal safe zone.' });
  assert.throws(() => prepare(E, f), /lore "gossip" gives away Ruth Han's secret/);
  // A secret a start gives its cast counts too.
  const g = zombieFiles();
  g['starts/herd.json'].cast = g['starts/herd.json'].cast.map((c) => ((c.id || c) === 'ferris' ? Object.assign(typeof c === 'string' ? { id: c } : c, { secret: 'He coached Little League for a decade and counts the till drawer nightly.' }) : c));
  assert.throws(() => prepare(E, g), /lore "ferris-store" gives away Gil Ferris's secret/);
});

test('flat scenario validation checks lore shape and region refs, and old saves without lore still play', () => {
  const { E, state } = newGame('mars-station');
  const sc = plain(state.scenario);
  sc.lore = [{ id: 'x', title: 'X', level: 'region', ref: 'atlantis', text: 'Nowhere.' }];
  assert.throws(() => E.Scenario.validate(sc), /lore "x" is about unknown region "atlantis"/);
  sc.lore = 'nope';
  assert.throws(() => E.Scenario.validate(sc), /"lore" must be a list of entries/);
  delete state.scenario.lore;
  assert.deepEqual(ids(E.Lore.select(state, { action: 'Ask about the Mule.' })), []);
  assert.ok(!E.Prompts.header(state).includes('WORLD LORE'));
});

test('bundled worlds have lore at every level, for the player region and with keywords', () => {
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const { E, state } = newGame(folder);
    const lore = E.Lore.entries(state.scenario);
    ['world', 'region', 'location', 'character', 'topic'].forEach((lv) => assert.ok(lore.some((e) => e.level === lv), `${folder}: a ${lv} entry`));
    assert.ok(E.Lore.always(state.scenario).length, `${folder}: an always-on entry`);
    assert.ok(lore.some((e) => e.level === 'region' && e.ref === E.Engine.playerRegion(state)), `${folder}: lore for the starting region`);
  }
});

// ---------- topics and the last fallback (task 5-5) ----------

// A Mars game whose player has the given role (set before anything reads it:
// the player's topics are worked out once per game).
function marsAs(role, lore, more) {
  const g = marsWith(lore);
  const sheet = g.state.scenario.characterData.find((c) => c.id === g.state.player);
  Object.assign(sheet, { role, traits: [], tags: [] }, more);
  return g;
}

test('two players in the same region pull different lore by topic: a student gets the schools, a manager the business side', () => {
  const lore = () => [
    entry('rim', { level: 'region', ref: 'crater-rim' }),
    entry('tube', { level: 'region', ref: 'lava-tube' }),
    entry('schools', { level: 'world', topics: ['school'] }),
    entry('contracts', { level: 'world', topics: ['business'] }),
    entry('crews', { topics: ['work', 'business'] }),
  ];
  const run = (role) => {
    const { E, state } = marsAs(role, lore());
    // The surface is inside the lava tube (found by now), inside the crater rim.
    state.locations.surface.region = 'lava-tube';
    delete state.regions['lava-tube'].known;
    state.characters[state.player].status.location = 'surface';
    return E.Lore.select(state, { action: 'Look around.', scene: '' });
  };
  const student = run('exchange student');
  const manager = run('operations manager');
  // After the player's own region, before the regions up the tree.
  assert.deepEqual(ids(student), ['tube', 'schools', 'rim']);
  assert.deepEqual(ids(manager), ['tube', 'crews', 'contracts', 'rim']);
  assert.equal(student[1].why, 'topic "school" (the player character)');
  assert.equal(manager[1].why, 'topic "business" (the player character)');
});

test("the player character's topics come from their role, traits and tags, plus their own topics, and are worked out once per game", () => {
  const { E, state } = marsAs('night-shift bartender', [], { traits: ['devout'], tags: ['army veteran'], topics: ['arts'] });
  assert.deepEqual([...E.Lore.playerTopics(state)], ['military', 'nightlife', 'arts']);
  // Fixed for the game: a new tag in play doesn't change them.
  state.characters[state.player].tags.push({ text: 'hospital patient', set: 1, until: null });
  assert.deepEqual([...E.Lore.playerTopics(state)], ['military', 'nightlife', 'arts']);
  // A world's own topic, with its words.
  const g = marsAs('ice miner', []);
  g.state.scenario.loreTopics = { mining: ['miner', 'ore'] };
  assert.deepEqual([...g.E.Lore.playerTopics(g.state)], ['mining']);
});

test("a keyword still brings in an off-topic entry, and a topic's words in the action or the last scene bring in its entries", () => {
  const { E, state } = marsAs('exchange student', [
    entry('station', { level: 'region', ref: 'station' }),
    entry('exchange', { level: 'world', topics: ['business'], keywords: ['stock exchange'] }),
    entry('gangs', { topics: ['crime'] }),
    entry('chapel', { topics: ['religion'] }),
  ]);
  const picks = E.Lore.select(state, { action: 'I ask Okafor about the stock exchange.', scene: '' });
  assert.deepEqual(ids(picks), ['station', 'exchange']);
  assert.equal(picks[1].why, '"stock exchange" in the action');
  const gangs = E.Lore.select(state, { action: 'I ask about the gangs.', scene: 'Bauer says a prayer.' });
  assert.deepEqual(ids(gangs), ['station', 'gangs', 'chapel']);
  assert.deepEqual([...gangs].map((p) => p.why).slice(1), ['topic "crime" in the action', 'topic "religion" in the last scene']);
});

test('entries about a room, person or region keep their places; a matching topic only puts them first within their trigger', () => {
  const { E, state } = marsAs('pilot', [
    entry('plain', { level: 'location', ref: 'commons', priority: 5 }),
    entry('flights', { level: 'location', ref: 'commons', topics: ['travel'] }),
    entry('far', { level: 'region', ref: 'basin-floor', topics: ['travel'] }),
  ]);
  const picks = E.Lore.select(state, { action: 'Look around.', scene: '' });
  assert.deepEqual(ids(picks), ['flights', 'plain']);
  assert.equal(picks[0].why, 'the player is here; topic "travel" (the player character)');
});

test('a region with no lore anywhere up its chain falls back to the world entries, best priority first and last of all', () => {
  const { E, state } = marsWith([
    entry('history', { level: 'world', priority: 2 }),
    entry('program', { level: 'world', priority: 4 }),
    entry('always', { level: 'world', alwaysOn: true }),
    entry('basin', { level: 'region', ref: 'basin-floor' }),
    entry('lander', { keywords: ['lander'] }),
  ]);
  const picks = E.Lore.select(state, { action: 'Ask about the lander.', scene: '' });
  assert.deepEqual(ids(picks), ['lander', 'program', 'history'], 'always-on entries are in the header already');
  assert.equal(picks[1].why, 'world lore (nothing here has its own)');
  // Once the region (or the room) has lore, the world entries wait for their keywords.
  state.scenario.lore.push(entry('station', { level: 'region', ref: 'station' }));
  assert.deepEqual(ids(E.Lore.select(state, { action: 'Ask about the lander.', scene: '' })), ['station', 'lander']);
  state.scenario.lore.pop();
  state.scenario.lore.push(entry('commons', { level: 'location', ref: 'commons' }));
  assert.deepEqual(ids(E.Lore.select(state, { action: 'Look around.', scene: '' })), ['commons']);
});

test('topic picks never touch the header and stay within the lore budget', () => {
  const big = (id, t) => entry(id, { level: 'world', topics: t, text: 'z'.repeat(400) });
  const { E, state } = marsAs('pilot and engineer', [entry('station', { level: 'region', ref: 'station', text: 'S.' }), big('a', ['travel']), big('b', ['tech']), big('c', ['travel']), big('d', ['crime'])]);
  const header = E.Prompts.header(state);
  const budget = E.estTokens(E.Lore.line(state.scenario.lore[1])) * 2 + 10;
  E.Memory.budgets = () => ({ facts: 1000, story: 1000, lore: budget });
  const present = E.Engine.present(state);
  const a = E.Prompts.intent(state, present, 'Check the rover.', 'a moment', 'moment');
  const b = E.Prompts.intent(state, present, 'Ask about the smugglers.', 'a moment', 'moment');
  assert.match(a, /- a: z+/);
  assert.equal(E.Prompts.header(state), header);
  assert.ok(!header.includes('zzz'), 'no topic entry in the header');
  const picks = E.Lore.select(state, { action: 'Ask about the smugglers.' });
  assert.deepEqual(ids(picks), ['station', 'd', 'a'].slice(0, picks.length));
  assert.ok(picks.reduce((n, p) => n + p.tokens, 0) <= budget);
  assert.ok(b.includes('- d: z'), 'the smugglers bring in crime');
});

test('topics are validated: unknown tags named in plain words, at most four, and a world may add its own', () => {
  const E = loadEngine();
  const problems = (edit) => {
    const f = zombieFiles();
    edit(f);
    try { prepare(E, f); return []; } catch (err) { return err.message.split('\n- ').slice(1); }
  };
  const tagged = (topics, more) => problems((f) => { f['world.json'].lore.push({ id: 'tagged', title: 'Tagged', level: 'topic', text: 'Text.', topics }); if (more) more(f); });
  assert.match(tagged(['skool']).join(), /lore "tagged": "skool" is not a topic this world knows \(school, work, .*scavenging\); add it to the world's "loreTopics"/);
  assert.match(tagged(['school', 'work', 'crime', 'family', 'health']).join(), /"topics" must be a list of at most 4 topic tags/);
  assert.match(tagged('school').join(), /"topics" must be a list/);
  assert.deepEqual(tagged(['school', 'scavenging']), []);
  assert.deepEqual(tagged(['farming'], (f) => { f['world.json'].loreTopics.farming = ['farmer', 'harvest']; }), []);
  assert.match(problems((f) => { f['world.json'].loreTopics = ['farming']; }).join(), /"loreTopics" must map each topic to the words/);
  assert.match(problems((f) => { f['world.json'].loreTopics = { Farming: ['farmer'] }; }).join(), /topic "Farming" must be a short lowercase tag/);
  assert.match(problems((f) => { f['world.json'].loreTopics = { farming: 'farmer' }; }).join(), /topic "farming" must list at most 20 words/);
  // A character's own topics are checked with the start that casts them.
  const startError = (topics) => { const f = zombieFiles(); f['characters/pike.json'].topics = topics; return prepare(E, f).starts[0].error; };
  assert.match(startError(['astrology']), /character "pike": "astrology" is not a topic this world knows/);
  assert.equal(startError(['family', 'scavenging']), undefined);
});

test("bundled worlds tag some entries with topics, and the holdout's driver gets the roads by topic", () => {
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const { E, state } = newGame(folder);
    assert.ok(E.Lore.entries(state.scenario).filter((e) => e.topics).length >= 3, `${folder}: entries with topics`);
  }
  const { E, state } = newGame('zombie-holdout');
  assert.ok([...E.Lore.playerTopics(state)].includes('travel'), 'a former delivery driver');
  const roads = [...E.Lore.select(state, { action: 'Look around.', scene: '' })].find((p) => p.id === 'the-roads');
  assert.ok(roads && /topic "travel" \(the player character\)/.test(roads.why));
});
