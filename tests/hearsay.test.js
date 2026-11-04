// Rumours (task B-3): a fact with source "hearsay" is what people are saying,
// worded "People say…" or "Teo says…". Like a narrated detail it is never
// true for the engine: no precondition, ending or reveal reads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame } = require('./helpers');

const PRESENT = ['okafor', 'bauer'];

test('hearsay always reads as said: the engine adds "People say" when it is missing', () => {
  const { E, state } = newGame();
  const add = (text) => E.Memory.addFact(state, { text, known_by: ['all'], source: 'hearsay' }).text;
  assert.equal(add('Teo broke the recycler.'), 'People say Teo broke the recycler.');
  assert.equal(add('The storm will cut the power.'), 'People say the storm will cut the power.');
  assert.equal(add('Word is the sponsor wants out.'), 'Word is the sponsor wants out.');
  assert.equal(add('Okafor says the ice is pure.'), 'Okafor says the ice is pure.');
  // Other sources are left as written.
  assert.equal(E.Memory.addFact(state, { text: 'The storm cut the power.', known_by: ['all'], source: 'intent' }).text, 'The storm cut the power.');
});

test('the update step records what is said as hearsay, and what happened as before', () => {
  const { E, state } = newGame();
  const here = state.characters[state.player].status.location;
  E.Engine.applyUpdate(state, { facts: [
    { about: [], text: 'People say the sponsor will sell the base to a mining firm.', known_by: ['all'] },
    { about: ['bauer'], text: 'says the pump sensor is faulty', known_by: ['all'] },
    { about: ['okafor'], text: 'Okafor checked the pump readout.', known_by: ['all'] },
  ] }, PRESENT, { startLoc: here, endLoc: here, prose: 'Teo talks. Okafor checks the readout.' });
  const src = (re) => state.facts.find((f) => re.test(f.text)).source;
  assert.equal(src(/mining firm/), 'hearsay');
  assert.equal(src(/Teo Bauer says the pump sensor/), 'hearsay');
  assert.equal(src(/checked the pump readout/), 'intent');
});

test('a hearsay fact never satisfies a timeline precondition or an ending', () => {
  const { E, state } = newGame();
  const cond = { known: { words: ['beacon', 'smugglers'] } };
  state.scenario.endings = [{ id: 'cut-off', title: 'Cut off', if: [cond] }];
  E.Memory.addFact(state, { text: 'People say smugglers lit the old beacon.', known_by: ['all'], source: 'hearsay' });
  assert.equal(E.Timeline.holds(state, cond), false);
  assert.equal(E.Engine.checkEndings(state, { guards: [] }), null);
  E.Memory.addFact(state, { text: 'Smugglers lit the old beacon.', known_by: ['all'], source: 'intent' });
  assert.equal(E.Timeline.holds(state, cond), true, 'a recorded fact still counts');
  assert.ok(E.Engine.checkEndings(state, { guards: [] }), 'and ends the story');
});

test('a hearsay fact never makes a reveal: words it shares are not the secret', () => {
  const { E, state } = newGame();
  // Teo has heard something; repeating it is not giving away what he hides.
  E.Memory.addFact(state, { about: ['raman'], text: 'People say Priya meets someone in the airlock every morning.', known_by: ['bauer'], source: 'hearsay' });
  const res = E.Engine.resolve(state, { player: {}, intents: [{ id: 'bauer', action: 'mutters about Priya', says: 'She meets someone in the airlock every morning.', reveals: 'Priya meets someone in the airlock every morning' }] }, PRESENT, 'Ask Teo what is going on.', 'hour');
  const teo = res.outcomes.find((o) => o.id === 'bauer');
  assert.equal(teo.reveals, null);
  assert.ok(res.guards.some((g) => g.type === 'reveal dropped'));
});

test('it reads as said in every prompt that carries it', () => {
  const { E, state } = newGame();
  E.Memory.addFact(state, { about: ['bauer'], text: 'Teo wiped the night log.', known_by: ['all'], weight: 3, source: 'hearsay' });
  const here = state.characters[state.player].status.location;
  const prompts = [
    E.Prompts.intent(state, PRESENT, 'Ask Teo about the log.'),
    E.Prompts.narrate(state, PRESENT, 'Ask Teo about the log.', { startLoc: here, startTime: 'Sol 214, 07:15', stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 }, { outcomes: [], events: [] }),
  ];
  prompts.forEach((p) => {
    const text = typeof p === 'string' ? p : JSON.stringify(p);
    assert.match(text, /People say Teo wiped the night log/);
    assert.ok(!/(?<!People say )Teo wiped the night log/.test(text));
  });
});

test('old saves are unchanged: facts with no source, or recorded from intent, still count', () => {
  const { E, state } = newGame();
  const f = E.Memory.addFact(state, { text: 'Teo says nothing about the log.', known_by: ['all'] });
  assert.equal(f.source, undefined);
  assert.equal(E.Memory.unproven(f), false);
  assert.equal(E.Timeline.holds(state, { known: { words: ['nothing', 'log'] } }), true);
});
