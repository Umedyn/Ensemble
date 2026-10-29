// JSON in the right shape, by grammar (task L-1): the shape module, every
// JSON prompt's grammar against its own example, recorded replies against
// the grammars their calls would now send, and the transport (grammar for
// KoboldCpp, JSON mode for APIs that have one, the HTTP 400 fallback, the
// recording and the turn report).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadEngine, newGame, scenarioFolders, readWorld } = require('./helpers');
const { matches, parse } = require('./gbnf');
const canon = require('./shapecanon');
const { replay } = require('./replay');
const genMock = require('./genmock');

// The ways a reply's shape went wrong in the Seiryo High recordings.
const broken = (good) => {
  const v = JSON.parse(good);
  return {
    fences: '```json\n' + good + '\n```',
    'a list around it': '[' + good + ']',
    indented: JSON.stringify(v, null, 2),
    'prose after': good + '\nHope this helps!',
    'prose before': 'Here is the JSON: ' + good,
  };
};

// ---------- the shape module ----------

test('a shape gives a compact example, its keys, and a grammar that takes only that shape', () => {
  const E = loadEngine();
  const S = E.Shape;
  const shape = S.obj({
    who: S.oneOf(['ana', 'ben'], 'character_id'), mood: S.maybe(S.str('how they seem')), n: S.int(-10, 10, 5),
    tags: S.list(S.str('tag'), { max: 2 }), extra: S.opt(S.bool(true), false),
  });
  assert.equal(S.example(shape), '{"who":"character_id","mood":null,"n":5,"tags":["tag"]}');
  assert.deepEqual([...S.keys(shape)], ['who', 'mood', 'n', 'tags']);
  const g = S.gbnf(shape);
  parse(g);
  const ok = ['{"who":"ana","mood":null,"n":5,"tags":[]}', '{"who": "ben", "mood": "tired", "n": -3, "tags": ["a", "b"]}', '{"who":"ana","mood":null,"n":0,"tags":[],"extra":false}', S.sample(shape)];
  ok.forEach((t) => assert.ok(matches(g, t), t));
  const no = {
    'an id that is not in the list': '{"who":"char:ana","mood":null,"n":5,"tags":[]}',
    'a list over its cap': '{"who":"ana","mood":null,"n":5,"tags":["a","b","c"]}',
    'a key left out': '{"who":"ana","n":5,"tags":[]}',
    'keys out of order': '{"mood":null,"who":"ana","n":5,"tags":[]}',
    'two spaces': '{"who":  "ana","mood":null,"n":5,"tags":[]}',
    'a newline between keys': '{"who":"ana",\n"mood":null,"n":5,"tags":[]}',
    'a number in quotes': '{"who":"ana","mood":null,"n":"5","tags":[]}',
  };
  Object.entries(no).forEach(([why, t]) => assert.ok(!matches(g, t), why));
  Object.entries(broken(S.sample(shape))).forEach(([why, t]) => assert.ok(!matches(g, t), why));
});

test('a tuple holds exactly its people, in order; lists keep their minimum; maps take only their keys', () => {
  const E = loadEngine();
  const S = E.Shape;
  const g = S.gbnf(S.obj({ intents: S.tuple(['ana', 'ben'].map((id) => S.obj({ id: S.lit(id), action: S.str() }))), at: S.list(S.str(), { min: 1, max: 3 }), rel: S.map(['ana', 'ben'], S.int(-30, 30)) }));
  assert.ok(matches(g, '{"intents":[{"id":"ana","action":"waits"},{"id":"ben","action":"leaves"}],"at":["x"],"rel":{"ben":10,"ana":-5}}'));
  assert.ok(!matches(g, '{"intents":[{"id":"ana","action":"waits"}],"at":["x"],"rel":{}}'), 'someone left out');
  assert.ok(!matches(g, '{"intents":[{"id":"ben","action":"leaves"},{"id":"ana","action":"waits"}],"at":["x"],"rel":{}}'), 'out of order');
  assert.ok(!matches(g, '{"intents":[{"id":"ana","action":"waits"},{"id":"ben","action":"leaves"},{"id":"cal","action":"arrives"}],"at":["x"],"rel":{}}'), 'someone who is not there');
  assert.ok(!matches(g, '{"intents":[{"id":"ana","action":"waits"},{"id":"ben","action":"leaves"}],"at":[],"rel":{}}'), 'under the minimum');
  assert.ok(!matches(g, '{"intents":[{"id":"ana","action":"waits"},{"id":"ben","action":"leaves"}],"at":["x"],"rel":{"cal":1}}'), 'a key not in the map');
});

test('long id lists stay free in the grammar, and strings may hold any text JSON allows', () => {
  const E = loadEngine();
  const S = E.Shape;
  const g = S.gbnf(S.obj({ text: S.str() }));
  assert.ok(matches(g, JSON.stringify({ text: 'Yumiko said "hi" — 「おはよう」\\ ok' })));
  assert.ok(!matches(g, '{"text":"a raw\nnewline"}'));
});

// ---------- every JSON prompt ----------

// Every JSON prompt of a world, from a fixed state (as the snapshots build them).
function jsonPrompts(E, state, folder) {
  const P = E.Prompts;
  const npcs = [...state.order].filter((id) => id !== state.player);
  const present = E.Engine.present(state);
  const out = {
    intent: P.intent(state, present, 'Ask what happened.', 'about an hour', 'hour', { regional: true, world: true }),
    'intent (minute)': P.intent(state, present, 'Wait.', 'a minute', 'minute', {}),
    update: P.update(state, 'Ask what happened.', { outcomes: [], events: [] }, 'You ask. They shrug.', present, false),
    suggest: P.suggest(state),
    chapter: P.chapter(state),
    skipIntent: P.skipIntent(state, 'Keep busy.', { reason: 'random' }, { startLoc: state.characters[state.player].status.location, startTime: E.fmtTime(state), endTime: 'later', days: 3 }, { outcomes: [], events: [] }, []),
    cardConvert: P.cardConvert(state.scenario, E.Cards.fromFile(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'cards', 'v2.png')))).card).user,
  };
  if (npcs[0]) out.agenda = P.agenda(state, npcs[0], null);
  const extra = Object.values(state.extras || {}).find((x) => !x.group);
  if (extra) out.fleshOut = P.fleshOut(state, extra.id);
  const cfg = E.Timeline.config(state.scenario);
  if (cfg) out.project = P.project(state, cfg);
  if (state.scenario.playerSlot) {
    const f = Object.assign(E.CharMaker.defaults(state.scenario), { name: 'Sam Reyes', traits: ['patient'] });
    const draft = E.CharMaker.draftState(state.scenario, f);
    ['traits', 'voice', 'description'].forEach((k) => { out['charSuggest ' + k] = P.charSuggest(draft, k, f); });
  }
  if (E.Sites.enabled(state.scenario)) {
    const req = { name: 'the pharmacy', kind: 'pharmacy', region: (state.scenario.regions || [])[0] ? state.scenario.regions[0].id : null, why: 'I head there.' };
    const layout = E.Sites.checkLayout(state, genMock.replies().siteLayout, 'pharmacy');
    out.siteLayout = P.siteLayout(state, req);
    out.siteFlavour = P.siteFlavour(state, req);
    if (!layout.error) {
      out.siteOccupants = P.siteOccupants(state, req, layout, false);
      out['siteOccupants (map)'] = P.siteOccupants(state, req, layout, true);
      out.siteGrow = P.siteGrow(state, req, layout);
    }
    out.regionLore = P.regionLore(state, { name: 'Port Town', label: 'town', parent: null });
  }
  const loaded = readWorld(folder, E);
  const job = E.Research.newJob(loaded, { asOf: 'the start of the story' });
  const ctx = E.Research.context(loaded, job);
  const topic = job.topics.find((t) => t.level === 'region') || job.topics[0];
  if (topic) {
    out.research = P.research(ctx, topic, { title: 'A page' }, 'Some source text.', 0, 2);
    out.researchBrief = P.research(ctx, topic, { title: 'A page' }, 'The opening.', 0, 1, true);
  }
  return out;
}

// Every step of a generated start in the holdout, each filled from the mock replies.
function genStepPrompts(E) {
  const w = readWorld('zombie-holdout', E);
  const GEN = E.StartGen;
  const r = genMock.replies();
  const job = GEN.newJob(w, { region: (GEN.regions(w.bundle.world)[0] || {}).id, line: 'a trucker', onePass: false });
  const ctx = GEN.context(w, job);
  const P = E.Prompts;
  const out = { player: P.genStep(ctx, 'player') };
  job.steps.player = GEN.check.player(r.player, ctx);
  out.rooms = P.genStep(ctx, 'rooms');
  job.steps.rooms = GEN.check.rooms(r.rooms, ctx);
  out.plan = P.genStep(ctx, 'plan');
  job.steps.plan = GEN.check.plan(r.plan, ctx);
  out.person = P.genStep(ctx, 'person', 0);
  out.room = P.genStep(ctx, 'room', job.steps.rooms.rooms[0].id);
  out.cast = P.genStep(ctx, 'cast');
  job.steps.cast = GEN.check.cast(r.cast, ctx);
  out.ties = P.genStep(ctx, 'ties');
  job.steps.ties = GEN.check.ties(r.ties, ctx);
  out.extras = P.genStep(ctx, 'extras');
  job.steps.extras = GEN.check.extras(r.extras, ctx);
  out.opening = P.genStep(ctx, 'opening');
  job.steps.opening = GEN.check.opening(r.opening, ctx);
  out.lore = P.genStep(ctx, 'lore');
  const custom = readWorld('your-story', E);
  const cjob = GEN.newJob(custom, { world: genMock.WORLD, line: 'a fisher' });
  out.setting = P.genStep(GEN.context(custom, cjob), 'setting');
  return out;
}

function checkPrompt(E, label, text) {
  const S = E.Shape;
  const shape = E.Prompts.shapeFor(text);
  assert.ok(shape, `${label}: the prompt remembers its shape`);
  const example = S.example(shape);
  assert.ok(text.includes(example), `${label}: the prompt shows the shape's own example`);
  assert.ok(!/\n {2,}"/.test(example), `${label}: the example is compact`);
  const g = S.gbnf(shape);
  parse(g);
  const sample = S.sample(shape);
  assert.ok(matches(g, sample), `${label}: the grammar takes its own example: ${sample.slice(0, 300)}`);
  Object.entries(broken(sample)).forEach(([why, t]) => assert.ok(!matches(g, t), `${label}: the grammar refuses ${why}`));
  assert.ok(S.keys(shape).length, `${label}: the shape names its keys`);
  return g;
}

test('every JSON prompt in every bundled world: its grammar takes its own example and refuses the broken shapes', () => {
  for (const folder of scenarioFolders()) {
    if (!readWorld(folder).defaultStart) {
      // A world played only from generated starts: its first steps.
      const E = loadEngine();
      const w = readWorld(folder, E);
      const ctx = E.StartGen.context(w, E.StartGen.newJob(w, { region: (E.StartGen.regions(w.bundle.world)[0] || {}).id, line: 'someone new', world: genMock.WORLD }));
      ['player', 'rooms'].forEach((step) => checkPrompt(E, `${folder} start step ${step}`, E.Prompts.genStep(ctx, step)));
      continue;
    }
    const { E, state } = newGame(folder);
    Object.entries(jsonPrompts(E, state, folder)).forEach(([k, text]) => checkPrompt(E, `${folder} ${k}`, text));
  }
});

test('every step of a generated start has a grammar that takes its own example', () => {
  const E = loadEngine();
  Object.entries(genStepPrompts(E)).forEach(([k, text]) => checkPrompt(E, `start step ${k}`, text));
});

test('the intent grammar holds exactly the people present, in order, and ids only from this game', () => {
  const { E, state } = newGame('zombie-holdout');
  const present = E.Engine.present(state);
  assert.ok(present.length >= 2);
  const text = E.Prompts.intent(state, present, 'Ask what happened.', 'about an hour', 'hour', {});
  const shape = E.Prompts.shapeFor(text);
  const g = E.Shape.gbnf(shape);
  const good = JSON.parse(E.Shape.sample(shape));
  assert.ok(matches(g, JSON.stringify(good)));
  const swap = (fn) => { const v = JSON.parse(JSON.stringify(good)); fn(v); return JSON.stringify(v); };
  assert.ok(!matches(g, swap((v) => v.intents.reverse())), 'out of order');
  assert.ok(!matches(g, swap((v) => v.intents.pop())), 'someone left out');
  assert.ok(!matches(g, swap((v) => v.intents.push(Object.assign({}, v.intents[0], { id: 'ferris' })))), 'someone who is not here');
  assert.ok(!matches(g, swap((v) => { v.intents[0].move_to = 'the-moon'; })), 'a place that does not exist');
  assert.ok(!matches(g, swap((v) => { v.events = [{ text: 'x', scope: 'local', who: ['char:han'], where: 'floor', visibility: 'heard', moves: [] }]; })), 'an id written as a target');
  assert.ok(!matches(g, swap((v) => { v.events = [1, 2].map(() => ({ text: 'x', scope: 'local', who: ['han'], where: 'floor', visibility: 'heard', moves: [] })); })), 'more events than the step allows');
  assert.ok(matches(g, swap((v) => { v.events = [{ text: 'x', scope: 'local', who: ['han'], where: 'floor', visibility: 'heard', moves: [] }]; })), 'one event is fine');
});

test('the update grammar takes targets only for things in this game, and at most five facts', () => {
  const { E, state } = newGame('zombie-holdout');
  const shape = E.Prompts.shapeFor(E.Prompts.update(state, 'Look.', { outcomes: [], events: [] }, 'You look.', E.Engine.present(state), false));
  const g = E.Shape.gbnf(shape);
  const fact = { about: ['han'], text: 'Han looked.', known_by: ['han', 'pike'], weight: 2 };
  const reply = (o) => JSON.stringify(Object.assign({ facts: [fact], state: [], relations: [], player_attitude: [] }, JSON.parse(E.Shape.sample(shape)), o));
  assert.ok(matches(g, reply({ facts: [fact], state: [{ target: 'char:han', field: 'mood', value: 'tired', reason: 'long day' }] })));
  assert.ok(matches(g, reply({ state: [{ target: 'char:albee', field: 'location', value: 'dock' }] })), 'a minor person may move');
  assert.ok(!matches(g, reply({ state: [{ target: 'char:albee', field: 'mood', value: 'tired', reason: 'x' }] })), 'but has no mood');
  assert.ok(!matches(g, reply({ facts: [Object.assign({}, fact, { about: ['char:han'] })] })), '"char:han" in a list of ids');
  assert.ok(!matches(g, reply({ facts: [1, 2, 3, 4, 5, 6].map(() => fact) })), 'six facts');
  assert.ok(!matches(g, reply({ state: [{ target: 'world:storm', value: 'close' }] })), 'a world key that does not exist');
});

// ---------- recorded replies ----------

// Each recorded JSON reply beside the grammar its call now sends.
async function recorded(name) {
  const rows = [];
  await replay(name, {
    onCall({ E, body, kind, recorded: rc }) {
      if (!body.grammar || !rc.response) return;
      const shape = E.Prompts.shapeFor(body.messages[1].content);
      const text = rc.response.text;
      const keys = [...E.Shape.keys(shape)];
      const obj = E.LLM.pickShape(E.LLM.extractJSON(text), keys) || E.LLM.pickShape(E.LLM.salvageJSON(text), keys);
      rows.push({ kind, text, grammar: body.grammar, E, shape, obj, canonical: obj ? canon.text(E, obj, shape) : null });
    },
  });
  return rows;
}

test('recorded replies that were right pass their grammar once written compactly in its order', async () => {
  const good = {
    'mock-session': null, // every call
    'playtest-zombie-steps-outside': null,
    'playtest-albee-promoted': ['intent', 'worldbuild'],
    'playtest-id-tags-in-prose': ['intent (retry)', 'update'],
    'playtest-r2-drive-to-ridge': ['intent', 'worldbuild (site: Ridge)'],
    'playtest-r7-tessk-workshop': null,
  };
  for (const [name, kinds] of Object.entries(good)) {
    const rows = (await recorded(name)).filter((r) => !kinds || kinds.includes(r.kind));
    assert.ok(rows.length, `${name}: has JSON calls`);
    rows.forEach((r) => assert.ok(r.canonical && matches(r.grammar, r.canonical), `${name} ${r.kind}: ${r.canonical && canon.why(r.E, r.obj, r.shape, r.grammar)}`));
  }
});

test('the Seiryo High replies fail their grammar: fences, a list around the object, indents, made-up ids', async () => {
  const school = await recorded('playtest-seiryo-goes-to-school');
  const downtown = await recorded('playtest-seiryo-goes-downtown');
  const all = school.concat(downtown);
  assert.ok(all.length >= 6);
  all.forEach((r) => assert.ok(!matches(r.grammar, r.text.trim()), `${r.kind} as it came back`));
  assert.ok(all.every((r) => /^```json/.test(r.text)), 'every one was fenced');
  assert.ok(all.filter((r) => /^```json\n\[/.test(r.text)).length >= 4, 'lists around the object');
  // What the grammar would also have stopped once the shape was fixed.
  const upd = school.find((r) => r.kind === 'update');
  assert.ok(upd.obj, 'the update salvages');
  assert.ok(upd.obj.facts.some((f) => (f.about || []).includes('char:yumiko')));
  assert.ok(!matches(upd.grammar, upd.canonical), '"char:yumiko" where an id goes');
  const intent = downtown.find((r) => r.kind === 'intent');
  assert.ok(JSON.stringify(intent.obj.events).includes('"aio"'));
  assert.ok(!matches(intent.grammar, intent.canonical), 'an event naming "aio"');
  const first = school.find((r) => r.kind === 'intent');
  assert.ok(!matches(first.grammar, first.canonical), 'people heading for regions, a made-up room');
});

test('an intent for someone who is not there fails the grammar (playtest-office-window)', async () => {
  const r = (await recorded('playtest-office-window')).find((x) => x.kind === 'intent');
  assert.equal(r.obj.intents.length, 1);
  assert.ok(!matches(r.grammar, r.canonical));
});

test('a compact update is at least a third shorter than the indented one the model wrote', async () => {
  const upd = (await recorded('playtest-seiryo-goes-to-school')).find((r) => r.kind === 'update');
  const indented = JSON.stringify(upd.obj, null, 4);
  assert.ok(upd.canonical.length <= indented.length * 2 / 3, `${upd.canonical.length} vs ${indented.length}`);
});

// ---------- the transport ----------

function withTransport(E) {
  const sent = [];
  E.LLM.perf = async () => null;
  E.LLM.transport = async (url, body, kind) => {
    sent.push({ url, body, kind });
    if (body.response_format && E._refuseJsonMode) throw new Error('openrouter.ai returned HTTP 400: response_format is not supported');
    return { text: '{"title":"A day","summary":"Things happened."}', finish: 'stop' };
  };
  return sent;
}

test('KoboldCpp gets a grammar with every JSON call; "Constrain JSON" off sends none', async () => {
  const { E, state } = newGame('zombie-holdout');
  const sent = withTransport(E);
  E.settings.routing.chapter = 'local';
  const out = await E.LLM.chatJSON({ kind: 'chapter', system: 'h', user: E.Prompts.chapter(state), maxTokens: 200 });
  assert.equal(out.title, 'A day');
  assert.match(sent[0].body.grammar, /^root ::= /);
  assert.equal(sent[0].url, 'http://localhost:5001/v1/chat/completions', 'the chat endpoint takes it');
  assert.equal(sent[0].body.response_format, undefined);
  const call = E.LLM.calls[E.LLM.calls.length - 1];
  assert.equal(call.grammar, sent[0].body.grammar.length, 'the call log has its size');
  await E.LLM.chat({ kind: 'narrate', system: 'h', user: 'Write.', maxTokens: 100 });
  assert.equal(sent[1].body.grammar, undefined, 'never on prose');
  E.settings.backends.local.constrainJSON = false;
  await E.LLM.chatJSON({ kind: 'chapter', system: 'h', user: E.Prompts.chapter(state), maxTokens: 200 });
  assert.equal(sent[2].body.grammar, undefined);
});

test('an API with a JSON mode gets response_format; one that refuses it is asked again without, once', async () => {
  const { E, state } = newGame('zombie-holdout');
  const sent = withTransport(E);
  E.settings.routing.chapter = 'external';
  Object.assign(E.settings.backends.external, { preset: 'openrouter', model: 'test/model', key: 'k' });
  await E.LLM.chatJSON({ kind: 'chapter', system: 'h', user: E.Prompts.chapter(state), maxTokens: 200 });
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].body.response_format)), { type: 'json_object' });
  assert.equal(sent[0].body.grammar, undefined);
  E._refuseJsonMode = true;
  E.LLM.noJsonMode.clear();
  const out = await E.LLM.chatJSON({ kind: 'chapter', system: 'h', user: E.Prompts.chapter(state), maxTokens: 200 });
  assert.equal(out.title, 'A day');
  assert.deepEqual(sent.slice(1).map((s) => [s.kind, !!s.body.response_format]), [['chapter', true], ['chapter (no JSON mode)', false]]);
  await E.LLM.chatJSON({ kind: 'chapter', system: 'h', user: E.Prompts.chapter(state), maxTokens: 200 });
  assert.equal(sent[3].body.response_format, undefined, 'not again this session');
  // Another OpenAI-compatible API: no known JSON mode, so nothing.
  Object.assign(E.settings.backends.external, { preset: 'custom', url: 'https://api.example.org/v1' });
  await E.LLM.chatJSON({ kind: 'chapter', system: 'h', user: E.Prompts.chapter(state), maxTokens: 200 });
  assert.equal(sent[4].body.response_format, undefined);
  assert.equal(sent[4].body.grammar, undefined);
});

test('"Constrain JSON" defaults: on for KoboldCpp and OpenRouter, off for other APIs', () => {
  const E = loadEngine();
  assert.deepEqual(['kobold-local', 'kobold-remote', 'openrouter', 'custom'].map(E.LLM.constrainDefault), [true, true, true, false]);
  assert.equal(E.LLM.backend('local').constrain, true);
  E.settings.backends.local.constrainJSON = false;
  assert.equal(E.LLM.backend('local').constrain, false);
});

test('a recording keeps the grammar as a size and a hash, and the turn report says when one was sent', async () => {
  const { E, state } = newGame('zombie-holdout');
  withTransport(E);
  E.Recorder.start(state);
  E.Recorder.begin('turn', { action: 'x' });
  await E.LLM.chatJSON({ kind: 'chapter', system: 'h', user: E.Prompts.chapter(state), maxTokens: 200 });
  const call = E.Recorder.fixture().actions[0].calls[0];
  E.Recorder.stop();
  assert.equal(call.request.grammar.chars, E.Shape.gbnf(E.Prompts.shapeFor(E.Prompts.chapter(state))).length);
  assert.match(call.request.grammar.hash, /^[0-9a-f]{8}$/);
  const report = E.Engine.turnReport({ turn: 1, ms: 10, calls: [E.LLM.calls[E.LLM.calls.length - 1]], guards: [] });
  assert.match(report, /grammar \d+ chars/);
});
