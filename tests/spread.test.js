// Things spread between people (task B-2): one engine rule at commit, no
// model call. People sharing a room pass on one fact a room a turn, by trust;
// never a secret, a fact about the teller, or anything to the player.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, noRoutines } = require('./helpers');

const guards = (res, type) => (res.guards || []).filter((g) => g.type === type).map((g) => g.detail);

// Priya and Okafor alone in the lab, Priya feeling `trust` toward Okafor; the player elsewhere.
function setup(trust) {
  const { E, state } = newGame();
  noRoutines(state);
  const rooms = Object.keys(state.locations);
  const lab = rooms.find((r) => r !== state.characters[state.player].status.location);
  Object.values(state.characters).forEach((c) => { if (c.id !== state.player) c.status.location = rooms.find((r) => r !== lab && r !== state.characters[state.player].status.location) || lab; });
  ['raman', 'okafor'].forEach((id) => { state.characters[id].status.location = lab; });
  state.characters.raman.relations.okafor = trust;
  return { E, state, lab };
}
const told = (E, state, text, extra = {}) => E.Memory.addFact(state, Object.assign({ about: ['sorensen'], text, known_by: ['raman'], weight: 2 }, extra));
function turns(E, state, n) {
  const all = [];
  for (let i = 0; i < n; i++) { state.turn++; const res = { guards: [] }; E.Engine.spreadFacts(state, res, state.turn); all.push(...guards(res, 'heard from')); }
  return all;
}

test('a fact told to Priya reaches Okafor after a few turns together with high trust', () => {
  const { E, state } = setup(70);
  const f = told(E, state, 'Sorensen has been sleeping in the lab every night this week.');
  const heard = turns(E, state, 12);
  assert.ok(f.known_by.includes('okafor'), 'Okafor heard it');
  assert.equal(heard.length, 1, 'once');
  assert.match(heard[0], /Dr\. Imani Okafor heard from Priya Raman: Sorensen has been sleeping/);
  assert.equal(f.heard.okafor.from, 'raman');
  assert.ok(!f.known_by.includes(state.player));
});

test("it doesn't spread with low trust, or to someone in another room", () => {
  const { E, state } = setup(5);
  const f = told(E, state, 'Sorensen has been sleeping in the lab every night this week.');
  turns(E, state, 60);
  assert.deepEqual([...f.known_by], ['raman']);
  const far = setup(90);
  far.state.characters.okafor.status.location = far.state.characters[far.state.player].status.location;
  const g = told(far.E, far.state, 'Sorensen has been sleeping in the lab every night this week.');
  turns(far.E, far.state, 60);
  assert.deepEqual([...g.known_by], ['raman']);
});

test('secrets, facts about the teller, public facts and narrated details never spread', () => {
  const { E, state } = setup(100);
  const facts = [
    told(E, state, 'Lev keeps cultures from the deep ice core in an unlogged incubator; their activity is unexplained.'),
    told(E, state, 'Priya has been feeling homesick lately.', { about: ['raman'] }),
    told(E, state, 'The dust storm is coming.', { known_by: ['all'] }),
    told(E, state, 'A cracked mug sits on the lab bench.', { source: 'narration', where: 'lab' }),
  ];
  turns(E, state, 60);
  assert.deepEqual(facts.map((f) => [...f.known_by]), [['raman'], ['raman'], ['all'], ['raman']]);
});

test("the player's known_by never grows this way, even sharing a room with trusting people", () => {
  const { E, state, lab } = setup(100);
  state.characters[state.player].status.location = lab;
  state.characters.raman.relations[state.player] = 100;
  const f = told(E, state, 'Sorensen has been sleeping in the lab every night this week.');
  turns(E, state, 60);
  assert.ok(!f.known_by.includes(state.player));
  assert.ok(f.known_by.includes('okafor'));
});

test('at most one fact a room a turn, the weightiest first', () => {
  const { E, state } = setup(100);
  const light = told(E, state, 'Sorensen skipped breakfast twice.', { weight: 1 });
  const heavy = told(E, state, 'Sorensen asked for the incubator logs to be wiped.', { weight: 3 });
  const other = told(E, state, 'Sorensen argued with mission control on the radio.', { weight: 2 });
  for (let i = 0; i < 40; i++) {
    const before = [light, heavy, other].filter((f) => f.known_by.includes('okafor')).length;
    turns(E, state, 1);
    const after = [light, heavy, other].filter((f) => f.known_by.includes('okafor')).length;
    assert.ok(after - before <= 1, 'one a turn');
    if (after === 1) assert.ok(heavy.known_by.includes('okafor'), 'the weightiest goes first');
  }
  assert.equal([light, heavy, other].filter((f) => f.known_by.includes('okafor')).length, 3, 'all in time');
});

test('spreading runs as turns are recorded, with no model call and the same on a replay', async () => {
  async function play() {
    const { E, state } = setup(70);
    told(E, state, 'Sorensen has been sleeping in the lab every night this week.');
    const calls = mockLLM(E, ({ kind }) => {
      if (kind.startsWith('intent')) return { player: { summary: 'waits', needs_roll: false }, intents: [], events: [] };
      if (kind === 'narrate (continue)') return '';
      if (kind.startsWith('narrate')) return '[+0m] You wait.\n\n[+5m] Nothing happens.';
      if (kind.startsWith('update')) return { facts: [], state: [], relations: [] };
      return { title: 'T', summary: 'S' };
    });
    for (let i = 0; i < 10; i++) await E.Engine.runTurn(state, 'Wait.', 'moment');
    return { state, calls };
  }
  const a = await play(), b = await play();
  assert.ok(a.state.facts.some((f) => f.heard && f.heard.okafor));
  assert.ok(!a.calls.some((c) => /spread|heard/i.test(c.kind)), 'no call of its own');
  assert.equal(JSON.stringify(a.state.facts), JSON.stringify(b.state.facts));
});
