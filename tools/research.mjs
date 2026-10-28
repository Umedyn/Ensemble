// The research helper (ROADMAP Phase 5): wiki pages → draft lore and
// timeline events for a world, at build time. It runs the game's own engine
// and model code (js/research.js, js/llm.js), so it uses the local KoboldCpp
// or an external API exactly as the game does; being a Node command, it can
// read wiki pages without a browser's cross-site limits. Drafts wait for
// review in the creator (Lore and Timeline tabs) and the game ignores them.
//
//   npm run research -- plan <world> [--wiki URL] [--start ID] [--as-of TEXT] [--date YYYY-MM-DD] [--per-topic N] [--check-known] [--brief]
//   npm run research -- run <world> [--backend local|external] [--url URL] [--model NAME] [--context TOKENS]
//   npm run research -- apply <world>
//
// <world> is a folder under scenarios/ or a path. "plan" writes research.json
// in the world folder: the topics, from the world's regions, groups and
// characters; edit it (set "skip": true, or a "page", "url" or pasted
// "text") before "run". "run" researches the topics not done yet (it resumes
// after a stop or a failure) and writes the drafts; "apply" writes them again
// without calling the model. An API key comes from ENSEMBLE_API_KEY, never
// from a file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loadEngine, worldFiles } = require(path.join(root, 'tests', 'helpers.js'));

const USAGE = `Usage:
  npm run research -- plan <world> [--wiki URL] [--start ID] [--as-of TEXT] [--date YYYY-MM-DD] [--per-topic N] [--check-known] [--brief]
  npm run research -- run <world> [--backend local|external] [--url URL] [--model NAME] [--context TOKENS]
  npm run research -- apply <world>`;

export function parseArgs(argv) {
  const out = { cmd: argv[0], world: argv[1], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'check-known' || k === 'brief') out.flags[k] = true;
    else out.flags[k] = argv[++i];
  }
  return out;
}

// Reads and writes keep each file's line endings.
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJSON(f, data) {
  const crlf = fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('\r\n');
  const s = JSON.stringify(data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
}
const dirOf = (world) => (fs.existsSync(path.join(root, 'scenarios', world)) ? path.join(root, 'scenarios', world) : path.resolve(world));

// The backend from the flags: KoboldCpp on this computer by default.
export function configure(E, flags, env) {
  const which = flags.backend === 'external' ? 'external' : 'local';
  const b = E.settings.backends[which];
  if (flags.url) b.url = flags.url;
  if (flags.model) b.model = flags.model;
  if (flags.context) b.context = Number(flags.context) || b.context;
  if (which === 'external') {
    b.preset = /openrouter\.ai/.test(b.url) ? 'openrouter' : 'custom';
    b.key = (env || {}).ENSEMBLE_API_KEY || '';
    if (!b.key) throw new Error('Set ENSEMBLE_API_KEY to the API key (it is never saved).');
    if (!b.model) throw new Error('Name the model with --model.');
  }
  E.settings.routing.worldbuild = which;
  return which;
}

// One command. deps: { fetch, env, log } (tests pass their own).
export async function main(argv, deps) {
  const { cmd, world, flags } = parseArgs(argv);
  const log = deps.log || console.log;
  if (!['plan', 'run', 'apply'].includes(cmd) || !world) { log(USAGE); return 1; }
  const dir = dirOf(world);
  if (!fs.existsSync(path.join(dir, 'world.json'))) { log(`No world.json in ${dir}.`); return 1; }
  const jobPath = path.join(dir, 'research.json');
  const E = loadEngine({ fetch: deps.fetch });
  const files = worldFiles(dir);
  const loaded = E.Scenario.prepareWorld(path.basename(dir), JSON.parse(JSON.stringify(files)));

  if (cmd === 'plan') {
    if (fs.existsSync(jobPath)) { log(`${jobPath} exists: edit it, or delete it to plan again.`); return 1; }
    const job = E.Research.newJob(loaded, {
      files, wiki: flags.wiki, startId: flags.start, asOf: flags['as-of'], calendar: flags.date ? { date: flags.date } : null,
      perTopic: flags['per-topic'] ? Number(flags['per-topic']) : null, checkKnown: !!flags['check-known'], brief: !!flags.brief,
    });
    writeJSON(jobPath, job);
    log(`Planned ${job.topics.length} topics in ${jobPath}:`);
    job.topics.forEach((t) => log(`  - ${t.name} (${t.about})${t.status === 'has lore' ? `: skipped, ${t.note}` : ''}`));
    if (job.brief) log('Brief: each topic is one summary of its page\'s opening ("brief": false on a topic reads all of it).');
    log('Topics that already have your lore are skipped, and stay skipped while they have it ("force": true researches one anyway).');
    log('Trim it before running: set "skip": true on topics that need no research (general knowledge, made-up people),');
    log('or give one a "page" (a wiki page title), a "url", or pasted "text". Then: npm run research -- run ' + world);
    return 0;
  }

  if (!fs.existsSync(jobPath)) { log(`No ${jobPath} yet: run "plan" first.`); return 1; }
  const job = readJSON(jobPath);
  if (cmd === 'run') {
    const which = configure(E, flags, deps.env);
    const b = E.LLM.backendFor('worldbuild');
    log(`Researching with the ${which} backend (${b.model || b.label} at ${b.url}).`);
    const ctx = E.Research.context(loaded, job, files);
    await E.Research.run(ctx, { fetch: deps.fetch, save: () => writeJSON(jobPath, job), onProgress: (m) => log('  ' + m) });
  }
  // Write the drafts: lore/research.json and world.json's timeline.
  const out = E.Research.apply(files, job);
  writeJSON(path.join(dir, 'lore', `${E.Research.PACKET}.json`), files[`lore/${E.Research.PACKET}.json`]);
  writeJSON(path.join(dir, 'world.json'), files['world.json']);
  writeJSON(jobPath, job); // what was written, so the next apply knows what the author changed
  const count = (s) => job.topics.filter((t) => t.status === s && !t.skip).length;
  log(`Topics: ${count('done')} done, ${count('known')} already known to the model, ${count('no source')} without a source, ${count('failed')} failed, ${count('has lore')} with lore of yours already, ${job.topics.filter((t) => t.skip).length} skipped.`);
  job.topics.filter((t) => t.status === 'failed').forEach((t) => log(`  failed: ${t.name}: ${t.error} (run again to retry)`));
  log(`Wrote ${out.entries} draft lore entries (lore/${E.Research.PACKET}.json) and ${out.events} draft timeline events (world.json); ${out.kept} entries of yours kept as they are${out.settled ? `, and ${out.settled} drafts you accepted, edited or deleted not written again` : ''}.`);
  if (job.suggestions.secrets.length) {
    log('Secrets found (not written; add them to the characters yourself if they fit):');
    job.suggestions.secrets.forEach((s) => log(`  - ${s.who}: ${s.text}`));
  }
  if (job.suggestions.events.length) {
    log('Later events without a date' + (job.calendar ? '' : ' (plan with --date YYYY-MM-DD to place dated ones)') + ':');
    job.suggestions.events.forEach((ev) => log(`  - ${ev.date ? ev.date + ': ' : ''}${ev.text}`));
  }
  log('Review the drafts in the creator (Lore and Timeline tabs): the game uses none of them until you accept them.');
  try {
    E.Scenario.prepareWorld(path.basename(dir), worldFiles(dir));
  } catch (err) {
    log(`The world now has problems to fix in the creator:\n${err.message}`);
    return 2;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { fetch: globalThis.fetch, env: process.env }).then((code) => process.exit(code), (err) => { console.error(err.message || err); process.exit(1); });
}
