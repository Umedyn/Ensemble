// Loads the browser engine scripts into an isolated Node VM context so the
// engine can be tested without a browser or a model.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ENGINE_FILES = ['util', 'llm', 'recorder', 'memory', 'prompts', 'engine', 'scenario'];

// extraGlobals lets a test provide browser objects such as localStorage.
function loadEngine(extraGlobals = {}) {
  const ctx = vm.createContext(Object.assign({ console, URL, setTimeout, clearTimeout }, extraGlobals));
  for (const f of ENGINE_FILES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f + '.js'), 'utf8'), ctx, { filename: `js/${f}.js` });
  }
  return ctx.Ensemble;
}

function readScenario(folder) {
  const dir = path.join(ROOT, 'scenarios', folder);
  const sc = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  sc.characterData = sc.characters.map((id) => JSON.parse(fs.readFileSync(path.join(dir, 'characters', id + '.json'), 'utf8')));
  sc.folder = folder;
  return sc;
}

function scenarioFolders() {
  return fs.readdirSync(path.join(ROOT, 'scenarios'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

// Fresh engine + new game. Returns { E, state }.
function newGame(folder = 'mars-station') {
  const E = loadEngine();
  const sc = E.Scenario.validate(readScenario(folder));
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

module.exports = { ROOT, loadEngine, readScenario, scenarioFolders, newGame, mockLLM, fixedRng };
