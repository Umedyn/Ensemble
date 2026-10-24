// Prompt snapshots: every prompt for a fixed state in each bundled scenario,
// compared byte for byte with tests/fixtures/prompt-snapshots.json. Refactors
// that shouldn't change what the model sees (cast helpers, prompt blocks) must
// keep these identical. After an intended prompt change, re-record with
// UPDATE_SNAPSHOTS=1 npm test and review the diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newGame, scenarioFolders, readWorld } = require('./helpers');
const genMock = require('./genmock');

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
  // The moved NPC's agenda step is due (task 2-2).
  if (npcs[1] && state.characters[npcs[1]].agenda) state.characters[npcs[1]].agenda.due = true;
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
    agenda: npcs[1] ? P.agenda(state, npcs[1], null) : '',
    fleshOut: ((x) => (x ? P.fleshOut(state, x.id) : ''))(Object.values(state.extras || {}).find((e) => !e.group)),
    // Character creator (task 4-1): the draft game's header and a Suggest call.
    charSuggest: ((sc) => {
      if (!sc.playerSlot) return '';
      const f = Object.assign(E.CharMaker.defaults(sc), { name: 'Sam Reyes', traits: ['patient'], want: 'see the week out' });
      const draft = E.CharMaker.draftState(sc, f);
      return P.header(draft) + '\n\n' + P.charSuggest(draft, 'traits', f);
    })(state.scenario),
  };

  // The player walks to where the moved NPC is: the frame shows who stayed and who's there.
  state.characters[state.player].status.location = away;
  out.narrateMoved = P.narrate(state, present, 'Go next door.', frame, res);

  const skipFrame = { startLoc: away, startTime: frame.startTime, endTime: 'later', days: 3 };
  const skipRes = { outcomes: [], events: ['A supply drop lands nearby.', '[major] An alarm sounds.'], major: { text: '[major] An alarm sounds.' } };
  out.skipIntent = P.skipIntent(state, 'Keep busy.', { reason: 'horizon' }, skipFrame, skipRes, npcs[1] ? [{ id: npcs[1], text: 'Someone finishes a task.', visibility: 'hidden' }] : []);
  out.narrateSkip = P.narrateSkip(state, 'Keep busy.', skipFrame, [{ after: '1d', text: 'Days pass.' }],
    npcs.filter((id) => id !== npcs[2]).map((id) => ({ id, doing: 'resting' })), skipRes, present);
  out.chapter = P.chapter(state);
  // Character card import (task 6-2): the v2 fixture card.
  out.cardConvert = ((p) => `${p.system}\n\n${p.user}`)(P.cardConvert(state.scenario, E.Cards.fromFile(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'cards', 'v2.png')))).card));
  Object.assign(out, genPrompts(E, folder), sitePrompts(E, state), researchPrompts(E, folder));
  return out;
}

// The research helper (ROADMAP Phase 5, tools/research.mjs): one chunk of a
// source for the first region, and the "what do you know" question.
function researchPrompts(E, folder) {
  const loaded = readWorld(folder, E);
  const job = E.Research.newJob(loaded, { asOf: 'the start of the story', calendar: { date: '2026-03-14' } });
  const ctx = E.Research.context(loaded, job);
  const topic = job.topics.find((t) => t.level === 'region') || job.topics[0];
  return {
    research: ctx.header + '\n\n' + E.Prompts.research(ctx, topic, { title: 'A page', url: 'https://example.org/page' }, 'Some source text about the place.', 0, 2),
    researchKnown: E.Prompts.researchKnown(ctx, topic),
  };
}

// Generated starts (task 4-2): every step's prompt, each step filled from the
// shared mock replies before the next. Empty for worlds without them.
const GEN_KEYS = ['genHeader', 'genPlayer', 'genRooms', 'genPlan', 'genPerson1', 'genPerson2', 'genCastAll', 'genTies', 'genExtras', 'genOpening'];
function genPrompts(E, folder) {
  const w = readWorld(folder, E);
  const out = {};
  GEN_KEYS.forEach((k) => { out[k] = ''; });
  if (!w.generate) return out;
  const GEN = E.StartGen;
  const r = genMock.replies();
  const job = GEN.newJob(w, { region: GEN.regions(w.bundle.world)[0].id, line: 'a trucker who just wants to get to the coast', note: 'quiet and tense', onePass: false });
  const ctx = GEN.context(w, job);
  const P = E.Prompts;
  out.genHeader = ctx.header;
  out.genPlayer = P.genStep(ctx, 'player');
  job.steps.player = GEN.check.player(r.player, ctx);
  out.genRooms = P.genStep(ctx, 'rooms');
  job.steps.rooms = GEN.check.rooms(r.rooms, ctx);
  out.genPlan = P.genStep(ctx, 'plan');
  job.steps.plan = GEN.check.plan(r.plan, ctx);
  out.genPerson1 = P.genStep(ctx, 'person', 0);
  job.partial.cast = [GEN.check.person(genMock.SHEETS['Lena Marsh'], ctx, 0).character];
  out.genPerson2 = P.genStep(ctx, 'person', 1);
  out.genCastAll = P.genStep(ctx, 'cast');
  job.steps.cast = GEN.check.cast(r.cast, ctx);
  out.genTies = P.genStep(ctx, 'ties');
  job.steps.ties = GEN.check.ties(r.ties, ctx);
  out.genExtras = P.genStep(ctx, 'extras');
  job.steps.extras = GEN.check.extras(r.extras, ctx);
  out.genOpening = P.genStep(ctx, 'opening');
  job.steps.opening = GEN.check.opening(r.opening, ctx);
  out.genLore = P.genStep(ctx, 'lore');
  return out;
}

// Generated sites (task 4-4): the layout and occupant prompts for one
// request, in worlds that build places.
function sitePrompts(E, state) {
  const out = { siteLayout: '', siteOccupants: '' };
  if (!E.Sites.enabled(state.scenario)) return out;
  const req = { name: 'the pharmacy', kind: 'pharmacy', region: (state.scenario.regions || [])[1] ? state.scenario.regions[1].id : null, why: 'I head to the pharmacy for antibiotics.' };
  out.siteLayout = E.Prompts.siteLayout(state, req);
  out.siteOccupants = E.Prompts.siteOccupants(state, req, E.Sites.checkLayout(state, genMock.replies().siteLayout, 'pharmacy'), false);
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
