// Skills improve with use (task B-8): a success under real stakes adds
// progress, enough raises the skill by one, capped by the world's highest
// skill and at most once a skill an in-game week. No dice of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, fixedRng, noRoutines } = require('./helpers');

const guards = (res, type) => (res.guards || []).filter((g) => g.type === type).map((g) => g.detail);
const rolled = (id, skill, result, dc) => ({ id, skill, roll: { d: 15, total: 15, dc, result } });
const grow = (E, state, outcomes) => { const res = { outcomes, guards: [] }; E.Engine.growSkills(state, res, state.turn); return res; };

function setup(skill = 1) {
  const { E, state } = newGame();
  state.scenario.playerSlot = Object.assign({}, state.scenario.playerSlot, { maxSkill: 3 });
  state.characters[state.player].skills.tech = skill;
  return { E, state, pc: state.characters[state.player] };
}

test('trivial rolls and failures give no progress', () => {
  const { E, state, pc } = setup();
  for (let i = 0; i < 5; i++) grow(E, state, [rolled(state.player, 'tech', 'success', 8)]);
  grow(E, state, [rolled(state.player, 'tech', 'failure', 16), rolled(state.player, 'tech', 'critical failure', 12)]);
  grow(E, state, [{ id: state.player, skill: 'tech', roll: null }]);
  assert.equal(pc.skills.tech, 1);
  assert.equal(pc.skillGrowth, undefined);
});

test('three successes at normal or harder raise the skill by one, recorded on the character', () => {
  const { E, state, pc } = setup();
  assert.deepEqual(guards(grow(E, state, [rolled(state.player, 'tech', 'success', 12)]), 'skill progress'), [`${pc.name}: tech 1/3`]);
  grow(E, state, [rolled(state.player, 'tech', 'critical success', 16)]);
  assert.equal(pc.skills.tech, 1);
  const res = grow(E, state, [rolled(state.player, 'tech', 'success', 14)]);
  assert.equal(pc.skills.tech, 2);
  assert.deepEqual(guards(res, 'skill improved'), [`${pc.name}: tech 1 → 2`]);
  assert.deepEqual({ ...pc.skillGrowth.tech }, { progress: 0, raised: state.time.day });
  assert.deepEqual({ ...pc.improved }, { skill: 'tech', turn: state.turn, to: 2 });
});

test('at most once a skill an in-game week; progress waits for the week', () => {
  const { E, state, pc } = setup();
  for (let i = 0; i < 3; i++) grow(E, state, [rolled(state.player, 'tech', 'success', 12)]);
  assert.equal(pc.skills.tech, 2);
  for (let i = 0; i < 5; i++) grow(E, state, [rolled(state.player, 'tech', 'success', 12)]);
  assert.equal(pc.skills.tech, 2, 'not twice in a week');
  assert.equal(pc.skillGrowth.tech.progress, 3, 'progress holds at the top');
  // Another skill isn't held back by this one.
  pc.skills.science = 0;
  for (let i = 0; i < 3; i++) grow(E, state, [rolled(state.player, 'science', 'success', 12)]);
  assert.equal(pc.skills.science, 1);
  state.time.day += 7;
  grow(E, state, [rolled(state.player, 'tech', 'success', 12)]);
  assert.equal(pc.skills.tech, 3, 'a week later the next success raises it');
});

test("the cap holds: the world's highest skill, else 4 for everyone", () => {
  const { E, state, pc } = setup(3);
  for (let i = 0; i < 6; i++) grow(E, state, [rolled(state.player, 'tech', 'success', 16)]);
  assert.equal(pc.skills.tech, 3);
  assert.equal(pc.skillGrowth, undefined, 'no progress at the cap');
  // An authored character above the world's highest skill is left as written.
  pc.skills.tech = 4;
  grow(E, state, [rolled(state.player, 'tech', 'success', 16)]);
  assert.equal(pc.skills.tech, 4);
  delete state.scenario.playerSlot;
  assert.equal(E.Engine.maxSkill(state.scenario), 4);
  assert.equal(E.Engine.maxSkill({ generatedStarts: { maxSkill: 2 } }), 2);
  assert.equal(E.Engine.maxSkill({ playerSlot: { maxSkill: 9 } }), 4);
});

test('other people grow the same way, and the dead do not', () => {
  const { E, state } = setup();
  const [a, b] = E.Engine.cast(state, { includePlayer: false });
  state.characters[a].skills.tech = 0;
  state.characters[b].skills.tech = 0;
  state.characters[b].status.health = 'dead';
  for (let i = 0; i < 3; i++) grow(E, state, [rolled(a, 'tech', 'success', 12), rolled(b, 'tech', 'success', 12)]);
  assert.equal(state.characters[a].skills.tech, 1);
  assert.equal(state.characters[b].skills.tech, 0);
});

// The player fixes the recycler at hard difficulty every turn and the dice always succeed.
function fixingModel(E) {
  return mockLLM(E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'fix the recycler', needs_roll: true, skill: 'tech', difficulty: 'hard' }, intents: [], events: [] };
    if (kind === 'narrate (continue)') return '';
    if (kind.startsWith('narrate')) return '[+0m] You open the panel.\n\n[+5m] The rattle eases.';
    if (kind.startsWith('update')) return { facts: [], state: [], relations: [] };
    return { title: 'T', summary: 'S' };
  });
}
async function play(cutLast) {
  const { E, state } = setup();
  noRoutines(state);
  fixedRng(E, [0.97]);
  fixingModel(E);
  for (let i = 0; i < 4; i++) await E.Engine.runTurn(state, 'Fix the recycler.', 'moment', null, cutLast && i === 3 ? 1 : undefined);
  return { E, state };
}

test('growth happens as turns are recorded, survives a step-in and replays the same', async () => {
  const { state } = await play(false);
  const pc = state.characters[state.player];
  // Turns 1–3 are recorded by the start of turn 4.
  assert.equal(pc.skills.tech, 2);
  assert.equal(pc.improved.turn, 3);
  const again = await play(false);
  assert.equal(JSON.stringify(again.state.characters[again.state.player]), JSON.stringify(pc), 'the same play grows the same');
  const cut = await play(true);
  assert.equal(cut.state.characters[cut.state.player].skills.tech, 2, 'stepping in keeps the turn\'s roll');
});
