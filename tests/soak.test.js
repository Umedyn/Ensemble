// The headless run harness (task B-9): every alarm tripped on purpose with a
// made-up log, the seed, a short real run, fixtures, the report and the command.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEngine, newGame } = require('./helpers');
const Soak = require('./soak');
const { replay } = require('./replay');

// A made-up life: n samples, each from base(i) over quiet defaults.
const COUNTS = { facts: 0, promptFacts: 0, extras: 0, standees: 0, clocks: 0, tags: 0 };
function log(n, base = () => ({})) {
  return Array.from({ length: n }, (_, i) => Object.assign({
    t: i, life: 0, turn: i + 1, hours: i, mode: 'active', step: 'hour', clocks: [], needs: {}, at: {},
    counts: COUNTS, tokens: { facts: 0, story: 0 }, budgets: { facts: 100, story: 100 }, guards: [], events: [], calls: [], save: null,
  }, base(i)));
}
const runOf = (samples, more) => Object.assign({ world: 'test', seed: 1, model: 'mock', samples, crashes: [], breaks: [0],
  lives: [{ n: 0, start: 'a', from: 0, turns: samples.length, why: 'turns ran out', endings: [] }] }, more);
const keys = (samples, more) => Soak.alarms(runOf(samples, more)).map((a) => a.key);
const clock = (o) => Object.assign({ id: 'c', name: 'The pressure', value: 0, max: 10, perHour: 1, fired: false, stopped: false, firedTurn: null }, o);

test('a clock that should have run out and has not trips clockStuck', () => {
  assert.deepEqual(keys(log(40, () => ({ clocks: [clock({ value: 2 })] }))), ['clockStuck:c']);
  assert.deepEqual(keys(log(15, () => ({ clocks: [clock({ value: 2 })] }))), [], 'not yet past its time');
  assert.deepEqual(keys(log(40, () => ({ clocks: [clock({ value: 0, firedTurn: 12 })] }))), [], 'a repeating clock that fired starts over at 0');
  assert.deepEqual(keys(log(40, () => ({ clocks: [clock({ perHour: 0 })] }))), [], 'one that only events move has no expected time');
});

test('a clock firing on most turns trips clockRacing', () => {
  assert.deepEqual(keys(log(40, (i) => ({ clocks: [clock({ value: 1, firedTurn: i })] }))), ['clockRacing:c']);
  assert.deepEqual(keys(log(40, (i) => ({ clocks: [clock({ value: 1, firedTurn: Math.floor(i / 5) })] }))), []);
});

test('a need stuck at a limit trips pinned; touching it and leaving does not', () => {
  assert.deepEqual(keys(log(30, () => ({ needs: { kit: { stress: 1 } } }))), ['pinned:kit/stress']);
  assert.deepEqual(keys(log(30, () => ({ needs: { kit: { hunger: 0 } } }))), ['pinned:kit/hunger'], 'the bottom counts too');
  assert.deepEqual(keys(log(30, (i) => ({ needs: { kit: { stress: i % 10 ? 1 : 0.5 } } }))), []);
});

test('someone who never moves trips statue, someone always moving trips pacer', () => {
  assert.deepEqual(keys(log(70, () => ({ at: { teo: 'lab' } }))), ['statue:teo']);
  assert.deepEqual(keys(log(40, () => ({ at: { teo: 'lab' } }))), [], 'too short to say');
  assert.deepEqual(keys(log(70, (i) => ({ at: { teo: i % 2 ? 'lab' : 'ops' } }))), ['pacer:teo']);
  assert.deepEqual(keys(log(70, (i) => ({ at: { teo: i % 10 ? 'lab' : 'ops' } }))), []);
});

test('an ending that can never come, or did not follow its cause, trips endingOutOfReach', () => {
  const lives = (status) => [{ n: 0, start: 'a', turns: 5, why: '', endings: [{ id: 'e', title: 'The end', status, detail: 'waits for nothing' }] }];
  assert.deepEqual(keys(log(5), { lives: lives('broken') }), ['endingOutOfReach:e']);
  assert.deepEqual(keys(log(5), { lives: lives('held') }), ['endingOutOfReach:e']);
  assert.deepEqual(keys(log(5), { lives: lives('open') }), [], 'not reached is only a line in the report');
});

test('endingFacts tells a broken ending and one whose clock fired from an open one', () => {
  const { E, state } = newGame('zombie-holdout');
  const ending = (e) => { state.scenario.endings = [e]; return Soak.endingFacts(E, state)[0]; };
  assert.equal(ending({ id: 'a', when: { clock: 'no-such-clock' } }).status, 'broken');
  assert.equal(ending({ id: 'b', when: { reach: 'no-such-place' } }).status, 'broken');
  const id = state.clocks[0].id;
  assert.equal(ending({ id: 'c', when: { clock: id } }).status, 'open');
  state.clocks[0].fired = true;
  assert.equal(ending({ id: 'd', when: { clock: id } }).status, 'held');
  assert.equal(ending({ id: 'e', when: { clock: id }, if: [{ alive: state.player }] }).status, 'open', 'its conditions may not have held');
  assert.equal(ending({ id: 'f', when: { judged: 'the model says so' } }).judged, true);
});

test('counts that keep climbing, too many facts and a huge save trip growth', () => {
  const counts = (o) => ({ counts: Object.assign({}, COUNTS, o) });
  assert.deepEqual(keys(log(80, (i) => counts({ extras: i }))), ['growth:extras']);
  assert.deepEqual(keys(log(80, (i) => counts({ extras: Math.min(i, 30) }))), [], 'levelling off is fine');
  assert.deepEqual(keys(log(80, (i) => counts({ facts: i * 7 }))), ['growth:facts']);
  assert.deepEqual(keys(log(80, (i) => ({ save: i === 70 ? 9e6 : null }))), ['growth:save']);
});

test('prompts past the context, cut to fit, or over their budgets trip overBudget', () => {
  assert.deepEqual(keys(log(2, () => ({ calls: [{ kind: 'intent', tokens: 9000, over: true }] }))), ['overBudget:context']);
  assert.deepEqual(keys(log(40, () => ({ calls: [{ kind: 'intent', tokens: 8000, squeezed: true }] }))), ['overBudget:squeezed']);
  assert.deepEqual(keys(log(15, () => ({ tokens: { facts: 200, story: 0 } }))), ['overBudget:facts']);
  assert.deepEqual(keys(log(15, () => ({ tokens: { facts: 0, story: 200 } }))), ['overBudget:story']);
  assert.deepEqual(keys(log(15, (i) => ({ tokens: { facts: i % 5 ? 200 : 0, story: 0 } }))), [], 'a moment over is not an alarm');
});

test('a guard firing on most turns trips constantGuard; routine ones never do', () => {
  assert.deepEqual(keys(log(40, () => ({ guards: ['update rejected'] }))), ['constantGuard:update rejected']);
  assert.deepEqual(keys(log(40, () => ({ guards: ['cast tier'] }))), []);
  assert.deepEqual(keys(log(40, (i) => ({ guards: i % 5 ? [] : ['update rejected'] }))), []);
});

test('the same event over and over trips repeatedEvents', () => {
  const found = keys(log(30, (i) => ({ events: i % 3 ? [] : ['A pipe bursts again!'] })));
  assert.equal(found.length, 1);
  assert.match(found[0], /^repeatedEvents:a pipe bursts/);
  assert.deepEqual(keys(log(30, (i) => ({ events: [`Thing ${i}`] }))), []);
  assert.deepEqual(keys(log(40, (i) => ({ events: i % 12 ? [] : ['A pipe bursts again!'] }))), [], 'far enough apart');
});

test('a turn that throws is a crash alarm', async () => {
  assert.deepEqual(keys(log(3), { crashes: [{ t: 1, turn: 2, action: 'x', message: 'boom' }] }), ['crash:boom']);
  const run = await Soak.play({ world: 'mars-station', turns: 3, seed: 1, connect: (E) => { E.LLM.transport = async () => { throw new Error('the model went away'); }; } });
  assert.ok(run.crashes.length >= 1);
  assert.ok(Soak.alarms(run).some((a) => a.id === 'crash'));
});

test('known alarms: by key, or every alarm of a kind in that world', () => {
  const known = { w: { 'statue:teo': 'why', 'pinned:*': 'why' } };
  assert.ok(Soak.isKnown(known, 'w', { key: 'statue:teo', id: 'statue' }));
  assert.ok(Soak.isKnown(known, 'w', { key: 'pinned:a/b', id: 'pinned' }));
  assert.ok(!Soak.isKnown(known, 'w', { key: 'statue:okafor', id: 'statue' }));
  assert.ok(!Soak.isKnown(known, 'other', { key: 'statue:teo', id: 'statue' }));
});

test('a soak is fixed by its seed: the same seed plays the same game, another a different one', async () => {
  const brief = (r) => JSON.stringify(r.samples.map((s) => [s.turn, s.hours, s.mode, s.step, s.at, s.needs, s.events, s.guards]));
  const opts = { world: 'mars-station', turns: 30 };
  const a = await Soak.play(Object.assign({ seed: 5 }, opts));
  const b = await Soak.play(Object.assign({ seed: 5 }, opts));
  const c = await Soak.play(Object.assign({ seed: 6 }, opts));
  assert.equal(brief(a), brief(b));
  assert.notEqual(brief(a), brief(c));
  assert.deepEqual(a.crashes, []);
  assert.ok(new Set(a.samples.map((s) => s.mode)).size >= 2, 'the player does more than one thing');
});

test('a soak plays through split calls and a generated start with no crash', async () => {
  const split = await Soak.play({ world: 'mars-station', turns: 6, seed: 2, smaller: true });
  assert.deepEqual(split.crashes, []);
  assert.ok(split.samples.flatMap((s) => s.calls).some((c) => c.kind.startsWith('intent:')));
  const open = await Soak.play({ world: 'your-story', turns: 5, seed: 2 });
  assert.deepEqual(open.crashes, []);
  assert.equal(open.lives[0].start, 'generated');
});

test('a story that stops starts a new life, and Keep playing does not run on for ever', async () => {
  const run = await Soak.play({ world: 'vesper-station', turns: 120, seed: 1 });
  assert.equal(run.samples.length, 120);
  assert.ok(run.lives.length >= 3, 'the station ends quickly');
  assert.ok(run.lives.every((l) => l.turns <= 60), `lives of ${run.lives.map((l) => l.turns)}`);
  assert.ok(run.lives.some((l) => l.endings.some((e) => e.status === 'reached')));
  assert.deepEqual(run.crashes, []);
});

test('an alarm becomes a fixture that replays, and the report says so', async () => {
  const opts = { world: 'mars-station', turns: 40, seed: 3 };
  const run = await Soak.play(opts);
  const alarm = { key: 'made:up', id: 'made', subject: 'up', t: 30, detail: 'on purpose', times: 1 };
  const fixture = await Soak.capture(opts, run, alarm, 5);
  assert.equal(fixture.format, 'ensemble-recording');
  assert.equal(fixture.actions.length, 6);
  const { steps } = await replay(JSON.parse(JSON.stringify(fixture)));
  assert.equal(steps.length, 6);
  alarm.fixture = 'made.json';
  const text = Soak.report(run, [alarm], {});
  assert.match(text, /# Soak: mars-station/);
  assert.match(text, /\*\*made:up\*\*: on purpose Fixture: `made\.json`/);
  assert.match(text, /## Lives/);
  assert.match(text, /1 new, 0 known/);
});

test('npm run soak writes a report, and --strict fails only on a new alarm', async () => {
  const { main } = await import('../tools/soak.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'));
  const deps = { out, known: {}, log: () => {} };
  const args = ['mars-station', '--turns', '8', '--seed', '2', '--strict'];
  const real = Soak.alarms;
  try {
    assert.equal(await main(args, deps), 0);
    assert.ok(fs.existsSync(path.join(out, 'mars-station-2.md')));
    assert.equal(await main([], deps), 1, 'no world: the usage');
    Soak.alarms = () => [{ key: 'made:up', id: 'made', subject: 'up', t: 2, detail: 'on purpose', times: 1 }];
    assert.equal(await main(args, deps), 1, 'a new alarm fails');
    assert.ok(fs.readdirSync(out).some((f) => f.endsWith('made-1.json')), 'with its fixture');
    assert.equal(await main(args, Object.assign({}, deps, { known: { 'mars-station': { 'made:up': 'accepted' } } })), 0, 'a known one does not');
  } finally {
    Soak.alarms = real;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a real backend: --model plays through the normal transport, and a missing key is said plainly', async () => {
  const { realModel, soakWorld } = await import('../tools/soak.mjs');
  const { startMocks } = await import('./mock-servers.mjs');
  const E = loadEngine();
  assert.throws(() => realModel({ model: 'nope' }, {})(E), /No preset "nope"/);
  assert.throws(() => realModel({ model: 'openrouter', name: 'x/y' }, {})(E), /ENSEMBLE_API_KEY/);
  const mocks = await startMocks({ kobold: 0, api: 0 });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'));
  try {
    const flags = { model: 'kobold-local', url: `http://127.0.0.1:${mocks.ports.kobold}/v1`, turns: '2' };
    const { run } = await soakWorld('mars-station', flags, { out, known: {}, log: () => {} });
    assert.equal(run.model, 'real');
    assert.deepEqual(run.crashes, []);
    assert.ok(mocks.log.some((l) => l.port === 5001), 'it reached the server');
  } finally {
    mocks.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the region tree is kept per list, and an edit in place still shows', () => {
  const E = loadEngine();
  const S = E.Scenario;
  const list = [{ id: 'a' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'a' }];
  assert.deepEqual([...S.regionChainIn(list, 'c')], ['c', 'a']);
  list[2].parent = 'b';
  assert.deepEqual([...S.regionChainIn(list, 'c')], ['c', 'b', 'a'], 'a new parent');
  list[1].id = 'bb';
  list[2].parent = 'bb';
  assert.deepEqual([...S.regionChildrenIn(list, 'bb')], ['c'], 'a new id');
  list.push({ id: 'd', parent: 'a' });
  assert.deepEqual([...S.regionChildrenIn(list, 'a')], ['bb', 'd'], 'a new region');
  list[3] = { id: 'e', parent: 'a' };
  assert.deepEqual([...S.regionChildrenIn(list, 'a')], ['bb', 'e'], 'a replaced region');
  S.regionChildrenIn(list, 'a').push('z');
  assert.deepEqual([...S.regionChildrenIn(list, 'a')], ['bb', 'e'], 'callers get their own copy');
});
