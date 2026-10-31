// Narration that stops at a paragraph (task L-2): the soft stop's rules on
// scripted text, a real stream from the fake servers stopped mid-way with the
// abort reaching them, a whole turn stopped and its recording replayed, and
// the token caps that grow with the turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { loadEngine, newGame, readWorld } = require('./helpers');
const { replay } = require('./replay');

const para = (marker, n, word = 'word') => `${marker ? marker + ' ' : ''}${Array.from({ length: n }, () => word).join(' ')}.`;
const names = ['Teo', 'Bauer', 'Okafor'];

// ---------- the rules ----------

test('the soft stop ends after the paragraph that reaches the top word count', () => {
  const E = loadEngine();
  const t = { words: [100, 200], beats: null, span: null, names };
  const text = [para('[+0m]', 80), para('', 80), para('[+30m]', 80), para('', 40)].join('\n\n');
  const stop = E.Engine.softStop(text, t);
  assert.ok(stop, 'stops');
  assert.match(stop.why, /^24\d words$/);
  assert.equal(text.slice(0, stop.at).split('\n\n').length, 3, 'after the third paragraph');
  assert.equal(E.Engine.softStop([para('[+0m]', 80), para('', 80)].join('\n\n') + '\n\n' + para('', 10).slice(0, 12), t), null, 'not yet at 160 words');
});

test('the soft stop ends before a beat past the ones asked for, once the marker is in sight', () => {
  const E = loadEngine();
  const t = { words: [100, 200], beats: [2, 3], span: 60, names };
  const three = [para('[+0m]', 15), para('[+20m]', 15), para('[+40m]', 15)].join('\n\n');
  assert.equal(E.Engine.softStop(three + '\n\n[+5', t), null, 'a marker only half written');
  const stop = E.Engine.softStop(three + '\n\n[+50m] Teo', t);
  assert.equal(stop.at, three.length);
  assert.match(stop.why, /3 beats/);
});

test('the soft stop ends before a marker past the end of the scene', () => {
  const E = loadEngine();
  const t = { words: [100, 200], beats: [2, 4], span: 60, names };
  const two = [para('[+0m]', 15), para('[+30m]', 15)].join('\n\n');
  const stop = E.Engine.softStop(two + '\n\n[+75m] Later', t);
  assert.equal(stop.at, two.length);
  assert.match(stop.why, /past \[\+60m\]/);
  assert.equal(E.Engine.softStop(two + '\n\n[+60m] Right at the end', t), null, 'the last minute is fine');
});

test('the soft stop ends before the player\'s own paragraph, but only once the scene has enough', () => {
  const E = loadEngine();
  const t = { words: [60, 200], beats: [2, 3], span: 60, names };
  // Early: a beat that opens on the player is part of the scene.
  const early = [para('[+0m]', 10), '[+20m] You hand Teo the spanner and watch.', para('[+30m]', 10)].join('\n\n') + '\n\n';
  assert.equal(E.Engine.softStop(early, t), null);
  // Once two beats are in: the player's own line is where the scene stops.
  const body = [para('[+0m] Okafor', 30), para('[+20m] Teo', 30)].join('\n\n');
  const stop = E.Engine.softStop(body + '\n\n"Fine," you say, and turn back to the panel.\n\nTeo', t);
  assert.equal(stop.at, body.length);
  assert.match(stop.why, /player's own line/);
  // A paragraph that opens on the player and hands over to someone else stays.
  const handed = body + '\n\nYou turn to go, but Teo hesitates. "Wait."\n\nMore';
  assert.equal(E.Engine.softStop(handed, t), null);
});

test('every narration call is asked for what the soft stop holds it to', () => {
  const E = loadEngine();
  const L = E.Prompts.LENGTH;
  assert.deepEqual([...L.beats.hour], [2, 3]);
  const { state } = newGame('mars-station');
  const frame = { startLoc: state.characters[state.player].status.location, startTime: '', stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 };
  const res = { outcomes: [], events: [] };
  assert.ok(E.Prompts.narrateMore(state, [], 'x', frame, res, '[+0m] Hi.', 10).includes(`(${L.more.words} words)`));
  assert.ok(E.Prompts.narrate(state, [], 'x', frame, res).includes(`(${L.scene.words} words)`));
});

// ---------- a real stream ----------

async function mocks() {
  const { startMocks } = await import(pathToFileURL(path.join(__dirname, 'mock-servers.mjs')).href);
  return startMocks({ kobold: 0, api: 0 });
}
// An engine that talks to the fake servers over HTTP.
function liveEngine(m) {
  const E = loadEngine({ fetch, AbortController, TextDecoder });
  E.settings.backends.local.url = `http://127.0.0.1:${m.ports.kobold}/v1`;
  Object.assign(E.settings.backends.external, { preset: 'custom', url: `http://127.0.0.1:${m.ports.api}/v1`, key: 'sk-test', model: 'test/story-70b' });
  return E;
}
const longScene = 'Write the next scene.\n=== PLAYER ACTION (time passing: about an hour) ===\n"Tell me everything."';

test('a stream from KoboldCpp stops at a paragraph and the abort reaches the server; an API stream is hung up on', async () => {
  const m = await mocks();
  try {
    const E = liveEngine(m);
    const stopAt = (t) => E.Engine.softStop(t, { words: [100, 200], beats: [2, 3], span: 60, names });
    let seen = 0;
    const text = await E.LLM.chat({ kind: 'narrate', system: 'h', user: longScene, maxTokens: 400, stopAt, onText: () => { seen++; } });
    assert.equal(E.LLM.lastFinish, 'stopped');
    assert.equal((text.match(/\[\+/g) || []).length, 3, 'three beats');
    assert.ok(!/\[\+40m\]/.test(text));
    assert.ok(seen > 3, 'the text arrived in pieces');
    const call = E.LLM.calls[E.LLM.calls.length - 1];
    assert.equal(call.finish, 'stopped');
    assert.match(call.stopped, /3 beats/);
    assert.ok(m.log.some((l) => l.user === longScene && l.stream), 'the request asked for a stream');
    await new Promise((r) => setTimeout(r, 50));
    const abort = m.log.find((l) => l.abort);
    assert.ok(abort && /^ENS/.test(abort.abort) && abort.running, 'KoboldCpp was told to stop this generation');

    E.settings.routing.narrate = 'external';
    m.log.length = 0;
    const api = await E.LLM.chat({ kind: 'narrate', system: 'h', user: longScene, maxTokens: 400, stopAt });
    assert.equal(E.LLM.lastFinish, 'stopped');
    assert.equal((api.match(/\[\+/g) || []).length, 3);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(m.log.some((l) => l.disconnected), 'the API saw the connection close');
    assert.ok(!m.log.some((l) => l.abort), 'no KoboldCpp abort for an API');

    // JSON calls never stream.
    m.log.length = 0;
    await E.LLM.chatJSON({ kind: 'chapter', system: 'h', user: 'Reply with JSON only: {"title":"...","summary":"..."}', maxTokens: 100 });
    assert.equal(m.log[0].stream, false);
  } finally { m.close(); }
});

test('a turn whose scene runs long is stopped at a paragraph, reported, and replays from its recording', async () => {
  const m = await mocks();
  let fixture;
  try {
    const E = liveEngine(m);
    E.settings.routing = Object.assign({}, E.settings.routing, { narrate: 'local' });
    const state = E.Engine.newGame(E.Scenario.startScenario(readWorld('mars-station', E)));
    E.Recorder.start(state);
    const phases = [];
    const out = await E.Engine.runTurn(state, 'Tell me everything.', 'hour', (p) => phases.push(p));
    fixture = JSON.parse(JSON.stringify(E.Recorder.stop()));
    assert.ok(out);
    const t = E.Engine.telemetry[E.Engine.telemetry.length - 1];
    const narrate = t.calls.find((c) => c.kind === 'narrate');
    assert.equal(narrate.finish, 'stopped');
    assert.ok(!t.guards.some((g) => g.type === 'cut-off paragraph dropped'), 'nothing to drop');
    assert.ok(state.pending.beats.length <= 3, 'no more beats than asked');
    assert.match(E.Engine.turnReport(t), /Ended: \d+ complete, 1 stopped at a paragraph, 0 cut off/);
    assert.match(E.Engine.turnReport(t), /stopped at a paragraph: 3 beats/);
    assert.ok(phases.some((p) => /^Writing the scene… \d+ words$/.test(p)), 'the phase line counts words');
    const rc = fixture.actions[0].calls.find((c) => c.kind === 'narrate');
    assert.equal(rc.response.finish, 'stopped');
    assert.match(rc.response.stopped, /3 beats/);
  } finally { m.close(); }

  const { steps } = await replay(fixture);
  const st = steps[0].state;
  assert.ok(st.pending.beats.length <= 3);
  assert.ok(!(st.log || []).some((e) => /cut-off paragraph/.test(JSON.stringify(e))));
});

// ---------- caps ----------

test('the update cap grows with the people present and the step, within the reply the context allows', () => {
  const { E, state } = newGame('mars-station');
  const U = E.Engine.updateTokens;
  const others = E.Engine.cast(state, { includePlayer: false });
  assert.equal(U(state, [], 'moment'), 360);
  assert.equal(U(state, others.slice(0, 2), 'moment'), 520);
  assert.equal(U(state, others.slice(0, 2), 'hour'), 640);
  assert.ok(U(state, others.slice(0, 3), 'hour') > U(state, others.slice(0, 2), 'hour'));
  assert.equal(U(state, [state.player].concat(others.slice(0, 2)), 'hour'), 640, 'the player is not counted');
  assert.equal(U(state, others.concat(others), 'morning'), E.contextTier().reply, 'capped by the 8K tier');
  E.settings.backends.local.context = 32768;
  assert.equal(U(state, others.concat(others), 'morning'), 360 + 80 * 6 + 240);
});

test('the intent cap is bigger for a player alone than the old 260', () => {
  const { E, state } = newGame('mars-station');
  const due = { canon: [] };
  assert.equal(E.Engine.intentTokens(state, [], due) - 60 * E.Engine.standeesAt(state, state.characters[state.player].status.location).length - 80 * E.Engine.agendasDue(state).length, 360);
  assert.equal(E.Engine.intentTokens(state, ['bauer'], due) - E.Engine.intentTokens(state, [], due), 410 - 360);
});

test('the scene is told the player\'s action has not happened yet; a scene being continued is not', () => {
  const shots = Object.values(require('./fixtures/prompt-snapshots.json'));
  const named = (re) => shots.flatMap((s) => Object.entries(s).filter(([k]) => re.test(k)).map(([, v]) => JSON.stringify(v)));
  const fresh = named(/^narrate$/), more = named(/^narrateMore$/);
  assert.ok(fresh.length && more.length);
  fresh.forEach((p) => { assert.match(p, /not done yet/); assert.match(p, /the new scene starts here and plays it out/); });
  more.forEach((p) => assert.doesNotMatch(p, /not done yet/));
});
