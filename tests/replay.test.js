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
  assert.deepEqual([...fact.known_by], ['coleman', 'han', 'pike'], 'Jordan was there: a fact about them is theirs too');
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

// NemoMix 12B, the task 3-2 check (2026-10-22): sneaking past the stragglers in the lot from the dock.
test('playtest: sneaking past the stragglers next door engages them, seconds markers leave the prose, and examples are not news', async () => {
  const r = await replay('playtest-stragglers-sneak');
  const [, t2, t3] = r.steps.map((s) => s.state);
  assert.deepEqual([...t2.pending.res.engaged], ['stragglers'], '"sneak past the stragglers" names the group in the lot');
  assert.doesNotMatch(t2.recent[0].text, /\[\+/, '[+30s] and [+1m 15s] are beat markers, not prose');
  assert.equal(t3.world.barricades, 'holding, front windows weak', 'the update copied "degraded, about 70% output" from its prompt');
  assert.ok(r.E.Engine.telemetry[1].guards.some((g) => g.type === 'update rejected' && /copied the prompt's example/.test(g.detail)));
  const sneak = t3.pending.res;
  assert.ok(sneak.guards.some((g) => g.type === 'roll required'), '"I sneak around the side of the truck" with the dead next door');
  assert.deepEqual([sneak.outcomes[0].skill, sneak.outcomes[0].roll.dc], ['stealth', 14]);
  assert.equal(t3.standees.stragglers.state, 'alert');
  const sneakFact = t3.facts.find((f) => /sneak past the stragglers/.test(f.text));
  assert.ok(sneakFact.known_by.includes('pike'), 'the update gave it only to Dex and Ruth; Jordan knows what they did');
});

// NemoMix 12B, the task 3-6 check (2026-10-22): into Gil's office, then out "the stockroom's back window".
test('playtest: a window the player names in another room on the way is added, and the move goes through it', async () => {
  const r = await replay('playtest-office-window');
  const s = r.steps[0].state;
  assert.equal(s.characters.pike.status.location, 'lot');
  assert.deepEqual([...s.pending.res.outcomes[0].via], ['floor', 'stockroom']);
  assert.equal(s.locations.stockroom.links.find((k) => k.to === 'lot').kind, 'window');
  assert.ok(s.pending.res.guards.some((g) => g.type === 'feature added' && /from the player's words/.test(g.detail)), 'the model left new_feature out');
  const narrate = r.E.LLM.calls.filter((c) => c.kind === 'narrate').pop();
  assert.match(narrate.user, /\[moves to Parking Lot, through Sales Floor, Stockroom\]/);
});

test('playtest: the scene that walked Jordan back out of the office is a relocation, and its closing line of theirs is trimmed', () => {
  const { E, state } = newGame('zombie-holdout');
  const prose = require('./fixtures/playtest-office-window.json').start.recent[0].text;
  state.characters.pike.status.location = 'office';
  state.links['floor|office'].locked = false;
  assert.equal(E.Engine.findRelocation(state, prose, 'floor').to, "back out of Manager's Office", '"You slip out of the office, leaving it unlocked"');
  assert.doesNotMatch(E.Engine.trimPlayerEnding(prose), /Just looking for supplies," you say/);
});

// DeepSeek v4.1 flash, 2026-10-22 (playtest-coffee-skips): a friend answered every
// scene with "Keep drinking coffee" and the until-something-major step.
test('playtest: facts and chapter summaries are cut at a sentence or word, never mid-word', async () => {
  const r = await replay('playtest-coffee-skips');
  const s = r.state;
  const scrubber = s.facts.find((f) => /scrubber bed has been run well past its swap interval/.test(f.text));
  assert.ok(scrubber, 'the major event is still a fact');
  assert.match(scrubber.text, /straight off the board\.$/, 'was "...The only spare cartridge is"');
  assert.ok(!s.facts.some((f) => /intercom twice, sa$/.test(f.text)), 'was "...keys the intercom twice, sa"');
  s.chapters.forEach((c) => assert.match(c.summary, /[.!?…"”]$/, `chapter ${c.title}: ${c.summary.slice(-40)}`));
});

test('playtest: compound beat markers ([+0h06], [+1d 20h]) are read, not left in the scene', async () => {
  const r = await replay('playtest-coffee-skips');
  const left = r.state.log.filter((l) => l.type === 'scene').flatMap((l) => l.text.match(/\[\s*\+[^\]]*\]/g) || []);
  assert.deepEqual(left, []);
  assert.deepEqual([...r.E.Engine.parseBeats('[+0h06] A.\n\n[+0h22] B.\n\n[+1d 20h] C.', 3000).map((b) => b.at)], [0, 22, 2640]);
});

test('playtest: a region tag that is too long is refused, not cut mid-word', async () => {
  const r = await replay('playtest-coffee-skips');
  const tags = [...r.state.regions.station.tags];
  assert.ok(!tags.includes('commons losing pressure at the'), tags.join(' | '));
  assert.ok(tags.every((t) => t.length <= 30));
  const report = r.E.Engine.telemetry.find((t) => (t.guards || []).some((g) => /tag too long for station/.test(g.detail)));
  assert.ok(report, 'the refusal shows in the turn report');
});

test('playtest: a one-hour skip is described in hours, not "about 0 days" of "a long stretch"', async () => {
  const r = await replay('playtest-coffee-skips', { until: 5 });
  const intents = r.E.LLM.calls.filter((c) => c.kind === 'intent');
  const short = intents.find((c) => /Sol 215, 18:51 → Sol 215, 19:51/.test(c.user));
  assert.match(short.user, /\(about 1 hour\)/);
  assert.doesNotMatch(short.user, /long stretch/);
  const narrate = r.E.LLM.calls.filter((c) => c.kind === 'narrate').pop();
  assert.doesNotMatch(narrate.user, /about 0 days/);
});

test('playtest: a pressure that went off is listed the turn it happens, then leaves the prompts and the update ids', async () => {
  const r = await replay('playtest-coffee-skips', { until: 3 });
  const byTurn = (kind) => r.E.LLM.calls.filter((c) => c.kind === kind);
  const [, n2, n3] = byTurn('narrate');
  assert.match(n2.user, /Dust storm arrival \(HAPPENED\)/, 'the turn the storm arrives');
  assert.doesNotMatch(n3.user, /Dust storm arrival/, 'a turn later it is a fact, not a pressure');
  const u3 = byTurn('update').pop();
  assert.doesNotMatch(u3.user, /clocks: [^\n]*\bstorm\b(?!-)/, 'the update step was offered a clock that can no longer move');
  const s = r.state;
  assert.deepEqual(s.clocks.filter((c) => c.fired).map((c) => [c.id, c.firedTurn]), [['storm', 2]]);
  assert.deepEqual([...r.E.Engine.liveClocks(s).map((c) => c.id)].sort(), ['battery', 'recycler', 'storm-clear']);
});

test('playtest: every ignored emergency costs the crew\'s trust, the montage keeps Kit to the coffee, and worn phrases reach the narrator', async () => {
  const r = await replay('playtest-coffee-skips');
  const s = r.state;
  const t3 = r.E.Engine.telemetry.find((t) => t.turn === 3);
  assert.match(t3.guards.find((g) => g.type === 'crisis ignored').detail, /^The dust storm arrives[^]*played out without Kit Navarro[^]*trust toward Kit Navarro −6/);
  ['okafor', 'sorensen', 'raman', 'bauer'].forEach((id) => assert.ok(s.characters[id].relations.navarro < 0, `${id} was ${s.characters[id].relations.navarro}; 15/15 after nine ignored emergencies`));
  const t10 = r.E.Engine.telemetry.find((t) => t.turn === 10);
  assert.ok(t10.guards.some((g) => g.type === 'montage dropped' && /half-interval cartridge seated/.test(g.detail)));
  assert.ok(r.E.LLM.calls.some((c) => c.kind === 'intent' && /a turning point that grows out of the people/.test(c.user)));
  const last = r.E.LLM.calls.filter((c) => c.kind === 'narrate').pop();
  assert.match(last.user, /=== WORN PHRASES[^\n]*===\n- "teo refills the pot without being asked"/);
});
