// Scoped memory (task B-0): facts load by what the scene touches. The header
// keeps a core frozen between chapter closes; the rest goes in the user
// message, by compartment, within the facts budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM } = require('./helpers');

function at(E, context) {
  E.settings.backends.local.context = context;
  Object.keys(E.settings.routing).forEach((k) => { E.settings.routing[k] = 'local'; });
}
// A game with its start facts out of the way, and two rooms.
function game(ctx = 8192) {
  const g = newGame('zombie-holdout');
  at(g.E, ctx);
  const { E, state } = g;
  const here = state.characters[state.player].status.location;
  const elsewhere = Object.keys(state.locations).find((id) => id !== here && !E.Engine.present(state, id).length) || Object.keys(state.locations).find((id) => id !== here);
  const absent = E.Engine.cast(state).find((id) => id !== state.player && !E.Engine.present(state).includes(id));
  state.recent = [];
  return { ...g, here, elsewhere, absent };
}
const add = (E, state, text, o) => E.Memory.addFact(state, Object.assign({ about: [], text, known_by: ['all'], weight: 1 }, o));
const texts = (E, state, opts) => E.Memory.sceneFacts(state, opts).map((p) => p.fact.text);
const closeChapter = (E, state) => E.Memory.closeChapter(state, { title: 'A', summary: 'B' }, 'test');

test("a room's facts load only when the scene is there or the room is named", () => {
  const { E, state, elsewhere } = game();
  const f = add(E, state, 'The generator coughs at night.', { where: elsewhere });
  assert.ok(!texts(E, state).includes(f.text), 'not from another room');
  assert.ok(texts(E, state, { room: elsewhere }).includes(f.text), 'when the scene is there');
  assert.ok(texts(E, state, { action: `I think about the ${state.locations[elsewhere].name}.` }).includes(f.text), 'when the action names it');
  assert.ok(texts(E, state, { scene: `Someone mentions the ${state.locations[elsewhere].name}.` }).includes(f.text), 'when the last scene names it');
});

test('facts tied to a region load anywhere inside it, up the chain', () => {
  const { E, state } = newGame('occupied-france', 'roquette');
  at(E, 8192);
  const room = state.characters[state.player].status.location;
  const chain = E.Engine.regionChain(state, E.Engine.regionOf(state, room));
  const far = state.scenario.regions.find((r) => !chain.includes(r.id) && state.regions[r.id] && r.id !== chain[0]);
  const up = add(E, state, 'Curfew holds across the whole city.', { where: chain[chain.length - 1] });
  const off = add(E, state, 'A bridge is out somewhere far away.', { where: far.id });
  const got = texts(E, state);
  assert.ok(got.includes(up.text));
  assert.ok(!got.includes(off.text));
});

test('facts about people load when they are present, or named by a part of their name', () => {
  const { E, state, absent } = game();
  const f = add(E, state, 'Keeps a spare key.', { about: [absent] });
  assert.ok(!texts(E, state).includes(f.text));
  const name = state.characters[absent].name;
  assert.ok(texts(E, state, { action: `I ask about ${name}.` }).includes(f.text), 'named in the action');
  state.characters[absent].status.location = state.characters[state.player].status.location;
  assert.ok(texts(E, state).includes(f.text), 'present');
});

test('major facts load wherever they are tied, after the scene has its share', () => {
  const { E, state, elsewhere } = game();
  const f = add(E, state, 'The bridge fell.', { where: elsewhere, weight: 3 });
  assert.ok(texts(E, state).includes(f.text), 'in the user message before its chapter closes');
  closeChapter(E, state);
  assert.match(E.Prompts.header(state), /The bridge fell\./, 'in the core after it');
  assert.ok(!texts(E, state).includes(f.text), 'and not twice');
});

test("a long game's major facts can't push out the scene: the core stops at its share at every tier", () => {
  for (const ctx of [8192, 16384, 32768]) {
    const { E, state, here } = game(ctx);
    for (let i = 0; i < 400; i++) add(E, state, `Major ${i}: ${'word '.repeat(30)}.`, { weight: 3, about: ['nobody'] });
    closeChapter(E, state);
    const budget = E.Memory.budgets(state).facts;
    assert.ok(E.estTokens(E.Memory.factsBlock(state)) <= budget * E.Memory.CORE_SHARE, `${ctx}: the core`);
    assert.match(E.Memory.factsBlock(state), /Major 399:/, 'the newest stays');
    const f = add(E, state, 'The latch is loose here.', { where: here });
    assert.ok(texts(E, state).includes(f.text), `${ctx}: the room's fact still loads`);
    const all = E.estTokens(E.Memory.factsBlock(state)) + E.Memory.sceneFacts(state).reduce((n, p) => n + p.tokens, 0);
    assert.ok(all <= budget + 8, `${ctx}: ${all} of ${budget}`);
  }
});

test('each compartment stays within its share when all of them are full, so a busy room leaves the cast their facts', () => {
  const { E, state, here, elsewhere, absent } = game();
  const someone = E.Engine.present(state)[0];
  assert.ok(someone, 'someone is here');
  for (let i = 0; i < 60; i++) {
    add(E, state, `Place ${i}: ${'word '.repeat(14)}.`, { where: here });
    add(E, state, `Person ${i}: ${'word '.repeat(14)}.`, { about: [someone] });
    add(E, state, `Named ${i}: ${'word '.repeat(14)}.`, { about: [absent] });
    add(E, state, `Major ${i}: ${'word '.repeat(14)}.`, { where: elsewhere, weight: 3 });
  }
  const picks = E.Memory.sceneFacts(state, { action: `I ask about ${state.characters[absent].name}.` });
  const budget = E.Memory.budgets(state).facts - E.estTokens(E.Memory.factsBlock(state));
  Object.entries(E.Memory.SCENE_SHARES).forEach(([k, share]) => {
    const used = picks.filter((p) => p.compartment === k);
    assert.ok(used.length > 0, `${k} has some`);
    const sum = used.reduce((n, p) => n + p.tokens, 0);
    assert.ok(sum <= budget * share + E.estTokens(`- [T0] Place 0: ${'word '.repeat(14)}.`), `${k}: ${sum}`);
  });
  assert.ok(picks.some((p) => /^Place 59:/.test(p.fact.text)), 'the newest first');
  assert.ok(!picks.some((p) => /^Place 0:/.test(p.fact.text)));
});

test('spare share goes to the compartments that can use it', () => {
  const { E, state, here } = game();
  for (let i = 0; i < 60; i++) add(E, state, `Place ${i}: ${'word '.repeat(14)}.`, { where: here });
  const picks = E.Memory.sceneFacts(state);
  const total = picks.reduce((n, p) => n + p.tokens, 0);
  assert.ok(total > (E.Memory.budgets(state).facts - E.estTokens(E.Memory.factsBlock(state))) * 0.6, `${total} is most of the scene's budget`);
});

test('facts with no home stay available through their chapter; a minor fact elsewhere does not', () => {
  const { E, state, elsewhere } = game();
  const world = add(E, state, 'Word is the bridge is the only way out.');
  const off = add(E, state, 'Someone left a note.', { where: elsewhere });
  const got = texts(E, state);
  assert.ok(got.includes(world.text));
  assert.ok(!got.includes(off.text));
});

test('the header is identical across calls and moves between rooms, and changes only at a chapter close', async () => {
  const { E, state, here, elsewhere } = game();
  const before = E.Prompts.header(state);
  add(E, state, 'Something minor.', { where: here });
  add(E, state, 'Something major.', { weight: 3, about: [state.player] });
  assert.equal(E.Prompts.header(state), before, 'new facts leave it alone');
  state.characters[state.player].status.location = elsewhere;
  assert.equal(E.Prompts.header(state), before, 'a move leaves it alone');
  closeChapter(E, state);
  const after = E.Prompts.header(state);
  assert.notEqual(after, before);
  assert.match(after, /Something major\./);
  assert.ok(!/Something minor\./.test(after), 'minor facts are in the summary now');
  const start = before.indexOf('\n=== STORY SO FAR') >= 0 ? before.indexOf('\n=== STORY SO FAR') : before.indexOf('\n=== ESTABLISHED FACTS');
  assert.equal(after.slice(0, start), before.slice(0, start), 'nothing before the live blocks');
});

test('a played turn sends one header, and the scene facts in the user messages', async () => {
  const { E, state, here } = game();
  add(E, state, 'The latch is loose here.', { where: here });
  const calls = mockLLM(E, ({ kind }) => (kind.startsWith('intent') ? { player: { needs_roll: false }, intents: [], events: [] } : kind === 'update' ? { facts: [] } : 'You look around.'));
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  const main = calls.filter((c) => /^(intent|narrate)/.test(c.kind));
  assert.equal(new Set(main.map((c) => c.system)).size, 1);
  main.forEach((c) => {
    assert.ok(!c.system.includes('latch'), `${c.kind}: not in the header`);
    assert.match(c.user, /=== FACTS THAT MATTER HERE/, c.kind);
  });
  const report = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  assert.ok(report.facts.some((f) => f.compartment === 'place' && f.count === 1 && f.tokens > 0), 'the telemetry has the compartment');
});

test('scoping never moves a private fact into a prompt: not in the core, not in the scene, not to the narrator', () => {
  const { E, state, here } = game();
  const someone = E.Engine.present(state)[0];
  const f = add(E, state, 'The ledger is hidden under the floor.', { about: [someone], known_by: [someone], where: here, weight: 3 });
  assert.ok(!texts(E, state, { action: state.characters[someone].name }).includes(f.text));
  E.Memory.freezeCore(state);
  closeChapter(E, state);
  assert.ok(!E.Prompts.header(state).includes(f.text));
});

test('the update step gives a fact its home: a real place, else the room of a scene that stayed in one', () => {
  const { E, state, here, elsewhere } = game();
  const ctx = (a, b) => ({ startLoc: a, endLoc: b, prose: 'Nothing moves.', involved: [], turn: state.turn, action: 'Wait.', extrasPresent: [], engaged: [] });
  const update = (where, loc) => {
    const n = state.facts.length;
    const text = ['Ravens circled above the rusted water tower', 'Muddy bootprints crossed behind the empty bakery', 'Distant church bells rang twice before sunrise', 'Broken glass glittered along the narrow alley'][n % 4];
    const report = E.Engine.applyUpdate(state, { facts: [{ about: [state.player], text, known_by: ['all'], weight: 2, where }] }, [], loc);
    return { fact: state.facts[n], report };
  };
  assert.equal(update(elsewhere, ctx(here, here)).fact.where, elsewhere, 'as proposed');
  assert.equal(update(undefined, ctx(here, here)).fact.where, here, 'the scene stayed here');
  assert.equal(update(undefined, ctx(here, elsewhere)).fact.where, undefined, 'no obvious place');
  const bad = update('atlantis', ctx(here, here));
  assert.equal(bad.fact.where, here, 'a made-up place is dropped');
  assert.ok(bad.report.rejected.some((r) => /atlantis/.test(JSON.stringify(r))), 'and reported');
});

test('a fact with no home has no "where" at all', () => {
  const { E, state } = game();
  assert.ok(!('where' in add(E, state, 'x', { where: null })));
});

test('old saves migrate: facts keep no home, and the core starts as what they had', () => {
  const { E, state } = newGame('zombie-holdout');
  add(E, state, 'An old fact.', { about: [state.player] });
  const old = JSON.parse(JSON.stringify(state));
  delete old.factCore;
  old.version = 16;
  const up = E.Engine.migrate(old);
  assert.equal(up.version, E.Engine.STATE_VERSION);
  assert.deepEqual([...up.factCore], up.facts.filter((f) => E.Memory.knows(f, up.player) && !f.inSummary).map((f) => f.id));
  assert.ok(up.facts.every((f) => f.where === undefined));
  assert.match(E.Memory.factsBlock(up), /An old fact\./);
});

test('what closes a chapter doesn\'t depend on where the scene is', () => {
  const { E, state, elsewhere } = game();
  const words = 'word '.repeat(20);
  while (E.estTokens(E.Memory.liveFacts(state).map((f) => `- [T${f.turn}] ${f.text}`).join('\n')) <= E.Memory.budgets(state).facts) add(E, state, `Note: ${words}.`, { where: elsewhere });
  state.turn = state.chapterStartTurn + 1;
  assert.equal(E.Memory.needsChapter(state), 'size');
  state.characters[state.player].status.location = elsewhere;
  assert.equal(E.Memory.needsChapter(state), 'size');
});

test('a call that would overflow drops the scene\'s facts after the lore, before the last scene', () => {
  const { E } = game();
  const user = ['=== NOW ===', 'Here', '', '=== LORE (public knowledge; use it when it fits) ===', '- lore', '', '=== FACTS THAT MATTER HERE (known to the player) ===', '- [T1] ' + 'fact '.repeat(400), '', '=== LAST SCENE ===', 'one '.repeat(100), '', 'two', '', 'three', '', '=== TASK ===', 'Reply.'].join('\n');
  const out = E.LLM.squeeze(user, 200);
  assert.deepEqual([...out.cut], ['lore', "the scene's facts"]);
  assert.ok(!/FACTS THAT MATTER/.test(out.user));
  assert.match(out.user, /=== LAST SCENE ===\none/);
});
