// The review screen for generated starts (task 4-3): editing one field,
// rerolling one person or room, redoing the pressures or the opening alone,
// the problems that stop Play and Save, and saving as an authored start.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, mockLLM, worldFiles } = require('./helpers');
const { SHEETS, replies, stepOf } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));
function mock(E, over) {
  const r = replies(over);
  return mockLLM(E, (call) => {
    const v = r[stepOf(call.user)];
    return typeof v === 'function' ? v(call.user, call) : v;
  });
}
// A finished job for Harmon's, from the shared mock replies.
async function finished() {
  const E = loadEngine();
  const w = readWorld('zombie-holdout', E);
  const job = E.StartGen.newJob(w, { region: 'main-street', line: 'a trucker who just wants to get to the coast', onePass: false });
  mock(E);
  await E.StartGen.run(w, job);
  return { E, w, job, GEN: E.StartGen };
}
const BITE = '\n\nKay was bitten on the hand two days ago and hides it in a glove.';

test('rerolling one character keeps the others, the same id, and still validates', async () => {
  const { E, w, job, GEN } = await finished();
  const before = plain(job.steps.cast.people);
  const calls = mock(E, { person: () => Object.assign({}, SHEETS['Owen Pruitt'], { want: 'get his badge back', secret: 'He sold the station\'s guns for a seat on the convoy.' }) });
  const out = await GEN.rerollPerson(w, job, 'owen-pruitt');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'worldbuild (start: reroll Owen Pruitt)');
  assert.match(calls[0].user, /fresh take on the same name and role/);
  assert.doesNotMatch(calls[0].user, /find the sheriff alive/, 'the sheet being replaced is not shown');
  assert.match(calls[0].user, /lena-marsh: Lena Marsh/, 'the others are');
  const after = plain(job.steps.cast.people);
  assert.equal(after[1].id, 'owen-pruitt');
  assert.equal(after[1].want, 'get his badge back');
  assert.deepEqual([after[0], after[2]], [before[0], before[2]], 'Lena and Kay are untouched');
  assert.match(out.note, /written for the earlier Owen Pruitt/);
  assert.deepEqual([...GEN.reviewProblems(w, job)], []);
  E.Engine.newGame(GEN.scenario(w, job));
});

test('rerolling one room keeps its id and connections', async () => {
  const { E, w, job, GEN } = await finished();
  let n = 0;
  mock(E, { room: () => (++n === 1 ? { name: 'Kitchen', desc: 'x' } : { name: 'Pantry', desc: 'Empty shelves and a smell of old onions.' }) });
  const room = await GEN.rerollRoom(w, job, 'booths');
  assert.deepEqual(plain(room), { id: 'booths', name: 'Pantry', desc: 'Empty shelves and a smell of old onions.', connects: ['counter'] });
  assert.match(job.log.slice(-2)[0].error, /another room is already called "Kitchen"/, 'a name clash is sent back');
});

test('the pressures or the opening can be redone alone; earlier steps can\'t', async () => {
  const { E, w, job, GEN } = await finished();
  const opening = plain(job.steps.opening);
  const calls = mock(E, { ties: Object.assign({}, replies().ties, { pressures: [{ name: 'The generator', max: 6, perHour: 0.2, fireText: 'The generator coughs and dies.' }] }) });
  await GEN.redoOnly(w, job, 'ties');
  assert.deepEqual(calls.map((c) => c.kind), ['worldbuild (start: ties)']);
  assert.equal(job.steps.ties.clocks[0].name, 'The generator');
  assert.deepEqual(plain(job.steps.opening), opening, 'the opening is kept');
  await assert.rejects(GEN.redoOnly(w, job, 'rooms'), /can't be redone on its own/);
});

test('editing one field: checked now, nothing stored when it fails', async () => {
  const { w, job, GEN } = await finished();
  const set = (...a) => plain(GEN.setField(w, job, ...a));
  assert.deepEqual(set('room', 'kitchen', 'name', 'Galley'), { value: 'Galley' });
  assert.equal(job.steps.rooms.rooms[1].name, 'Galley');
  assert.match(set('room', 'kitchen', 'name', '  ').error, /can't be empty/);
  assert.match(set('room', 'kitchen', 'name', 'Booths').error, /Another room has that name/);
  assert.equal(job.steps.rooms.rooms[1].name, 'Galley', 'unchanged after a refused edit');
  assert.deepEqual(set('person', 'lena-marsh', 'traits', 'tired, generous , tired, wry'), { value: ['tired', 'generous', 'wry'] });
  assert.match(set('person', 'lena-marsh', 'name', 'Owen Pruitt').error, /already has that name/);
  assert.match(set('person', 'lena-marsh', 'name', 'Marlene Ortiz').error, /already has that name/, 'nor someone in the world');
  assert.match(set('person', 'lena-marsh', 'secret', '').error, /Everyone here keeps a secret/);
  assert.deepEqual(set('person', 'sam-whitlock', 'secret', 'He left his partner at a rest stop.'), { value: 'He left his partner at a rest stop.' });
  assert.equal(GEN.target(job, 'person', 'sam-whitlock').guard, 'medium');
  set('person', 'sam-whitlock', 'secret', '');
  assert.equal(GEN.target(job, 'person', 'sam-whitlock').guard, undefined, 'your own secret is optional');
  assert.deepEqual(set('person', 'lena-marsh', 'age', ''), { value: null });
  assert.equal(GEN.target(job, 'person', 'lena-marsh').age, undefined);
  assert.match(set('clock', 'fuel-runs-out', 'max', '40').error, /whole number from 2 to 24/);
  assert.match(set('opening', null, 'opening', 'Rain.').error, /at least a few sentences/);
  assert.match(set('opening', null, 'facts', 'a\nb\nc\nd').error, /Up to 3 facts/);
  assert.match(set('person', 'nobody', 'want', 'x').error, /nothing to change/);
});

test('the problems that stop Play and Save: validation, secrets in public text, people from elsewhere', async () => {
  const { w, job, GEN } = await finished();
  const base = job.steps.opening.opening;
  assert.deepEqual([...GEN.reviewProblems(w, job)], []);
  GEN.setField(w, job, 'opening', null, 'opening', base + BITE);
  assert.match(GEN.reviewProblems(w, job).join(' '), /The opening gives away Kay Dunbar's secret/);
  GEN.setField(w, job, 'opening', null, 'opening', base + '\n\nGil Ferris waves from the road.');
  assert.match(GEN.reviewProblems(w, job).join(' '), /names Gil Ferris/);
  GEN.setField(w, job, 'opening', null, 'opening', base);
  GEN.setField(w, job, 'clock', 'fuel-runs-out', 'name', "Kay's bitten hand");
  GEN.setField(w, job, 'clock', 'fuel-runs-out', 'fireText', 'The glove comes off and everyone sees the bite.');
  assert.match(GEN.reviewProblems(w, job).join(' '), /pressure "Kay's bitten hand" gives away Kay Dunbar's secret/);
  job.steps.ties.clocks[0].max = 0;
  assert.match(GEN.reviewProblems(w, job).join(' '), /clock "fuel-runs-out" needs id, name and max/, 'the same validation as an authored start');
});

test('a saved start loads as an authored start and plays', async () => {
  const { w, job, GEN } = await finished();
  const files = plain(GEN.files(w, job));
  assert.deepEqual(Object.keys(files).sort(), ['characters/kay-dunbar.json', 'characters/lena-marsh.json', 'characters/owen-pruitt.json', 'characters/sam-whitlock.json', 'starts/' + job.id + '.json', 'world.json']);
  assert.deepEqual(files['world.json'].starts, ['herd', job.id]);
  assert.ok(files['world.json'].characters.includes('lena-marsh') && files['world.json'].characters.includes('pike'));
  const merged = Object.assign(worldFiles('zombie-holdout'), files);
  const E2 = loadEngine();
  const loaded = E2.Scenario.prepareWorld('zombie-holdout', merged);
  assert.deepEqual([...loaded.warnings], [], 'no unknown fields: "generated" is a start field');
  const st = loaded.starts.find((s) => s.id === job.id);
  assert.equal(st.error, undefined);
  assert.equal(st.title, 'Day 23: the diner');
  assert.equal(loaded.starts.find((s) => s.id === 'herd').error, undefined, 'the authored start still loads');
  const state = E2.Engine.newGame(E2.Scenario.startScenario(loaded, job.id));
  assert.equal(state.player, 'sam-whitlock');
  assert.equal(state.characters['lena-marsh'].status.location, 'counter');
  assert.ok(E2.StartGen.taken(loaded).names.has('Lena Marsh'), 'a second generated start won\'t reuse their names');
});
