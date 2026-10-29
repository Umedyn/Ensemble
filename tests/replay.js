// Replays a recording (js/recorder.js) without a model: each action runs with
// its recorded random numbers and model replies, from the recorded start state.
// Fails with a ReplayError as soon as the engine does something the recording
// didn't: a different call, more or fewer calls or random draws, or an error
// that did (or didn't) happen. See tests/fixtures/README.md.
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('./helpers');

class ReplayError extends Error {
  constructor(message) { super(message); this.name = 'ReplayError'; }
}

function loadFixture(name) {
  const file = path.isAbsolute(name) ? name : path.join(__dirname, 'fixtures', name.endsWith('.json') ? name : name + '.json');
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (f.format !== 'ensemble-recording') throw new ReplayError(`${path.basename(file)} is not an Ensemble recording`);
  if (f.version !== 1) throw new ReplayError(`${path.basename(file)}: unsupported recording version ${f.version}`);
  return f;
}

// Recorded settings, with placeholder URLs (recordings never hold them).
function applySettings(E, s) {
  if (!s) return;
  ['narrateTokens', 'temperature', 'chapterLength', 'memoryCap'].forEach((k) => { if (s[k] != null) E.settings[k] = s[k]; });
  if (s.routing) E.settings.routing = Object.assign({}, E.defaults.routing, s.routing);
  Object.entries(s.backends || {}).forEach(([id, b]) => {
    E.settings.backends[id] = Object.assign({}, E.defaults.backends[id] || E.defaults.backends.local, b, { url: 'http://replay.invalid/v1', key: '' });
  });
}

// Recordings made before chapters closed by size (2026-10-27, chapterRule 2)
// close them as the engine did then: after the length, on a "story beat"
// (any of the moments that set flags.chapterWorthy, or the update's
// chapter_worthy) from the second turn, or when the facts outgrow the budget.
function oldChapterRule(E) {
  const M = E.Memory;
  M.needsChapter = function (state) {
    if (state.turn < state.chapterStartTurn) return false;
    if (M.turnsInChapter(state) >= E.settings.chapterLength) return 'length';
    if (state.flags.chapterWorthy && M.turnsInChapter(state) >= 2) return 'story beat';
    const facts = M.headerFacts(state).map((f) => `- [T${f.turn}] ${f.text}`).join('\n');
    return E.estTokens(facts) > M.budgets().facts ? 'size' : false;
  };
  const apply = E.Engine.applyUpdate;
  E.Engine.applyUpdate = function (state, upd, ...rest) {
    const out = apply.call(this, state, upd, ...rest);
    if (upd && upd.chapter_worthy === true) state.flags.chapterWorthy = true;
    return out;
  };
}

// replay(fixtureOrName, { until, setup, onCall }) → { E, state, steps: [{ index, action, state, result, error }] }
// until: stop after this many actions (default: all). setup(E): runs before the
// first action, to turn engine behaviour the recording predates off. Each step's state is a copy.
// onCall({ E, body, kind, recorded }): sees each request and its recorded call.
async function replay(fixture, opts = {}) {
  if (typeof fixture === 'string') fixture = loadFixture(fixture);
  const E = loadEngine();
  applySettings(E, fixture.settings);
  if (!fixture.settings || fixture.settings.chapterRule !== 2) oldChapterRule(E);
  if (opts.setup) opts.setup(E);
  E.LLM.perf = async () => null;
  const state = E.Engine.migrate(JSON.parse(JSON.stringify(fixture.start)));
  const actions = fixture.actions || [];
  const until = Math.min(opts.until ?? actions.length, actions.length);
  const steps = [];
  let cur = null, label = '', calls = 0, draws = 0;

  E.rng = () => {
    if (!cur || !cur.rng || draws >= cur.rng.length) {
      throw new ReplayError(`${label}: the engine drew more random numbers than recorded (${cur && cur.rng ? cur.rng.length : 0})`);
    }
    return cur.rng[draws++];
  };
  E.LLM.transport = async (url, body, kind) => {
    const rc = cur && cur.calls ? cur.calls[calls] : null;
    if (!rc) throw new ReplayError(`${label}, call ${calls + 1}: the engine made a "${kind}" call, but the recording has only ${cur && cur.calls ? cur.calls.length : 0}`);
    if (rc.kind !== kind) throw new ReplayError(`Replay mismatch at ${label}, call ${calls + 1}: engine made "${kind}", recording has "${rc.kind}"`);
    calls++;
    if (opts.onCall) opts.onCall({ E, body, kind, recorded: rc });
    if (rc.error) {
      const err = new Error(rc.error.message);
      err.name = rc.error.name || 'Error';
      throw err;
    }
    return { text: rc.response.text, finish: rc.response.finish, usage: rc.response.usage };
  };

  for (let i = 0; i < until; i++) {
    const a = actions[i];
    cur = a;
    calls = 0;
    draws = 0;
    label = `action ${i + 1} (${a.type}${a.action ? ` "${a.action}"` : ''})`;
    let result, error = null;
    try {
      if (a.type === 'turn') result = await E.Engine.runTurn(state, a.action, a.stepId, null, a.cutAt);
      else if (a.type === 'reroll') result = await E.Engine.rerollNarration(state);
      else if (a.type === 'undo') result = E.Engine.undo(state);
      else if (a.type === 'correct') result = E.Engine.correctAttitude(state, a.id, a.delta, a.why);
      else if (a.type === 'pin') result = E.Engine.setPinned(state, a.id, a.on);
      else throw new ReplayError(`${label}: unknown action type`);
    } catch (err) {
      if (err && err.name === 'ReplayError') throw err;
      error = err;
    }
    if (a.error && !error) throw new ReplayError(`${label}: the recording failed here ("${a.error.message}") but the replay didn't`);
    if (!a.error && error) throw new ReplayError(`${label}: failed in the replay but not in the recording: ${error.message}`);
    if (a.calls && calls < a.calls.length) throw new ReplayError(`${label}: the engine made ${calls} call(s); the recording has ${a.calls.length} (next: "${a.calls[calls].kind}")`);
    if (a.rng && draws < a.rng.length) throw new ReplayError(`${label}: the engine drew ${draws} random number(s); the recording has ${a.rng.length}`);
    steps.push({ index: i + 1, action: a, state: JSON.parse(JSON.stringify(state)), result, error });
  }
  return { E, state, steps };
}

module.exports = { replay, loadFixture, applySettings, ReplayError };
