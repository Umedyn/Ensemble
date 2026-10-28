// The context report (task G-4): how many tokens each prompt block takes,
// for every bundled world's default start, at each context size, at the start
// of a game and in a simulated mid-game (60 facts, 8 chapter summaries, a long
// last scene). Read-only; no model.
//
//   npm run context [-- --world occupied-france] [--ctx 8192,16384] [--min 40]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { newGame, scenarioFolders, readWorld } = require(path.join(root, 'tests', 'helpers.js'));

export const CONTEXTS = [8192, 16384, 32768];
const words = (n, seed) => Array.from({ length: n }, (_, i) => ['the', 'station', 'quiet', 'night', 'door', 'ration', 'letter', 'police', 'map', 'road'][(i * 7 + seed) % 10]).join(' ');

// About forty turns in: 60 player-known facts (every third a major one),
// eight chapter summaries and a long last scene.
export function midGame(E, state) {
  for (let i = 0; i < 60; i++) {
    const f = E.Memory.addFact(state, { about: [state.player], text: `Fact ${i}: ${words(22, i)}.`, known_by: ['all'], weight: i % 3 === 0 ? 3 : 2 });
    f.turn = i;
  }
  for (let n = 1; n <= 8; n++) state.chapters.push({ n, title: `Chapter ${n}`, summary: words(120, n) + '.', fromTurn: n * 5, toTurn: n * 5 + 4 });
  state.turn = 40;
  state.recent = [{ turn: 40, action: 'Look around.', text: Array.from({ length: 4 }, (_, i) => words(65, i) + '.').join('\n\n') }];
}

// One world at one context size: { totals: {header, intent, narrate, update},
// reply (the intent call's), blocks: {'header.regions': tokens, …}, tier }.
export function measure(folder, ctx, mid) {
  const { E, state } = newGame(folder);
  E.settings.backends.local.context = ctx;
  Object.keys(E.settings.routing).forEach((k) => { E.settings.routing[k] = 'local'; });
  if (mid) midGame(E, state);
  else state.recent = [{ turn: 1, action: 'Look around.', text: words(60, 3) + '.' }];
  const P = E.Prompts;
  P.fixedHeader(state); // measured once, as in a game; not counted below
  const blocks = {};
  Object.keys(P.blocks).forEach((id) => {
    const orig = P.blocks[id];
    P.blocks[id] = (c, layout) => {
      const out = orig(c, layout);
      if (out != null) blocks[`${layout}.${id}`] = (blocks[`${layout}.${id}`] || 0) + E.estTokens(Array.isArray(out) ? out.join('\n') : out);
      return out;
    };
  });
  const present = E.Engine.present(state);
  const here = state.characters[state.player].status.location;
  const res = { outcomes: [{ id: state.player, action: 'Looks around.', visible: true }].concat(present.map((id) => ({ id, action: 'Waits.', says: 'Not now.', visible: true }))), events: [] };
  const frame = { startLoc: here, startTime: E.fmtTime(state), stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 };
  const t = (s) => E.estTokens(s);
  const totals = {
    header: t(P.header(state)),
    intent: t(P.intent(state, present, 'Look around.', 'about an hour', 'hour', { regional: true })),
    narrate: t(P.narrate(state, present, 'Look around.', frame, res)),
    update: t(P.update(state, 'Look around.', res, words(200, 5), present, false)),
  };
  // The intent call's reply, as the engine asks for it (a regional event due).
  const reply = 260 + 150 * present.length + 120;
  return { totals, reply, blocks, tier: E.contextTier().id, budgets: E.Memory.budgets(state) };
}

export const worlds = () => scenarioFolders().filter((f) => readWorld(f).defaultStart);

function main(argv) {
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
  const only = flag('world');
  const ctxs = flag('ctx') ? flag('ctx').split(',').map(Number) : CONTEXTS;
  const min = Number(flag('min') || 40);
  for (const mid of [false, true]) {
    console.log(`\n${mid ? 'MID-GAME (60 facts, 8 chapters, a long last scene)' : 'AT THE START'}`);
    for (const w of worlds().filter((x) => !only || x === only)) {
      const rows = ctxs.map((c) => measure(w, c, mid));
      console.log(`\n${w}`);
      rows.forEach((r, i) => {
        const sum = r.totals.header + r.totals.intent + r.reply;
        console.log(`  ${String(ctxs[i] / 1024).padStart(3)}K ${r.tier.padEnd(8)} header ${r.totals.header} + intent ${r.totals.intent} + reply ${r.reply} = ${sum}${sum > ctxs[i] ? '  OVER' : ''}; narrate ${r.totals.narrate}, update ${r.totals.update}; budgets: facts ${r.budgets.facts}, story ${r.budgets.story}, lore ${r.budgets.lore}`);
      });
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r.blocks)))].filter((k) => rows.some((r) => (r.blocks[k] || 0) >= min))
        .sort((a, b) => (rows[0].blocks[b] || 0) - (rows[0].blocks[a] || 0));
      console.log(`  ${'block'.padEnd(26)}${ctxs.map((c) => `${c / 1024}K`.padStart(7)).join('')}`);
      keys.forEach((k) => console.log(`  ${k.padEnd(26)}${rows.map((r) => String(r.blocks[k] || 0).padStart(7)).join('')}`));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
