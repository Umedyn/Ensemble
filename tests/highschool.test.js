// Seiryo High (task 7-2): three years of high school in Mito, a cast of
// thirty-four. What the world leans on, and the engine work it brought:
// people who join later (`joins`) and timeline events that move people
// (`moves`); a big cast fitting a small context (short cast lines, the rest
// per call for the people there); a crowded room's foreground (a classroom
// of nine: three take part, the rest are in the background); skips with a
// big cast; the calendar, the maps and the routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, newGame, readWorld, worldFiles, mockLLM } = require('./helpers');
const { replies, stepOf } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));
function at(E, context) {
  E.settings.backends.local.context = context;
  Object.keys(E.settings.routing).forEach((k) => { E.settings.routing[k] = 'local'; });
}
const game = (start, context) => {
  const g = newGame('seiryo-high', start || 'hayakawa');
  at(g.E, context || 8192);
  return g;
};
const res0 = () => ({ outcomes: [], events: [], guards: [] });
const event = (state, id) => state.scenario.timeline.find((e) => e.id === id);

// ---------- the world ----------

test('Seiryo High loads with both starts, a cast of thirty-four, and the timeline from the entrance ceremony to graduation', () => {
  const E = loadEngine();
  const w = readWorld('seiryo-high', E);
  assert.deepEqual(plain(w.warnings), []);
  assert.deepEqual(Object.keys(w.bundle.starts).sort(), ['dorm', 'hayakawa']);
  assert.equal(w.bundle.world.characters.length, 34);
  const sc = E.Scenario.startScenario(w);
  assert.equal(E.dayName(sc, event({ scenario: sc }, 'entrance-ceremony-1').when.day), 'Wednesday 8 April 2026');
  const grad = event({ scenario: sc }, 'graduation-3');
  assert.equal(E.dayName(sc, grad.when.day), 'Thursday 1 March 2029');
  assert.equal(grad.ending.kind, 'bittersweet', 'graduation is a soft ending: Keep playing goes on into what comes next');
  assert.ok(sc.timeline.some((e) => e.when.day > grad.when.day), 'the canon carries on a little past it, and the model projects the rest');
  assert.notEqual(sc.projectTimeline, false);
  assert.deepEqual(plain(sc.tags), ['slice-of-life', 'comedy', 'romance']);
  assert.ok(sc.needs.every((n) => n.id !== 'hunger'), 'no hunger: tiredness and stress only');
});

test('Japan by prefecture, Tokyo by ward, Mito by neighbourhood and Daigo by area, with the trips between them', () => {
  const { E, state } = game();
  const regions = state.scenario.regions;
  const under = (id) => regions.filter((r) => r.parent === id).map((r) => r.id);
  assert.equal(regions.filter((r) => r.label === 'prefecture').length, 47);
  assert.equal(under('tokyo').length, 24, 'the 23 wards and the Tama area');
  assert.ok(under('mito').includes('mito-senba') && under('daigo').includes('fukuroda'));
  assert.ok(regions.find((r) => r.id === 'tokyo').map && regions.find((r) => r.id === 'mito').map && regions.find((r) => r.id === 'daigo').map);
  const trip = (a, b) => E.Engine.regionTrip(state, a, b).hours;
  const up = trip('mito-senba', 'fukuroda');
  assert.ok(up >= 1 && up <= 80 / 60, 'the Suigun Line up to Fukuroda Onsen, or the road by Hitachiota');
  assert.ok(Math.abs(trip('mito-senba', 'shibuya') - 80 / 60) < 0.01, 'the limited express to Tokyo; inside Tokyo the wards are next door');
  assert.equal(trip('mito-senba', 'mito-downtown'), 0, 'walking across Mito is part of a turn');
  assert.ok(trip('mito', 'kyoto') > 3, 'the school trip is a journey');
});

// ---------- people who join later ----------

test('someone who joins later is out of the story until their event: no cast line, no prompt, no feelings toward them yet', () => {
  const { E, state } = game('dorm');
  assert.ok(!state.characters.lena && state.waiting.lena, 'Lena waits for the second term');
  assert.ok(!state.order.includes('lena'));
  assert.ok(!('lena' in state.characters.sayo.relations), 'Sayo\'s jealousy of her waits too');
  const all = E.Prompts.header(state) + E.Prompts.intent(state, E.Engine.present(state), 'Look around.', 'about an hour', 'hour', {});
  assert.ok(!/Lena|Kirishima/.test(all), 'not in any prompt');
  assert.ok(!state.facts.some((f) => f.about.includes('lena')));
});

test('when their event happens they join as newcomers, where their file puts them, with the feelings that waited for them', () => {
  const { E, state } = game('dorm');
  state.turn = 30;
  const res = res0();
  E.Timeline.happen(state, event(state, 'second-term-1'), event(state, 'second-term-1'), res, 'fired');
  const c = state.characters.lena;
  assert.ok(c && !state.waiting.lena);
  assert.deepEqual([c.joined, c.status.location, c.tier, 'joins' in c], [30, 'dorm-lounge', 'secondary', false]);
  assert.ok(state.order.includes('lena'));
  assert.equal(state.characters.sayo.relations.lena, -20, 'Sayo\'s feelings toward her arrive with her');
  assert.ok(res.guards.some((g) => g.type === 'joined' && /Lena Kirishima/.test(g.detail)));
  assert.match(E.Prompts.header(state), /=== CAST: JOINED DURING THE STORY ===\n- lena: Lena Kirishima/);
  assert.ok(res.director[0].who.includes('lena'), 'the event that brings her names her');
});

test('a start where the event is past, or where they belong from the start, leaves "joins" out', () => {
  // Momo is the Hayakawas' daughter: at home from day one in that start.
  const home = game('hayakawa');
  assert.ok(home.state.characters.momo && !home.state.waiting.momo);
  assert.equal(home.state.characters.momo.status.location, 'sora-room');
  // In the dorm start she is one of next April's first-years.
  assert.ok(game('dorm').state.waiting.momo);
  const E = loadEngine();
  const f = worldFiles(require('path').join(__dirname, '..', 'scenarios', 'seiryo-high'));
  f['characters/lena.json'].joins = 'no-such-event';
  const startError = (id) => E.Scenario.prepareWorld('seiryo-high', f).starts.find((x) => x.id === id).error;
  assert.match(startError('dorm'), /Lena Kirishima joins at "no-such-event", which isn't one of the timeline's events/);
  f['characters/lena.json'].joins = 'club-week-1';
  f['starts/dorm.json'].start = { day: 200, hour: 9 };
  assert.match(startError('dorm'), /Lena Kirishima joins at "club-week-1", which has already happened when this start begins/);
});

test('a timeline event\'s "moves" send people where it says when it happens as written: the third-years off to Tokyo', () => {
  const { E, state } = game();
  const res = res0();
  E.Timeline.happen(state, event(state, 'graduation-1'), event(state, 'graduation-1'), res, 'fired');
  assert.equal(state.characters.reiko.status.location, 'tokyo-campus');
  assert.equal(state.characters.shinji.status.location, 'tokyo-campus');
  assert.deepEqual(plain(res.director[0].moved), ['Reiko Kujo → University district, Bunkyo', 'Shinji Gotō → University district, Bunkyo']);
  assert.equal(res.guards.filter((g) => g.type === 'canon moved').length, 2);
  // A version the story changed moves no one; validation catches a bad move.
  const g2 = game();
  E.Timeline.happen(g2.state, event(g2.state, 'graduation-1'), { text: 'Graduation is postponed.' }, res0(), 'diverged');
  assert.equal(g2.state.characters.reiko.status.location, 'council-room');
  const E2 = loadEngine();
  const f = worldFiles(require('path').join(__dirname, '..', 'scenarios', 'seiryo-high'));
  const ev = f['world.json'].timeline.find((e) => e.id === 'graduation-1');
  ev.moves = [{ id: 'reiko', to: 'the-moon' }, { id: 'sora', to: 'gate' }];
  const err = E2.Scenario.prepareWorld('seiryo-high', f).starts.find((x) => x.id === 'hayakawa').error;
  assert.match(err, /moves reiko to "the-moon", which isn't one of the rooms/);
  assert.match(err, /moves the player/);
});

test('the bundled worlds use them: the holdout\'s convoy scout joins at the checkpoint, Ares Deep\'s lead goes to Ops for the review', () => {
  const h = newGame('zombie-holdout');
  assert.ok(h.state.waiting.webb && !h.state.characters.webb);
  const ev = event(h.state, 'convoy-checkpoint');
  h.E.Timeline.happen(h.state, ev, ev, res0(), 'fired');
  assert.equal(h.state.characters.webb.status.location, 'lot');
  const m = newGame('mars-station');
  const review = event(m.state, 'midrotation-review');
  m.E.Timeline.happen(m.state, review, review, res0(), 'fired');
  assert.equal(m.state.characters.okafor.status.location, 'ops');
});

// ---------- a big cast on a small context ----------

test('a big cast at 8K: short cast lines in the header, and each present person\'s wants and voice in the call', () => {
  const { E, state } = game();
  assert.ok(E.Prompts.castBrief(state));
  const header = E.Prompts.header(state);
  assert.match(header, /\n- yumiko: Yumiko Hayakawa \(she\/her\), Hayakawa mother, bakery part-timer, 44\. Traits: nosy, cheerful, romantic\.\n/);
  assert.match(header, /\n- sora \(PLAYER\): [^\n]*Voice: /, 'the player\'s own line stays whole');
  const present = E.Engine.present(state);
  const intent = E.Prompts.intent(state, present, 'Say good morning.', 'a few minutes', 'moment', {});
  assert.match(intent, /=== THE PEOPLE HERE ===\n- yumiko: Wants: see her eldest make friends[^\n]*Voice: Teasing/);
  const frame = { startLoc: 'hayakawa-living', startTime: E.fmtTime(state), stepId: 'moment', stepLabel: 'a few minutes', spanMinutes: 5 };
  const narrate = E.Prompts.narrate(state, present, 'Say good morning.', frame, { outcomes: [], events: [] });
  assert.match(narrate, /=== THE PEOPLE HERE ===\n- Yumiko Hayakawa: Wants:/, 'the narrator gets names, never ids');
  // The header is the same for every call in a turn, and at 16K the lines are whole.
  assert.equal(E.Prompts.header(state), header);
  at(E, 16384);
  assert.ok(!E.Prompts.castBrief(state));
  assert.match(E.Prompts.header(state), /\n- yumiko: [^\n]*Wants: [^\n]*Voice: /);
  assert.ok(!/THE PEOPLE HERE/.test(E.Prompts.intent(state, present, 'Say good morning.', 'a few minutes', 'moment', {})));
  // A small cast is untouched at 8K.
  const holdout = newGame('zombie-holdout');
  at(holdout.E, 8192);
  assert.ok(!holdout.E.Prompts.castBrief(holdout.state));
});

test('a crowded classroom at 8K: three people take part, the action\'s own picks first, and the rest are in the background', () => {
  const { E, state } = game();
  state.characters.sora.status.location = 'classroom-1b';
  const present = E.Engine.present(state);
  assert.equal(present.length, 9);
  const front = E.Engine.sceneFront(state, present, 'Ask Haru and Yui what they did over spring break.');
  assert.equal(front.length, 3);
  assert.ok(front.includes('haru') && front.includes('yui'), 'the people the player names come first');
  const intent = E.Prompts.intent(state, present, 'Ask Haru and Yui what they did over spring break.', 'about an hour', 'hour', {}, front);
  assert.match(intent, new RegExp(`You MUST give exactly one intent for EACH present character: ${front.join(', ')}\\.`));
  assert.match(intent, /Also present, in the background this turn \(no intents; they only watch and listen\): /);
  assert.ok(!/=== OFFSTAGE[\s\S]*\n- kenta \(/.test(intent), 'the background is present, not offstage');
  // The resolve step: no intent asked for, none missing; whatever the model gave anyway is set aside.
  const given = present.map((id) => ({ id, action: 'shouts across the room', says: 'Hey!' }));
  const res = E.Engine.resolve(state, { player: { summary: 'asks' }, intents: given }, present, 'Ask Haru and Yui what they did over spring break.', 'hour', {}, { front });
  const back = res.outcomes.filter((o) => o.background);
  assert.equal(back.length, 6);
  assert.ok(back.every((o) => !o.missing && !o.says && o.action === 'stays in the background'));
  assert.deepEqual(plain(res.front), plain(front));
  const frame = { startLoc: 'classroom-1b', startTime: E.fmtTime(state), stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 };
  const narrate = E.Prompts.narrate(state, present, 'Ask Haru and Yui.', frame, res);
  assert.match(narrate, /In the background \(there, but with no part of their own this scene: at most a glance or a murmur\): /);
  assert.ok(!/stays in the background/.test(narrate), 'the narrator gets one line for them, not an outcome each');
  // At 16K up to eight take part.
  at(E, 16384);
  assert.equal(E.Engine.sceneFront(state, present, 'Look around.').length, 8);
});

test('a skip with a big cast: the people in the foreground in full, the rest keep to their usual places', () => {
  const { E, state } = game();
  const frame = { startLoc: 'hayakawa-living', startTime: E.fmtTime(state), endTime: 'later', days: 3 };
  const user = E.Prompts.skipIntent(state, 'Keep to routine.', { reason: 'horizon' }, frame, { outcomes: [], events: [], major: null }, []);
  assert.match(user, /\n- yumiko \(Yumiko Hayakawa, she\/her\), in [^;]+; wants /);
  assert.match(user, /\n- In the background, keeping to their usual places: [^\n]*rin \(Rin Kagami, Class 1-B\)/);
  assert.ok(!/Rin Kagami[^\n]*secret/.test(user));
  assert.match(user, /- positions: one entry for EVERY other character: [a-z, ]+ \(the people in the background stay where they are\)\./);
});

test('Seiryo High fits an 8K context in a crowded classroom in its third year, with everyone who joins later', async () => {
  const { midGame } = await import('../tools/context-report.mjs');
  for (const start of ['hayakawa', 'dorm']) {
    const { E, state } = game(start);
    ['second-term-1', 'entrance-ceremony-2'].forEach((id) => E.Timeline.happen(state, event(state, id), event(state, id), res0(), 'fired'));
    midGame(E, state);
    state.characters[state.player].status.location = 'classroom-1b';
    E.Prompts.fixedHeader(state);
    const present = E.Engine.present(state);
    const front = E.Engine.sceneFront(state, present, 'Look around.');
    const system = E.Prompts.header(state);
    let user = E.Prompts.intent(state, present, 'Look around.', 'about an hour', 'hour', { regional: true }, front);
    const reply = 260 + 150 * front.length + 120;
    const over = E.estTokens(system) + E.estTokens(user) + reply - 8192;
    // The safety net may take the lore, never more than that.
    if (over > 0) {
      const sq = E.LLM.squeeze(user, over);
      assert.deepEqual([...sq.cut], ['lore'], `${start}: ${over} over`);
      user = sq.user;
    }
    assert.ok(E.estTokens(system) + E.estTokens(user) + reply <= 8192, start);
  }
});

// ---------- a generated start ----------

test('a generated start in Mito composes and plays', async () => {
  const E = loadEngine();
  const w = readWorld('seiryo-high', E);
  const job = E.StartGen.newJob(w, { region: 'mito-downtown', line: 'a first-year who works at a bookshop', onePass: false });
  const r = replies({ player: Object.assign({}, replies().player, { skills: { studies: 3, charm: 3, insight: 3 } }) });
  mockLLM(E, (call) => {
    const v = r[stepOf(call.user)];
    if (v == null) return call.kind === 'intent' ? { player: { summary: 'look around' }, intents: [], events: [] } : { facts: [], state: [], relations: [], player_attitude: [] };
    return typeof v === 'function' ? v(call.user, call) : v;
  });
  await E.StartGen.run(w, job, {});
  assert.ok(E.StartGen.done(job), job.failed);
  const state = E.Engine.newGame(E.StartGen.scenario(w, job));
  assert.deepEqual([...E.Engine.regionChain(state, E.Engine.playerRegion(state))], ['mito-downtown', 'mito', 'ibaraki', 'kanto']);
  assert.equal(E.dayName(state.scenario, state.time.day), 'Wednesday 8 April 2026');
});
