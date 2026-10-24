// Start anywhere in a big world (R-7): startable on branches, Surprise me,
// starting somewhere that isn't on the map, and lore figures kept out of
// generated casts. The open-galaxy fixture: three levels of original
// regions, a branch shut out (the Throne Spire), a hidden relay, a figure
// from the lore (Kesh Varro), generated regions on.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, worldFiles, readWorld, mockLLM, fixedRng } = require('./helpers');
const { replies, stepOf } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));
const GALAXY = path.join(__dirname, 'fixtures', 'open-galaxy');
const galaxy = (edit) => {
  const E = loadEngine();
  const f = worldFiles(GALAXY);
  if (edit) edit(f['world.json']);
  return { E, w: E.Scenario.prepareWorld('open-galaxy', f) };
};
const ids = (list) => plain(list.map((r) => r.id));

test('startable on branches: a region\'s own word wins, else the nearest region it is inside; false shuts a branch out', () => {
  const { E, w } = galaxy();
  const ok = ids(E.StartGen.regions(w.bundle.world));
  assert.ok(ok.includes('tessk-crossing') && ok.includes('core'), 'none marked true: everywhere');
  assert.ok(!ok.includes('throne-spire') && !ok.includes('spire-vaults'), 'startable: false shuts out the Spire and what is inside it');
  assert.ok(!ok.includes('ghost-relay'), 'never a hidden region');
  const marked = galaxy((x) => { x.regions.find((r) => r.id === 'rim').startable = true; x.regions.find((r) => r.id === 'greywater').startable = false; });
  assert.deepEqual(ids(marked.E.StartGen.regions(marked.w.bundle.world)), ['rim', 'tessk', 'tessk-crossing', 'saltpan', 'morrow', 'morrow-port', 'kade', 'kade-station'], 'true takes in the branch; one marked: only marked branches');
  const H = loadEngine();
  assert.deepEqual(ids(H.StartGen.regions(readWorld('zombie-holdout', H).bundle.world)), ['main-street', 'residential', 'junction'], 'Harmon\'s choices are unchanged');
});

test('Surprise me: a random startable region at the deepest level with detail, from the engine\'s dice', () => {
  const { E, w } = galaxy();
  const ok = new Set(ids(E.StartGen.regions(w.bundle.world)));
  const leaves = new Set();
  for (let i = 0; i < 40; i++) {
    fixedRng(E, [i / 40]);
    const id = E.StartGen.surprise(w.bundle.world);
    assert.ok(ok.has(id), id);
    leaves.add(id);
  }
  assert.ok(!leaves.has('core') && !leaves.has('aurel') && !leaves.has('throne-spire'), 'never a branch with startable places inside, never the Spire');
  assert.ok(leaves.has('tessk-crossing') && leaves.has('hask-yard'));
  fixedRng(E, [0.5]);
  const a = E.StartGen.surprise(w.bundle.world);
  fixedRng(E, [0.5]);
  assert.equal(E.StartGen.surprise(w.bundle.world), a, 'the same dice, the same place');
});

// The genmock replies were written for the holdout; the player's sheet
// spends the default skills here.
function mock(E, over) {
  const r = replies(Object.assign({ player: Object.assign({}, replies().player, { skills: { physical: 3, technical: 3, social: 2 } }) }, over || {}));
  return mockLLM(E, (call) => {
    const v = r[stepOf(call.user)];
    if (v == null) return call.kind === 'intent' ? { player: { summary: 'look around' }, intents: [], events: [] }
      : call.kind === 'update' ? { facts: [], state: [], relations: [], player_attitude: [] } : '[+0m] Dust hisses against the dome.';
    return typeof v === 'function' ? v(call.user, call) : v;
  });
}

test('a start deep in the tree composes and plays', async () => {
  const { E, w } = galaxy();
  const job = E.StartGen.newJob(w, { region: 'tessk-crossing', line: 'a smuggler who owes the wrong people', onePass: false });
  mock(E);
  await E.StartGen.run(w, job, {});
  assert.ok(E.StartGen.done(job), job.failed);
  const sc = E.StartGen.scenario(w, job);
  assert.equal(sc.region, 'tessk-crossing');
  const state = E.Engine.newGame(sc);
  assert.deepEqual([...E.Engine.regionChain(state, E.Engine.playerRegion(state))], ['tessk-crossing', 'tessk', 'rim']);
  assert.throws(() => E.StartGen.newJob(w, { region: 'spire-vaults', line: 'a guard' }), /can't start in "spire-vaults"/);
});

test('playtest-r7-tessk-workshop: where exactly is the place the rooms are made as, inside the region picked; no region of its own, no extra call', async () => {
  const { E, w } = galaxy();
  const job = E.StartGen.newJob(w, { region: 'tessk-crossing', place: 'Engineer workshop and flat.', line: 'a droid engineer', onePass: false });
  assert.equal(job.place, 'Engineer workshop and flat', 'the full stop goes');
  assert.ok(!E.StartGen.order(job).includes('region'));
  const calls = mock(E);
  await E.StartGen.run(w, job, {});
  assert.ok(E.StartGen.done(job), job.failed);
  assert.ok(!calls.some((c) => /region/.test(c.kind)), 'no region call');
  const rooms = calls.find((c) => c.kind === 'worldbuild (start: rooms)').user;
  assert.match(rooms, /Where exactly: the player starts at Engineer workshop and flat, in Tessk Crossing\./);
  assert.match(rooms, /Invent where the story starts, at Engineer workshop and flat:/);
  const { start } = E.StartGen.toStart(w, job);
  assert.equal(start.regions, undefined, 'no new region');
  assert.equal(start.region, 'tessk-crossing');
  const state = E.Engine.newGame(E.StartGen.scenario(w, job));
  assert.equal(E.Engine.playerRegion(state), 'tessk-crossing');
  assert.throws(() => E.StartGen.newJob(w, { region: 'tessk', place: 'Saltpan Flats', line: 'x' }), /already on the map/);
});

test('playtest-r7-tessk-workshop: opening facts addressed to the player are left out (the player\'s past is theirs)', () => {
  const { E, w } = galaxy();
  const job = E.StartGen.newJob(w, { region: 'tessk-crossing', line: 'a droid engineer', onePass: false });
  job.steps.player = { character: { id: 'zara-nox', name: 'Zara Nox' } };
  job.steps.cast = { people: [] };
  const ctx = E.StartGen.context(w, job);
  const opening = 'The morning sun creeps through the grimy window of the back room. The air is thick with the smell of metal and oil, and somewhere outside a speeder coughs into life and dies again.\n\nA rusty security droid stands by the door, its single red eye sweeping the room. "Intruder. No. Correction," it says. "Morning."';
  const out = E.StartGen.check.opening({ title: 'A new day', summary: 'A workshop in Tessk Crossing.', opening, facts: [
    'Tessk Crossing is a bustling city on the planet Tessk.', 'As a newcomer, you\'re still trying to establish your reputation.', 'Your back room is where you do your most intricate work.'] }, ctx);
  assert.equal(out.error, undefined, out.error);
  assert.deepEqual([...out.facts], ['Tessk Crossing is a bustling city on the planet Tessk.']);
});

test('playtest-r7-tessk-workshop: the planning call never names a hidden region', async () => {
  const { replay } = require('./replay');
  const { E } = await replay('playtest-r7-tessk-workshop');
  const plan = E.LLM.calls.find((c) => c.kind === 'worldbuild (timeline)');
  assert.ok(plan, 'the planning call ran');
  assert.ok(!/ghost-relay/.test(plan.user), 'the Ghost Relay is hidden');
  assert.match(plan.user, /"region": one of core, rim, drift/);
});

test('lore figures are never placed in a generated cast: a planned person or a minor person with a lore name is sent back', () => {
  const { E, w } = galaxy();
  const job = E.StartGen.newJob(w, { region: 'morrow-port', line: 'a deckhand', onePass: false });
  const ctx = E.StartGen.context(w, job);
  job.steps.player = { character: { name: 'Ana Coll', id: 'ana-coll' } };
  const out = E.StartGen.check.plan({ people: [{ name: 'Kesh Varro', role: 'retired officer', hook: 'drinks alone' }, { name: 'Bel Orr', role: 'dock boss', hook: 'owes money' }, { name: 'Tam Ris', role: 'mechanic', hook: 'lies' }] }, ctx);
  assert.match(out.error, /Kesh Varro is someone from the world's lore: make up someone new/);
  assert.match(E.StartGen.check.plan({ people: [{ name: 'Admiral Varro', role: 'officer', hook: 'x' }] }, ctx).error, /Admiral Varro is someone from the world's lore/, 'its keywords too');
  assert.ok(!E.StartGen.check.plan({ people: [{ name: 'Bel Orr', role: 'dock boss', hook: 'owes money' }, { name: 'Tam Ris', role: 'mechanic', hook: 'lies' }, { name: 'Ivo Pell', role: 'pilot', hook: 'debts' }] }, ctx).error);
});
