// A scene that is the last one again (the owner's playtests on NemoMix 12B):
// one rewrite, a little warmer, kept only if it repeats less; and the guard
// tally counting the update step's refusals by reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, noRoutines } = require('./helpers');

const LAST = 'Teo kneels by the hydroponics racks, checking the pump seals one by one while the grow lights hum overhead and the water lines tick in the cold.';
const AGAIN = '[+0m] Teo kneels by the hydroponics racks, checking the pump seals one by one while the grow lights hum overhead and the water lines tick.';
const NEW = '[+0m] Okafor calls from the commons: the dust front is closer than the forecast said, and she wants everyone in the suit room within the hour, helmets checked.';

function play(scenes, o = {}) {
  const { E, state } = newGame();
  noRoutines(state);
  state.recent = [{ turn: 0, action: 'wait', text: LAST }];
  const calls = [];
  E.LLM.transport = async (url, body, kind) => {
    if (/narrate/.test(kind)) {
      calls.push({ kind, temperature: body.temperature, user: body.messages[body.messages.length - 1].content });
      return { text: scenes[Math.min(calls.length - 1, scenes.length - 1)], finish: 'stop' };
    }
    if (/intent/.test(kind)) return { text: JSON.stringify({ player: { summary: 'waits', needs_roll: false, move_to: null }, intents: [], events: [] }), finish: 'stop' };
    return { text: '{}', finish: 'stop' };
  };
  return E.Engine.runTurn(state, o.action || 'I wait.', 'moment').then((out) => ({ E, state, calls, out }));
}

test('a scene that repeats the last one is rewritten once, a little warmer', async () => {
  const { E, calls, out } = await play([AGAIN, NEW]);
  assert.deepEqual(calls.map((c) => c.kind), ['narrate', 'narrate (retry)']);
  assert.equal(calls[1].temperature, Math.min(1.3, E.settings.temperature + 0.2));
  assert.ok(calls[0].temperature === undefined || calls[0].temperature === E.settings.temperature);
  assert.match(calls[1].user, /repeated the last scene/);
  assert.match(out.prose, /dust front/);
  assert.ok(out.res.guards.some((g) => g.type === 'repeat regenerated'));
});

test('a rewrite that repeats as much is dropped, and there is no third call', async () => {
  const { calls, out } = await play([AGAIN, AGAIN]);
  assert.equal(calls.length, 2);
  assert.ok(out.res.guards.some((g) => g.type === 'repeat still there'));
});

test('a new scene costs no second call, and neither does a short one', async () => {
  assert.equal((await play([NEW])).calls.length, 1);
  assert.equal((await play(['[+0m] Teo kneels by the racks.'])).calls.length, 1);
});

test('the repeat share is the new scene\'s words the last scene had', () => {
  const { E, state } = newGame();
  state.recent = [{ text: LAST }];
  assert.ok(E.Engine.sceneRepeats(state, AGAIN) >= 0.8);
  assert.ok(E.Engine.sceneRepeats(state, NEW) < 0.4);
});

test('the guard tally counts the update step\'s refusals by reason, without what they named', () => {
  const { E } = newGame();
  assert.equal(E.Engine.rejectReason('{"target":"char:sora","field":"mood"} — the player\'s mood comes from the player, not the model'), 'the player\'s mood comes from the player, not the model');
  assert.equal(E.Engine.rejectReason('detail — the scene doesn\'t say that (Yumiko took a photo)'), 'the scene doesn\'t say that');
  assert.equal(E.Engine.rejectReason('no reason here'), null);
});
