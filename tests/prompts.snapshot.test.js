// Prompt snapshots: every prompt for a fixed state in each bundled scenario,
// compared byte for byte with tests/fixtures/prompt-snapshots.json. Refactors
// that shouldn't change what the model sees (cast helpers, prompt blocks) must
// keep these identical. After an intended prompt change, re-record with
// UPDATE_SNAPSHOTS=1 npm test and review the diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newGame, scenarioFolders } = require('./helpers');

const FILE = path.join(__dirname, 'fixtures', 'prompt-snapshots.json');

// One NPC is moved elsewhere and one is dead, so present, offstage and
// "elsewhere" lists all have something to show.
function promptsFor(folder) {
  const { E, state } = newGame(folder);
  const P = E.Prompts;
  const npcs = [...state.order].filter((id) => id !== state.player);
  const here = state.characters[state.player].status.location;
  const away = Object.keys(state.locations).find((l) => l !== here);
  if (npcs[1]) state.characters[npcs[1]].status.location = away;
  if (npcs[2]) state.characters[npcs[2]].status.health = 'dead';
  state.recent = [{ turn: 1, action: 'Look around.', text: 'You look around. Nobody says much.' }];

  const present = E.Engine.present(state);
  const res = {
    outcomes: [{ id: state.player, action: 'Asks what happened.', visible: true }]
      .concat(present.map((id) => ({ id, action: 'Answers vaguely.', says: 'Not now.', visible: id !== present[1] }))),
    events: ['Something rattles in the vents.'],
  };
  const frame = { startLoc: here, startTime: E.fmtTime(state), stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 };
  const out = {
    header: P.header(state),
    intent: P.intent(state, present, 'Ask what happened.', 'about an hour', 'hour', { regional: true }),
    narrate: P.narrate(state, present, 'Ask what happened.', frame, res),
    narrateMore: P.narrateMore(state, present, 'Ask what happened.', frame, res, '[+0m] You ask.', 10),
    update: P.update(state, 'Ask what happened.', res, 'You ask. They shrug.', present, false),
    updateCut: P.update(state, 'Ask what happened.', res, 'You ask.', present, true),
    suggest: P.suggest(state),
  };

  // The player walks to where the moved NPC is: the frame shows who stayed and who's there.
  state.characters[state.player].status.location = away;
  out.narrateMoved = P.narrate(state, present, 'Go next door.', frame, res);

  const skipFrame = { startLoc: away, startTime: frame.startTime, endTime: 'later', days: 3 };
  const skipRes = { outcomes: [], events: ['A supply drop lands nearby.', '[major] An alarm sounds.'], major: { text: '[major] An alarm sounds.' } };
  out.skipIntent = P.skipIntent(state, 'Keep busy.', { reason: 'horizon' }, skipFrame, skipRes);
  out.narrateSkip = P.narrateSkip(state, 'Keep busy.', skipFrame, [{ after: '1d', text: 'Days pass.' }],
    npcs.filter((id) => id !== npcs[2]).map((id) => ({ id, doing: 'resting' })), skipRes, present);
  out.chapter = P.chapter(state);
  return out;
}

// Rule 7: the header only grows at its end during play, so blocks that change
// (chapters, facts) come last, and every layout names real blocks.
test('prompt layouts use known blocks, and the header keeps its live blocks at the end', () => {
  const { E } = newGame();
  const P = E.Prompts;
  for (const [name, layout] of Object.entries(P.layouts)) {
    for (const id of layout) assert.equal(typeof P.blocks[id], 'function', `${name} uses unknown block "${id}"`);
  }
  const header = [...P.layouts.header];
  assert.deepEqual(header.slice(-P.LIVE_HEADER.length), [...P.LIVE_HEADER]);
  assert.ok(header.filter((id) => P.LIVE_HEADER.includes(id)).length === P.LIVE_HEADER.length);
});

test('prompts are unchanged for a fixed state in every bundled scenario', () => {
  const now = {};
  for (const folder of scenarioFolders()) now[folder] = promptsFor(folder);
  if (process.env.UPDATE_SNAPSHOTS || !fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(now, null, 1) + '\n');
    return;
  }
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepEqual(Object.keys(now), Object.keys(saved), 'scenario list changed: re-record with UPDATE_SNAPSHOTS=1');
  for (const folder of Object.keys(saved)) {
    for (const kind of Object.keys(saved[folder])) {
      assert.equal(now[folder][kind], saved[folder][kind], `${folder} › ${kind} prompt changed`);
    }
  }
});
