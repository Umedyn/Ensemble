// Context tiers (task G-4): the fixed parts of a prompt sized by the context
// window, memory fitted into what is left, a safety net for a call that
// would still overflow, and what is never cut.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, newGame, mockLLM } = require('./helpers');

const tool = import('../tools/context-report.mjs');
const userOf = (u) => (typeof u === 'string' ? u : u.user);
function at(E, context) {
  E.settings.backends.local.context = context;
  Object.keys(E.settings.routing).forEach((k) => { E.settings.routing[k] = 'local'; });
}

test('the tier follows the smallest context in use: compact up to 10K, standard up to 24K, roomy above', () => {
  const E = loadEngine();
  at(E, 8192);
  assert.equal(E.contextTier().id, 'compact');
  at(E, 12288);
  assert.equal(E.contextTier().id, 'standard');
  at(E, 32768);
  assert.equal(E.contextTier().id, 'roomy');
  // The shared prefix goes to every backend in use: the smallest decides.
  E.settings.backends.external.context = 8192;
  E.settings.routing.narrate = 'external';
  assert.equal(E.contextTier().id, 'compact');
});

test('every bundled world fits an 8K context forty turns in, the intent call\'s reply included', async () => {
  const { measure, worlds } = await tool;
  for (const w of worlds()) {
    const r = measure(w, 8192, true);
    const sum = r.totals.header + r.totals.intent + r.reply;
    assert.ok(sum <= 8192, `${w}: header ${r.totals.header} + intent ${r.totals.intent} + reply ${r.reply} = ${sum}`);
    assert.ok(r.totals.header + r.totals.narrate + 704 <= 8192, `${w}: the narrator's call fits too`);
  }
});

test('memory fills what the fixed parts leave: smaller budgets at 8K than the old shares, the old shares from 16K', () => {
  const { E, state } = newGame('occupied-france');
  at(E, 8192);
  const small = E.Memory.budgets(state);
  assert.ok(small.facts < 8192 * 0.2 && small.facts >= E.Memory.FLOOR.facts, `facts ${small.facts}`);
  assert.ok(small.story < 8192 * 0.12 && small.story >= E.Memory.FLOOR.story, `story ${small.story}`);
  at(E, 16384);
  assert.deepEqual({ ...E.Memory.budgets(state) }, { facts: Math.floor(16384 * 0.2), story: Math.floor(16384 * 0.12), lore: Math.floor(16384 * 0.1), tier: 'standard' });
});

test('compact facts: about the player and major ones first, then the newest, in the order they happened; standard keeps every major fact', () => {
  const { E, state } = newGame('zombie-holdout');
  at(E, 8192);
  const add = (i, w, about) => { const f = E.Memory.addFact(state, { about, text: `Fact ${i}: ${'word '.repeat(30)}.`, known_by: ['all'], weight: w }); f.turn = i; };
  for (let i = 0; i < 80; i++) add(i, i % 4 === 0 ? 3 : 1, i % 5 === 0 ? [state.player] : ['ortiz']);
  const turns = (block) => block.split('\n').map((l) => Number(/^- \[T(\d+)\]/.exec(l)[1]));
  const compact = turns(E.Memory.factsBlock(state));
  assert.ok(E.estTokens(E.Memory.factsBlock(state)) <= E.Memory.budgets(state).facts);
  assert.deepEqual(compact, compact.slice().sort((a, b) => a - b), 'in the order they happened');
  assert.ok(compact.includes(76) && compact.includes(75), 'the newest major fact and the newest about the player');
  assert.ok(!/Fact 0:/.test(E.Memory.factsBlock(state)), 'the oldest major fact gives way (the chapter summaries have it)');
  at(E, 16384);
  const standard = turns(E.Memory.factsBlock(state));
  for (let i = 0; i < 80; i += 4) assert.ok(standard.includes(i), `standard keeps major fact ${i}`);
});

test('major facts alone over the budget don\'t close a chapter every two turns', () => {
  const { E, state } = newGame('zombie-holdout');
  at(E, 8192);
  state.facts.forEach((f) => { f.weight = 3; });
  for (let i = 0; i < 80; i++) E.Memory.addFact(state, { about: [state.player], text: `Major ${i}: ${'word '.repeat(30)}.`, known_by: ['all'], weight: 3 });
  state.turn = state.chapterStartTurn + 2;
  assert.equal(E.Memory.needsChapter(state), false, 'a close would free nothing');
  E.Memory.addFact(state, { about: [state.player], text: 'A minor thing.', known_by: ['all'], weight: 1 });
  assert.equal(E.Memory.needsChapter(state), 'size');
});

test('a compact context shortens the outline and the user message, never what the engine checks against', () => {
  const { E, state } = newGame('occupied-france', 'roquette');
  at(E, 8192);
  const header = E.Prompts.header(state);
  const user = userOf(E.Prompts.intent(state, E.Engine.present(state), 'Look around.', 'about an hour', 'hour', { regional: true }));
  // Shorter: 12 regions in full and 20 names; Inside by who holds it; 6 nearby; groups that are here.
  assert.equal((header.split('=== REGIONS ===')[1].split('\n=== ')[0].match(/\n- /g) || []).length, 12);
  assert.match(user, /\nInside: Paris, a city \(paris\): held by The German occupation › Seine/);
  assert.equal(user.split('\n').find((l) => l.startsWith('Nearby:')).split(' | ').length, 6);
  assert.ok(!/Kingdom of Italy:/.test(user.split('\n').find((l) => l.startsWith('Groups:'))), 'Italy holds nothing near Paris');
  // The event ids: what the header shows and what is around, not the whole tree.
  assert.match(user, /regions: [^)]*\bparis-11\b/);
  assert.ok(!/\bmarseille-16\b/.test(user));
  // Never cut: rooms and their links, the cast, who is present, routes, secrets of those present.
  Object.keys(state.locations).forEach((id) => assert.match(header, new RegExp(`\\n- ${id}: `), `room ${id}`));
  [...state.order].forEach((id) => assert.match(header, new RegExp(`\\n- ${id}( \\(PLAYER\\))?: `), `cast ${id}`));
  assert.match(user, /exactly one intent for EACH present character: leroy/);
  assert.match(user, /\nRoutes from here: /);
  assert.match(user, /Nadine Leroy's secret: /);
  assert.match(user, /\nWays from here: Back room/);
  const update = userOf(E.Prompts.update(state, 'Look around.', { outcomes: [], events: [] }, 'You look around.', E.Engine.present(state), false));
  assert.match(update, /=== VALID IDS ===/);
  ['ferrand', 'marchal', 'backroom', 'cellar'].forEach((id) => assert.match(update, new RegExp(`\\b${id}\\b`), id));
});

test('the header is the same for every call in a turn at each tier', async () => {
  for (const ctx of [8192, 16384, 32768]) {
    const { E, state } = newGame('occupied-france', 'roquette');
    at(E, ctx);
    const { midGame } = await tool;
    midGame(E, state);
    const calls = mockLLM(E, ({ kind }) => (kind.startsWith('intent') ? { player: { needs_roll: false }, intents: [{ id: 'leroy', action: 'Waits.', says: null, reveals: null, visible: true }], events: [] } : kind === 'update' ? { facts: [] } : 'You look around.'));
    await E.Engine.runTurn(state, 'Look around.', 'moment');
    const systems = new Set(calls.filter((c) => /^(intent|narrate|update)/.test(c.kind)).map((c) => c.system));
    assert.equal(systems.size, 1, `${ctx}: one header for ${calls.map((c) => c.kind).join(', ')}`);
  }
});

test('a call that would still overflow drops lore, then the start of the last scene, then nearby regions, and says so; never the header', async () => {
  const E = loadEngine();
  at(E, 4096);
  const user = ['=== NOW ===', 'Region: Here', 'Nearby: A | B | C', '', '=== LORE (public knowledge; use it when it fits) ===', '- ' + 'lore '.repeat(600),
    '', '=== LAST SCENE ===', 'one '.repeat(300), '', 'two '.repeat(300), '', 'three '.repeat(40), '', 'four '.repeat(40), '', '=== TASK ===', 'Reply.'].join('\n');
  const system = 'header '.repeat(1700);
  const calls = mockLLM(E, () => 'Fine.');
  const seen = [];
  E.LLM.onCall = (entry) => seen.push(entry);
  await E.LLM.chat({ kind: 'narrate', system, user, maxTokens: 300 });
  assert.equal(calls[0].system, system, 'the header as it was');
  assert.ok(!/=== LORE/.test(calls[0].user), 'the lore went first');
  assert.match(calls[0].user, /=== LAST SCENE ===\n\[…\]\n\nthree/, 'then all but the end of the last scene');
  assert.match(calls[0].user, /=== TASK ===\nReply\./);
  assert.deepEqual([...seen[0].squeezed], ['lore', 'the start of the last scene']);
  // A call that fits is sent as it is.
  at(E, 32768);
  await E.LLM.chat({ kind: 'narrate', system, user, maxTokens: 300 });
  assert.equal(calls[1].user, user);
  assert.equal(seen[1].squeezed, null);
});
