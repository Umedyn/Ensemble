// Engine rules. Each test pins down a behavior we hit while playtesting with a
// real 12B model; the comment says what went wrong before the rule existed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, fixedRng, readScenario, scenarioFolders, loadEngine } = require('./helpers');

const intentOf = (o) => JSON.parse(JSON.stringify(o));
const PRESENT = ['okafor', 'bauer'];

// ---------- scenarios ----------

test('every bundled scenario validates and starts', () => {
  for (const folder of scenarioFolders()) {
    const E = loadEngine();
    const sc = E.Scenario.validate(readScenario(folder));
    const state = E.Engine.newGame(sc);
    assert.ok(state.characters[state.player], `${folder}: player exists`);
    assert.ok(E.Prompts.header(state).includes(sc.title), `${folder}: header builds`);
  }
});

test('scenario validation reports authoring mistakes', () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  sc.characterData[1].status.location = 'nowhere';
  sc.characterData[1].guard = 'extreme';
  assert.throws(() => E.Scenario.validate(sc), (err) =>
    /unknown location "nowhere"/.test(err.message) && /guard must be low, medium or high/.test(err.message));
});

// ---------- movement ----------

test('acting on someone in the room cancels a move elsewhere (log 3/4: Kit walked off to hydroponics)', () => {
  const { E, state } = newGame();
  const res = E.Engine.resolve(state, intentOf({ player: { summary: 'Kit checks on Teo in hydroponics', move_to: 'hydro' }, intents: [] }), PRESENT, 'See what Teo is up to.', 'hour');
  assert.equal(state.characters.navarro.status.location, 'commons');
  assert.match(res.outcomes[0].note, /stayed with Teo Bauer/);
  assert.match(res.outcomes[0].action, /right here in Commons/, 'narrator gets the player words, not the model summary naming the wrong room');
});

test('moving to a person goes to wherever they are', () => {
  const { E, state } = newGame();
  E.Engine.resolve(state, intentOf({ player: { move_to: 'sorensen' }, intents: [] }), PRESENT, 'Go find Lev.', 'hour');
  assert.equal(state.characters.navarro.status.location, 'lab');
});

test('update step: player never moved, NPC moves only if seen in the scene (log 5: everyone got moved to follow a drifting narrator)', () => {
  const { E, state } = newGame();
  const r = E.Engine.applyUpdate(state, {
    state: [
      { target: 'char:navarro', field: 'location', value: 'hydro' },
      { target: 'char:okafor', field: 'location', value: 'ops' },
      { target: 'char:sorensen', field: 'location', value: 'med' },
    ],
  }, PRESENT, { startLoc: 'commons', endLoc: 'commons' });
  assert.equal(state.characters.navarro.status.location, 'commons');
  assert.equal(state.characters.okafor.status.location, 'ops', 'Okafor left the scene and was seen leaving');
  assert.equal(state.characters.sorensen.status.location, 'lab', 'Lev was offscreen; nobody saw him move');
  assert.equal(r.rejected.length, 2);
});

test('relocation check catches the narrator walking the player into another room', () => {
  const { E, state } = newGame();
  const where = (p) => (E.Engine.findRelocation(state, p, 'commons') || {}).id || null;
  assert.equal(where('You head to hydroponics, the clattering growing louder.'), 'hydro');
  assert.equal(where('You push open the hydroponics door.'), 'hydro');
  assert.equal(where('Teo heads for the Suit Room & Airlock.'), null, 'others leaving is fine');
  assert.equal(where('You glance toward the lab door.'), null, 'looking is not moving');
});

// ---------- secrets ----------

test('low-guard Teo cracks when confronted while stressed (log 8 felt natural)', () => {
  const { E, state } = newGame();
  const res = E.Engine.resolve(state, intentOf({ player: {}, intents: [{ id: 'bauer', action: 'admits the recycler fault is his', says: 'I pushed it too hard to save a crop', reveals: true }] }), PRESENT, 'See what Teo is up to.', 'hour');
  assert.ok(res.outcomes.find((o) => o.id === 'bauer').reveals);
});

test('secrets leaking through dialogue are caught when unearned (log 8: reveals:true bypassed the gate)', () => {
  const { E, state } = newGame();
  state.characters.bauer.needs.stress = 0.3;
  const res = E.Engine.resolve(state, intentOf({ player: {}, intents: [{ id: 'bauer', action: 'Teo admits the recycler fault is his', says: 'I ran it past its rated cycle to save the crop' }] }), PRESENT, 'Make coffee.', 'hour');
  const teo = res.outcomes.find((o) => o.id === 'bauer');
  assert.equal(teo.reveals, null);
  assert.equal(teo.says, null);
  assert.match(teo.action, /keeps the secret/);
});

test('innocent dialogue is not mistaken for a leak', () => {
  const { E, state } = newGame();
  const res = E.Engine.resolve(state, intentOf({ player: {}, intents: [{ id: 'bauer', action: 'checks the readout', says: "The recycler's acting up. Sensor issue." }] }), PRESENT, 'Make coffee.', 'hour');
  assert.equal(res.outcomes.find((o) => o.id === 'bauer').action, 'checks the readout');
});

test('high-guard Okafor holds even when asked directly; a social success opens anyone', () => {
  const ask = (rng, intentPlayer) => {
    const g = newGame();
    fixedRng(g.E, rng);
    const r = g.E.Engine.resolve(g.state, intentOf({ player: intentPlayer, intents: [{ id: 'okafor', action: 'admits she adjusted the report', says: 'I adjusted the purity numbers', reveals: true }] }), PRESENT, 'Ask Okafor why the ice purity numbers look off.', 'hour');
    return r.outcomes.find((o) => o.id === 'okafor').reveals;
  };
  assert.equal(ask([0.5], {}), null);
  assert.ok(ask([0.95], { needs_roll: true, skill: 'social', difficulty: 'normal' }));
});

// ---------- feelings ----------

test("player's feelings only change through player_attitude, capped at ±10", () => {
  const { E, state } = newGame();
  const r = E.Engine.applyUpdate(state, {
    relations: [{ from: 'navarro', to: 'bauer', delta: -5 }, { from: 'bauer', to: 'navarro', delta: -3 }],
    player_attitude: [{ to: 'bauer', delta: -25, reason: 'snapped at Teo' }],
  }, PRESENT);
  assert.equal(state.characters.navarro.relations.bauer, 10, '20 - 10 (cap); the relations entry from the player is rejected');
  assert.equal(state.characters.bauer.relations.navarro, 17);
  assert.equal(state.characters.navarro.attitudeNotes.bauer, 'snapped at Teo');
  assert.equal(r.rejected.length, 1);
});

test('moods are rejected as conditions (stress is a need)', () => {
  const { E, state } = newGame();
  E.Engine.applyUpdate(state, { state: [
    { target: 'char:bauer', field: 'add_condition', value: 'stressed' },
    { target: 'char:bauer', field: 'add_condition', value: 'grease-stained hands' },
  ] }, PRESENT);
  assert.deepEqual([...state.characters.bauer.status.conditions], ['grease-stained hands']);
});

// ---------- narration cleanup ----------

test('prose cleanup: repeated paragraphs, cut-off sentences, endings on the player', () => {
  const { E } = newGame();
  assert.equal(E.Engine.cleanProse('You find Teo.\n\n"You find Teo."\n\nHe looks up.'), 'You find Teo.\n\nHe looks up.');
  assert.equal(E.Engine.cleanProse('Priya sighs. "I swear, if I have to'), 'Priya sighs.');
  assert.equal(E.Engine.trimPlayerEnding('Teo hurries off.\n\nYou turn back to the counter.'), 'Teo hurries off.');
});

test('beats parse minutes, hours and days and stay in order', () => {
  const { E } = newGame();
  const b = E.Engine.parseBeats('[+0m] A.\n\n[+40m] B.\n\n[+2h] C.', 180);
  assert.deepEqual([...b.map((x) => x.at)], [0, 40, 120]);
  assert.deepEqual([...E.Engine.parseBeats('[+0d] A.\n\n[+3d] B.', 10 * 1440).map((x) => x.at)], [0, 4320]);
  assert.equal(E.Engine.parseBeats('No markers here.', 60).length, 1);
});

// ---------- events ----------

test('event tiers: regional/world only when due, effects applied, extras dropped', () => {
  const { E, state } = newGame();
  const res = E.Engine.resolve(state, intentOf({ player: {}, intents: [], events: [
    { scope: 'world', text: 'A hurricane knocks Mission Control offline.', visibility: 'heard',
      effects: { world: [{ key: 'comms', value: 'no contact with Earth' }], groups: [{ id: 'mission', stance: 'offline' }],
        new_clock: { name: 'Mission Control blackout', max: 8, perHour: 0.15, fireText: 'Backup control comes online.' } } },
    { scope: 'regional', text: 'A dust devil scours the solar field.' },
    { scope: 'world', text: 'A second world event.' },
    { scope: 'local', text: 'Priya calls on the intercom.', who: ['raman'] },
  ] }), PRESENT, 'Ask Teo.', 'hour', { world: true, regional: false });
  assert.deepEqual([...res.director.map((d) => d.scope)], ['world', 'local']);
  assert.equal(state.world.comms, 'no contact with Earth');
  assert.equal(state.factions.find((f) => f.id === 'mission').stance, 'offline');
  assert.ok(state.clocks.find((c) => c.id === 'mission-control-blackout'));
  assert.equal(state.news.length, 1);
});

test('hidden events become private knowledge and change nothing public', () => {
  const { E, state } = newGame();
  E.Engine.resolve(state, intentOf({ player: {}, intents: [], events: [
    { scope: 'local', text: 'Lev moves his cultures to a hidden incubator.', who: ['sorensen'], visibility: 'hidden' },
  ] }), PRESENT, 'Ask Teo.', 'hour', {});
  assert.ok(E.Memory.privateFacts(state, 'sorensen').some((f) => /hidden incubator/.test(f.text)));
  assert.ok(!E.Memory.playerFacts(state).some((f) => /hidden incubator/.test(f.text)));
});

// ---------- time ----------

test('the storm chain: firing a clock starts its follow-ups, and long skips stop at the next one', () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]); // keep random major events far away
  const plan1 = E.Engine.planMajorSkip(state);
  assert.equal(plan1.reason, 'clock');
  assert.equal(plan1.clock.id, 'storm');
  E.Engine.advanceTime(state, plan1.hours, { events: [] }, true);
  assert.ok(state.clocks.find((c) => c.id === 'storm-clear') && state.clocks.find((c) => c.id === 'battery'));
  E.Engine.advanceTime(state, E.Engine.planMajorSkip(state).hours, { events: [] }, true); // recycler fails next
  const plan3 = E.Engine.planMajorSkip(state);
  assert.equal(plan3.clock.id, 'battery');
  assert.ok(plan3.hours > 200, 'about ten sols of storm');
});

test('routine downtime keeps needs near normal instead of maxing out', () => {
  const { E, state } = newGame();
  E.Engine.advanceTime(state, 24 * 14, { events: [] }, true);
  for (const id of state.order) for (const v of Object.values(state.characters[id].needs)) assert.ok(v < 0.5);
});

// ---------- full turns ----------

function scriptedModel(E, { prose, more }) {
  return mockLLM(E, ({ kind }) => {
    if (kind === 'narrate (continue)' && more !== undefined) return more;
    if (kind.startsWith('intent')) return { player: { summary: 'talk to Teo' }, intents: [
      { id: 'okafor', action: 'goes to Ops to call Mission Control', move_to: 'ops' },
      { id: 'bauer', action: 'deflects', says: 'Sensor issue.' }] , events: [] };
    if (kind.startsWith('narrate')) return prose;
    if (kind.startsWith('update')) return { facts: [{ about: ['bauer'], text: 'Teo blamed a sensor.', known_by: ['navarro', 'bauer', 'okafor'], weight: 1 }], state: [], relations: [] };
    return { title: 'T', summary: 'S' };
  });
}

test('memory is recorded at the start of the next turn, not right after the scene', async () => {
  const { E, state } = newGame();
  const calls = scriptedModel(E, { prose: 'Teo shrugs. "Sensor issue."' });
  await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'hour');
  assert.ok(state.pending);
  assert.ok(!calls.some((c) => c.kind === 'update'));
  await E.Engine.runTurn(state, 'Nod.', 'moment');
  assert.equal(calls.filter((c) => c.kind === 'update').length, 1);
  assert.ok(E.Memory.playerFacts(state).some((f) => /sensor/.test(f.text)));
});

test('stepping in after beat 1 rewinds later beats: time, moves and memory', async () => {
  const { E, state } = newGame();
  const calls = scriptedModel(E, { prose: '[+0m] You ask Teo. He shrugs.\n\n[+70m] Okafor heads for Ops.\n\n[+160m] Priya stomps in.' });
  await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'hours');
  assert.equal(state.characters.okafor.status.location, 'ops');
  await E.Engine.runTurn(state, 'Imani, wait.', 'moment', null, 1);
  const turn1 = state.log.find((e) => e.type === 'action' && e.turn === 1);
  assert.equal(turn1.until, 'Sol 214, 07:35', 'midpoint between beat 1 (07:00) and beat 2 (08:10)');
  assert.equal(state.log.find((e) => e.type === 'scene' && e.turn === 1).cutAt, 1);
  const update = calls.find((c) => c.kind === 'update');
  assert.ok(!update.user.includes('Priya stomps in'), 'memory only sees the kept beat');
  assert.match(update.user, /stepped in here/);
});

// Log: an "about an hour" scene stopped at [+20m] (token cap), but the clock
// jumped the full hour, leaving 40 minutes nobody narrated.
const minutesOf = (state) => state.time.day * 1440 + Math.round(state.time.hour * 60);

test('a scene that stops before half the step is continued once, and the clock follows it', async () => {
  const { E, state } = newGame();
  const t0 = minutesOf(state);
  const calls = scriptedModel(E, {
    prose: '[+0m] You ask Teo about the rattle.\n\n[+10m] Teo opens the panel.\n\n[+20m] Teo points at a clog. "Could be worse."',
    more: '[+35m] For the next quarter hour you work the clog loose together.\n\n[+50m] Okafor leans in the doorway. "Arrays next."',
  });
  await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'hour');
  assert.equal(calls.filter((c) => c.kind === 'narrate (continue)').length, 1);
  const scene = state.log.find((e) => e.type === 'scene' && e.turn === 1);
  assert.deepEqual([...scene.beats.map((b) => b.at)], [0, 10, 20, 35, 50]);
  assert.equal(minutesOf(state) - t0, 56, 'last beat (+50m) plus a little, not the full hour');
  assert.equal(state.log.find((e) => e.type === 'action' && e.turn === 1).until, 'Sol 214, 07:56');
});

test('a scene that covers most of the step is not continued and keeps the full step', async () => {
  const { E, state } = newGame();
  const t0 = minutesOf(state);
  const calls = scriptedModel(E, { prose: '[+0m] You ask Teo.\n\n[+30m] Okafor heads out.\n\n[+55m] Teo shrugs. "Sensor."' });
  await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'hour');
  assert.ok(!calls.some((c) => c.kind === 'narrate (continue)'));
  assert.equal(minutesOf(state) - t0, 60);
});

test('a short continuation is not retried; the clock still follows the scene', async () => {
  const { E, state } = newGame();
  const t0 = minutesOf(state);
  const calls = scriptedModel(E, { prose: '[+0m] You ask Teo.\n\n[+10m] Teo shrugs.', more: '[+15m] Teo goes quiet. "Anything else?"' });
  await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'hour');
  assert.equal(calls.filter((c) => c.kind === 'narrate (continue)').length, 1);
  assert.equal(minutesOf(state) - t0, 21);
});

test('a few minutes is never continued and keeps its span', async () => {
  const { E, state } = newGame();
  const t0 = minutesOf(state);
  const calls = scriptedModel(E, { prose: '[+0m] You ask Teo. He shrugs.' });
  await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'moment');
  assert.ok(!calls.some((c) => c.kind === 'narrate (continue)'));
  assert.equal(minutesOf(state) - t0, 15);
});

test('a pressure clock firing during the step keeps the full step', async () => {
  const { E, state } = newGame();
  const t0 = minutesOf(state);
  const cl = state.clocks.find((c) => c.perHour > 0);
  cl.value = cl.max - cl.perHour * 0.9;
  scriptedModel(E, { prose: '[+0m] You ask Teo.\n\n[+10m] An alarm goes off. "That\'s not good," Teo says.', more: '' });
  await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'hour');
  assert.ok(cl.fired);
  assert.equal(minutesOf(state) - t0, 60);
});

test('a failed model call rolls the whole turn back', async () => {
  const { E, state } = newGame();
  E.LLM.transport = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(E.Engine.runTurn(state, 'Ask Teo.', 'hour'), /Couldn't reach KoboldCpp/);
  assert.equal(state.turn, 0);
  assert.equal(state.time.hour, 7);
});

test('per-step routing sends each step to its backend', async () => {
  const { E, state } = newGame();
  E.settings.backends.external = { preset: 'custom', url: 'https://api.example.com/v1', key: 'sk-test', model: 'bigco/story-70b' };
  E.settings.routing = { intent: 'external', narrate: 'external', update: 'local', chapter: 'local' };
  const seen = [];
  E.LLM.transport = async (url, body, kind) => {
    seen.push(`${kind}@${new URL(url).host}:${body.model}`);
    if (kind === 'intent') return JSON.stringify({ player: {}, intents: [], events: [] });
    if (kind === 'narrate') return 'Teo looks up.';
    return JSON.stringify({ facts: [], state: [], relations: [] });
  };
  await E.Engine.runTurn(state, 'Wave.', 'moment');
  await E.Engine.runTurn(state, 'Wave again.', 'moment');
  assert.ok(seen.includes('intent@api.example.com:bigco/story-70b'));
  assert.ok(seen.includes('narrate@api.example.com:bigco/story-70b'));
  assert.ok(seen.includes('update@localhost:5001:koboldcpp'));
});

// OpenRouter free reasoning models: thinking counts against max_tokens, so the
// reply came back empty or cut off mid-JSON, and the retry used the same limit.
function cutOffModel(E, replies) {
  const bodies = [];
  E.LLM.transport = async (url, body) => { bodies.push(body); return replies[Math.min(bodies.length - 1, replies.length - 1)]; };
  return bodies;
}

test('a hosted reply that runs out of room while thinking is retried with more room', async () => {
  const { E } = newGame();
  E.settings.backends.external = { preset: 'openrouter', url: 'https://openrouter.ai/api/v1', key: 'k', model: 'some/reasoner:free' };
  E.settings.routing.intent = 'external';
  const bodies = cutOffModel(E, [{ text: '<think>Let me consider each character carefully', finish: 'length' }, { text: '{"ok": true}', finish: 'stop' }]);
  const obj = await E.LLM.chatJSON({ kind: 'intent', system: 's', user: 'u', maxTokens: 300 });
  assert.equal(obj.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 10000, 'hosted JSON steps get a flat 10k');
  assert.equal(bodies[1].max_tokens, 20000, 'and double that if cut off');
  assert.deepEqual({ ...bodies[0].reasoning }, { effort: 'low', exclude: true }, 'OpenRouter is asked to keep reasoning short');
});

test('JSON cut off mid-object is retried with a bigger limit, not the same one', async () => {
  const { E } = newGame();
  const bodies = cutOffModel(E, [{ text: '{"player": {"summary": "talk to', finish: 'length' }, { text: '{"player": {"summary": "talk to Teo"}}', finish: 'stop' }]);
  const obj = await E.LLM.chatJSON({ kind: 'intent', system: 's', user: 'u', maxTokens: 300 });
  assert.equal(obj.player.summary, 'talk to Teo');
  assert.equal(bodies[1].max_tokens, 600, 'local KoboldCpp gets double');
  assert.equal(bodies[0].reasoning, undefined, 'only OpenRouter gets the reasoning setting');
});

// Log (DeepSeek): rich intents ran past the limit inside the second event.
const DEEPSEEK_CUT = '{"player":{"summary":"Kit checks in on Teo.","needs_roll":false,"skill":null,"move_to":null},' +
  '"intents":[{"id":"okafor","action":"assigns the sol\'s work","says":"Arrays and the Mule by 18:00.","visible":true},' +
  '{"id":"bauer","action":"deflects hard","says":"It\'s probably just the filter housing, honestly, I\'ll handle it.","visible":true}],' +
  '"events":[{"text":"Priya comes back over the intercom.","scope":"local","who":["raman"],"visibility":"heard","moves":[],"effects":null},' +
  '{"text":"The orbital weather relay pushes a new pass: the storm front has accelerated, now tracking to reach';

test('JSON still cut off after the bigger retry is salvaged up to the last complete item', async () => {
  const { E } = newGame();
  cutOffModel(E, [{ text: DEEPSEEK_CUT, finish: 'length' }]);
  const obj = await E.LLM.chatJSON({ kind: 'intent', system: 's', user: 'u', maxTokens: 300 });
  assert.equal(obj.intents.length, 2);
  assert.equal(obj.events.length, 1, 'the half-written event is dropped');
  assert.equal(obj.events[0].who[0], 'raman');
  assert.ok(E.LLM.calls[E.LLM.calls.length - 1].salvaged, 'marked in Debug');
});

test('a reply that was not cut off is never salvaged', async () => {
  const { E } = newGame();
  cutOffModel(E, [{ text: DEEPSEEK_CUT, finish: 'stop' }]);
  await assert.rejects(E.LLM.chatJSON({ kind: 'intent', system: 's', user: 'u', maxTokens: 300 }), /valid JSON/);
});

test('a bad reply that was not cut off retries with the same limit', async () => {
  const { E } = newGame();
  const bodies = cutOffModel(E, [{ text: 'Sure! Here is what happens.', finish: 'stop' }, { text: '{"a": 1}', finish: 'stop' }]);
  await E.LLM.chatJSON({ kind: 'intent', system: 's', user: 'u', maxTokens: 300 });
  assert.equal(bodies[1].max_tokens, 300);
});

test('old single-endpoint settings migrate to the local backend', () => {
  const store = { 'ensemble.settings': JSON.stringify({ endpoint: 'http://192.168.1.20:5001', narrateTokens: 420 }) };
  const E = loadEngine({ localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } } });
  E.loadSettings();
  assert.equal(E.settings.backends.local.url, 'http://192.168.1.20:5001/v1');
  assert.equal(E.settings.narrateTokens, 320);
  assert.equal(E.settings.routing.narrate, 'local');
});
