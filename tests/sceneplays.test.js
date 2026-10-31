// The scene plays the action (task L-4): a one-beat scene that leaves out the
// player's action or someone speaking is rewritten once, the soft stop waits for
// them, and nothing else costs a second narrate call.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame } = require('./helpers');

// The first turn of the Seiryo start, smiling for Mom's camera, with these outcomes.
function firstDay() {
  const g = newGame('seiryo-high', 'hayakawa');
  const res = { outcomes: [
    { id: g.state.player, action: 'Sora Hayakawa smiles for the camera', visible: true, moved: null },
    { id: 'yumiko', action: 'takes a photo', says: 'Let me get a good one for your first day.', visible: true, moved: null },
  ] };
  return { ...g, res, action: 'I smile for the camera.' };
}
// From the recorded rerolls of that turn on NemoMix.
const miss = "You look at the camera, at Mom, at Dad, and at Aoi's voice through the door. Aoi's always been louder than you.";
const hit = 'You smile for the camera, your stomach churning. Mom takes the photo. "Perfect!"';

test('a scene that only looks at the camera has not played "I smile for the camera"; one that smiles has', () => {
  const { E, state, res, action } = firstDay();
  assert.match(E.Engine.sceneMissing(state, miss, res, action).join(), /your action/);
  assert.deepEqual([...E.Engine.sceneMissing(state, hit, res, action)], []);
});

test('the scene check leaves alone what the narrator may phrase its own way', () => {
  const { E, state, res } = firstDay();
  const check = (action, prose) => [...E.Engine.sceneMissing(state, prose, res, action)];
  assert.deepEqual(check('"Thanks, Mom," I say.', `${hit} Mom beams.`), [], 'a spoken line');
  assert.deepEqual(check('Check on Kenji.', 'You lean over and Kenji shrugs. Mom takes a photo.'), [], 'someone named and there');
  assert.deepEqual(check('Wait.', 'Mom takes a photo.'), [], 'a plain verb');
  const moved = { outcomes: [{ id: state.player, action: 'walks to the gate', moved: 'street-south' }] };
  assert.deepEqual([...E.Engine.sceneMissing(state, 'You step outside.', moved, 'I head for the gate.')], [], 'a move');
});

test('someone who speaks must be in the scene, as Mom or by name; a covert act need not', () => {
  const { E, state, res, action } = firstDay();
  assert.deepEqual([...E.Engine.sceneMissing(state, 'You smile for the camera. Mom nods.', res, action)], [], 'Mom is the mother');
  const quiet = 'You smile for the camera. The room is quiet.';
  assert.match(E.Engine.sceneMissing(state, quiet, res, action).join(), /Yumiko/);
  res.outcomes[1].visible = false;
  assert.deepEqual([...E.Engine.sceneMissing(state, quiet, res, action)], []);
});

test('a second beat is not cut while the outcomes are still to come, and is once they have played', () => {
  const { E, state, res, action } = firstDay();
  const t = { words: [40, 90], beats: [1, 1], span: 1, names: [], unplayed: (x) => E.Engine.sceneMissing(state, x, res, action) };
  const first = `[+0m] ${miss}`;
  assert.equal(E.Engine.softStop(`${first}\n\n[+1m] You smile`, t), null, 'the smile is still to come');
  assert.match(E.Engine.softStop(`[+0m] ${hit}\n\n[+1m] Dad`, t).why, /1 beat/);
  assert.ok(E.Engine.softStop(`${first}\n\n[+2m] Later`, t), 'a marker past the span still ends it');
  const long = Array.from({ length: 100 }, () => 'word').join(' ');
  assert.ok(E.Engine.softStop(`[+0m] ${long}.\n\n[+1m] More`, t), 'so do the words');
});

// A turn at one minute with these scenes for the narrate calls.
async function playScenes(scenes, intents = []) {
  const g = firstDay();
  const { E, state, action } = g;
  const calls = [];
  E.LLM.transport = async (url, body, kind) => {
    if (/narrate/.test(kind)) {
      calls.push({ kind, user: body.messages[body.messages.length - 1].content });
      return { text: scenes[Math.min(calls.length - 1, scenes.length - 1)], finish: 'stop' };
    }
    if (/intent/.test(kind)) return { text: JSON.stringify({ player: { summary: 'smiles for the camera', needs_roll: false, skill: null, difficulty: 'normal', move_to: null }, intents }), finish: 'stop' };
    return { text: '{}', finish: 'stop' };
  };
  const out = await E.Engine.runTurn(state, action, 'minute');
  return { ...g, calls, out };
}

test('a scene that leaves out the action is rewritten once and told what it left out', async () => {
  const { calls, out } = await playScenes([`[+0m] ${miss}`, `[+0m] ${hit}`]);
  assert.deepEqual(calls.map((c) => c.kind), ['narrate', 'narrate (retry)']);
  assert.match(calls[1].user, /CORRECTION: Your previous draft left this out: your action: I smile for the camera\./);
  assert.match(JSON.stringify(out), /smile for the camera, your stomach/);
  assert.match(JSON.stringify(out), /outcome regenerated/);
});

test('a rewrite no better than the first draft is dropped, and there is no third call', async () => {
  const { calls, out } = await playScenes([`[+0m] ${miss}`, '[+0m] You study the wall. Mom hums.']);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(out), /Aoi's always been louder/);
  assert.match(JSON.stringify(out), /outcome still missing/);
});

test('a scene that played the action costs no second call, and a longer step is not checked', async () => {
  assert.equal((await playScenes([`[+0m] ${hit}`])).calls.length, 1);
  const { E } = firstDay();
  assert.equal(E.Engine.oneBeat('minute'), true);
  assert.equal(E.Engine.oneBeat('moment'), true);
  assert.equal(E.Engine.oneBeat('hour'), false);
});

test('a one-beat scene is told to use its one marker; a longer one keeps its limit', () => {
  const { E, state } = firstDay();
  const frame = (stepId, spanMinutes) => ({ startLoc: state.characters[state.player].status.location, startTime: '', stepId, stepLabel: stepId, spanMinutes });
  const res = { outcomes: [], events: [] };
  const one = E.Prompts.narrate(state, [], 'x', frame('minute', 1), res);
  assert.match(one, /Use that one marker only\./);
  assert.ok(!one.includes('The last marker is at most'));
  assert.match(E.Prompts.narrate(state, [], 'x', frame('hour', 60), res), /The last marker is at most \[\+60m\]/);
});

test('a person whose whole action is "says" reaches the narrator as speaking up', async () => {
  const { calls } = await playScenes([`[+0m] ${hit} Dad laughs.`], [{ id: 'kenji', action: 'says', says: 'Say ramen!', visible: true }]);
  assert.match(calls[0].user, /Kenji Hayakawa: speaks up/);
});
