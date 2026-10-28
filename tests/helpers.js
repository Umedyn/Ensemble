// Loads the browser engine scripts into an isolated Node VM context so the
// engine can be tested without a browser or a model.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ENGINE_FILES = ['util', 'llm', 'recorder', 'memory', 'standing', 'lore', 'timeline', 'genres', 'prompts', 'engine', 'scenario', 'packs', 'charmaker', 'startgen', 'sites', 'geo', 'layouts', 'sitedraw', 'mapdraw', 'zip', 'cards', 'mapedit', 'loreedit', 'worldedit', 'siteedit', 'research'];

// extraGlobals lets a test provide browser objects such as localStorage.
function loadEngine(extraGlobals = {}) {
  const ctx = vm.createContext(Object.assign({ console, URL, setTimeout, clearTimeout }, extraGlobals));
  for (const f of ENGINE_FILES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f + '.js'), 'utf8'), ctx, { filename: `js/${f}.js` });
  }
  return ctx.Ensemble;
}

// A folder name under scenarios/, or an absolute path (test fixtures).
const folderDir = (folder) => (path.isAbsolute(folder) ? folder : path.join(ROOT, 'scenarios', folder));

// Every JSON file a world folder needs, as { relative path: parsed JSON }
// (what Scenario.prepareWorld takes). Missing files are left out.
function worldFiles(folder) {
  const dir = folderDir(folder);
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  const legacy = !fs.existsSync(path.join(dir, 'world.json'));
  const rootName = legacy ? 'scenario.json' : 'world.json';
  const files = { [rootName]: read(rootName) };
  const needed = legacy
    ? (files[rootName].characters || []).map((id) => `characters/${id}.json`)
    : [...(files[rootName].starts || []).map((id) => `starts/${id}.json`), ...(files[rootName].characters || []).map((id) => `characters/${id}.json`), ...(files[rootName].sites || []).map((id) => `sites/${id}.json`),
      ...(files[rootName].lore || []).filter((x) => typeof x === 'string').map((id) => `lore/${id}.json`)];
  needed.forEach((rel) => { if (fs.existsSync(path.join(dir, rel))) files[rel] = read(rel); });
  return files;
}

// A loaded world (Scenario.prepareWorld): every start composed and validated.
function readWorld(folder, E = loadEngine()) {
  return E.Scenario.prepareWorld(path.basename(folder), worldFiles(folder));
}

// The shared site map library (task 6-3) from a folder (default: library/),
// set on E so worlds that ask for it get its maps. → { maps, errors }
function loadLibrary(E, dir = path.join(ROOT, 'library')) {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  const index = read('index.json');
  const maps = {};
  (index.sites || []).forEach((e) => { try { maps[e.id] = read(`sites/${e.id}.json`); } catch (err) { /* reported as missing */ } });
  E.Scenario.library = Object.assign(E.Scenario.buildLibrary(index, maps), { assets: {} });
  return E.Scenario.library;
}

// A lore pack folder's files (task 5-7): pack.json and the lore/ files it
// lists, as { relative path: parsed JSON }. A name is under packs/.
function packFiles(folder) {
  const dir = path.isAbsolute(folder) ? folder : path.join(ROOT, 'packs', folder);
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  const files = { 'pack.json': read('pack.json') };
  (files['pack.json'].lore || []).filter((x) => typeof x === 'string').forEach((id) => { const rel = `lore/${id}.json`; if (fs.existsSync(path.join(dir, rel))) files[rel] = read(rel); });
  return files;
}
// The packs listed in packs/index.json, read (Packs.read).
function readPacks(E) {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', 'index.json'), 'utf8'));
  return (index.packs || []).map((f) => (typeof f === 'string' ? f : f.folder)).map((f) => E.Packs.read(f, packFiles(f)));
}

// The flat scenario, not yet validated: a legacy folder's scenario.json as it
// is, or a world's start (default: the first) composed.
function readScenario(folder, startId) {
  const files = worldFiles(folder);
  const name = path.basename(folder);
  if (files['scenario.json']) {
    const sc = files['scenario.json'];
    sc.characterData = sc.characters.map((id) => files[`characters/${id}.json`]);
    sc.folder = name;
    return sc;
  }
  const w = files['world.json'];
  const id = startId || w.starts[0];
  const characters = {};
  w.characters.forEach((c) => (characters[c] = files[`characters/${c}.json`]));
  const E = loadEngine();
  // Lore file ids become their entries, as Scenario.prepareWorld does.
  const world = w.lore == null ? w : Object.assign({}, w, { lore: E.Lore.resolve(w.lore, E.Scenario.loreFiles(files)).entries });
  return E.Scenario.compose(world, files[`starts/${id}.json`], characters, name);
}

function scenarioFolders() {
  return fs.readdirSync(path.join(ROOT, 'scenarios'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

// Fresh engine + new game from a world's start (default: its first). Returns { E, state }.
function newGame(folder = 'mars-station', startId) {
  const E = loadEngine();
  const sc = E.Scenario.startScenario(readWorld(folder, E), startId);
  return { E, state: E.Engine.newGame(sc) };
}

// Replaces the network with a handler: ({ kind, user, system }) => string | object.
// Objects are JSON-encoded. Records every call in the returned array.
function mockLLM(E, handler) {
  const calls = [];
  E.LLM.transport = async (url, body, kind) => {
    const call = { kind, url, user: body.messages[1].content, system: body.messages[0].content, body };
    calls.push(call);
    const out = await handler(call);
    return typeof out === 'string' ? out : JSON.stringify(out);
  };
  return calls;
}

// Deterministic dice: returns the values in order, then repeats the last.
function fixedRng(E, values) {
  let i = 0;
  E.rng = () => values[Math.min(i++, values.length - 1)];
}

module.exports = { ROOT, loadEngine, loadLibrary, packFiles, readPacks, worldFiles, readWorld, readScenario, scenarioFolders, newGame, mockLLM, fixedRng };
