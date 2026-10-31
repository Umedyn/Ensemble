// Narrated details (task B-0b): what the scene says stays true. Details are
// filed at their home, objects become features, what contradicts the engine is
// dropped and reported, and none of it ever drives a rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame } = require('./helpers');

function game() {
  const g = newGame('zombie-holdout');
  const here = g.state.characters[g.state.player].status.location;
  return { ...g, here };
}
// One update with these details, in a scene that stayed in the player's room.
function file(E, state, details, prose, extra) {
  const here = state.characters[state.player].status.location;
  const scene = prose != null ? prose : details.map((d) => d.text).join(' ');
  return E.Engine.applyUpdate(state, Object.assign({ details }, extra), E.Engine.present(state), { startLoc: here, endLoc: here, prose: scene });
}
const details = (E, state) => state.facts.filter(E.Memory.narrated);
const rejected = (report, re) => report.rejected.some((r) => re.test(r));

test('a narrated object with a state becomes a feature of its room, on the map and able to change', () => {
  const { E, state, here } = game();
  const report = file(E, state, [{ text: 'The coffee machine is broken.', thing: 'Coffee Machine', state: 'Broken', about: [] }]);
  const f = E.Engine.features(state, here).find((x) => x.name === 'coffee machine');
  assert.equal(f.state, 'broken');
  assert.ok(f.inferred && f.narrated);
  assert.equal(details(E, state)[0].where, here, 'filed at the room');
  assert.equal(details(E, state)[0].source, 'narration');
  assert.ok(report.applied.some((a) => a.startsWith('feature:')));
  const moved = E.Engine.applyUpdate(state, { state: [{ target: `feature:${here}|coffee machine`, field: 'state', value: 'mended' }] }, [], { startLoc: here, endLoc: here });
  assert.deepEqual([...moved.rejected], []);
  assert.equal(state.features[`${here}|coffee machine`], 'mended');
});

test('a detail about a person is filed on them, and the scene loads it when they are there', () => {
  const { E, state } = game();
  const other = E.Engine.present(state)[0] || E.Engine.cast(state, { includePlayer: false })[0];
  state.characters[other].status.location = state.characters[state.player].status.location;
  const here = state.characters[state.player].status.location;
  E.Engine.applyUpdate(state, { details: [{ text: 'She hums while she works.', about: [other] }] }, [other], { startLoc: here, endLoc: 'elsewhere', prose: 'She hums while she works.' });
  const d = details(E, state)[0];
  assert.deepEqual([...d.about], [other]);
  assert.ok(!d.where);
  assert.ok(E.Memory.sceneFacts(state).some((p) => p.fact === d));
});

test('a detail with no home, or that the scene never says, is dropped and reported', () => {
  const { E, state, here } = game();
  const away = E.Engine.applyUpdate(state, { details: [{ text: 'The weather is bad.', about: [] }] }, [], { startLoc: here, endLoc: 'elsewhere', prose: 'The weather is bad.' });
  assert.ok(rejected(away, /no home/));
  const report = file(E, state, [{ text: 'Harper secretly hides the medicine under floorboards.', about: [] }], 'You nod and sit down.');
  assert.ok(rejected(report, /doesn't say that/));
  assert.equal(details(E, state).length, 0);
});

test('a detail contradicting a locked door is dropped and reported', () => {
  const { E, state } = newGame('seiryo-high', 'hayakawa');
  state.characters[state.player].status.location = 'upper-hall';
  const report = file(E, state, [{ text: 'The door to the rooftop stands open.', about: [] }]);
  assert.ok(rejected(report, /is locked/));
  assert.equal(details(E, state).length, 0);
  state.links[E.Engine.linkKey('upper-hall', 'rooftop')].locked = false;
  assert.ok(!rejected(file(E, state, [{ text: 'The door to the rooftop stands open.', about: [] }]), /is locked/), 'fine once it is unlocked');
});

test('someone placed in the wrong room is dropped, but a walk-in the update records stays', () => {
  const { E, state } = newGame('seiryo-high', 'hayakawa');
  state.characters[state.player].status.location = 'hayakawa-entry';
  const text = 'Aoi is in the genkan, sleeves rolled twice.';
  assert.ok(rejected(file(E, state, [{ text, about: ['aoi'] }]), /Aoi Mizuhara is in/));
  const report = file(E, state, [{ text, about: ['aoi'] }], `${text} She walks in.`, { state: [{ target: 'char:aoi', field: 'location', value: 'hayakawa-entry' }] });
  assert.deepEqual([...report.rejected], [], 'checked after the move');
  assert.equal(details(E, state).length, 1);
});

test('a key held by someone else and a dead person present are dropped', () => {
  const { E, state } = newGame('seiryo-high', 'hayakawa');
  assert.ok(rejected(file(E, state, [{ text: 'Sora has the key to the rooftop.', about: ['sora'] }]), /doesn't hold the key/));
  assert.ok(!rejected(file(E, state, [{ text: 'Shinji keeps the key to the rooftop.', about: ['shinji'] }]), /doesn't hold the key/));
  state.characters.kenji.status.health = 'dead';
  assert.ok(rejected(file(E, state, [{ text: 'Kenji laughs at the table.', about: ['kenji'] }]), /is dead/));
  assert.ok(!rejected(file(E, state, [{ text: 'Kenji died at the table.', about: ['kenji'] }]), /is dead/));
});

test('a detail against a tracked feature is dropped; one the engine does not track is not a contradiction', () => {
  const { E, state, here } = game();
  state.locations[here].features = (state.locations[here].features || []).concat([{ name: 'radio', state: 'off' }]);
  state.features[`${here}|radio`] = 'off';
  assert.ok(rejected(file(E, state, [{ text: 'The radio is on.', thing: 'radio', state: 'on', about: [] }]), /radio is off/));
  assert.equal(state.features[`${here}|radio`], 'off');
  assert.deepEqual([...file(E, state, [{ text: 'The sink drips all night long.', about: [] }]).rejected], []);
});

test('a narration-only fact never satisfies a timeline precondition or an ending', () => {
  const { E, state, here } = game();
  const cond = { known: { words: ['coffee', 'machine'] } };
  file(E, state, [{ text: 'The coffee machine is broken.', about: [] }]);
  assert.equal(E.Timeline.holds(state, cond), false);
  assert.ok(state.facts.some((f) => /coffee machine/.test(f.text)));
  E.Memory.addFact(state, { text: 'The coffee machine was stolen.', known_by: ['all'], where: here, source: 'intent' });
  assert.equal(E.Timeline.holds(state, cond), true, 'a recorded fact still counts');
});

test('a narrated feature never satisfies a feature condition, a requires, or sight', () => {
  const { E, state, here } = game();
  file(E, state, [{ text: 'A camera watches the room, switched on.', thing: 'camera', state: 'on', about: [] }]);
  const key = `${here}|camera`;
  assert.equal(state.features[key], 'on');
  assert.equal(E.Timeline.holds(state, { feature: key, is: 'on' }), false);
  state.locations[here].features.push({ name: 'gate', state: 'shut', requires: { open: { if: [{ feature: key, is: 'on' }], otherwise: 'no' } } });
  assert.ok('open' in E.Engine.featureOptions(state, here, 'gate').blocked);
  assert.ok(!E.Engine.ruleFeatures(state, here).some((f) => f.name === 'camera'));
});

test('a filed detail survives a chapter close, outside the core and the roll-up, and loads first at its home', () => {
  const { E, state, here } = game();
  file(E, state, [{ text: 'The coffee machine is broken.', about: [] }]);
  const d = details(E, state)[0];
  assert.ok(!E.Memory.chapterFacts(state).includes(d), 'not rolled up');
  assert.ok(!E.Prompts.chapter(state).includes(d.text));
  assert.equal(E.Memory.freeable(state), E.estTokens(E.Memory.chapterFacts(state).filter((f) => f.weight < 3 && !f.inSummary).map((f) => `- [T${f.turn}] ${f.text}`).join('\n')));
  E.Memory.addFact(state, { text: 'Something else happened nearby at this place.', known_by: ['all'], where: here });
  E.Memory.closeChapter(state, { title: 'A', summary: 'B' }, 'test');
  assert.ok(state.facts.includes(d));
  assert.ok(!E.Prompts.header(state).includes(d.text), 'never in the core');
  E.Memory.closeChapter(state, { title: 'C', summary: 'D' }, 'test');
  const picks = E.Memory.sceneFacts(state);
  assert.ok(picks.some((p) => p.fact === d && p.compartment === 'place'));
});

test('a home keeps five details: the oldest gives way, and Debug says so', () => {
  const { E, state, here } = game();
  const things = ['Ravens circle the rusted tower', 'Muddy bootprints cross the bakery', 'Church bells ring before sunrise', 'Broken glass lines the alley', 'Green paint peels from shutters', 'Candle stubs fill the window'];
  let last;
  things.forEach((text) => { last = file(E, state, [{ text, about: [] }]); });
  assert.equal(details(E, state).filter((f) => f.where === here).length, 5);
  assert.ok(!state.facts.some((f) => f.text === things[0]));
  assert.ok(rejected(last, /gives way/));
});

test('a room takes three narrated features at most; the detail stays', () => {
  const { E, state, here } = game();
  state.locations[here].features = [];
  const words = ['kettle', 'ladder', 'bucket', 'mirror'];
  let last;
  words.forEach((w) => { last = file(E, state, [{ text: `A dented ${w} leans here.`, thing: w, about: [] }]); });
  assert.equal(E.Engine.features(state, here).filter((f) => f.narrated).length, 3);
  assert.ok(rejected(last, /narrated features/));
  assert.equal(details(E, state).length, 4);
});

test('old saves play the same: a fact with no source still counts, and an update with no details adds none', () => {
  const { E, state } = game();
  const f = E.Memory.addFact(state, { text: 'The coffee machine is broken.', known_by: ['all'] });
  assert.ok(!('source' in f));
  assert.equal(E.Timeline.holds(state, { known: { words: ['coffee'] } }), true);
  assert.ok(E.Memory.rollable(state).includes(f));
  const report = E.Engine.applyUpdate(state, { facts: [] }, [], {});
  assert.deepEqual([...report.rejected], []);
  assert.equal(details(E, state).length, 0);
});

test('the update asks for details, in the facts part, and its reply may leave them out', () => {
  const { E, state } = game();
  assert.ok(E.Prompts.UPDATE_PARTS.facts.keys.includes('details'));
  assert.match(E.Prompts.update(state, 'Look.', { outcomes: [], events: [] }, 'You look.', [], false), /- details: /);
});
