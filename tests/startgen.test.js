// Generated starts (task 4-2): the world's settings, each step's checker, the
// retries, rerunning one step, resuming a job, and the whole pipeline making
// a start that loads like an authored one and plays a turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, mockLLM, worldFiles } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));

const { SHEETS, replies, stepOf } = require('./genmock');

function mock(E, over) {
  const r = replies(over);
  return mockLLM(E, (call) => {
    const v = r[stepOf(call.user)];
    return typeof v === 'function' ? v(call.user, call) : v;
  });
}

const setup = (opts = {}) => {
  const E = loadEngine();
  const w = readWorld('zombie-holdout', E);
  const job = E.StartGen.newJob(w, Object.assign({ region: 'main-street', line: 'a trucker who just wants to get to the coast', note: 'quiet and tense', onePass: false }, opts));
  return { E, w, job, GEN: E.StartGen };
};
const ctxOf = (E, w, job) => E.StartGen.context(w, job);

// ---------- the world's settings ----------

test('generatedStarts: checked like a player slot; startable regions are the choices', () => {
  const E = loadEngine();
  const w = readWorld('zombie-holdout', E);
  assert.equal(w.generate, true);
  assert.equal(readWorld('mars-station', E).generate, false, 'Ares Deep is a closed station: no generated starts');
  assert.deepEqual(plain(E.StartGen.regions(w.bundle.world).map((r) => r.id)), ['main-street', 'residential', 'junction']);
  const files = (edit) => { const f = worldFiles('zombie-holdout'); edit(f['world.json']); return f; };
  assert.throws(() => E.Scenario.prepareWorld('z', files((w) => { w.generatedStarts.maxSkill = 6; })), /generatedStarts: "maxSkill" must be a whole number from 1 to 4/);
  assert.throws(() => E.Scenario.prepareWorld('z', files((w) => { w.generatedStarts.castSize = [5, 2]; })), /"castSize" must be \[fewest, most\]/);
  assert.throws(() => E.Scenario.prepareWorld('z', files((w) => { w.generatedStarts.colour = 1; })), /generatedStarts: unknown field "colour"/);
  assert.match(E.Scenario.prepareWorld('z', files((w) => { w.regions[0].startable = 'yes'; })).starts[0].error, /"startable" must be true or false/);
});

test('a world with generated starts may have no authored start', () => {
  const E = loadEngine();
  const f = worldFiles('zombie-holdout');
  f['world.json'].starts = [];
  delete f['world.json'].map;
  f['world.json'].extras = [];
  f['world.json'].standees = [];
  const w = E.Scenario.prepareWorld('zombie-holdout', f);
  assert.equal(w.starts.length, 0);
  assert.equal(w.generate, true);
  delete f['world.json'].generatedStarts;
  assert.throws(() => E.Scenario.prepareWorld('zombie-holdout', f), /missing "starts" list/);
});

test('world extras and groups in rooms a start lacks: nowhere in particular, or left out; a room nobody has is an error', () => {
  const E = loadEngine();
  const f = worldFiles('zombie-holdout');
  const w = f['world.json'];
  const sc = E.Scenario.compose(w, { id: 'x', cast: [], region: 'main-street', locations: [{ id: 'pharmacy', name: 'Pharmacy', desc: 'Empty shelves.' }] }, {}, 'zombie-holdout');
  assert.equal(sc.extras.find((x) => x.id === 'albee').location, null);
  assert.equal(sc.standees.length, 0);
  w.extras[0].location = 'dok';
  assert.throws(() => E.Scenario.prepareWorld('zombie-holdout', f), /"albee" stands in "dok", which is not a room of the world or of any start/);
});

// ---------- step checkers ----------

test('rooms: names or ids link both ways, unreachable rooms join the start, clashing ids are renamed', () => {
  const { E, w, job, GEN } = setup();
  const ctx = ctxOf(E, w, job);
  const out = GEN.check.rooms(replies().rooms, ctx);
  assert.deepEqual([...out.rooms.map((r) => [r.id, [...r.connects]])], [['counter', ['kitchen', 'booths']], ['kitchen', ['counter', 'back-lot']], ['back-lot', ['kitchen']], ['booths', ['counter']]]);
  assert.equal(out.playerRoom, 'counter');
  assert.deepEqual([...out.warnings], ['Booths connected nowhere; linked to Diner Counter']);
  const clash = GEN.check.rooms({ rooms: [{ id: 'floor', name: 'Floor', desc: 'x' }, { name: 'Roof', desc: 'y', connects: ['floor'] }, { name: 'Lot', desc: 'z', connects: ['Roof'] }], player_room: 'attic' }, ctx);
  assert.deepEqual(plain(clash.rooms.map((r) => r.id)), ['floor-2', 'roof-2', 'lot-2'], 'the holdout start already has floor, roof and lot');
  assert.equal(clash.playerRoom, 'floor-2');
  assert.match(clash.warnings[0], /"attic" is not one of the rooms/);
  assert.match(GEN.check.rooms({ rooms: [{ name: 'A', desc: 'x' }] }, ctx).error, /3 to 6 rooms \(got 1\)/);
  assert.match(GEN.check.rooms({ rooms: [{ name: 'A', desc: 'x' }, { name: 'B' }, { name: 'C', desc: 'z' }] }, ctx).error, /room "B" needs a "desc"/);
});

test('who is here: within the cast size, every name new', () => {
  const { E, w, job, GEN } = setup();
  job.steps.player = { character: { id: 'sam', name: 'Sam Whitlock' } };
  const ctx = ctxOf(E, w, job);
  assert.equal(GEN.check.plan(replies().plan, ctx).people.length, 3);
  assert.match(GEN.check.plan({ people: [{ name: 'A B', role: 'x' }] }, ctx).error, /plan 3 to 5 people \(got 1\)/);
  assert.match(GEN.check.plan({ people: [{ name: 'Marlene Ortiz', role: 'x' }, { name: 'B', role: 'y' }, { name: 'C', role: 'z' }] }, ctx).error, /"Marlene Ortiz" is already used/);
  assert.match(GEN.check.plan({ people: [{ name: 'Sam Whitlock', role: 'x' }] }, ctx).error, /already used/, 'not the player\'s name either');
  const six = Array.from({ length: 7 }, (_, i) => ({ name: `Person ${i}`, role: 'x' }));
  assert.equal(GEN.check.plan({ people: six }, ctx).people.length, 5);
});

test('a person: a want, traits and a secret are required; rooms by name; skills 0-4; ids unique', () => {
  const { E, w, job, GEN } = setup();
  const ctx = ctxOf(E, w, job);
  job.steps.rooms = GEN.check.rooms(replies().rooms, ctx);
  job.steps.plan = { people: replies().plan.people };
  const lena = GEN.check.person(SHEETS['Lena Marsh'], ctx, 0).character;
  assert.equal(lena.id, 'lena-marsh');
  assert.equal(lena.status.location, 'kitchen');
  assert.equal(lena.skills.medicine, 4);
  assert.equal(lena.guard, 'medium');
  assert.equal(GEN.check.person(SHEETS['Kay Dunbar'], ctx, 2).character.status.location, 'counter', 'an unknown room: where the player starts');
  assert.match(GEN.check.person(Object.assign({}, SHEETS['Lena Marsh'], { secret: 'none' }), ctx, 0).error, /needs a "secret"/);
  assert.match(GEN.check.person(Object.assign({}, SHEETS['Lena Marsh'], { want: '' }), ctx, 0).error, /needs a "want"/);
  job.steps.plan.people[0].name = 'Ortiz';
  assert.equal(GEN.check.person(SHEETS['Lena Marsh'], ctx, 0).character.id, 'ortiz-2', 'not the pool\'s ortiz');
});

test('ties: names become ids, the player\'s own feelings are left out, values clamp, a pressure is required', () => {
  const { E, w, job, GEN } = setup();
  job.steps.player = { character: { id: 'sam-whitlock', name: 'Sam Whitlock' } };
  job.steps.cast = { people: [{ id: 'lena-marsh', name: 'Lena Marsh' }, { id: 'owen-pruitt', name: 'Owen Pruitt' }, { id: 'kay-dunbar', name: 'Kay Dunbar' }] };
  const ctx = ctxOf(E, w, job);
  const out = GEN.check.ties(replies().ties, ctx);
  assert.deepEqual(plain(out.relations), [{ from: 'lena-marsh', to: 'owen-pruitt', value: 30 }, { from: 'kay-dunbar', to: 'sam-whitlock', value: 25 }]);
  assert.deepEqual(plain(out.knows), [{ id: 'owen-pruitt', text: 'The radio in the booths still picks up the convoy at night.' }]);
  assert.deepEqual(plain(out.clocks), [{ id: 'fuel-runs-out', name: 'The fuel runs out', value: 0, max: 8, perHour: 0.1, fireText: 'The generator dies and the lights go out.' }]);
  assert.ok(out.warnings.some((x) => /player's own feelings/.test(x)));
  assert.match(GEN.check.ties({ relations: [] }, ctx).error, /add 1 or 2 "pressures"/);
});

test('minor people and groups: rooms checked, counts read, ids new', () => {
  const { E, w, job, GEN } = setup();
  const ctx = ctxOf(E, w, job);
  job.steps.rooms = GEN.check.rooms(replies().rooms, ctx);
  job.steps.player = { character: { id: 'sam-whitlock', name: 'Sam Whitlock' } };
  job.steps.cast = { people: [] };
  const out = GEN.check.extras(replies().extras, ctx);
  assert.deepEqual(plain(out.extras), [{ id: 'father-abel', name: 'Father Abel', role: 'priest on the radio', location: null, note: 'calls every night at nine' }]);
  assert.deepEqual(plain(out.standees), [{ id: 'dead', label: 'the dead', count: 12, location: 'back-lot', state: 'alert', note: '' }]);
  assert.match(out.warnings.join(' '), /group "raiders" skipped/);
  assert.match(GEN.check.extras({ extras: [{ name: 'Mrs. Albee', role: 'x' }] }, ctx).warnings[0], /needs a new name/);
});

test('the opening: long enough, never ending on the player, never giving away a secret', () => {
  const { E, w, job, GEN } = setup();
  job.steps.player = { character: { id: 'sam-whitlock', name: 'Sam Whitlock' } };
  job.steps.cast = { people: [{ id: 'kay-dunbar', name: 'Kay Dunbar', secret: 'She was bitten on the hand two days ago and hides it in a glove.' }] };
  const ctx = ctxOf(E, w, job);
  const good = replies().opening;
  const ended = GEN.check.opening(Object.assign({}, good, { opening: good.opening + '\n\nYou nod and decide to stay.' }), ctx);
  assert.ok(ended.opening.endsWith('she asks.'), 'the player\'s own move is trimmed');
  assert.match(GEN.check.opening(Object.assign({}, good, { opening: 'Rain falls.' }), ctx).error, /too short/);
  const leak = good.opening + '\n\nKay was bitten on the hand two days ago; she hides the bite under her glove.';
  assert.match(GEN.check.opening(Object.assign({}, good, { opening: leak }), ctx).error, /gives away Kay Dunbar's secret/);
  assert.match(GEN.check.opening(Object.assign({}, good, { facts: ['Kay was bitten on the hand and hides it in a glove.'] }), ctx).error, /public fact gives away/);
  assert.match(GEN.check.opening(Object.assign({}, good, { title: '' }), ctx).error, /"title"/);
});

test('your character from a line: a sheet within the point-buy, a name nobody has', () => {
  const { E, w, job, GEN } = setup();
  const ctx = ctxOf(E, w, job);
  const c = GEN.check.player(replies().player, ctx).character;
  assert.equal(c.role, 'Long-haul trucker');
  assert.equal(Object.values(c.skills).reduce((a, b) => a + b, 0), 9, 'fitted: each at most 3');
  assert.deepEqual([c.skills.fighting, c.skills.shooting, c.skills.mechanics], [3, 3, 3]);
  assert.match(GEN.check.player(Object.assign({}, replies().player, { name: 'Jordan Pike' }), ctx).error, /already someone in this world/);
  assert.equal(GEN.fitSkills({ a: 3, b: 3, c: 3 }, ['a', 'b', 'c'], 5, 3).a + GEN.fitSkills({ a: 3, b: 3, c: 3 }, ['a', 'b', 'c'], 5, 3).b + GEN.fitSkills({ a: 3, b: 3, c: 3 }, ['a', 'b', 'c'], 5, 3).c, 5);
});

// ---------- running ----------

test('the whole pipeline makes a start that loads like an authored one and plays a turn', async () => {
  const { E, w, job, GEN } = setup();
  const calls = mock(E);
  const saves = [];
  await GEN.run(w, job, { save: (j) => saves.push(JSON.stringify(j)) });
  assert.ok(GEN.done(job));
  assert.deepEqual(calls.map((c) => c.kind), ['worldbuild (start: player)', 'worldbuild (start: rooms)', 'worldbuild (start: plan)',
    'worldbuild (start: character 1)', 'worldbuild (start: character 2)', 'worldbuild (start: character 3)', 'worldbuild (start: ties)', 'worldbuild (start: extras)', 'worldbuild (start: opening)']);
  assert.ok(calls.every((c) => E.LLM.stepOf(c.kind) === 'worldbuild'), 'routed with World building');
  assert.equal(new Set(calls.map((c) => c.system)).size, 1, 'one header for every step (cache)');
  assert.equal(saves.length, 7, 'checkpointed after every step');
  const { start, characters } = GEN.toStart(w, job);
  assert.equal(start.generated, true);
  assert.equal(start.region, 'main-street');
  assert.deepEqual(plain(start.start), { day: 23, hour: 9 }, 'the default start\'s date');
  assert.deepEqual([...start.cast], ['sam-whitlock', 'lena-marsh', 'owen-pruitt', 'kay-dunbar']);
  assert.equal(characters['kay-dunbar'].relations['sam-whitlock'], 25, 'they have only just met');
  assert.deepEqual(plain(characters['sam-whitlock'].relations), {}, 'your own feelings start neutral');
  assert.deepEqual([...characters['owen-pruitt'].knows], ['The radio in the booths still picks up the convoy at night.']);
  const sc = GEN.scenario(w, job);
  assert.equal(sc.extras.find((x) => x.id === 'albee').location, null, 'the world\'s extra from the holdout dock');
  assert.deepEqual(plain(sc.standees.map((g) => g.id)), ['dead'], 'the holdout\'s stragglers stay at the holdout');
  const state = E.Engine.newGame(sc);
  assert.equal(state.player, 'sam-whitlock');
  assert.equal(state.characters['sam-whitlock'].status.location, 'counter');
  assert.match(E.Prompts.header(state), /- lena-marsh: Lena Marsh \(she\/her\), diner cook, 52\./);
  mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { summary: 'look around' }, intents: [], events: [] }
    : kind === 'update' ? { facts: [], state: [], relations: [], player_attitude: [] } : '[+0m] Lena wipes the counter.'));
  await E.Engine.runTurn(state, 'Look around the diner.', 'moment');
  assert.equal(state.turn, 1);
});

test('a bad reply is retried with the problem named; three bad replies stop the run at that step', async () => {
  const { E, w, job, GEN } = setup();
  let n = 0;
  const calls = mock(E, { rooms: () => (++n === 1 ? { rooms: [{ name: 'Only', desc: 'x' }] } : replies().rooms) });
  await GEN.run(w, job);
  const rooms = calls.filter((c) => /rooms/.test(c.kind));
  assert.equal(rooms.length, 2);
  assert.match(rooms[1].user, /Your last reply had a problem: make 3 to 6 rooms \(got 1\)\. Fix it/);
  assert.deepEqual(plain(job.log.filter((l) => l.step === 'rooms').map((l) => l.error)), ['make 3 to 6 rooms (got 1)', null]);

  const t = setup();
  mock(t.E, { plan: { people: [] } });
  await assert.rejects(t.GEN.run(t.w, t.job), (err) => err.name === 'StepError' && /plan: plan 3 to 5 people/.test(err.message));
  assert.equal(t.job.failed, 'plan');
  assert.ok(t.job.steps.rooms && !t.job.steps.plan, 'earlier steps are kept');
  const again = mock(t.E);
  await t.GEN.run(t.w, t.job);
  assert.equal(again[0].kind, 'worldbuild (start: plan)', 'the run picks up at the failed step');
  assert.ok(t.GEN.done(t.job));
});

test('rerunning one step redoes it and the steps after it, nothing before', async () => {
  const { E, w, job, GEN } = setup();
  mock(E);
  await GEN.run(w, job);
  const rooms = JSON.stringify(job.steps.rooms);
  GEN.clearFrom(job, 'ties');
  const calls = mock(E, { opening: Object.assign({}, replies().opening, { title: 'Second try' }) });
  await GEN.run(w, job);
  assert.deepEqual(calls.map((c) => c.kind), ['worldbuild (start: ties)', 'worldbuild (start: extras)', 'worldbuild (start: opening)']);
  assert.equal(JSON.stringify(job.steps.rooms), rooms);
  assert.equal(job.steps.opening.title, 'Second try');
});

test('an API model writes the whole cast in one call; a local model one person per call', async () => {
  const api = setup({ onePass: true });
  const calls = mock(api.E);
  await api.GEN.run(api.w, api.job);
  assert.deepEqual(calls.filter((c) => /character|cast/.test(c.kind)).map((c) => c.kind), ['worldbuild (start: cast)']);
  assert.equal(api.job.steps.cast.people.length, 3);
  const E = loadEngine();
  const w = readWorld('zombie-holdout', E);
  assert.equal(E.StartGen.newJob(w, { line: 'x' }).onePass, false, 'KoboldCpp by default: one per call');
  E.settings.backends.external = { preset: 'openrouter', url: 'https://openrouter.ai/api/v1', model: 'm' };
  E.settings.routing.worldbuild = 'external';
  assert.equal(E.StartGen.newJob(w, { line: 'x' }).onePass, true);
});

test('a job survives being saved mid-cast and resumes at the next person', async () => {
  const { E, w, job, GEN } = setup();
  let people = 0;
  mock(E, { person: (user) => (++people === 2 ? { want: '' } : SHEETS[/sheet for ([^,]+),/.exec(user)[1]]) });
  GEN.TRIES = 1;
  try { await assert.rejects(GEN.run(w, job)); } finally { GEN.TRIES = 3; }
  assert.equal(job.failed, 'cast');
  const saved = JSON.parse(JSON.stringify(job));
  assert.equal(saved.partial.cast.length, 1, 'Lena is kept');
  const calls = mock(E);
  await GEN.run(w, saved);
  assert.equal(calls[0].kind, 'worldbuild (start: character 2)');
  assert.deepEqual(saved.steps.cast.people.map((c) => c.id), ['lena-marsh', 'owen-pruitt', 'kay-dunbar']);
});

test('a character made with the form (4-1) skips the player step and gets the generated room', async () => {
  const E = loadEngine();
  const w = readWorld('zombie-holdout', E);
  const sc = E.StartGen.slotScenario(w, 'junction');
  const form = Object.assign(E.CharMaker.defaults(sc), { name: 'Pike', want: 'find my sister', traits: ['wry'], role: 'trucker' });
  const c = E.CharMaker.build(sc, form).character;
  assert.equal(c.id, 'pike-2', 'not the pool\'s pike');
  const job = E.StartGen.newJob(w, { region: 'junction', character: c, onePass: false });
  const calls = mock(E);
  await E.StartGen.run(w, job);
  assert.ok(!calls.some((x) => /player\)/.test(x.kind)));
  const state = E.Engine.newGame(E.StartGen.scenario(w, job));
  assert.equal(state.characters['pike-2'].status.location, 'counter');
  assert.equal(state.characters['pike-2'].role, 'Long-haul trucker');
  assert.throws(() => E.StartGen.newJob(w, { region: 'ridge-town', line: 'x' }), /can't start in "ridge-town"/);
  assert.throws(() => E.StartGen.newJob(w, { region: 'junction' }), /Make a character, or describe one/);
});

// ---------- from the first 12B run (2026-10-22) ----------
// NemoMix 12B on Harmon's, "a park ranger" in the houses: a playable start,
// with these mistakes (each now caught).

test('playtest-12b: a described character with no skills is sent back to spend the points', () => {
  const { E, w, job, GEN } = setup();
  const ctx = ctxOf(E, w, job);
  const out = GEN.check.player(Object.assign({}, replies().player, { name: 'Emma Thompson', skills: {} }), ctx);
  assert.match(out.error, /spend the skill points: up to 10 in all, each from 0 to 3/);
});

test('playtest-12b: nobody is planned as the player\'s family', () => {
  const { E, w, job, GEN } = setup();
  job.steps.player = { character: { id: 'emma-thompson', name: 'Emma Thompson' } };
  const ctx = ctxOf(E, w, job);
  const plan = (p) => GEN.check.plan({ people: [p, { name: 'Jim Davis', role: 'retired veteran' }, { name: 'Mia Hernandez', role: 'single mother' }] }, ctx);
  assert.match(plan({ name: 'Sarah Thompson', role: 'teenager' }).error, /shares the player's surname; don't make anyone the player's family/);
  assert.match(plan({ name: 'Sarah Lowe', role: 'teenage daughter of Emma Thompson' }).error, /ties them to the player/);
  assert.match(plan({ name: 'Sarah Lowe', role: 'teenager', hook: 'Emma\'s old friend' }).error, /ties them to the player/);
  assert.equal(plan({ name: 'Sarah Lowe', role: 'teenager', hook: 'believes in a cure' }).people.length, 3);
});

test('playtest-12b: a sheet about someone from the authored cast is sent back', () => {
  const { E, w, job, GEN } = setup();
  const ctx = ctxOf(E, w, job);
  job.steps.player = { character: { id: 'emma-thompson', name: 'Emma Thompson' } };
  job.steps.rooms = GEN.check.rooms(replies().rooms, ctx);
  job.steps.plan = { people: [{ name: 'Ben Walker', role: 'local shopkeeper' }] };
  const ben = Object.assign({}, SHEETS['Lena Marsh'], { description: 'Marlene Ortiz is the no-nonsense owner of Harmon\'s Hardware, having taken over the family business.' });
  assert.match(GEN.check.person(ben, ctx, 0).error, /the sheet for Ben Walker talks about Marlene Ortiz, who isn't in this start/);
  assert.match(GEN.check.person(Object.assign({}, ben, { description: 'Used to argue with Ortiz about prices.' }), ctx, 0).error, /talks about Marlene Ortiz/, 'the surname alone counts');
  assert.match(GEN.check.person(Object.assign({}, ben, { description: 'Mrs. Albee taught her to shoot.' }), ctx, 0).error, /talks about Mrs\. Albee/);
  assert.match(GEN.check.person(Object.assign({}, ben, { description: 'Owes Emma a favour.' }), ctx, 0).error, /decides things about the player/);
  assert.ok(GEN.check.person(Object.assign({}, ben, { description: 'Ran the corner shop for twenty years.' }), ctx, 0).character);
  const good = replies().opening;
  assert.match(GEN.check.opening(Object.assign({}, good, { opening: good.opening + '\n\nOutside, Gil Ferris shouts something.' }), ctx).error, /opening names Gil Ferris/);
});

test('playtest-12b: private facts about the player are left out; feelings toward the player stay mild', () => {
  const { E, w, job, GEN } = setup();
  job.steps.player = { character: { id: 'emma-thompson', name: 'Emma Thompson' } };
  job.steps.cast = { people: [{ id: 'jim-davis', name: 'Jim Davis' }, { id: 'mia-hernandez', name: 'Mia Hernandez' }] };
  const ctx = ctxOf(E, w, job);
  const out = GEN.check.ties({
    relations: [{ from: 'jim-davis', to: 'emma-thompson', value: 40 }, { from: 'mia-hernandez', to: 'jim-davis', value: 40 }],
    knows: [{ id: 'jim-davis', text: 'He knows that Emma has a first aid kit hidden in her backpack.' }, { id: 'mia-hernandez', text: 'Jim keeps weapons in the attic.' }],
    pressures: [{ name: 'Food', max: 24, perHour: 0.1, fireText: 'The food runs out.' }],
  }, ctx);
  assert.deepEqual(plain(out.relations), [{ from: 'jim-davis', to: 'emma-thompson', value: 25 }, { from: 'mia-hernandez', to: 'jim-davis', value: 40 }]);
  assert.deepEqual(plain(out.knows), [{ id: 'mia-hernandez', text: 'Jim keeps weapons in the attic.' }]);
  assert.ok(out.warnings.some((x) => /private fact about the player left out/.test(x)));
});

test('playtest-12b: a couple named as one minor person becomes a group of two', () => {
  const { E, w, job, GEN } = setup();
  const ctx = ctxOf(E, w, job);
  job.steps.rooms = GEN.check.rooms(replies().rooms, ctx);
  job.steps.player = { character: { id: 'emma-thompson', name: 'Emma Thompson' } };
  job.steps.cast = { people: [] };
  const out = GEN.check.extras({ extras: [{ name: 'Young Couple', role: 'Survivors', room: 'counter', note: 'trying to keep quiet' }, { name: 'Stranger', role: 'passing through', room: null }] }, ctx);
  assert.deepEqual(plain(out.extras.map((x) => x.name)), ['Stranger']);
  assert.deepEqual(plain(out.standees), [{ id: 'young-couple', label: 'Young Couple', count: 2, location: 'counter', state: 'calm', note: 'Survivors; trying to keep quiet' }]);
});

// ---------- from the first API run (2026-10-22) ----------
// An external model on Harmon's, a park ranger in the houses: a rich start
// with interlocking secrets, and these mistakes (each now caught).

test('playtest-api: the people the opening shows start in the player\'s room', async () => {
  const { E, w, job, GEN } = setup();
  mock(E);
  await GEN.run(w, job);
  assert.deepEqual(plain(job.steps.opening.withYou), ['lena-marsh', 'owen-pruitt', 'kay-dunbar'], 'no "with_you": everyone the opening names');
  const { characters } = GEN.toStart(w, job);
  assert.equal(characters['lena-marsh'].status.location, 'counter', 'her sheet said the kitchen');
  const ctx = ctxOf(E, w, job);
  const listed = GEN.check.opening(Object.assign({}, replies().opening, { with_you: ['Lena', 'owen-pruitt', 'nobody'] }), ctx);
  assert.deepEqual(plain(listed.withYou), ['lena-marsh', 'owen-pruitt'], 'a "with_you" list wins');
  const nick = GEN.check.opening(Object.assign({}, replies().opening, { opening: replies().opening.opening.replace(/Kay/g, 'Teddy') }), Object.assign(ctx, {}));
  assert.ok(!nick.withYou.includes('kay-dunbar'));
});

test('playtest-api: a pressure that gives away someone\'s secret is sent back', () => {
  const { E, w, job, GEN } = setup();
  job.steps.player = { character: { id: 'nadia-voss', name: 'Nadia Voss' } };
  job.steps.cast = { people: [{ id: 'renata-boyle', name: 'Renata Boyle', secret: 'She was bitten on the left forearm six hours ago and has it wrapped and buttoned; she knows the fever comes by tonight.' }] };
  const ctx = ctxOf(E, w, job);
  const out = GEN.check.ties({ relations: [], knows: [], pressures: [{ name: "Renata's fever", max: 8, perHour: 0.4, fireText: "Renata's fever breaks into the open — the wrapping comes off in front of everyone." }] }, ctx);
  assert.match(out.error, /the pressure "Renata's fever" gives away Renata Boyle's secret/);
  assert.ok(GEN.check.ties({ relations: [], knows: [], pressures: [{ name: 'The last of the food', max: 8, perHour: 0.15, fireText: 'The last can is opened and split five ways.' }] }, ctx).clocks);
});

test('playtest-api: long notes are cut at a sentence or a word, never mid-word', () => {
  const { E } = setup();
  const note = 'Lives in the blue house behind the fence. Has a week of canned food and a dead husband in the garage she hasn\'t told anyone about. Watches the street through a gap in her curtains; will trade water for news.';
  assert.equal(E.StartGen.clip(note, 200), 'Lives in the blue house behind the fence. Has a week of canned food and a dead husband in the garage she hasn\'t told anyone about.');
  assert.equal(E.StartGen.clip('one two three four five six seven eight nine ten eleven', 30), 'one two three four five six…');
});

test('playtest-api: an age on the end of a role goes to the sheet; a nickname stays out of the id', () => {
  const { E, w, job, GEN } = setup();
  job.steps.player = { character: { id: 'nadia-voss', name: 'Nadia Voss' } };
  const ctx = ctxOf(E, w, job);
  const plan = GEN.check.plan({ people: [{ name: 'Teodora "Teddy" Marchetti', role: 'Retired school-bus driver, 61' }, { name: 'Ezra Kwan', role: 'student' }, { name: 'Renata Boyle', role: 'Hospice nurse, 38' }] }, ctx);
  assert.deepEqual(plain(plan.people[0]), { name: 'Teodora "Teddy" Marchetti', role: 'Retired school-bus driver', hook: '', age: 61 });
  job.steps.rooms = GEN.check.rooms(replies().rooms, ctx);
  job.steps.plan = plan;
  const teddy = GEN.check.person(Object.assign({}, SHEETS['Lena Marsh'], { age: undefined }), ctx, 0).character;
  assert.equal(teddy.id, 'teodora-marchetti');
  assert.equal(teddy.age, 61);
});
