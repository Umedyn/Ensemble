// Arc memory (task B-10): a game is long when its chapter summaries outgrow
// the story budget, by turns and facts, never in-game time. Then the oldest
// fold into an arc (one call before the turn's first) instead of dropping out
// of the header. The canon past is authored: rewritten once to fit its share,
// never folded, and its personal events go back to being facts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM } = require('./helpers');

const SUMMARY = (n) => `In chapter ${n} the crew argued over the water ration, repaired the failing recycler pump twice, and sent a long report to Mission Control about the storm. Okafor kept the peace while Teo worked late in hydroponics, and Priya flew the Mule out to check the solar field.`;
// A game twelve chapters in, each summary about a hundred tokens.
function longGame(chapters = 12, world) {
  const g = newGame(world);
  for (let n = 1; n <= chapters; n++) g.state.chapters.push({ n, title: `Week ${n}`, summary: SUMMARY(n), fromTurn: n * 10 - 9, toTurn: n * 10, reason: 'length' });
  g.state.chapter = chapters + 1;
  g.state.turn = chapters * 10;
  g.state.chapterStartTurn = g.state.turn + 1;
  return g;
}
function model(E, over = {}) {
  return mockLLM(E, (call) => {
    if (over[call.kind]) return over[call.kind](call);
    if (call.kind.startsWith('intent')) return { player: { summary: 'waits' }, intents: [], events: [] };
    if (call.kind.startsWith('narrate')) return '[+0m] The commons hums.\n\n[+5m] Nobody speaks.';
    if (call.kind.startsWith('update')) return { facts: [], state: [], relations: [] };
    if (call.kind === 'arc') return { title: 'The Long Rationing', summary: 'Over those weeks the crew argued over water and kept the recycler running; Okafor held them together.' };
    return { title: 'T', summary: 'S' };
  });
}
const shownChapters = (E, state) => E.Memory.storyBlock(state).split('\n').filter((l) => /^Chapters? \d/.test(l) && !/^Chapter 0 /.test(l));
const guards = (state, type) => (state.pending.res.guards || []).filter((g) => g.type === type).map((g) => g.detail);

test('summaries that outgrow the budget fold into an arc instead of dropping out of the header', async () => {
  const { E, state } = longGame();
  assert.ok(shownChapters(E, state).length < 12, 'today the oldest would drop out');
  const folding = [...E.Memory.needsArc(state)];
  assert.equal(folding.length, 6, 'the oldest half');
  const calls = model(E);
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal(calls[0].kind, 'arc', 'before the turn\'s first call');
  assert.match(calls[0].user, /Chapter 1 — Week 1: In chapter 1/);
  assert.equal(state.arcs.length, 1);
  assert.deepEqual({ from: state.arcs[0].from, to: state.arcs[0].to }, { from: 1, to: 6 });
  assert.match(guards(state, 'arc')[0], /chapters 1–6 folded into "The Long Rationing"/);
  const block = E.Memory.storyBlock(state);
  assert.match(block, /^Chapter 0 — Before the story: /, 'the canon past first');
  assert.match(block, /Chapters 1–6 — The Long Rationing: Over those weeks/);
  assert.equal(E.Memory.storyEntries(state).length, shownChapters(E, state).length, 'nothing left out');
  assert.ok(!/Chapter 1 — Week 1/.test(block));
  // Every call of the turn has the same header (rule 7).
  const turn = calls.filter((c) => /^(intent|narrate)/.test(c.kind));
  assert.ok(turn.length >= 2 && turn.every((c) => c.system === turn[0].system));
  assert.match(turn[0].system, /The Long Rationing/);
});

test('arcs fold into arcs, so the block stays in budget however long the game runs', async () => {
  const { E, state } = longGame(24);
  model(E);
  for (let i = 0; i < 6 && E.Memory.needsArc(state).length; i++) await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.deepEqual([...E.Memory.needsArc(state)], []);
  assert.ok(state.arcs.some((a) => a.into != null), 'an older arc folded into a newer one');
  assert.equal(E.Memory.storyEntries(state).length, shownChapters(E, state).length);
  assert.ok(E.estTokens(E.Memory.storyBlock(state)) <= E.Memory.budgets(state).story);
});

test('a refused or failed arc changes nothing and is tried again next turn', async () => {
  const { E, state } = longGame();
  model(E, { arc: () => ({ title: 'X', summary: [1, 2, 3, 4, 5, 6, 7].map(SUMMARY).join(' ') }) });
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal((state.arcs || []).length, 0);
  assert.match(guards(state, 'arc refused')[0], /not shorter/);
  model(E, { arc: () => 'not json at all', 'arc (retry)': () => 'still not json' });
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal((state.arcs || []).length, 0);
  model(E);
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal(state.arcs.length, 1);
});

test('the journal keeps every chapter, and major facts outlive the fold', async () => {
  const { E, state } = longGame();
  const major = E.Memory.addFact(state, { about: ['bauer'], text: 'Teo confessed he broke the recycler.', known_by: ['all'], weight: 3 });
  model(E);
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal(state.chapters.filter((c) => c.n > 0).length, 12, 'every chapter still there');
  assert.ok(state.chapters.filter((c) => c.arc === 1).every((c) => c.summary === SUMMARY(c.n)), 'in their own words');
  assert.ok(state.facts.includes(major));
});

test('old saves (chapters, no arcs) load and fold on their next turn', async () => {
  const { E, state } = longGame();
  const save = JSON.parse(JSON.stringify(state));
  delete save.arcs;
  model(E);
  await E.Engine.runTurn(save, 'Wait.', 'moment');
  assert.equal(save.arcs.length, 1);
});

test('a short game folds nothing and makes no extra call', async () => {
  const { E, state } = longGame(2);
  const calls = model(E);
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.ok(!calls.some((c) => c.kind === 'arc' || c.kind === 'history'));
  assert.equal(state.arcs, undefined);
});

// ---------- the canon past ----------

test("a canon past over its share reaches the header anyway, then is rewritten to fit: the Frontier's at 8K", async () => {
  const { E, state } = newGame('frontier');
  const c = E.Memory.canon(state);
  const share = E.Memory.canonShare(state);
  assert.ok(E.estTokens(c.summary) > share, 'too long as written');
  const before = E.Memory.storyBlock(state);
  assert.match(before, /^Chapter 0 — Before the story: /, 'its newest sentences meanwhile');
  assert.ok(E.estTokens(before) <= share);
  const personal = state.facts.filter((f) => f.canon && f.inSummary && f.about.length);
  const fit = c.summary.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');
  const calls = model(E, { history: () => ({ summary: fit }) });
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  assert.equal(calls[0].kind, 'history');
  assert.match(calls[0].user, /Rewrite this history in at most \d+ words/);
  assert.equal(c.fitted.text, fit);
  assert.equal(c.summary.length > fit.length, true, 'the journal keeps the original');
  assert.match(E.Memory.storyBlock(state), new RegExp(`^Chapter 0 — Before the story: ${fit.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(personal.every((f) => !f.inSummary), 'personal past events are facts again');
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  assert.equal(calls.filter((x) => x.kind === 'history').length, 1, 'once');
});

test('a rewrite that invents or runs over is refused; after two tries the history is cut to its newest sentences', async () => {
  const { E, state } = newGame('frontier');
  const c = E.Memory.canon(state);
  const calls = model(E, { history: () => ({ summary: 'Dragons ruled the plains and wizards founded every town along the rivers of gold.' }) });
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  assert.match(guards(state, 'history refused')[0], /words are the history's own/);
  model(E, { history: () => ({ summary: c.summary }) });
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  assert.match(guards(state, 'history refused')[0], /tokens, over the \d+ it has/);
  const after = model(E);
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  assert.ok(!after.some((x) => x.kind === 'history'), 'no third try');
  assert.match(guards(state, 'history cut')[0], /cut to its newest sentences/);
  assert.ok(c.fitted && c.summary.endsWith(c.fitted.text));
  assert.ok(calls.length);
});

test('a canon past that fits is left as written', async () => {
  const { E, state } = newGame();
  const calls = model(E);
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.ok(!calls.some((c) => c.kind === 'history'));
  assert.equal(E.Memory.canon(state).fitted, undefined);
});
