// The headless run harness (task B-9): plays a world for hundreds of turns and
// reports what looks wrong. Writes a report per run to soak-out/, and a replay
// fixture for each alarm that isn't in tests/soak-known.json.
//
//   npm run soak -- <world>|all [--turns 300] [--seed 1] [--start id] [--smaller] [--strict]
//   npm run soak -- <world> --model kobold-local|kobold-remote|openrouter|custom [--url URL] [--name MODEL] [--context TOKENS]
//
// --strict exits with 1 on a crash or a new alarm (CI). An API key comes from
// ENSEMBLE_API_KEY, never from a file. A real model is slow and costs tokens,
// so start with a few turns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Soak = require(path.join(root, 'tests', 'soak.js'));

const MAX_FIXTURES = 3; // per run: each one plays the seed again
const USAGE = `Usage:
  npm run soak -- <world>|all [--turns 300] [--seed 1] [--start id] [--smaller] [--strict]
  npm run soak -- <world> --model <preset> [--url URL] [--name MODEL] [--context TOKENS]`;

export function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const k = a.slice(2);
    if (['strict', 'smaller'].includes(k)) flags[k] = true;
    else flags[k] = argv[++i];
  }
  return { world: rest[0], flags };
}

// Sets a real backend up, every step on it. flags: { model (a preset), url, name, context }.
export function realModel(flags, env) {
  return (E) => {
    const preset = E.backendPresets[flags.model];
    if (!preset) throw new Error(`No preset "${flags.model}". Use mock, or one of: ${Object.keys(E.backendPresets).join(', ')}.`);
    const b = Object.assign(E.settings.backends.local, { preset: flags.model, url: flags.url || preset.url, model: flags.name || preset.model, key: preset.key ? env.ENSEMBLE_API_KEY || '' : '' });
    if (flags.context) b.context = Number(flags.context) || b.context;
    if (!b.url) throw new Error('This preset needs --url.');
    if (preset.key === true && !b.key) throw new Error('Set ENSEMBLE_API_KEY to the API key (it is never saved).');
    if (!b.model) throw new Error('Name the model with --name.');
    if (preset.kobold) b.smallerCalls = true;
    Object.keys(E.settings.routing).forEach((k) => { E.settings.routing[k] = 'local'; });
  };
}

export async function soakWorld(world, flags, deps = {}) {
  const log = deps.log || console.log;
  const out = deps.out || path.join(root, 'soak-out');
  const known = deps.known || JSON.parse(fs.readFileSync(path.join(root, 'tests', 'soak-known.json'), 'utf8'));
  const seed = Number(flags.seed || 1);
  const real = flags.model && flags.model !== 'mock';
  const opts = { world, turns: Number(flags.turns || 300), seed, start: flags.start, smaller: !!flags.smaller };
  if (real) Object.assign(opts, { connect: realModel(flags, process.env), globals: { fetch, AbortController, TextDecoder } });
  const t0 = Date.now();
  const run = await Soak.play(opts);
  const found = Soak.alarms(run);
  const fresh = found.filter((a) => !Soak.isKnown(known, run.world, a));
  fs.mkdirSync(out, { recursive: true });
  // No fixture from a real model: playing it again would cost the whole run.
  if (!real) {
    for (const a of fresh.slice(0, MAX_FIXTURES)) {
      try {
        const name = `${run.world}-${seed}-${a.id}-${fresh.indexOf(a) + 1}.json`;
        fs.writeFileSync(path.join(out, name), JSON.stringify(await Soak.capture(opts, run, a)));
        a.fixture = name;
      } catch (err) { log(`  no fixture for ${a.key}: ${err.message}`); }
    }
  }
  const file = path.join(out, `${run.world}-${seed}.md`);
  fs.writeFileSync(file, Soak.report(run, found, known));
  log(`${run.world}: ${run.samples.length} turns, ${run.lives.length} lives, ${((Date.now() - t0) / 1000).toFixed(1)}s; ${fresh.length} new alarms, ${found.length - fresh.length} known`);
  fresh.forEach((a) => log(`  ${a.key}: ${a.detail}`));
  return { run, found, fresh };
}

export async function main(argv, deps = {}) {
  const log = deps.log || console.log;
  const { world, flags } = parseArgs(argv);
  if (!world) { log(USAGE); return 1; }
  if (world === 'all' && flags.model && flags.model !== 'mock') { log('A real model soaks one world at a time.'); return 1; }
  const worlds = world === 'all' ? Soak.bundledWorlds() : [world];
  let fresh = 0;
  for (const w of worlds) fresh += (await soakWorld(w, flags, deps)).fresh.length;
  if (flags.strict && fresh) { log(`\n${fresh} new alarms. Fix them, or add them to tests/soak-known.json with the reason.`); return 1; }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 1; });
}
