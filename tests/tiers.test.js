// Cast tiers (task 2-1): local characters get the full simulation, secondary
// ones a one-line brief, so a big cast keeps the intent prompt small.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, readScenario, loadEngine } = require('./helpers');

const tierOf = (state, id) => state.characters[id].tier;

// A model that does nothing in particular; events can be scripted.
function quietModel(E, events = []) {
  return mockLLM(E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'waits' }, intents: [], events };
    if (kind.startsWith('narrate')) return 'Okafor nods at you.';
    if (kind.startsWith('update')) return { facts: [], state: [], relations: [] };
    return { title: 'T', summary: 'S' };
  });
}

// The mars-station default start, plus extra background people (copies of
// Sorensen) to make a 12-person cast.
function bigCast(extra) {
  const { E, state } = newGame();
  for (let i = 1; i <= extra; i++) {
    const c = JSON.parse(JSON.stringify(state.characters.sorensen));
    Object.assign(c, { id: `tech${i}`, name: `Tech Number${i}`, tier: 'secondary', lastSeen: 0 });
    c.want = 'to finish the long survey of the northern ice field before the season turns and the rover is needed elsewhere';
    c.secret = `Tech ${i} has been quietly falsifying the survey logs for weeks.`;
    state.characters[c.id] = c;
    state.order.push(c.id);
  }
  return { E, state };
}
const intentUser = (E, state) => E.Prompts.intent(state, E.Engine.present(state), 'Look around.', 'about an hour', 'hour', {});

// ---------- defaults and authoring ----------

test('by default the people in the starting room are local and everyone else is secondary', () => {
  const { state } = newGame();
  assert.equal(tierOf(state, 'navarro'), 'local', 'the player');
  assert.equal(tierOf(state, 'okafor'), 'local');
  assert.equal(tierOf(state, 'bauer'), 'local');
  assert.equal(tierOf(state, 'sorensen'), 'secondary');
  assert.equal(tierOf(state, 'raman'), 'secondary');
});

test('a start can set tier and pinned per cast entry', () => {
  const garage = newGame('mars-station', 'garage').state;
  assert.equal(garage.characters.navarro.pinned, true);
  assert.equal(tierOf(garage, 'navarro'), 'local', 'pinned keeps someone local even away from the player');
  assert.equal(tierOf(garage, 'okafor'), 'secondary');
  const herd = newGame('zombie-holdout').state;
  assert.equal(tierOf(herd, 'ortiz'), 'local', 'authored tier wins over the room rule');
});

test('validation rejects a bad tier, pinned or tiers setting', () => {
  const E = loadEngine();
  const sc = readScenario('mars-station');
  sc.characterData[1].tier = 'core';
  sc.characterData[2].pinned = 'yes';
  sc.tiers = { demoteAfter: 0, often: 2 };
  assert.throws(() => E.Scenario.validate(sc), (err) =>
    /tier must be local or secondary/.test(err.message) && /pinned must be true or false/.test(err.message) &&
    /tiers.demoteAfter/.test(err.message) && /tiers.often/.test(err.message));
});

// ---------- promotion ----------

test('promotion: someone named in the player action comes forward before the intent call', async () => {
  const { E, state } = newGame();
  const calls = quietModel(E);
  await E.Engine.runTurn(state, 'Call Priya on the radio.', 'moment');
  assert.equal(tierOf(state, 'raman'), 'local');
  assert.equal(state.characters.raman.lastSeen, 1);
  const intent = calls.find((c) => c.kind === 'intent');
  assert.match(intent.user, /=== OFFSTAGE[^]*raman \(Priya Raman\)/, 'gets the full brief the same turn');
  assert.ok(!/BACKGROUND[^]*raman/.test(intent.user));
  assert.ok(state.pending.res.guards.some((g) => g.type === 'cast tier' && /Priya Raman → local \(named in your action\)/.test(g.detail)));
});

test('promotion: someone who enters the scene comes forward when the turn is committed', async () => {
  const { E, state } = newGame();
  quietModel(E);
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  state.characters.raman.status.location = 'commons'; // arrived during the scene
  await E.Engine.runTurn(state, 'Wait.', 'moment');
  assert.equal(tierOf(state, 'raman'), 'local');
  const t = E.Engine.telemetry[E.Engine.telemetry.length - 1];
  assert.ok([...t.guards].some((g) => g.type === 'cast tier' && g.turn === 1 && /Priya Raman → local \(in the scene\)/.test(g.detail)));
});

test('promotion: the subject of a seen or heard event comes forward, a hidden one does not', () => {
  const { E, state } = newGame();
  const out = E.Engine.updateTiers(state, 1, { here: E.Engine.present(state), events: ['raman'] });
  assert.equal(tierOf(state, 'raman'), 'local');
  assert.match([...out].join(), /Priya Raman → local \(in an event you saw or heard\)/);
  assert.equal(tierOf(state, 'sorensen'), 'secondary');
});

test('events in a full turn: heard ones promote, hidden ones do not, and none after a step-in', async () => {
  const run = async (visibility, cutAt) => {
    const { E, state } = newGame();
    mockLLM(E, ({ kind }) => {
      if (kind.startsWith('intent')) return { player: { summary: 'waits' }, intents: [], events: [{ text: 'Priya radios about the rover.', who: ['raman'], where: 'garage', visibility, moves: [] }] };
      if (kind.startsWith('narrate')) return '[+0m] Okafor nods.\n\n[+30m] The radio crackles.';
      if (kind.startsWith('update')) return { facts: [], state: [], relations: [] };
      return { title: 'T', summary: 'S' };
    });
    await E.Engine.runTurn(state, 'Wait.', 'hour');
    await E.Engine.runTurn(state, 'Wait.', 'moment', null, cutAt);
    return tierOf(state, 'raman');
  };
  assert.equal(await run('heard'), 'local');
  assert.equal(await run('hidden'), 'secondary');
  assert.equal(await run('heard', 1), 'secondary', 'the player stepped in before it reached them');
});

// ---------- demotion and pinning ----------

test('demotion: a local character not seen for 4 turns goes to the background', () => {
  const { E, state } = newGame();
  state.characters.okafor.status.location = 'ops';
  const here = () => E.Engine.present(state);
  for (let t = 1; t <= 3; t++) E.Engine.updateTiers(state, t, { here: here() });
  assert.equal(tierOf(state, 'okafor'), 'local', '3 turns away');
  const out = E.Engine.updateTiers(state, 4, { here: here() });
  assert.equal(tierOf(state, 'okafor'), 'secondary');
  assert.match([...out].join(), /Dr. Imani Okafor → secondary \(not seen for 4 turns\)/);
  assert.equal(tierOf(state, 'bauer'), 'local', 'still in the scene');
});

test('demoteAfter comes from the world', () => {
  const { E, state } = newGame('zombie-holdout');
  state.characters.ortiz.lastSeen = 0;
  E.Engine.updateTiers(state, 3, { here: [] });
  assert.equal(tierOf(state, 'ortiz'), 'secondary', 'zombie-holdout demotes after 3');
});

test('pinned characters are never demoted', () => {
  const { E, state } = newGame('mars-station', 'garage');
  E.Engine.updateTiers(state, 50, { here: E.Engine.present(state) });
  assert.equal(tierOf(state, 'navarro'), 'local');
});

test('maxLocal sends the longest-unseen offstage locals to the background', () => {
  const { E, state } = bigCast(7);
  state.scenario.tiers = { maxLocal: 2 };
  ['sorensen', 'raman', 'tech1', 'tech2'].forEach((id, i) => Object.assign(state.characters[id], { tier: 'local', lastSeen: i + 2 }));
  const out = E.Engine.updateTiers(state, 5, { here: E.Engine.present(state) });
  assert.deepEqual(['sorensen', 'raman', 'tech1', 'tech2'].map((id) => tierOf(state, id)), ['secondary', 'secondary', 'local', 'local']);
  assert.equal([...out].filter((l) => /more than 2 people/.test(l)).length, 2);
  assert.equal(tierOf(state, 'okafor'), 'local', 'people with the player never count');
});

// ---------- prompts ----------

test('the header is unchanged when tiers change (cache rule)', () => {
  const { E, state } = newGame();
  const before = E.Prompts.header(state);
  state.characters.okafor.tier = 'secondary';
  state.characters.raman.tier = 'local';
  assert.equal(E.Prompts.header(state), before);
});

test('secondary characters get one line in the intent call, without secrets', () => {
  const { E, state } = newGame();
  const user = intentUser(E, state);
  assert.match(user, /=== BACKGROUND[^\n]*\n- sorensen \(Dr. Lev Sorensen, [^)]+\), in [^;]+; wants: /);
  assert.ok(!user.includes(state.characters.sorensen.secret));
  assert.ok(!/=== OFFSTAGE/.test(user), 'no offstage locals at the start');
});

test('the intent prompt stays flat with a 12-person cast', () => {
  const small = bigCast(0);
  const big = bigCast(7);
  assert.equal(big.state.order.length, 12);
  const a = intentUser(small.E, small.state).length;
  const b = intentUser(big.E, big.state).length;
  assert.ok(b - a <= 7 * 240, `7 background people add ${b - a} characters`);
  // Richer background sheets don't grow it (their want is already past the 60-character cut).
  Object.values(big.state.characters).filter((c) => c.id.startsWith('tech')).forEach((c) => {
    c.want += ' and then much more besides';
    c.secret += ' Nobody knows.';
    c.traits = (c.traits || []).concat(['meticulous', 'secretive', 'tired']);
  });
  assert.equal(intentUser(big.E, big.state).length, b);
  assert.ok(!intentUser(big.E, big.state).includes('falsifying'));
});

// ---------- needs and saves ----------

test('secondary needs settle like routine while local ones keep climbing', () => {
  const { E, state } = newGame();
  state.characters.raman.needs.hunger = 0.3;
  state.characters.okafor.needs.hunger = 0.3;
  E.Engine.advanceTime(state, 24, { events: [] });
  assert.ok(state.characters.raman.needs.hunger < 0.4, 'background: near normal');
  assert.ok(state.characters.okafor.needs.hunger > 0.6, 'foreground: hungry');
});

test('save migration v3→v4 gives everyone a tier, in the pending step-in copy too', () => {
  const { E, state } = newGame();
  const v3 = JSON.parse(JSON.stringify(state));
  v3.version = 3;
  v3.turn = 7;
  for (const c of Object.values(v3.characters)) { delete c.tier; delete c.lastSeen; }
  v3.pending = { pre: { player: v3.player, characters: JSON.parse(JSON.stringify(v3.characters)) } };
  const v4 = E.Engine.migrate(v3);
  assert.equal(v4.version, E.Engine.STATE_VERSION);
  assert.equal(v4.characters.okafor.tier, 'local');
  assert.equal(v4.characters.raman.tier, 'secondary');
  assert.equal(v4.characters.raman.lastSeen, 7);
  assert.equal(v4.pending.pre.characters.raman.tier, 'secondary');
});
