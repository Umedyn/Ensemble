// Engine rules. Each test pins down a behavior we hit while playtesting with a
// real 12B model; the comment says what went wrong before the rule existed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, fixedRng, readScenario, loadEngine } = require('./helpers');

const intentOf = (o) => JSON.parse(JSON.stringify(o));
const PRESENT = ['okafor', 'bauer'];
const guardTypes = (res) => [...(res.guards || [])].map((g) => g.type);

// ---------- scenarios ----------

// Every bundled world and start: tests/worlds.test.js.

test('cast helpers list ids in cast order: everyone, the living, present and offstage', () => {
  const { E, state } = newGame();
  state.characters.sorensen.status.location = 'ops';
  state.characters.bauer.status.health = 'dead';
  const Eng = E.Engine;
  assert.deepEqual([...Eng.cast(state)], [...state.order]);
  assert.ok(Eng.cast(state, { alive: true }).includes('navarro'));
  assert.ok(!Eng.cast(state, { alive: true }).includes('bauer'));
  assert.ok(!Eng.cast(state, { includePlayer: false }).includes('navarro'));
  assert.deepEqual([...Eng.present(state)], ['okafor']);
  assert.deepEqual([...Eng.present(state, 'ops')], ['sorensen']);
  assert.deepEqual([...Eng.offstage(state)], ['sorensen', 'raman'], 'the dead are neither present nor offstage');
  assert.deepEqual([...Eng.offstage(state, [])], ['okafor', 'sorensen', 'raman']);
});

test('scenario validation reports authoring mistakes', () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  sc.characterData[1].status.location = 'nowhere';
  sc.characterData[1].guard = 'extreme';
  assert.throws(() => E.Scenario.validate(sc), (err) =>
    /unknown location "nowhere"/.test(err.message) && /guard must be low, medium or high/.test(err.message));
});

// Content for later phases can be authored before the engine reads it.
test('scenario validation accepts and ignores fields the engine does not use yet', () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  Object.assign(sc, { tags: ['hard-sf'], lore: [{ id: 'ares', title: 'The Ares program' }], regions: [{ id: 'tharsis' }] });
  sc.locations[0].region = 'tharsis';
  Object.assign(sc.characterData[1], { tags: ['stubborn'], portrait: 'okafor.png', region: 'tharsis' });
  const state = E.Engine.newGame(E.Scenario.validate(sc));
  assert.equal(state.characters[sc.characterData[1].id].name, sc.characterData[1].name);
  assert.ok(E.Prompts.header(state).includes(sc.worldTitle));
});

// ---------- movement ----------

test('acting on someone in the room cancels a move elsewhere (log 3/4: Kit walked off to hydroponics)', () => {
  const { E, state } = newGame();
  const res = E.Engine.resolve(state, intentOf({ player: { summary: 'Kit checks on Teo in hydroponics', move_to: 'hydro' }, intents: [] }), PRESENT, 'See what Teo is up to.', 'hour');
  assert.equal(state.characters.navarro.status.location, 'commons');
  assert.match(res.outcomes[0].note, /stayed with Teo Bauer/);
  assert.match(res.outcomes[0].action, /right here in Commons/, 'narrator gets the player words, not the model summary naming the wrong room');
  assert.deepEqual(guardTypes(res), ['move cancelled']);
});

// Playtest 2026-10-19 (DeepSeek): the guard above cancelled four moves the
// player asked for, because each action also named someone in the room.
test('a move the player states is kept even when the action names someone in the room', () => {
  const move = (action, to, present, setup) => {
    const { E, state } = newGame();
    if (setup) setup(state);
    const res = E.Engine.resolve(state, intentOf({ player: { move_to: to }, intents: [] }), present, action, 'hour');
    return { where: state.characters.navarro.status.location, guards: guardTypes(res) };
  };
  const toGarage = (s) => { s.characters.raman.status.location = 'garage'; s.characters.navarro.status.location = 'garage'; };
  assert.equal(move('Help Priya then go work on the Array.', 'surface', ['raman'], toGarage).where, 'surface', '"then go"');
  assert.equal(move('Ask Teo to watch the console while I head down to the garage.', 'garage', PRESENT).where, 'garage', '"I head"');
  assert.equal(move('Help Priya while Teo works on the shaft.', 'garage', PRESENT).where, 'garage', 'Priya is in the garage');
  assert.equal(move('Grab the toolkit and go to the lab with Teo.', 'lab', PRESENT).where, 'lab', '"and go"');
  const asked = move('Ask Teo to go to the lab.', 'lab', PRESENT);
  assert.equal(asked.where, 'commons', 'Teo going is not the player going');
  assert.deepEqual(asked.guards, ['move cancelled']);
});

// Playtest 2026-10-20 (friend, DeepSeek): "…then i get up to follow him" was
// cancelled while Teo himself walked to Hydroponics.
test('following someone who leaves this turn is a stated move', () => {
  const { E, state } = newGame();
  E.Engine.resolve(state, intentOf({ player: { move_to: 'hydro' }, intents: [{ id: 'bauer', action: 'heads back to the recycler', move_to: 'hydro' }] }), PRESENT,
    'i tell Teo "here, i\'ll help with that and it\'ll take even less time", then i get up to follow him', 'hour');
  assert.equal(state.characters.navarro.status.location, 'hydro');
  const g = newGame();
  g.E.Engine.resolve(g.state, intentOf({ player: { move_to: 'hydro' }, intents: [{ id: 'bauer', action: 'goes to fix the recycler', move_to: 'hydro' }] }), PRESENT, 'Help Teo with the recycler.', 'hour');
  assert.equal(g.state.characters.navarro.status.location, 'hydro', 'Teo is heading there, so going with him is not leaving him');
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

// Playtest 2026-10-20 (playtest-zombie-steps-outside): "You nod, then step
// outside into the cool morning air." named no room, so nothing caught it.
test('relocation check catches the player stepping outside when they are not moving', () => {
  const { E, state } = newGame('zombie-holdout');
  const where = (p, from = 'floor') => E.Engine.findRelocation(state, p, from);
  assert.equal(where('You nod, then step outside into the cool morning air.').to, 'outside');
  assert.equal(where('You head out the back door, rifle ready.').to, 'outside');
  assert.equal(where('You slip out into the lot.').to, 'outside');
  assert.equal(where('You glance outside through a gap in the plywood.'), null, 'looking is not moving');
  assert.equal(where('Dex steps outside to check the street.'), null, 'others leaving is fine');
  state.characters.pike.status.location = 'lot';
  assert.equal(where('You step outside into the lot, squinting at the light.', 'dock'), null, 'a stated move outdoors is fine');
});

// Same playtest: the update gave a scene fact to Marlene and Gil, who were in
// other rooms. People in this turn's events (even hidden ones) may still know.
test('update facts are known only by the player, the people present and those in this turn\'s events', () => {
  const { E, state } = newGame('zombie-holdout');
  const report = E.Engine.applyUpdate(state, { facts: [
    { about: ['pike'], text: 'Pike and Dex talked about lumber.', known_by: ['ortiz', 'coleman', 'han', 'ferris'], weight: 2 },
    { about: [], text: 'The radio crackled loud enough for the whole store.', known_by: ['all'], weight: 1 },
    { about: ['ortiz'], text: 'Marlene heard everything.', known_by: ['ortiz'], weight: 1 },
  ] }, ['coleman', 'han'], {});
  E.Engine.applyUpdate(state, { facts: [
    { about: ['ferris'], text: 'Gil counted the cans in his desk.', known_by: ['ferris'], weight: 2 },
  ] }, ['coleman', 'han'], { involved: ['ferris'] });
  const known = (re) => [...state.facts.find((f) => re.test(f.text)).known_by];
  assert.deepEqual(known(/lumber/), ['coleman', 'han']);
  assert.deepEqual(known(/cans/), ['ferris'], "Gil's hidden event");
  assert.deepEqual(known(/radio/), ['all']);
  assert.deepEqual(known(/heard everything/), ['pike', 'coleman', 'han'], 'nobody left: falls back to the witnesses');
  assert.ok(report.rejected.some((r) => /dropped ortiz, ferris: not in the scene/.test(r)));
});

// Playtest 2026-10-19: "you cross the commons" on the way from Hydroponics to
// the Med Bay triggered a rewrite; the Commons is the only way through.
test('rooms passed through on the way are not a relocation', () => {
  const { E, state } = newGame();
  state.characters.navarro.status.location = 'med';
  assert.deepEqual([...E.Engine.route(state, 'hydro', 'med')], ['hydro', 'commons', 'med']);
  assert.equal(E.Engine.findRelocation(state, 'You leave Teo at the console and cross the commons to the med bay.', 'hydro'), null);
  assert.equal(E.Engine.findRelocation(state, 'You head into the lab first.', 'hydro').id, 'lab', 'a detour still counts');
});

// Playtest 2026-10-19: walking to the garage, the frame told the narrator that
// Okafor "leaves for Commons", the room she never left.
test('when the player moves, people who stay put are left behind, not leaving', () => {
  const { E, state } = newGame();
  state.characters.navarro.status.location = 'garage';
  state.characters.bauer.status.location = 'hydro';
  const user = E.Prompts.narrate(state, PRESENT, 'Check on the Mule.', { startLoc: 'commons', startTime: 'Sol 214, 07:15', stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 }, { outcomes: [], events: [] });
  assert.match(user, /Dr\. Imani Okafor stays behind in Commons/);
  assert.match(user, /Teo Bauer leaves for Hydroponics/);
  assert.ok(!/leaves for Commons/.test(user));
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
  assert.deepEqual(guardTypes(res), ['leak deflected'], 'a leak, not the reveals field');
});

test('innocent dialogue is not mistaken for a leak', () => {
  const { E, state } = newGame();
  const res = E.Engine.resolve(state, intentOf({ player: {}, intents: [{ id: 'bauer', action: 'checks the readout', says: "The recycler's acting up. Sensor issue." }] }), PRESENT, 'Make coffee.', 'hour');
  assert.equal(res.outcomes.find((o) => o.id === 'bauer').action, 'checks the readout');
  assert.deepEqual(guardTypes(res), []);
});

test('high-guard Okafor holds even when asked directly; a social success opens anyone', () => {
  const ask = (rng, intentPlayer) => {
    const g = newGame();
    fixedRng(g.E, rng);
    const r = g.E.Engine.resolve(g.state, intentOf({ player: intentPlayer, intents: [{ id: 'okafor', action: 'admits she adjusted the report', says: 'I adjusted the purity numbers', reveals: true }] }), PRESENT, 'Ask Okafor why the ice purity numbers look off.', 'hour');
    ask.guards = guardTypes(r);
    return r.outcomes.find((o) => o.id === 'okafor').reveals;
  };
  assert.equal(ask([0.5], {}), null);
  assert.deepEqual(ask.guards, ['reveal blocked']);
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

// add_condition is the update step's name from before tags (task 1-6); recordings still use it.
test('moods are rejected as tags (stress is a need), and the old add_condition name still adds a tag', () => {
  const { E, state } = newGame();
  E.Engine.applyUpdate(state, { state: [
    { target: 'char:bauer', field: 'add_condition', value: 'stressed' },
    { target: 'char:bauer', field: 'add_condition', value: 'grease-stained hands' },
  ] }, PRESENT, { turn: 1 });
  assert.deepEqual([...state.characters.bauer.tags.map((t) => t.text)], ['grease-stained hands']);
});

// ---------- narration cleanup ----------

test('prose cleanup: repeated paragraphs, cut-off sentences, endings on the player', () => {
  const { E } = newGame();
  assert.equal(E.Engine.cleanProse('You find Teo.\n\n"You find Teo."\n\nHe looks up.'), 'You find Teo.\n\nHe looks up.');
  assert.equal(E.Engine.cleanProse('Priya sighs. "I swear, if I have to'), 'Priya sighs.');
  assert.equal(E.Engine.trimPlayerEnding('Teo hurries off.\n\nYou turn back to the counter.'), 'Teo hurries off.');
  const res = {};
  assert.equal(E.Engine.cleanScene('Teo looks up.\n\nTeo looks up.\n\nYou turn back to the counter. "Fine, I\'ll', res), 'Teo looks up.');
  assert.deepEqual(guardTypes(res), ['cut to last sentence', 'repeated paragraph removed', 'player ending trimmed']);
  const quiet = {};
  E.Engine.cleanScene('Teo looks up. "Sensor."', quiet);
  assert.deepEqual(guardTypes(quiet), [], 'clean prose fires nothing');
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

test('unknown or invalid event effects are rejected and reported in Debug, valid ones still apply', () => {
  const { E, state } = newGame();
  const before = state.clocks.length;
  const res = E.Engine.resolve(state, intentOf({ player: {}, intents: [], events: [
    { scope: 'world', text: 'Halvorsen announces layoffs.', visibility: 'heard',
      effects: { world: [{ key: 'comms', value: 'jammed' }, { key: 'toString', value: 'x' }], morale: [{ value: -2 }],
        groups: [{ id: 'nobody', stance: 'angry' }], clocks: { id: 'storm', delta: 2 }, new_clock: null } },
  ] }), PRESENT, 'Ask Teo.', 'hour', { world: true });
  assert.equal(state.world.comms, 'jammed');
  assert.equal(state.clocks.length, before);
  assert.deepEqual([...res.director[0].effects], ['comms: jammed']);
  const rejected = [...res.guards].filter((g) => g.type === 'effect rejected').map((g) => g.detail);
  assert.ok(rejected.some((d) => /^morale: unknown effect/.test(d)));
  assert.ok(rejected.some((d) => /world: unknown world key "toString"/.test(d)));
  assert.ok(rejected.some((d) => /groups: unknown group "nobody"/.test(d)));
  assert.ok(rejected.some((d) => /clocks: not a list/.test(d)));
  assert.equal(rejected.length, 4);
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

// Playtest 2026-10-20: the player stepped in while Teo was still refitting a
// panel, but the update step moved him to Ops (his plan for later in the
// scene), so the confrontation that followed happened with an empty room.
test('after a step-in, the update step only moves people the kept scene shows leaving', () => {
  const { E, state } = newGame();
  const kept = '"Go see Okafor about the incubator draw."\n\n"Yeah — yeah, I\'ll go." Teo is already crouched, fitting the panel back on with exaggerated care.';
  const r = E.Engine.applyUpdate(state, { state: [{ target: 'char:bauer', field: 'location', value: 'ops' }] }, PRESENT, { startLoc: 'commons', endLoc: 'commons', keptProse: kept });
  assert.equal(state.characters.bauer.status.location, 'commons');
  assert.match(r.rejected[0], /stepped in before they left/);
  assert.ok(E.Engine.seenLeaving('Okafor pockets her tablet. She’s gone toward Ops before you can answer.', state.characters.okafor));
  assert.ok(E.Engine.seenLeaving('Teo\'s face does something complicated. He\'s backing toward the corridor.', state.characters.bauer));
  const full = E.Engine.applyUpdate(state, { state: [{ target: 'char:bauer', field: 'location', value: 'ops' }] }, PRESENT, { startLoc: 'commons', endLoc: 'commons' });
  assert.equal(full.rejected.length, 0, 'without a step-in the old rule applies');
});

test('after a step-in, the update prompt calls the resolution a plan, not what happened', () => {
  const { E, state } = newGame();
  const res = { outcomes: [{ id: 'navarro', action: 'fix it', visible: true }], events: [] };
  assert.match(E.Prompts.update(state, 'Fix it.', res, 'Teo shrugs.', PRESENT, true), /WHAT WAS PLANNED THIS TURN/);
  assert.match(E.Prompts.update(state, 'Fix it.', res, 'Teo shrugs.', PRESENT, false), /WHAT HAPPENED THIS TURN/);
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

// ---------- undo and reroll (playtest tools) ----------

const withoutUndo = (state) => { const s = JSON.parse(JSON.stringify(state)); delete s.undo; return JSON.stringify(s); };

// Like scriptedModel, but the player's action needs a roll and prose can change between calls.
function rollingModel(E, proses) {
  let n = 0;
  return mockLLM(E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'fix the recycler', needs_roll: true, skill: 'tech', difficulty: 'hard' }, intents: [
      { id: 'okafor', action: 'goes to Ops to call Mission Control', move_to: 'ops' },
      { id: 'bauer', action: 'deflects', says: 'Sensor issue.' }], events: [] };
    if (kind === 'narrate (continue)') return '';
    if (kind.startsWith('narrate')) return proses[Math.min(n++, proses.length - 1)];
    if (kind.startsWith('update')) return { facts: [{ about: ['bauer'], text: 'Teo blamed a sensor.', known_by: ['navarro', 'bauer'], weight: 2 }], state: [], relations: [{ from: 'bauer', to: 'navarro', delta: -5 }] };
    return { title: 'The Rattle', summary: 'Kit looked into the recycler.' };
  });
}

test('undo returns the exact state from before the last action: facts, time, clocks and rolls', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.5, 0.9, 0.1, 0.7]);
  rollingModel(E, ['[+0m] You open the panel.\n\n[+40m] Teo shrugs. "Sensor."']);
  await E.Engine.runTurn(state, 'Fix the recycler.', 'hour');
  const before = withoutUndo(state);
  await E.Engine.runTurn(state, 'Ask Teo again.', 'hours');
  assert.notEqual(withoutUndo(state), before, 'the second turn changed things');
  const info = E.Engine.undo(state);
  assert.equal(withoutUndo(state), before);
  assert.equal(info.turn, 2);
  assert.equal(info.action, 'Ask Teo again.');
  assert.equal(info.stepId, 'hours');
  assert.equal(state.pending.turn, 1, 'turn 1 is pending again, its memory not yet recorded');
  assert.ok(!state.facts.some((f) => /sensor/.test(f.text)));
  assert.ok(!E.Engine.canUndo(state), 'only one level of undo');
  assert.equal(E.Engine.undo(state), null);
});

test('undo after a chapter close also removes that chapter', async () => {
  const { E, state } = newGame();
  E.settings.chapterLength = 2;
  rollingModel(E, ['[+0m] You open the panel. Teo shrugs.']);
  await E.Engine.runTurn(state, 'Fix the recycler.', 'moment');
  await E.Engine.runTurn(state, 'Keep at it.', 'moment');
  const before = withoutUndo(state);
  await E.Engine.runTurn(state, 'Ask Teo.', 'moment');
  assert.equal(state.chapters.length, 1);
  assert.ok(state.log.some((e) => e.type === 'chapter'));
  const info = E.Engine.undo(state);
  assert.deepEqual([...info.chaptersRemoved], [1]);
  assert.equal(state.chapters.length, 0);
  assert.equal(state.chapter, 1);
  assert.ok(!state.log.some((e) => e.type === 'chapter'));
  assert.equal(withoutUndo(state), before);
});

test('undo after stepping in brings back the whole previous scene, still pending', async () => {
  const { E, state } = newGame();
  scriptedModel(E, { prose: '[+0m] You ask Teo. He shrugs.\n\n[+70m] Okafor heads for Ops.\n\n[+160m] Priya stomps in.' });
  await E.Engine.runTurn(state, 'Ask Teo about the rattle.', 'hours');
  const t1 = E.fmtTime(state);
  await E.Engine.runTurn(state, 'Imani, wait.', 'moment', null, 1);
  const info = E.Engine.undo(state);
  assert.equal(info.cutAt, 1, 'the page can put the step-in point back');
  assert.equal(state.pending.turn, 1);
  assert.equal(state.pending.beats.length, 3, 'beats after the step-in are back, since the step-in was undone');
  assert.equal(state.log.find((e) => e.type === 'scene' && e.turn === 1).cutAt, undefined);
  assert.equal(state.characters.okafor.status.location, 'ops');
  assert.equal(E.fmtTime(state), t1);
});

test('a failed turn keeps the previous undo', async () => {
  const { E, state } = newGame();
  scriptedModel(E, { prose: 'Teo shrugs. "Sensor issue."' });
  await E.Engine.runTurn(state, 'Ask Teo.', 'moment');
  E.LLM.transport = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(E.Engine.runTurn(state, 'Nod.', 'moment'));
  assert.equal(state.undo.action, 'Ask Teo.');
  E.Engine.undo(state);
  assert.equal(state.turn, 0);
});

test('reroll keeps the rolls, positions, events and time, and replaces only the prose and beats', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.5, 0.95]);
  const calls = rollingModel(E, ['[+0m] You open the panel.\n\n[+40m] Teo shrugs. "Sensor."', '[+0m] You crack the casing.\n\n[+20m] Okafor leaves.\n\n[+40m] Teo frowns. "Careful."']);
  await E.Engine.runTurn(state, 'Fix the recycler.', 'hour');
  const keep = (s) => JSON.stringify({ time: s.time, outcomes: s.pending.res.outcomes, chars: s.characters, clocks: s.clocks.map((c) => c.fired), facts: s.facts, world: s.world, turn: s.turn });
  const kept = keep(state);
  const firstSystem = calls.find((c) => c.kind === 'narrate').system;
  const out = await E.Engine.rerollNarration(state);
  assert.equal(calls.filter((c) => c.kind === 'intent').length, 1, 'no new intent call');
  assert.equal(calls.filter((c) => c.kind === 'narrate').length, 2);
  const reroll = calls.filter((c) => c.kind === 'narrate')[1];
  assert.equal(reroll.system, firstSystem, 'same cached prefix as the turn');
  assert.ok(!reroll.user.includes('You open the panel'), 'the old draft is not fed back as the last scene');
  assert.equal(keep(state), kept);
  assert.match(out.oldText, /open the panel/);
  const scene = state.log.find((e) => e.type === 'scene' && e.turn === 1);
  assert.match(scene.text, /crack the casing/);
  assert.equal(scene.beats.length, 3);
  assert.equal(state.pending.beats.length, 3);
  assert.match(state.recent[0].text, /crack the casing/);
  assert.equal(state.log.filter((e) => e.turn === 1).length, 3, 'no extra log entries');
});

test('reroll on a loose step settles the clock on the new scene', async () => {
  const { E, state } = newGame();
  const t0 = minutesOf(state);
  rollingModel(E, ['[+0m] You open the panel.\n\n[+40m] Teo shrugs.', '[+0m] You open the panel.\n\n[+20m] Teo shrugs.\n\n[+55m] Okafor calls.']);
  await E.Engine.runTurn(state, 'Fix the recycler.', 'hour');
  assert.equal(minutesOf(state) - t0, 46);
  assert.equal(state.log.find((e) => e.type === 'action').until, 'Sol 214, 07:46');
  await E.Engine.rerollNarration(state);
  assert.equal(minutesOf(state) - t0, 60, 'new last beat covers the hour');
  assert.equal(state.log.find((e) => e.type === 'action').until, undefined);
});

test('reroll then next turn: memory sees the rerolled scene; undo still goes back past both', async () => {
  const { E, state } = newGame();
  const calls = rollingModel(E, ['[+0m] Teo shrugs.', '[+0m] Teo glares. "Leave it."', '[+0m] Teo nods.']);
  await E.Engine.runTurn(state, 'Ask Teo.', 'moment');
  await E.Engine.rerollNarration(state);
  await E.Engine.runTurn(state, 'Nod.', 'moment');
  const upd = calls.find((c) => c.kind === 'update');
  assert.match(upd.user, /Leave it/);
  assert.ok(!upd.user.includes('Teo shrugs'));
  assert.ok(!E.Engine.canReroll(state) || state.pending.turn === 2, 'only the pending turn can be rerolled');
  E.Engine.undo(state);
  assert.equal(state.pending.turn, 1);
  assert.match(state.recent[0].text, /Leave it/, 'undo returns to the rerolled scene');
});

test('a failed reroll leaves the scene as it was', async () => {
  const { E, state } = newGame();
  rollingModel(E, ['[+0m] Teo shrugs.']);
  await E.Engine.runTurn(state, 'Ask Teo.', 'moment');
  const before = JSON.stringify(state);
  E.LLM.transport = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(E.Engine.rerollNarration(state));
  assert.equal(JSON.stringify(state), before);
});

test('reroll of a downtime skip keeps the time jump and where everyone is', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.995]);
  let n = 0;
  const calls = mockLLM(E, ({ kind }) => {
    if (kind === 'intent') return { montage: [{ after: '1d', text: 'Routine.' }], events: [], major_event: null, positions: [{ id: 'bauer', where: 'hydro', doing: 'pruning' }], player_where: 'commons' };
    return n++ ? '[+0h] Days pass.\n\n[+20h] The alarm sounds. Teo looks up.' : '[+0h] Quiet days.\n\n[+20h] An alarm. Priya swears.';
  });
  await E.Engine.runTurn(state, '', 'major');
  const time = E.fmtTime(state);
  await E.Engine.rerollNarration(state);
  assert.equal(calls.filter((c) => c.kind === 'intent').length, 1);
  assert.equal(E.fmtTime(state), time);
  assert.equal(state.characters.bauer.status.location, 'hydro');
  assert.match(state.log.find((e) => e.type === 'scene' && e.turn === 1).text, /Teo looks up/);
});

// ---------- telemetry ----------

test('a turn report lists its calls and every guard, including the update step rejections from the turn before', async () => {
  const { E, state } = newGame();
  let narrations = 0;
  mockLLM(E, ({ kind }) => {
    if (kind === 'intent') return { player: { summary: 'Kit checks on Teo in hydroponics', move_to: 'hydro' }, intents: [], events: [] };
    if (kind.startsWith('narrate')) return narrations++ ? 'Teo shrugs. "Sensor."' : 'You head to hydroponics. Teo is not there.';
    if (kind === 'update') return { facts: [], state: [{ target: 'char:navarro', field: 'location', value: 'hydro' }], relations: [] };
    return { title: 'T', summary: 'S' };
  });
  await E.Engine.runTurn(state, 'See what Teo is up to.', 'moment');
  const t1 = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  assert.equal(t1.turn, 1);
  assert.deepEqual([...t1.calls.map((c) => c.kind)], ['intent', 'narrate', 'narrate (retry)']);
  assert.deepEqual([...t1.guards.map((g) => g.type)], ['move cancelled', 'relocation regenerated']);
  await E.Engine.runTurn(state, 'Nod.', 'moment');
  const t2 = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  const rejected = t2.guards.find((g) => g.type === 'update rejected');
  assert.equal(rejected.turn, 1, 'the update step records turn 1');
  assert.match(rejected.detail, /only moves through the player's own action/);
  const text = E.Engine.turnReport(t2);
  assert.match(text, /^Turn 2 · "Nod\." · moment/);
  assert.match(text, /- update \[local: koboldcpp\]: ~\d+ in, ~\d+ out/, 'no usage, so counts are estimates');
  assert.match(text, /update rejected \(turn 1\)/);
  const t1text = E.Engine.turnReport(t1);
  assert.match(t1text, /What happened:\n- Kit Navarro: See what Teo is up to\. \(right here in Commons\) · stayed with Teo Bauer/, 'what the engine decided');
  assert.match(t1text, /Scene:\n\[\+0m\] Teo shrugs\. "Sensor\."$/, 'the scene as kept, with beat times');
});

test('telemetry uses the reply usage, cached tokens and KoboldCpp perf when they are reported', async () => {
  const { E, state } = newGame();
  E.LLM.transport = async (url, body, kind) => kind === 'intent'
    ? { text: JSON.stringify({ player: {}, intents: [], events: [] }), finish: 'stop' }
    : { text: 'Teo shrugs. "Sensor."', finish: 'stop', usage: { prompt_tokens: 1800, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 1500 } } };
  E.LLM.perf = async () => ({ processSec: 0.4, evalSec: 6.2, processTps: 4500, evalTps: 19 });
  await E.Engine.runTurn(state, 'Ask Teo.', 'moment');
  const t = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  const [intent, narrate] = t.calls;
  assert.equal(intent.estimated, true, 'missing usage falls back to an estimate');
  assert.ok(intent.promptTokens > 0 && intent.completionTokens > 0);
  assert.equal(intent.cachedTokens, null, 'no cache figure unless reported');
  assert.equal(narrate.estimated, false);
  assert.equal(narrate.promptTokens, 1800);
  assert.equal(narrate.cachedTokens, 1500);
  const totals = E.Engine.reportTotals(t);
  assert.equal(totals.estimated, true, 'one estimate makes the total an estimate');
  const text = E.Engine.turnReport(t);
  assert.match(text, /narrate \[local: koboldcpp\]: 1800 in, 120 out, .*1500 cached; prompt 0\.4 s, gen 6\.2 s/);
  assert.match(text, /Guards fired: none/);
});

test('a failed turn still leaves a report, with the error', async () => {
  const { E, state } = newGame();
  E.LLM.transport = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(E.Engine.runTurn(state, 'Ask Teo.', 'moment'));
  const t = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  assert.match(t.error, /Couldn't reach KoboldCpp/);
  assert.equal(t.calls.length, 1);
  assert.equal(E.LLM.collector, null, 'calls after the turn are not collected into it');
});

test('a reroll gets its own report, and only the new draft\'s cleanup counts', async () => {
  const { E, state } = newGame();
  let n = 0;
  mockLLM(E, ({ kind }) => kind === 'intent' ? { player: {}, intents: [], events: [] } : (n++ ? 'Teo shrugs.' : 'Teo shrugs.\n\nYou turn away.'));
  await E.Engine.runTurn(state, 'Ask Teo.', 'moment');
  assert.deepEqual(guardTypes(state.pending.res), ['player ending trimmed']);
  await E.Engine.rerollNarration(state);
  const t = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  assert.equal(t.kind, 'reroll');
  assert.deepEqual([...t.calls.map((c) => c.kind)], ['narrate']);
  assert.deepEqual(guardTypes(state.pending.res), []);
  assert.match(E.Engine.turnReport(t), /^Reroll of turn 1/);
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

// Playtest 2026-10-19 (DeepSeek): one scene came back empty after 725 tokens of
// thinking, another was cut off mid-sentence and lost its last event.
test('hosted prose calls get headroom for reasoning; local and JSON limits are unchanged', async () => {
  const { E } = newGame();
  E.settings.backends.external = { preset: 'openrouter', url: 'https://openrouter.ai/api/v1', key: 'k', model: 'deepseek/x' };
  E.settings.routing.narrate = 'external';
  const bodies = cutOffModel(E, [{ text: 'Teo shrugs.', finish: 'stop' }]);
  await E.LLM.chat({ kind: 'narrate', system: 's', user: 'u', maxTokens: 350 });
  await E.LLM.chat({ kind: 'update', system: 's', user: 'u', maxTokens: 350 });
  assert.equal(bodies[0].max_tokens, 350 + E.LLM.hostedTextHeadroom);
  assert.equal(bodies[1].max_tokens, 350, 'local KoboldCpp keeps the exact limit');
});

test('attitude notes are cut at a word, not mid-word', () => {
  const { E, state } = newGame();
  E.Engine.applyUpdate(state, { player_attitude: [{ to: 'raman', delta: 4, reason: 'Kit dropped what they were doing to cycle the airlock and get Raman out of the storm.' }] }, PRESENT);
  const note = state.characters.navarro.attitudeNotes.raman;
  assert.ok(note.length <= 80);
  assert.match(note, /get Raman out of the…$/);
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

// The single "context size" setting looked local-only, but it sized memory for
// every backend, so an all-DeepSeek game was still squeezed into 8K.
test('memory budgets follow the smallest context among the backends in use, capped', () => {
  const E = loadEngine();
  E.settings.backends.local.context = 8192;
  E.settings.backends.external.context = 131072;
  assert.equal(E.Memory.budgets().facts, Math.floor(8192 * 0.2), 'all local');
  E.settings.routing = { intent: 'external', narrate: 'external', update: 'local', chapter: 'local' };
  assert.equal(E.memoryContext().tokens, 8192, 'hybrid uses the smaller');
  E.settings.routing = { intent: 'external', narrate: 'external', update: 'external', chapter: 'external' };
  assert.deepEqual({ ...E.memoryContext() }, { tokens: 32768, from: 'external', capped: true }, 'all external, capped');
  E.settings.memoryCap = 65536;
  assert.equal(E.Memory.budgets().facts, Math.floor(65536 * 0.2));
});

test('the old global context size carries over to the local backend', () => {
  const store = { 'ensemble.settings': JSON.stringify({ contextSize: 16384, routing: { narrate: 'external' } }) };
  const E = loadEngine({ localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } } });
  E.loadSettings();
  assert.equal(E.settings.backends.local.context, 16384);
  assert.equal(E.settings.backends.external.context, 32768);
  assert.equal(E.settings.contextSize, undefined);
});

test('Test reads a hosted model\'s context from the provider\'s model list', async () => {
  const E = loadEngine({ fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: 'other/model', context_length: 4096 }, { id: 'deepseek/v4', context_length: 163840 }] }) }) });
  E.settings.backends.external = { preset: 'openrouter', url: 'https://openrouter.ai/api/v1', key: 'k', model: 'deepseek/v4', context: 32768 };
  const info = await E.LLM.ping('external');
  assert.equal(info.context, 163840);
});

test('old single-endpoint settings migrate to the local backend', () => {
  const store = { 'ensemble.settings': JSON.stringify({ endpoint: 'http://192.168.1.20:5001', narrateTokens: 420 }) };
  const E = loadEngine({ localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } } });
  E.loadSettings();
  assert.equal(E.settings.backends.local.url, 'http://192.168.1.20:5001/v1');
  assert.equal(E.settings.narrateTokens, 320);
  assert.equal(E.settings.routing.narrate, 'local');
});
