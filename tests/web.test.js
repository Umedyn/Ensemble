// Relationship web (task 2-4): who feels what about whom, filtered to what
// the player could know. Your own feelings and theirs toward you (both on the
// cards already) always show; feelings between two other people show only
// when you know a fact about both of them. Words only; numbers stay in Debug.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame } = require('./helpers');

const ids = (list) => [...list].map((n) => n.id);
const edge = (web, from, to) => [...web.edges].find((e) => e.from === from && e.to === to);

test('the web shows you and the local characters, and the background on request; never the dead', () => {
  const { E, state } = newGame();
  assert.deepEqual(ids(E.Engine.relationWeb(state).nodes), ['navarro', 'okafor', 'bauer']);
  state.characters.bauer.status.health = 'dead';
  assert.deepEqual(ids(E.Engine.relationWeb(state, { secondary: true }).nodes), ['navarro', 'okafor', 'sorensen', 'raman']);
});

test('your feelings and theirs toward you always show, as words with a reason, never numbers', () => {
  const { E, state } = newGame();
  state.characters.navarro.attitudeNotes = { bauer: 'he covered for me' };
  const web = E.Engine.relationWeb(state);
  const mine = edge(web, 'navarro', 'bauer');
  assert.deepEqual([mine.word, mine.level, mine.sign, mine.source, mine.why], ['friendly', 1, 1, 'you', 'he covered for me']);
  assert.equal(edge(web, 'bauer', 'navarro').word, 'friendly');
  assert.equal(edge(web, 'navarro', 'okafor').word, 'neutral');
  for (const e of web.edges) assert.ok(!('value' in e), 'no numbers');
});

test('feelings between two others stay hidden until you know a fact about both of them', () => {
  const { E, state } = newGame();
  assert.equal(edge(E.Engine.relationWeb(state), 'okafor', 'bauer'), undefined);
  // A private fact (only Okafor knows it) changes nothing for you.
  E.Memory.addFact(state, { about: ['okafor', 'bauer'], text: 'Okafor suspects Teo of tampering with the recycler.', known_by: ['okafor'], weight: 2 });
  assert.equal(edge(E.Engine.relationWeb(state), 'okafor', 'bauer'), undefined);
  state.characters.okafor.relations.bauer = -30;
  E.Memory.addFact(state, { about: ['okafor', 'bauer'], text: 'Okafor snapped at Teo over the recycler logs.', known_by: ['navarro', 'okafor', 'bauer'], weight: 2 });
  const web = E.Engine.relationWeb(state);
  const e = edge(web, 'okafor', 'bauer');
  assert.deepEqual([e.word, e.level, e.sign, e.source, e.why], ['wary', 1, -1, 'seen', 'Okafor snapped at Teo over the recycler logs.']);
  assert.ok(edge(web, 'bauer', 'okafor'), 'both directions, since you know what passed between them');
  assert.equal(edge(web, 'okafor', 'sorensen'), undefined, 'Lev is in the background and not in the web');
});

test('a promoted extra is in the web like anyone else; extras are not', () => {
  const { E, state } = newGame('zombie-holdout');
  assert.ok(!ids(E.Engine.relationWeb(state, { secondary: true }).nodes).includes('albee'));
  const c = E.Engine.characterFromExtra(state, state.extras.albee, { want: 'outlive the dead', traits: ['sharp'], relations: { pike: 20 } }, 2);
  state.characters.albee = c;
  state.order.push('albee');
  delete state.extras.albee;
  const web = E.Engine.relationWeb(state);
  assert.ok(ids(web.nodes).includes('albee'));
  assert.equal(edge(web, 'albee', 'pike').word, 'friendly');
});
