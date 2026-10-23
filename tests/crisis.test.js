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

test('right after an emergency a random stop grows out of the people, and a major event hurts only those it reaches', async () => {
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
  assert.equal(state.characters.sorensen.status.health, 'hurt', 'Lev was in the lab');
  assert.equal(state.characters.okafor.status.health, 'ok', 'Okafor was in the commons');
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
