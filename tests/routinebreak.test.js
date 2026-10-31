// Breaking routine is a clue (task B-1): someone missing from where they
// usually are, or somewhere they usually aren't, is noticed in one plain line
// and a small fact, never with the reason. Fixture: fixtures/routine-town/.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newGame, mockLLM } = require('./helpers');

const TOWN = path.join(__dirname, 'fixtures', 'routine-town');
const MONDAY = 5;
const SCENE = '[+5m] Sora looks around.\n\n[+50m] The day wears on, and Sora waits by the wall.';
// In class at ten, everyone seen and in place.
const game = () => {
  const g = newGame(TOWN);
  const { state, E } = g;
  state.time = { day: MONDAY, hour: 8 };
  state.characters.sora.status.location = 'canteen';
  E.Engine.knowAll(state, 0);
  E.Engine.advanceTime(state, 2, { events: [] });
  state.characters.sora.status.location = 'classroom';
  return Object.assign(g, { Eng: E.Engine });
};
const play = async (g, o = {}) => {
  const calls = mockLLM(g.E, ({ kind }) => {
    if (kind.startsWith('intent')) return Object.assign({ player: { summary: 'waits', needs_roll: false, move_to: null }, intents: [], events: [] }, o.intent);
    return kind.startsWith('update') ? { facts: [] } : o.scene || SCENE;
  });
  const out = await g.Eng.runTurn(g.state, o.action || 'I wait at my desk.', o.step || 'moment');
  return { out, calls, user: (calls.find((c) => c.kind === 'narrate') || {}).user };
};
const facts = (g, id) => g.state.facts.filter((f) => (f.about || []).includes(id));

test('someone missing from where they usually are is noticed, with a line and a small fact', async () => {
  const g = game();
  g.Eng.setLocation(g.state, 'aoi', 'plaza');
  const { user, out } = await play(g);
  assert.match(user, /notices: Aoi Mori isn't here, though they usually are at this hour\./);
  assert.equal(out.res.noticed.kind, 'absence');
  await play(g);
  const f = facts(g, 'aoi').find((x) => /wasn't in Classroom/.test(x.text));
  assert.ok(f, 'the fact goes in at commit');
  assert.equal(f.weight, 1);
  assert.deepEqual([...f.known_by], ['sora']);
  assert.equal(f.where, 'classroom');
});

test('a covert agenda step gives a noticed absence, and the reason never reaches the narrator', async () => {
  const g = game();
  const aoi = g.state.characters.aoi;
  aoi.secret = 'meets a stranger behind the shop';
  aoi.agenda = { goal: 'meet the stranger', steps: [{ text: 'slips out to the plaza to meet the stranger' }], step: 0, visibility: 'hidden', hours: 0.01, progress: 1, due: true };
  g.Eng.storyMove(g.state, 'aoi', 'plaza');
  const { user, calls } = await play(g);
  assert.match(user, /Aoi Mori isn't here/);
  assert.doesNotMatch(user, /stranger|Plaza\.? (?:to|because)/);
  calls.filter((c) => c.kind === 'narrate').forEach((c) => assert.doesNotMatch(c.user + c.system, /behind the shop/));
});

test('someone somewhere they usually aren\'t is noticed when they come in', async () => {
  const g = game();
  g.state.time.hour = 3;
  g.state.time.day = MONDAY + 1;
  g.state.characters.sora.status.location = 'plaza';
  g.state.characters.gil.routineState = null;
  g.Eng.setLocation(g.state, 'gil', 'plaza');
  // Gil's routine has them here at three, so it's Ken who shouldn't be: off the map.
  const ken = g.state.characters.ken;
  ken.routineState = { slot: g.Eng.routineSlot(g.state, 'ken', g.state.time).key, left: 'yard' };
  g.Eng.setLocation(g.state, 'ken', 'yard');
  const present = [...g.Eng.present(g.state)];
  g.Eng.setLocation(g.state, 'ken', 'plaza');
  const n = g.Eng.routineBreak(g.state, { outcomes: [] }, present);
  assert.equal(n.kind, 'presence');
  assert.match(n.line, /Ken Oda is here, which isn't usual/);
});

test('where the story began someone is no clue', async () => {
  const g = newGame(TOWN);
  g.state.time = { day: MONDAY, hour: 10 };
  g.state.characters.sora.status.location = 'classroom';
  g.E.Engine.knowAll(g.state, 0);
  g.E.Engine.advanceTime(g.state, 0.1, { events: [] });
  assert.equal(g.E.Engine.routineBreak(g.state, { outcomes: [] }, []), null, 'Aoi began in their room, and no slot has passed');
});

test('someone already in the scene isn\'t news', async () => {
  const g = game();
  g.Eng.setLocation(g.state, 'ken', 'canteen');
  g.state.characters.sora.status.location = 'canteen';
  assert.equal(g.Eng.routineBreak(g.state, { outcomes: [] }, ['ken']), null);
});

test('a routine move, a place in the slot, or a day still catching up isn\'t noticed', async () => {
  const g = game();
  assert.equal((await play(g)).out.res.noticed, null, 'everyone where they should be');
  // Lunch lists two places: being in either is fine, at either.
  const h = game();
  h.state.time.hour = 12;
  ['aoi', 'ken', 'rin'].forEach((id) => { h.state.characters[id].routineState = { slot: h.Eng.routineSlot(h.state, id, h.state.time).key, left: 'yard' }; h.Eng.setLocation(h.state, id, 'yard'); });
  h.state.characters.sora.status.location = 'canteen';
  assert.equal(h.Eng.routineBreak(h.state, { outcomes: [] }, []), null);
  // Held at the bell, or on their way: no clue in that.
  const i = game();
  i.Eng.setLocation(i.state, 'aoi', 'yard');
  i.state.characters.aoi.routineState.slot = 'an older slot';
  assert.equal(i.Eng.routineBreak(i.state, { outcomes: [] }, []), null);
  assert.equal(i.Eng.routineBreak(i.state, { outcomes: [], routineMoves: [{ id: 'aoi', to: 'yard', at: 3 }] }, []), null);
});

test('someone hurt, away from their slot or dead unknown to the player is noticed; a death they know isn\'t', async () => {
  const g = game();
  g.state.characters.aoi.status.health = 'badly_hurt';
  g.state.characters.aoi.routineState.slot = 'an older slot';
  g.Eng.setLocation(g.state, 'aoi', 'nurse-room' in g.state.locations ? 'nurse-room' : 'plaza');
  assert.equal(g.Eng.routineBreak(g.state, { outcomes: [] }, []).id, 'aoi');
  const d = game();
  d.Eng.setLocation(d.state, 'aoi', 'plaza');
  d.state.characters.aoi.status.health = 'dead';
  d.E.Memory.addFact(d.state, { about: ['aoi'], text: 'Aoi Mori died in the fire.', known_by: ['sora'], weight: 3 });
  assert.equal(d.Eng.routineBreak(d.state, { outcomes: [] }, []), null);
});

test('never someone the player hasn\'t seen, or a private slot', () => {
  const g = game();
  g.Eng.setLocation(g.state, 'aoi', 'plaza');
  delete g.state.known.aoi;
  assert.equal(g.Eng.routineBreak(g.state, { outcomes: [] }, []), null);
  const h = game();
  h.state.characters.aoi.slots = { school: [{ from: 9, to: 12, at: ['classroom'], private: true }] };
  h.Eng.setLocation(h.state, 'aoi', 'plaza');
  assert.equal(h.Eng.routineBreak(h.state, { outcomes: [] }, []), null);
});

test('one a scene, people with an agenda or a secret first', () => {
  const g = game();
  ['aoi', 'ken', 'rin'].forEach((id) => g.Eng.setLocation(g.state, id, 'plaza'));
  delete g.state.characters.aoi.secret;
  delete g.state.characters.ken.secret;
  g.state.characters.rin.secret = 'hides the workshop key';
  assert.equal(g.Eng.routineBreak(g.state, { outcomes: [] }, []).id, 'rin');
  assert.equal(g.Eng.routineBreak(g.state, { outcomes: [] }, []), null, 'the gap between lines');
  const h = game();
  ['aoi', 'rin'].forEach((id) => h.Eng.setLocation(h.state, id, 'plaza'));
  h.state.characters.rin.secret = 'x';
  h.state.characters.aoi.agenda = { goal: 'g', steps: [{ text: 's' }], step: 0 };
  assert.equal(h.Eng.routineBreak(h.state, { outcomes: [] }, []).id, 'aoi');
});

test('three turns apart, and once a person a slot', () => {
  const g = game();
  g.Eng.setLocation(g.state, 'aoi', 'plaza');
  assert.ok(g.Eng.routineBreak(g.state, { outcomes: [] }, []));
  g.state.turn += g.Eng.NOTICE_GAP - 1;
  assert.equal(g.Eng.routineBreak(g.state, { outcomes: [] }, []), null);
  g.state.turn += 1;
  assert.equal(g.Eng.routineBreak(g.state, { outcomes: [] }, []), null, 'the same slot');
  g.state.time.hour = 13;
  g.state.characters.aoi.routineState.slot = g.Eng.routineSlot(g.state, 'aoi', g.state.time).key;
  assert.ok(g.Eng.routineBreak(g.state, { outcomes: [] }, []), 'the next time they should be here');
});

test('stepping in before the end drops the fact', async () => {
  const g = game();
  g.Eng.setLocation(g.state, 'aoi', 'plaza');
  await play(g, { step: 'hour' });
  await g.Eng.commitPending(g.state, 1, () => {});
  assert.ok(!facts(g, 'aoi').some((x) => /wasn't in/.test(x.text)));
});

test('a world without routines is unchanged', async () => {
  const g = newGame('zombie-holdout');
  assert.equal(g.E.Engine.routineBreak(g.state, { outcomes: [] }, []), null);
  assert.equal(g.state.routineNoticed, undefined);
});
