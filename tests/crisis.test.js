// Harm, endings and open emergencies (playtest-coffee-skips): a friend answered
// every scene with "Keep drinking coffee", and nothing could hurt anyone,
// emergencies solved themselves off-screen and the crew never minded.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, fixedRng, readScenario, loadEngine } = require('./helpers');

const guards = (res, type) => (res.guards || []).filter((g) => g.type === type).map((g) => g.detail);

// A model that answers every step plainly; extra per-kind answers override.
function model(E, over = {}) {
  return mockLLM(E, (call) => {
    const { kind } = call;
    if (over[kind]) return over[kind](call);
    if (kind.startsWith('intent (agenda)')) return { routine: true };
    if (kind.startsWith('intent')) return { player: { summary: 'waits' }, intents: [], events: [] };
    if (kind.startsWith('narrate')) return '[+0m] Okafor nods.\n\n[+30m] Teo hums at the counter.';
    if (kind.startsWith('update')) return { facts: [], state: [], relations: [] };
    return { title: 'T', summary: 'S' };
  });
}

// A skip that stops at the storm clock: no agendas in the way, no random stop.
function quietSkip(state) {
  Object.values(state.characters).forEach((c) => { c.agenda = null; });
}

test('harm only makes health worse, the player one step at a time, and the player dying ends the story', () => {
  const { E, state } = newGame();
  const res = { guards: [] };
  assert.match(E.Engine.harm(state, 'okafor', 'badly_hurt', res, 'test'), /Okafor: badly hurt/);
  assert.match(E.Engine.harm(state, 'okafor', 'hurt', res).reject, /no worse than badly hurt/);
  E.Engine.harm(state, 'navarro', 'dead', res);
  assert.equal(state.characters.navarro.status.health, 'hurt', 'one step for the player');
  assert.equal(state.flags.gameOver, false);
  E.Engine.harm(state, 'navarro', 'dead', res);
  E.Engine.harm(state, 'navarro', 'dead', res);
  assert.equal(state.characters.navarro.status.health, 'dead');
  assert.equal(state.flags.gameOver, true);
  assert.match(E.Engine.harm(state, 'navarro', 'dead', res).reject, /not a living character/);
});

test('the update step cannot bring the dead back', () => {
  const { E, state } = newGame();
  state.characters.okafor.status.health = 'dead';
  const r = E.Engine.applyUpdate(state, { state: [{ target: 'char:okafor', field: 'health', value: 'ok' }] }, ['okafor'], { startLoc: 'commons', endLoc: 'commons' });
  assert.equal(state.characters.okafor.status.health, 'dead');
  assert.ok(r.rejected.some((x) => /the dead stay dead/.test(x)));
});

test('a pressure that hurts when it goes off hurts everyone; a repeating one starts again; either leaves an emergency', () => {
  const { E, state } = newGame();
  state.clocks.push({ id: 'thirst', name: 'Thirst', value: 9.5, max: 10, perHour: 1, fired: false, fireText: 'Thirst turns into harm.', fireHarm: 'all', repeat: true });
  const res = { events: [], guards: [] };
  E.Engine.advanceTime(state, 1, res);
  ['navarro', 'okafor', 'sorensen', 'raman', 'bauer'].forEach((id) => assert.equal(state.characters[id].status.health, 'hurt', id));
  const thirst = state.clocks.find((c) => c.id === 'thirst');
  assert.deepEqual([thirst.fired, thirst.value], [false, 0], 'it starts again');
  assert.equal(state.crisis.text, 'Thirst turns into harm.');
  assert.equal(state.crisis.turn, state.turn);
  assert.equal(guards(res, 'harm').length, 5);
});

test('an open emergency is shown to the next hour\'s intent and update step', async () => {
  const { E, state } = newGame();
  state.crisis = { turn: state.turn, text: 'The CO2 alarm goes continuous.', who: ['okafor', 'bauer'] };
  const calls = model(E);
  await E.Engine.runTurn(state, 'Keep drinking coffee', 'hour');
  assert.match(calls.find((c) => c.kind === 'intent').user, /=== STILL HAPPENING ===\nThe last scene ended on an emergency: "The CO2 alarm goes continuous\." [^\n]*the others act on it without Kit Navarro/);
  assert.equal(state.pending.res.crisisText, 'The CO2 alarm goes continuous.');
  await E.Engine.runTurn(state, 'Keep drinking coffee', 'hour');
  assert.match(calls.filter((c) => c.kind === 'update')[0].user, /=== AN EMERGENCY WAS STILL HAPPENING ===[^]*record that in relations/);
  assert.doesNotMatch(calls.filter((c) => c.kind === 'intent').pop().user, /STILL HAPPENING/, 'one turn later it has played out');
});

test('skipping past an emergency: it plays out without the player, hurts only those there, and costs their trust', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]);
  quietSkip(state);
  state.crisis = { turn: state.turn, text: 'The CO2 alarm goes continuous.', who: ['okafor', 'bauer'] };
  const before = { okafor: state.characters.okafor.relations.navarro, bauer: state.characters.bauer.relations.navarro, raman: state.characters.raman.relations.navarro };
  const calls = model(E, {
    intent: () => ({
      crisis: { outcome: 'Teo collapses at the racks before Okafor gets the scrubber bypassed.', harm: [{ id: 'bauer', health: 'badly_hurt' }, { id: 'raman', health: 'dead' }] },
      montage: [
        { after: '6h', text: 'Kit rebuilds the scrubber intake by hand and gets the fan to half flow.' },
        { after: '12h', text: 'Kit keeps drinking coffee while Okafor works the checklist.' },
        { after: '20h', text: 'Teo admits he ran the recycler past its rated cycle and wiped the log.' },
      ],
      events: [], major_event: null, positions: [], player_where: 'commons',
    }),
    narrate: () => '[+0h] Days pass.\n\n[+40h] The storm hits.',
  });
  const out = await E.Engine.runTurn(state, 'Keep drinking coffee', 'major');
  const intent = calls.find((c) => c.kind === 'intent').user;
  assert.match(intent, /It starts with an emergency Kit Navarro's plan ignores: the last scene ended on "The CO2 alarm goes continuous\."/);
  assert.match(intent, /"crisis":\{"outcome":"one or two sentences","harm":\[/);
  assert.match(intent, /Kit Navarro does only what their plan says \("Keep drinking coffee"\)/);
  assert.equal(state.characters.bauer.status.health, 'badly_hurt');
  assert.equal(state.characters.raman.status.health, 'ok', 'Priya was in the garage');
  assert.ok(guards(out.res, 'harm rejected').some((g) => /Priya Raman wasn't there/.test(g)));
  assert.equal(state.characters.okafor.relations.navarro, before.okafor - E.Engine.CRISIS_TRUST);
  assert.equal(state.characters.bauer.relations.navarro, before.bauer - E.Engine.CRISIS_TRUST);
  assert.equal(state.characters.raman.relations.navarro, before.raman, 'not there, not let down');
  assert.ok(state.facts.some((f) => /^Teo collapses at the racks/.test(f.text) && f.known_by.includes('all') && f.weight === 3));
  assert.match(guards(out.res, 'crisis ignored')[0], /CO2 alarm[^]*Teo collapses[^]*trust toward Kit Navarro −6: Dr\. Imani Okafor, Teo Bauer/);
  // The montage: the player only drinks coffee, and Teo's secret doesn't come out there.
  assert.ok(guards(out.res, 'montage dropped').some((g) => /rebuilds the scrubber/.test(g)));
  assert.ok(guards(out.res, 'leak deflected').some((g) => /Teo Bauer, in the montage/.test(g)));
  const narrate = calls.find((c) => c.kind === 'narrate').user;
  assert.match(narrate, /=== DURING THE DOWNTIME ===\n- after 12h: Kit keeps drinking coffee[^\n]*\n\n/);
  assert.match(narrate, /=== ALSO DURING THE DOWNTIME ===\n- Teo collapses at the racks/);
  assert.equal(out.plan.reason, 'clock');
  assert.equal(state.crisis.turn, state.turn, 'the storm is the next emergency');
});

test('right after an emergency a random stop grows out of the people, lands where the player is, and hurts only those it reaches', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.01]);
  quietSkip(state);
  state.clocks.forEach((c) => { c.perHour = 0; });
  state.crisis = { turn: state.turn, text: 'The storm hits.', who: [] };
  const calls = model(E, {
    intent: () => ({
      crisis: { outcome: 'The crew rides out the storm.', harm: [] },
      montage: [], events: [], positions: [], player_where: 'commons',
      major_event: { text: 'A glovebox seal fails in the lab.', scope: 'local', who: [], where: 'lab', harm: [{ id: 'sorensen', health: 'hurt' }, { id: 'okafor', health: 'hurt' }] },
    }),
  });
  const out = await E.Engine.runTurn(state, '', 'major');
  assert.equal(out.plan.reason, 'random');
  const intent = calls.find((c) => c.kind === 'intent').user;
  assert.match(intent, /a turning point that grows out of the people, not another disaster/);
  assert.match(intent, /"harm":\[\{"id":"character_id","health":"hurt\|badly_hurt\|dead"\}\],"effects"/);
  // Kit sat that emergency out, so this one happens where Kit is, whatever "where" says.
  assert.match(intent, /Kit Navarro has sat things out long enough: this one happens where they are \(commons\) and to them/);
  assert.equal(state.characters.sorensen.status.health, 'ok', 'Lev was in the lab');
  assert.equal(state.characters.okafor.status.health, 'hurt', 'Okafor was in the commons, with Kit');
});

test('without an open emergency, a random stop is any major event and the montage rule still holds', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.01]);
  quietSkip(state);
  state.clocks.forEach((c) => { c.perHour = 0; });
  const calls = model(E, { intent: () => ({ montage: [], events: [], positions: [], player_where: 'commons', major_event: { text: 'A quake.', scope: 'local' } }) });
  await E.Engine.runTurn(state, '', 'major');
  const intent = calls.find((c) => c.kind === 'intent').user;
  assert.match(intent, /The downtime ends with a MAJOR EVENT that you choose/);
  assert.doesNotMatch(intent, /"crisis":/);
  assert.match(intent, /Kit Navarro does only what their plan says \("keep to routine"\)/);
});

test('a skip that ends with someone coming to talk is not a chapter beat and leaves no emergency', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]);
  ['okafor', 'raman', 'bauer'].forEach((id) => { state.characters[id].agenda = null; });
  Object.assign(state.characters.sorensen.agenda, { step: 2, progress: 0 });
  state.crisis = { turn: state.turn - 1, text: 'old news', who: [] };
  model(E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  const out = await E.Engine.runTurn(state, '', 'major');
  assert.equal(out.plan.reason, 'agenda');
  assert.equal(state.flags.chapterWorthy, false);
  assert.equal(state.crisis, undefined);
});

test('a player who dies in a skip gets a closing scene, and the story ends', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]);
  quietSkip(state);
  state.characters.navarro.status.health = 'badly_hurt';
  state.crisis = { turn: state.turn, text: 'The CO2 alarm goes continuous.', who: ['okafor'] };
  const calls = model(E, { intent: () => ({ crisis: { outcome: 'The air gives out in the commons.', harm: [{ id: 'navarro', health: 'dead' }] }, montage: [], events: [], positions: [], player_where: 'commons' }) });
  await E.Engine.runTurn(state, 'Keep drinking coffee', 'major');
  assert.equal(state.flags.gameOver, true);
  assert.match(calls.find((c) => c.kind === 'narrate').user, /Kit Navarro dies here \(STATUS\)[^\n]*This ends the story/);
  await assert.rejects(E.Engine.runTurn(state, 'Keep drinking coffee', 'hour'), /This story has ended/);
});

test('region tags an event adds fade after three days; the timeline\'s scripted ones last', () => {
  const { E, state } = newGame();
  const res = { events: [], guards: [] };
  E.Engine.applyEffects(state, { add_tag: [{ region: 'station', tag: 'co2 climbing' }] }, 'regional', res);
  E.Engine.applyEffects(state, { add_tag: [{ region: 'crater-rim', tag: 'scripted quake' }] }, 'regional', res, { lasting: true });
  E.Engine.advanceTime(state, 48, res);
  assert.ok(state.regions.station.tags.includes('co2 climbing'));
  E.Engine.advanceTime(state, 30, res);
  assert.ok(!state.regions.station.tags.includes('co2 climbing'));
  assert.ok(state.regions['crater-rim'].tags.includes('scripted quake'));
  assert.deepEqual(guards(res, 'region tag faded'), ['station: co2 climbing']);
});

test('worn phrases: runs of four or more words that recent scenes share, not names or filler', () => {
  const { E, state } = newGame();
  state.log = [
    { type: 'scene', text: 'You top up the pot. The coffee is the only warm thing in Commons, and Okafor says nothing at all.' },
    { type: 'scene', text: 'Teo leaves a mug. The coffee is the only warm thing in Commons now. Okafor says nothing at all.' },
  ];
  assert.deepEqual([...E.Engine.wornPhrases(state)], ['the coffee is the only warm thing in commons']);
  state.log = state.log.slice(0, 1);
  assert.deepEqual([...E.Engine.wornPhrases(state)], []);
});

test('a pressure may hurt "all" or "outside" when it goes off, and may repeat; both bundled worlds have one', () => {
  const E = loadEngine();
  const sc = readScenario('mars-station', 'recycler');
  sc.clocks[0].fireHarm = 'everyone';
  sc.clocks[0].then[0].repeat = 'yes';
  assert.throws(() => E.Scenario.validate(sc), (err) => /"fireHarm" must be "all" or "outside"/.test(err.message) && /"repeat" must be true or false/.test(err.message));
  const find = (list, id) => { for (const c of list || []) { if (c.id === id) return c; const t = find(c.then, id); if (t) return t; } return null; };
  const thirst = find(readScenario('mars-station', 'recycler').clocks, 'thirst');
  assert.deepEqual([thirst.fireHarm, thirst.repeat], ['all', true], 'after "Stored water runs low"');
  const starving = find(readScenario('zombie-holdout').clocks, 'starving');
  assert.deepEqual([starving.fireHarm, starving.repeat], ['all', true]);
});

// playtest-coffee-bystander (DeepSeek v4.1 flash, 2026-10-23): seven skips of
// coffee, and everything happened around Kit, never to them. A skip settled
// Kit's needs like everyone's, so four sols awake cost nothing.
test('a skip settles the player\'s needs only when their plan covers them; the rest climb', async () => {
  const { E, state } = newGame();
  const un = (a) => [...E.Engine.unmetNeeds(state, a)];
  assert.deepEqual(un(''), [], 'no plan: routine');
  assert.deepEqual(un('keep to my usual routine'), []);
  assert.deepEqual(un('Keep drinking coffee'), ['hunger', 'fatigue', 'stress']);
  assert.deepEqual(un('Eat a meal, then nap'), ['stress']);
  assert.deepEqual(un('Sleep in my bunk and eat when I wake'), [], 'sleep is rest too');
  fixedRng(E, [0.999]);
  quietSkip(state);
  model(E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  const okaforBefore = state.characters.okafor.needs.fatigue;
  await E.Engine.runTurn(state, 'Keep drinking coffee', 'major');
  assert.equal(state.characters.navarro.needs.fatigue, 1, '20 hours awake on coffee');
  assert.ok(state.characters.okafor.needs.fatigue < okaforBefore, 'everyone else kept to routine');
});

test('a need left too long stops the skip and happens to the player: they collapse and get hurt', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]);
  quietSkip(state);
  const pc = state.characters.navarro;
  pc.needs.fatigue = 1;
  pc.needsOver = { fatigue: 11 };
  const plan = E.Engine.planMajorSkip(state, 'Keep drinking coffee');
  assert.equal(plan.reason, 'body');
  assert.equal(plan.hours, 1, 'twelve hours past the limit is all a body lasts');
  assert.equal(E.Engine.planMajorSkip(state, 'Sleep it off').reason, 'clock', 'a plan with sleep in it has no such stop');
  const calls = model(E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  const out = await E.Engine.runTurn(state, 'Keep drinking coffee', 'major');
  assert.equal(out.plan.reason, 'body');
  assert.equal(pc.status.health, 'hurt');
  assert.equal(pc.needs.fatigue, 0.3, 'they slept where they fell');
  assert.match(guards(out.res, 'body gives out')[0], /Kit Navarro blacks out from exhaustion and goes down hard against a bulkhead. \(Fatigue at its limit; the plan "Keep drinking coffee" left no room for sleep\)/);
  assert.match(calls.find((c) => c.kind === 'intent').user, /The downtime ends when Kit Navarro's body gives out: their plan left no room for sleep, and Kit Navarro blacks out from exhaustion and goes down hard against a bulkhead./);
  assert.match(calls.find((c) => c.kind === 'intent').user, /The plan leaves out food and sleep and rest: show it wearing on Kit Navarro\./);
  assert.match(calls.find((c) => c.kind === 'narrate').user, /=== WHAT ENDS IT ===\nKit Navarro blacks out from exhaustion and goes down hard against a bulkhead./);
  assert.equal(state.crisis, undefined, 'the player\'s own collapse is no emergency for the next turn');
});

test('exhaustion hurts at most badly; going without food long enough kills, and the story ends', async () => {
  const { E, state } = newGame();
  const pc = state.characters.navarro;
  pc.status.health = 'badly_hurt';
  quietSkip(state);
  model(E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  pc.needs.fatigue = 1; pc.needsOver = { fatigue: 12 };
  fixedRng(E, [0.999]);
  await E.Engine.runTurn(state, 'Keep drinking coffee', 'major');
  assert.equal(pc.status.health, 'badly_hurt');
  pc.needs.hunger = 1; pc.needsOver = { hunger: 48 };
  fixedRng(E, [0.999]);
  await E.Engine.runTurn(state, 'Keep drinking coffee', 'major');
  assert.equal(pc.status.health, 'dead');
  assert.equal(state.flags.gameOver, true);
});

test('sitting out two emergencies brings a reckoning: the one who thinks least of the player comes to confront them', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]);
  quietSkip(state);
  state.characters.okafor.status.location = 'ops';
  state.ignored = ['The storm hits.'];
  state.crisis = { turn: state.turn, text: 'The recycler grinds to a halt.', who: ['okafor', 'bauer'] };
  const calls = model(E, {
    intent: () => ({ crisis: { outcome: 'Teo and Okafor get the loop isolated.', harm: [] }, montage: [], events: [], major_event: null, player_where: 'commons',
      positions: [{ id: 'okafor', where: 'ops', doing: 'logging the fault' }] }),
  });
  const out = await E.Engine.runTurn(state, 'Keep drinking coffee', 'major');
  assert.equal(out.plan.reason, 'reckoning');
  assert.equal(out.plan.hours, E.Engine.RECKONING_HOURS);
  assert.equal(out.plan.reckoning.id, 'okafor', 'the lowest regard for Kit');
  assert.match(calls.find((c) => c.kind === 'intent').user, /The downtime ends when Dr\. Imani Okafor comes to confront Kit Navarro, who has sat out 2 emergencies \("The storm hits\."; "The recycler grinds to a halt\."\)/);
  assert.equal(state.characters.okafor.status.location, 'commons', 'she comes to Kit, whatever the positions say');
  assert.match(calls.find((c) => c.kind === 'narrate').user, /- Dr\. Imani Okafor: in Commons, comes to confront Kit Navarro/);
  assert.ok(state.facts.some((f) => /confront Kit Navarro about sitting out the emergencies/.test(f.text) && f.known_by.includes('okafor')));
  assert.deepEqual([...state.ignored], [], 'the slate is clean');
  assert.ok(guards(out.res, 'reckoning').length);
});

test('a played turn that ignores an emergency counts like a skip: trust drops and the count grows; dealing with one clears it', async () => {
  const { E, state } = newGame();
  const answer = (v) => model(E, { intent: () => ({ player: { summary: 'x', crisis_answered: v }, intents: [], events: [] }) });
  state.crisis = { turn: state.turn, text: 'The CO2 alarm goes continuous.', who: ['okafor', 'bauer'] };
  const before = state.characters.okafor.relations.navarro;
  const calls = answer(false);
  const out = await E.Engine.runTurn(state, 'I keep drinking coffee.', 'hour');
  assert.match(calls.find((c) => c.kind === 'intent').user, /Set "player"\."crisis_answered" to true only if/);
  assert.match(calls.find((c) => c.kind === 'intent').user, /"crisis_answered":false/);
  assert.equal(state.characters.okafor.relations.navarro, before - E.Engine.CRISIS_TRUST);
  assert.deepEqual([...state.ignored], ['The CO2 alarm goes continuous.']);
  assert.match(guards(out.res, 'crisis ignored')[0], /the action didn't deal with it; trust toward Kit Navarro −6/);
  state.crisis = { turn: state.turn, text: 'The scrubber fan seizes.', who: ['okafor'] };
  answer(true);
  await E.Engine.runTurn(state, 'I go fix the scrubber fan.', 'hour');
  assert.deepEqual([...state.ignored], []);
});

test('with no word from the model, a played turn deals with an emergency only if the action names it', async () => {
  const { E, state } = newGame();
  model(E);
  state.crisis = { turn: state.turn, text: 'The scrubber fan seizes.', who: ['okafor'] };
  await E.Engine.runTurn(state, 'I check the scrubber.', 'hour');
  assert.deepEqual([...state.ignored], []);
  state.crisis = { turn: state.turn, text: 'The scrubber fan seizes.', who: ['okafor'] };
  await E.Engine.runTurn(state, 'I drink coffee.', 'hour');
  assert.equal(state.ignored.length, 1);
});

test('the reckoning comes in a played turn too: the one who has had enough walks in and is told to confront the player', async () => {
  const { E, state } = newGame();
  state.characters.okafor.status.location = 'ops';
  state.ignored = ['The storm hits.', 'The recycler grinds to a halt.'];
  const calls = model(E);
  const out = await E.Engine.runTurn(state, 'I drink coffee.', 'hour');
  const intent = calls.find((c) => c.kind === 'intent').user;
  assert.match(intent, /=== SOMEONE HAS HAD ENOUGH ===\nDr\. Imani Okafor has come to confront Kit Navarro, who has sat out 2 emergencies/);
  assert.match(intent, /\{"id":"okafor"/, 'she is present and gets an intent');
  assert.ok(guards(out.res, 'reckoning').length);
  assert.deepEqual([...state.ignored], []);
});

test("every world's needs have a limit: built-in ones, a plain one for any other need, and the world's own", () => {
  const { E, state } = newGame();
  state.scenario.needs.push({ id: 'oxygen', label: 'Oxygen', perHour: 0.1 });
  const ox = E.Engine.needLimit(state, 'oxygen');
  assert.equal(ox.text, 'gives out, worn down by oxygen');
  assert.deepEqual([...E.Engine.unmetNeeds(state, 'Swap my oxygen bottle')].includes('oxygen'), false);
  assert.ok([...E.Engine.unmetNeeds(state, 'Drink coffee')].includes('oxygen'));
  state.scenario.needs.find((n) => n.id === 'fatigue').limit = { relief: ['coffee'], text: 'nods off over the console', grace: 2 };
  const f = E.Engine.needLimit(state, 'fatigue');
  assert.equal(f.text, 'nods off over the console');
  assert.equal(f.grace, 2);
  assert.equal(f.missing, 'sleep', 'fields the world leaves out keep the built-in');
  assert.ok(![...E.Engine.unmetNeeds(state, 'Drink coffee')].includes('fatigue'));
});

test("a need's limit is checked when a world is loaded", () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  sc.needs[0].limit = { relief: 'eat', worst: 'gone', grace: -1, after: 1.5 };
  let problems = '';
  try { E.Scenario.validate(sc); } catch (err) { problems = err.message; }
  assert.match(problems, /need "hunger" limit: "relief" must be a list of words/);
  assert.match(problems, /"worst" must be ok, hurt, badly_hurt or dead/);
  assert.match(problems, /"grace" must be hours/);
  assert.match(problems, /"after" must be between 0 and 1/);
});

test('timeline news ends a skip but is no emergency, and the model repeating it as an event is dropped', async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]);
  quietSkip(state);
  state.clocks.forEach((c) => { c.perHour = 0; });
  const canon = state.scenario.timeline.find((t) => t.id === 'halvorsen-review');
  model(E, { intent: () => ({ montage: [], major_event: null, positions: [], player_where: 'commons', events: [{ text: canon.text, scope: 'world' }] }) });
  const out = await E.Engine.runTurn(state, '', 'major');
  assert.equal(out.plan.reason, 'canon');
  assert.equal(state.crisis, undefined);
  assert.ok(guards(out.res, 'event dropped').some((g) => /repeats the timeline event/.test(g)));
  assert.equal(state.facts.filter((f) => f.text === canon.text).length, 1);
});

// playtest-coffee-toothless: twenty more turns of coffee. Kit blacked out again
// and again, the update step healed them in between, Okafor's ultimatum came
// and went, and everyone who came asking for help was simply ignored.
test('a reply that forgets to close "major_event" is still read, and its stray keys go back where they belong', () => {
  const { E } = newGame();
  const rec = require('./fixtures/playtest-coffee-toothless.json');
  const obj = E.LLM.extractJSON(rec.actions[0].calls[0].response.text);
  assert.ok(obj && obj.major_event, 'closed what was left open');
  assert.ok(Array.isArray(obj.major_event.positions), 'positions ended up inside major_event (skipTurn moves them back)');
});

test('the update step cannot heal the player unless they rest or get care, and never raises their needs', () => {
  const { E, state } = newGame();
  const pc = state.characters.navarro;
  pc.status.health = 'badly_hurt';
  pc.needs.fatigue = 0.5;
  const upd = { state: [{ target: 'char:navarro', field: 'health', value: 'hurt' }, { target: 'char:navarro', field: 'need', need: 'fatigue', delta: 1 }] };
  let rep = E.Engine.applyUpdate(state, upd, [], { action: 'Drink more coffee.' });
  assert.equal(pc.status.health, 'badly_hurt');
  assert.equal(pc.needs.fatigue, 0.5);
  assert.ok(rep.rejected.some((r) => /only mends when their own action rests/.test(r)));
  assert.ok(rep.rejected.some((r) => /needs only climb with time/.test(r)));
  E.Engine.applyUpdate(state, { state: [{ target: 'char:navarro', field: 'health', value: 'ok' }] }, [], { action: 'Lie down in med bay and sleep.' });
  assert.equal(pc.status.health, 'badly_hurt', 'two steps at once is too much');
  E.Engine.applyUpdate(state, { state: [{ target: 'char:navarro', field: 'health', value: 'hurt' }] }, [], { action: 'Lie down in med bay and sleep.' });
  assert.equal(pc.status.health, 'hurt', 'rest mends a step');
  rep = E.Engine.applyUpdate(state, { state: [{ target: 'char:navarro', field: 'health', value: 'badly_hurt' }] }, [], { action: 'x', playerHarmed: true });
  assert.equal(pc.status.health, 'hurt', 'the engine already counted this turn\'s blow');
  E.Engine.applyUpdate(state, { state: [{ target: 'char:navarro', field: 'health', value: 'dead' }] }, [], { action: 'x' });
  assert.equal(pc.status.health, 'badly_hurt', 'a blow from the scene is one step');
});

test('the same limit pushed again goes a step past its worst, deadly only where danger is lethal; each collapse counts as sitting out', async () => {
  const { E, state } = newGame();
  const pc = state.characters.navarro;
  quietSkip(state);
  model(E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  E.Engine.RECKONING_AFTER = Infinity;
  pc.status.health = 'badly_hurt';
  pc.collapses = { fatigue: 1 };
  pc.needs.fatigue = 1; pc.needsOver = { fatigue: 12 };
  fixedRng(E, [0.999]);
  const out = await E.Engine.runTurn(state, 'Keep drinking coffee', 'major');
  assert.equal(out.plan.reason, 'body');
  assert.equal(pc.status.health, 'dead', 'Ares Deep is survival: danger is lethal');
  assert.ok(state.ignored.some((t) => /blacks out/.test(t)));

  const mild = newGame();
  const mpc = mild.state.characters.navarro;
  mild.state.scenario.tags = ['slice-of-life'];
  quietSkip(mild.state);
  model(mild.E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  mild.E.Engine.RECKONING_AFTER = Infinity;
  mpc.status.health = 'badly_hurt';
  mpc.collapses = { fatigue: 1 };
  mpc.needs.fatigue = 1; mpc.needsOver = { fatigue: 12 };
  fixedRng(mild.E, [0.999]);
  await mild.E.Engine.runTurn(mild.state, 'Keep drinking coffee', 'major');
  assert.equal(mpc.status.health, 'badly_hurt', 'a mild world never kills by exhaustion');
});

test('someone who comes to the player and is ignored next turn trusts them less and it counts as sitting out', async () => {
  const { E, state } = newGame();
  quietSkip(state);
  E.Engine.RECKONING_AFTER = Infinity;
  model(E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  const before = state.characters.bauer.relations.navarro;
  state.ask = { turn: state.turn, who: 'bauer', text: 'Teo asks Kit for help rebuilding the recycler pump.' };
  fixedRng(E, [0.999]);
  const out = await E.Engine.runTurn(state, 'Drink more coffee.', 'major');
  assert.equal(state.characters.bauer.relations.navarro, before - E.Engine.ASK_TRUST);
  assert.ok(state.ignored.some((t) => /Teo Bauer came to Kit Navarro and was turned away/.test(t)));
  assert.equal(guards(out.res, 'ask ignored').length, 1);

  const b = newGame();
  quietSkip(b.state);
  model(b.E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  b.state.ask = { turn: b.state.turn, who: 'bauer', text: 'Teo asks Kit for help rebuilding the recycler pump.' };
  fixedRng(b.E, [0.999]);
  const ok = await b.E.Engine.runTurn(b.state, 'Help rebuild the pump.', 'major');
  assert.equal(guards(ok.res, 'ask ignored').length, 0, 'answering the ask is enough');
});

test("a reckoning carries the model's ultimatum, and ignoring it sidelines the player: everyone trusts them less", async () => {
  const { E, state } = newGame();
  fixedRng(E, [0.999]);
  quietSkip(state);
  state.ignored = ['The storm hits.', 'The recycler fails.'];
  const ultimatum = 'Okafor tells Kit to take charge of the recycler rebuild by morning or be written up as unfit for duty.';
  model(E, { intent: () => ({ reckoning: ultimatum, montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  const out = await E.Engine.runTurn(state, 'Drink coffee.', 'major');
  assert.equal(out.plan.reason, 'reckoning');
  assert.equal(out.res.major.text, ultimatum);
  assert.equal(state.ask.reckoning, true);
  const trust = Object.fromEntries(['okafor', 'sorensen', 'raman', 'bauer'].map((id) => [id, state.characters[id].relations.navarro]));
  model(E, { intent: () => ({ montage: [], events: [], major_event: null, positions: [], player_where: 'commons' }) });
  fixedRng(E, [0.999]);
  const next = await E.Engine.runTurn(state, 'Drink coffee.', 'major');
  assert.equal(guards(next.res, 'sidelined').length, 1);
  Object.entries(trust).forEach(([id, t]) => assert.equal(state.characters[id].relations.navarro, t - E.Engine.SIDELINED_TRUST, id));
  assert.ok(state.characters.navarro.tags.some((t) => /sidelined/.test(t.text)));
  assert.ok(state.facts.some((f) => /ignored Dr\. Imani Okafor's ultimatum/.test(f.text)));
});
