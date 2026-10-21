// Recordings replayed without a model. The sample fixture comes from the mock
// servers (`npm run fixture:mock`); real playtest fixtures go next to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { replay, loadFixture } = require('./replay');
const { newGame, mockLLM } = require('./helpers');

const json = (o) => JSON.stringify(o);
const withoutUndo = (s) => { const c = JSON.parse(json(s)); delete c.undo; return json(c); };
const fresh = () => JSON.parse(json(loadFixture('mock-session')));

test('the sample session replays turn by turn, the same way every time', async () => {
  const a = await replay('mock-session');
  const b = await replay('mock-session');
  assert.equal(json(a.state), json(b.state), 'deterministic');
  const [t1, t2, reroll, t3, undo, t3again] = a.steps;
  const roll = t1.state.pending.res.outcomes[0].roll;
  assert.ok(roll, 'turn 1: the tech roll is replayed from the recorded dice');
  assert.equal(t1.state.characters.okafor.status.location, 'ops', 'turn 1: Okafor left for Ops');
  assert.equal(t2.state.log.find((e) => e.type === 'scene' && e.turn === 1).cutAt, 2, 'turn 2 stepped in after beat 2');
  assert.equal(reroll.state.pending.turn, 2);
  assert.equal(t3.state.turn, 3);
  assert.equal(withoutUndo(undo.state), withoutUndo(reroll.state), 'undo went back to before turn 3');
  assert.equal(t3again.state.turn, 3);
  assert.equal(t3again.state.log.find((e) => e.type === 'action' && e.turn === 3).text, 'Ask Teo what he wiped from the log.');
  for (const s of a.steps) {
    const res = s.state.pending && s.state.pending.res;
    assert.ok(!res || !res.outcomes.some((o) => o.id === 'bauer' && o.reveals), `action ${s.index}: Teo's secret stays hidden`);
  }
  assert.ok(a.state.facts.some((f) => /sensor issue/.test(f.text)), 'memory recorded from the replayed update calls');
});

// Real session (DeepSeek, 2026-10-19), see the note in the fixture.
test('playtest: the storm session replays, and Kit gets where the player sent them', async () => {
  const r = await replay('playtest-deepseek-storm');
  const at = (n) => r.steps[n - 1].state.characters.navarro.status.location;
  assert.equal(at(3), 'surface', '"Help Priya then go work on the Array."');
  assert.equal(at(6), 'surface', '"Help Priya while Teo works on the shaft." (Priya is outside)');
  assert.equal(at(8), 'garage', '"…while I head down to the garage."');
  assert.equal(at(11), 'med');
  assert.equal(r.state.turn, 16);
  for (const s of r.steps) {
    const res = s.state.pending && s.state.pending.res;
    assert.ok(!res || !res.outcomes.some((o) => o.reveals), `action ${s.index}: nobody's secret came out`);
  }
});

test('playtest: walking out to the garage leaves Okafor behind instead of sending her to the Commons', async () => {
  const r = await replay('playtest-deepseek-storm', { until: 2 });
  const narrate = r.E.LLM.calls.filter((c) => c.kind === 'narrate').pop();
  assert.match(narrate.user, /Dr\. Imani Okafor stays behind in Commons/);
});

// Friend's session (DeepSeek, 2026-10-20): stepped in on Teo, then confronted him.
test('playtest: after stepping in on Teo, he is still there to be confronted', async () => {
  const r = await replay('playtest-friend-stepin');
  const intents = r.E.LLM.calls.filter((c) => c.kind === 'intent');
  assert.match(intents[intents.length - 1].user, /Present with Kit Navarro: Teo Bauer/, 'turn 5 has Teo in the room');
  const report = r.E.Engine.telemetry[r.E.Engine.telemetry.length - 1];
  assert.ok(report.guards.some((g) => g.type === 'update rejected' && /stepped in before they left/.test(g.detail) && g.turn === 4));
});

// Holdout at Harmon's (NemoMix 12B, 2026-10-20), see the note in the fixture.
test('playtest: stepping outside without naming a room is caught, and Pike stays on the sales floor', async () => {
  const r = await replay('playtest-zombie-steps-outside', { until: 1 });
  const guards = [...r.steps[0].state.pending.res.guards];
  assert.ok(guards.some((g) => g.type === 'relocation regenerated' && /outside/.test(g.detail)), '"You nod, then step outside into the cool morning air"');
  const retry = r.E.LLM.calls.find((c) => c.kind === 'narrate (retry)');
  assert.match(retry.user, /took the player character outside, which did not happen\. The whole scene stays in Sales Floor/);
  assert.equal(r.state.characters.pike.status.location, 'floor');
  assert.doesNotMatch(r.state.recent[0].text, /step outside/);
});

test('playtest: a scene fact is known only by the people who were there (Marlene and Gil were in other rooms)', async () => {
  const r = await replay('playtest-zombie-steps-outside');
  const fact = r.state.facts.find((f) => /scavenge lumber/.test(f.text));
  assert.deepEqual([...fact.known_by], ['coleman', 'han']);
  const report = r.E.Engine.telemetry[r.E.Engine.telemetry.length - 1];
  assert.ok(report.guards.some((g) => g.type === 'update rejected' && /dropped ortiz, ferris: not in the scene/.test(g.detail)));
});

// Ares Deep on NemoMix 12B, 2026-10-21 (playtest-id-tags-in-prose): the
// narrator copied the "[okafor]" id tags from its STATUS lines into the
// prose, the update step tagged Teo "anxious about recycler" (a feeling),
// and a scene cut at the token limit ended inside a line of dialogue.
test('playtest: character id tags in the prose become names, and the narrator no longer sees them', async () => {
  const r = await replay('playtest-id-tags-in-prose');
  const scenes = r.state.log.filter((e) => e.type === 'scene' && e.turn > 0);
  scenes.forEach((s) => assert.doesNotMatch(s.text, /\[okafor\]/i));
  assert.match(scenes[0].text, /\n\nOkafor looks up from her tablet/);
  assert.ok([...r.steps[0].state.pending.res.guards].some((g) => g.type === 'id tag replaced' && /\[okafor\] → Okafor/.test(g.detail)));
  r.E.LLM.calls.filter((c) => c.kind === 'narrate').forEach((c) => assert.doesNotMatch(c.user, /\[(okafor|bauer|navarro)\]/));
});

test('playtest: "anxious about recycler" is a feeling, so it is not a tag', async () => {
  const r = await replay('playtest-id-tags-in-prose');
  assert.deepEqual([...r.state.characters.bauer.tags], []);
  const report = r.E.Engine.telemetry[r.E.Engine.telemetry.length - 1];
  assert.ok(report.guards.some((g) => g.type === 'update rejected' && /anxious about recycler/.test(g.detail) && /a feeling/.test(g.detail)));
});

test('playtest: a scene cut off at the token limit closes the line of dialogue it stops in', async () => {
  const r = await replay('playtest-id-tags-in-prose');
  assert.match(r.state.recent[0].text, /he nods quickly\. "Y-yes, Imani\."$/);
});

// Ares Deep on NemoMix 12B, 2026-10-21 (playtest-agenda-skips): two skips
// with no plan. The first stops at the storm, the second at Teo's agenda.
test('playtest: the clock that ends a skip is what the narrator is told ends it', async () => {
  const r = await replay('playtest-agenda-skips');
  const narrates = r.E.LLM.calls.filter((c) => c.kind === 'narrate');
  assert.match(narrates[0].user, /=== WHAT ENDS IT ===\nThe dust storm arrives\./, 'not the sponsor message applied after it');
});

test('playtest: a skip with no plan leaves Kit where they were, not outside in the storm', async () => {
  const r = await replay('playtest-agenda-skips', { until: 1 });
  assert.equal(r.state.characters.navarro.status.location, 'commons');
  assert.ok([...r.state.pending.res.guards].some((g) => g.type === 'move cancelled' && /surface/.test(g.detail)));
});

test('playtest: the live beat that ends a skip survives the player-ending trim', async () => {
  const r = await replay('playtest-agenda-skips', { until: 1 });
  const beats = [...r.state.pending.beats];
  assert.match(beats[beats.length - 1].text, /The Mule's windshield just cracked![^]*I need help!"$/);
});

test('playtest: the update step cannot undo what a clock set this turn, or record a fact twice', async () => {
  const r = await replay('playtest-agenda-skips');
  assert.equal(r.state.world.power, 'solar output collapsed, running on battery reserve');
  assert.equal(r.state.facts.filter((f) => /dust storm arrives/i.test(f.text)).length, 1);
  const report = r.E.Engine.telemetry[r.E.Engine.telemetry.length - 1];
  assert.ok(report.guards.some((g) => g.type === 'update rejected' && /set by "Dust storm arrival" this turn/.test(g.detail)));
  assert.ok(report.guards.some((g) => g.type === 'update rejected' && /already recorded/.test(g.detail)));
});

test('playtest: a downtime scene that retells the last scene keeps only what is new, and Teo arrives with his theory', async () => {
  const r = await replay('playtest-agenda-skips');
  const text = r.state.recent[0].text;
  assert.doesNotMatch(text, /drilling into your skull/);
  assert.match(text, /^Teo comes bounding into the suit room/);
  assert.equal(r.state.characters.bauer.status.location, r.state.characters.navarro.status.location);
  assert.equal(r.state.characters.bauer.agenda.done, true);
  const narrates = r.E.LLM.calls.filter((c) => c.kind === 'narrate');
  assert.match(narrates[1].user, /- Teo Bauer: in [^,]+, comes to Kit with a too-cheerful theory about a sensor fault/);
});

// Holdout on NemoMix 12B, 2026-10-21 (playtest-albee-promoted): Mrs. Albee,
// named on two turns, becomes a character. The narrator wrote dialogue like
// a script ("You (Jordan Pike): ...", "Mrs. Albee: ..."), and her new sheet
// contradicted how the scene had just shown her.
test('playtest: Mrs. Albee, named twice, becomes a character who keeps what is known about her', async () => {
  const r = await replay('playtest-albee-promoted');
  const c = r.state.characters.albee;
  assert.ok(c && !r.state.extras.albee);
  assert.deepEqual([c.tier, c.joined, c.status.location], ['local', 2, 'dock']);
  assert.ok(r.E.Engine.knownAbout(r.state, 'albee').some((f) => /armed men from the Ridge/.test(f.text)));
  const intents = r.E.LLM.calls.filter((call) => call.kind === 'intent');
  assert.match(intents[intents.length - 1].user, /Present with Jordan Pike: Mrs\. Albee/);
});

test('playtest: the promotion call sees how the last scene showed her', async () => {
  const r = await replay('playtest-albee-promoted');
  const wb = r.E.LLM.calls.find((call) => call.kind === 'worldbuild');
  assert.match(wb.user, /=== HOW THE STORY HAS SHOWN THEM ===[^]*her hair in curlers/);
  assert.match(wb.user, /Stay consistent with how the story has shown them/);
});

test('playtest: script-style speaker labels are taken out of the prose', async () => {
  const r = await replay('playtest-albee-promoted');
  const scenes = r.state.log.filter((e) => e.type === 'scene' && e.turn > 0);
  scenes.forEach((s) => assert.doesNotMatch(s.text, /(^|\n)(You \(Jordan Pike\)|Mrs\. Albee):/));
  assert.match(scenes[1].text, /^"Mrs\. Albee, what have you seen out here/);
  assert.match(scenes[2].text, /\n\n"No, not army\. But they were organized/);
});

test('until stops after that many actions', async () => {
  const r = await replay('mock-session', { until: 2 });
  assert.equal(r.steps.length, 2);
  assert.equal(r.state.turn, 2);
});

test('replay fails clearly when the engine makes a different call than recorded', async () => {
  const f = fresh();
  f.actions[0].calls[1].kind = 'narrate (retry)';
  await assert.rejects(replay(f), (err) => err.name === 'ReplayError' &&
    /Replay mismatch at action 1 \(turn "I open up the recycler\."\), call 2: engine made "narrate", recording has "narrate \(retry\)"/.test(err.message));
});

test('replay fails when the engine makes fewer or more calls than recorded', async () => {
  const fewer = fresh();
  fewer.actions[0].calls.push(JSON.parse(json(fewer.actions[0].calls[1])));
  await assert.rejects(replay(fewer), /the engine made 2 call\(s\); the recording has 3/);
  const more = fresh();
  more.actions[0].calls.pop();
  await assert.rejects(replay(more), /made a "narrate" call, but the recording has only 1/);
});

test('replay fails when the dice are drawn differently', async () => {
  const short = fresh();
  short.actions[0].rng = short.actions[0].rng.slice(0, 1);
  await assert.rejects(replay(short), /drew more random numbers than recorded \(1\)/);
  const long = fresh();
  long.actions[0].rng.push(0.5);
  await assert.rejects(replay(long), /drew 3 random number\(s\); the recording has 4/);
});

test('a recorded failure must fail again, and an unrecorded one is reported', async () => {
  const f = fresh();
  f.actions[0].error = { name: 'Error', message: 'boom' };
  await assert.rejects(replay(f), /the recording failed here \("boom"\) but the replay didn't/);
  const g = fresh();
  g.actions[0].calls[0].response.text = 'not json at all';
  g.actions[0].calls[0].kind = 'intent';
  await assert.rejects(replay(g), /call 2: engine made "intent \(retry\)", recording has "narrate"/);
});

test('a recorded network failure replays as the same failure', async () => {
  const f = fresh();
  f.actions = [{ type: 'turn', action: 'Look around.', stepId: 'hour', cutAt: null, rng: f.actions[0].rng.slice(0, 2), calls: [
    { kind: 'intent', backend: 'local', request: {}, error: { name: 'TypeError', message: 'Failed to fetch' } }],
  error: { name: 'Error', message: "Couldn't reach KoboldCpp" }}];
  const r = await replay(f);
  assert.match(r.steps[0].error.message, /Couldn't reach KoboldCpp/);
  assert.equal(r.state.turn, 0, 'the failed turn rolled back');
});

test('the recorder keeps calls and dice per action, and never keys or URLs', async () => {
  const { E, state } = newGame();
  E.settings.backends.external.key = 'sk-secret';
  E.settings.backends.external.url = 'https://private.example/v1';
  const calls = mockLLM(E, ({ kind }) => kind === 'intent'
    ? { player: { needs_roll: true, skill: 'tech' }, intents: [], events: [] } : 'Teo shrugs.');
  const transport = E.LLM.transport, rng = E.rng;
  E.Recorder.start(state);
  await E.Engine.runTurn(state, 'Fix it.', 'moment');
  E.Engine.undo(state);
  const f = E.Recorder.stop();
  assert.equal(E.LLM.transport, transport, 'stop puts the transport back');
  assert.equal(E.rng, rng);
  assert.deepEqual([...f.actions.map((a) => a.type)], ['turn', 'undo']);
  assert.deepEqual([...f.actions[0].calls.map((c) => c.kind)], ['intent', 'narrate']);
  assert.ok(f.actions[0].rng.length >= 2, 'tier roll and the tech roll');
  assert.equal(f.actions[0].calls[1].response.text, 'Teo shrugs.');
  assert.equal(f.start.turn, 0);
  assert.ok(!json(f).includes('sk-secret') && !json(f).includes('private.example'));
  assert.equal(calls.length, 2);
  // and it replays
  const r = await replay(JSON.parse(json(f)));
  assert.equal(r.state.turn, 0);
  assert.equal(r.steps[0].state.turn, 1);
});
