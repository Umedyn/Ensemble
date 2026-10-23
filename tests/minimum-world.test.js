// Open worlds and the minimum world (R-0): a world.json with only a title and
// a setting validates, composes and starts a generated game. Everything
// beyond that is optional, and new world features must keep this passing.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, worldFiles, mockLLM } = require('./helpers');
const { replies, stepOf } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));
const MIN = path.join(__dirname, 'fixtures', 'minimum-world');

// The genmock replies were written for the holdout; the player's sheet here
// spends the default skills.
function mock(E) {
  const r = replies({ player: Object.assign({}, replies().player, { skills: { physical: 3, technical: 3, social: 2 } }) });
  return mockLLM(E, (call) => {
    const v = r[stepOf(call.user)];
    if (v == null) return call.kind === 'intent' ? { player: { summary: 'look around' }, intents: [], events: [] }
      : call.kind === 'update' ? { facts: [], state: [], relations: [], player_attitude: [] } : '[+0m] The wind leans on the windows.';
    return typeof v === 'function' ? v(call.user, call) : v;
  });
}

// Loads the world, runs a generated start to the end and plays one turn.
async function playGenerated(files, opts = {}) {
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('minimum-world', files);
  const job = E.StartGen.newJob(w, Object.assign({ line: 'a keeper who came here to forget', onePass: false }, opts));
  const calls = mock(E);
  await E.StartGen.run(w, job, {});
  assert.ok(E.StartGen.done(job), `stopped at ${job.failed && job.failed.step}: ${job.failed && job.failed.error}`);
  const sc = E.StartGen.scenario(w, job);
  const state = E.Engine.newGame(sc);
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  return { E, w, job, sc, state, calls };
}

test('the minimum world: a title and a setting validate, compose and start a generated game', async () => {
  const files = worldFiles(MIN);
  assert.deepEqual(Object.keys(files), ['world.json']);
  assert.deepEqual(Object.keys(files['world.json']).sort(), ['setting', 'title'], 'the fixture stays minimal');
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('minimum-world', worldFiles(MIN));
  assert.deepEqual([...w.warnings], []);
  assert.equal(w.legacy, false);
  assert.equal(w.starts.length, 0);
  assert.equal(w.generate, true, 'no starts: Make my own');
  const { sc, state, job } = await playGenerated(worldFiles(MIN));
  assert.equal(job.region, null);
  assert.deepEqual(plain(sc.skills), plain(E.DEFAULT_SKILLS));
  assert.deepEqual(plain(sc.needs), []);
  assert.deepEqual(plain(sc.start), { day: 1, hour: 9 }, 'day 1, 9:00');
  assert.equal(state.turn, 1);
  assert.equal(state.characters[state.player].name, 'Sam Whitlock');
});

test('the minimum world with a few regions and nothing else', async () => {
  const files = worldFiles(MIN);
  files['world.json'].regions = [{ id: 'cape', name: 'The Cape' }, { id: 'harbour', name: 'Old Harbour' }, { id: 'moor', name: 'The Moor' }];
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('minimum-world', E.clone(files));
  assert.deepEqual(plain(E.StartGen.regions(w.bundle.world).map((r) => r.id)), ['cape', 'harbour', 'moor'], 'none marked: every region is startable');
  const { sc, state } = await playGenerated(files, { region: 'harbour' });
  assert.equal(sc.region, 'harbour');
  assert.equal(state.turn, 1);
});

test('generatedStarts defaults: 10 skill points, at most 3 each, 3 to 5 people, freeform roles', () => {
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('minimum-world', worldFiles(MIN));
  const slot = E.StartGen.slot(w.bundle.world, 'here');
  assert.deepEqual(plain(slot), { location: 'here', roles: [], freeform: true, skillPoints: 10, maxSkill: 3 });
  assert.deepEqual(plain(E.StartGen.castSize(w.bundle.world)), [3, 5]);
  // Tuning one field keeps the others' defaults.
  const f = worldFiles(MIN);
  f['world.json'].generatedStarts = { maxSkill: 4 };
  const tuned = E.Scenario.prepareWorld('minimum-world', f);
  assert.equal(E.StartGen.slot(tuned.bundle.world, 'here').skillPoints, 10);
  assert.equal(E.StartGen.slot(tuned.bundle.world, 'here').maxSkill, 4);
});

test('the world date: a generated start begins on it; generatedStarts.start wins; a bad one is a problem', () => {
  const E = loadEngine();
  const at = (edit) => {
    const f = worldFiles(MIN);
    edit(f['world.json']);
    const w = E.Scenario.prepareWorld('minimum-world', f);
    return plain(E.StartGen.contextScenario(w, null).start);
  };
  assert.deepEqual(at(() => {}), { day: 1, hour: 9 });
  assert.deepEqual(at((w) => { w.date = { day: 40, hour: 6 }; }), { day: 40, hour: 6 });
  assert.deepEqual(at((w) => { w.date = { day: 40, hour: 6 }; w.generatedStarts = { start: { day: 2, hour: 20 } }; }), { day: 2, hour: 20 });
  assert.throws(() => at((w) => { w.date = 'spring'; }), /"date" must be \{day, hour\}/);
});

test('the world date is the date of an authored start that gives none', () => {
  const E = loadEngine();
  const sc = E.Scenario.compose({ title: 'T', setting: 'S', date: { day: 5, hour: 7 } }, { id: 'a', cast: [] }, {}, 'x');
  assert.deepEqual(plain(sc.start), { day: 5, hour: 7 });
  assert.equal(sc.date, undefined);
  const own = E.Scenario.compose({ title: 'T', setting: 'S', date: { day: 5, hour: 7 } }, { id: 'a', cast: [], start: { day: 9, hour: 12 } }, {}, 'x');
  assert.deepEqual(plain(own.start), { day: 9, hour: 12 });
});

test('authored starts sit alongside: a world with starts and no generatedStarts stays closed', () => {
  const E = loadEngine();
  const files = worldFiles('mars-station');
  assert.equal(E.Scenario.prepareWorld('mars-station', files).generate, false);
  files['world.json'].generatedStarts = {};
  const w = E.Scenario.prepareWorld('mars-station', files);
  assert.equal(w.generate, true);
  assert.ok(w.starts.length > 0 && w.starts.every((s) => s.scenario), 'the authored starts still load, listed first');
});

test('the minimum world still needs a title and a setting', async () => {
  const E = loadEngine();
  const f = worldFiles(MIN);
  delete f['world.json'].title;
  assert.throws(() => E.Scenario.prepareWorld('m', f), /missing "title"/);
  const g = worldFiles(MIN);
  delete g['world.json'].setting;
  await assert.rejects(playGenerated(g), /missing "setting"/);
});
