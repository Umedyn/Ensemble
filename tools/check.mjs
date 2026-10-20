// Syntax-checks every script and validates every world folder (new format or
// legacy scenario.json), composing and validating each of its starts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let failed = 0;
for (const f of fs.readdirSync(path.join(root, 'js'))) {
  try { execFileSync(process.execPath, ['--check', path.join(root, 'js', f)], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error(`✕ js/${f}\n${e.stderr}`); }
}
const { readWorld, scenarioFolders } = require(path.join(root, 'tests', 'helpers.js'));
const index = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'index.json'), 'utf8'));
const listed = new Set((index.scenarios || index).map((x) => (typeof x === 'string' ? x : x.folder)));
for (const folder of scenarioFolders()) {
  try {
    const w = readWorld(folder);
    w.warnings.forEach((msg) => console.warn(`! ${folder}: ${msg}`));
    const broken = w.starts.filter((s) => s.error);
    broken.forEach((s) => { failed++; console.error(`✕ ${folder} start "${s.id}": ${s.error}`); });
    if (!broken.length) console.log(`✓ ${w.legacy ? 'scenario' : 'world'} ${folder} (${w.starts.length} start${w.starts.length === 1 ? '' : 's'})`);
  } catch (e) { failed++; console.error(`✕ ${folder}: ${e.message}`); }
  if (!listed.has(folder)) { failed++; console.error(`✕ ${folder} is not listed in scenarios/index.json`); }
}
if (failed) { console.error(`${failed} problem(s)`); process.exit(1); }
console.log('✓ all scripts parse');
