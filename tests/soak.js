// The headless run harness (task B-9): plays hundreds of turns of a world with
// a seeded mock model (or a real one), logs one sample a turn, and reports what
// looks wrong. play() makes the log, alarms() reads it (plain functions over
// samples, so a test can trip each alarm with a made-up log), report() writes
// it up, and capture() turns an alarm into a replay fixture by playing the same
// seed again and recording the turns before it. `npm run soak` is tools/soak.mjs.
const path = require('path');
const { loadEngine, loadLibrary, readWorld, scenarioFolders } = require('./helpers');
const { createMock, seeded } = require('./soakmock');
const genMock = require('./genmock');
const { replay } = require('./replay');

// Every limit an alarm uses, in one place.
const LIMITS = {
  clockGrace: 2, // a clock is stuck after this many times its expected hours
  clockRacing: 0.5, // of a life's turns, with at least minTurns turns
  minTurns: 30, // a life or run shorter than this says nothing about rates
  pinnedTurns: 25, // turns in a row at a limit
  pinHigh: 0.98,
  pinLow: 0.02,
  statueTurns: 60, // turns a person must be in play before "never moved" counts
  pacer: 0.8, // of the turns they were in play
  growthShare: 0.1, // each of the last three quarters rises by this much
  growthMin: 5, // ...and by at least this many
  growthTurns: 60,
  factsPerTurn: 6,
  saveMB: 8,
  squeezed: 0.2, // share of calls that had to be cut to fit
  overStretch: 1.5, // facts or chapters this far over their budget
  overTurns: 10, // ...this many turns in a row
  guardShare: 0.5,
  repeatCount: 4, // the same event this many times...
  repeatWindow: 20, // ...within this many turns
};

const AFTER_ENDING = 20; // turns of Keep playing before a new life
const TIRED = 0.9; // the scripted player goes to bed past this

// Guards that report ordinary business, not something going wrong.
const ROUTINE_GUARDS = new Set(['agenda step', 'cast tier', 'joined', 'ending', 'region tag faded', 'region revealed', 'clock stopped', 'site grown']);

// What the player does: stretches of one behaviour at a time.
const BEHAVIOURS = [['active', 0.45], ['travel', 0.2], ['passive', 0.25], ['skip', 0.1]];
const STEPS = { active: ['minute', 'moment', 'hour', 'hour', 'hours'], travel: ['moment', 'hour'], passive: ['hour', 'hours', 'morning'], skip: ['major'] };
const TALK = ['Ask around about what has been going on.', 'Help with whatever needs doing.', 'Look the place over carefully.', 'Have a quiet word with whoever is nearby.', 'Try to fix what is broken here.'];
const PASSIVE = ['Keep drinking coffee.', 'Eat something and get some rest.', 'Sit and wait.', 'Sleep for a while.'];

function pickBy(rand, table) {
  let r = rand() * table.reduce((a, [, w]) => a + w, 0);
  for (const [v, w] of table) if ((r -= w) <= 0) return v;
  return table[0][0];
}

// The next action: { mode, step, action, summary, moveTo, roll }.
function nextPlan(E, state, rand, script) {
  if (script.left <= 0) {
    script.mode = pickBy(rand, BEHAVIOURS);
    script.left = script.mode === 'skip' ? 1 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 10);
  }
  script.left--;
  const step = STEPS[script.mode][Math.floor(rand() * STEPS[script.mode].length)];
  const one = (list) => list[Math.floor(rand() * list.length)];
  // People look after themselves; ignoring a need is the passive stretches' job.
  if (script.mode !== 'passive' && script.mode !== 'skip' && Object.values(state.characters[state.player].needs).some((v) => v >= TIRED) && rand() < 0.7) {
    const action = 'Eat something and get some rest.';
    return { mode: 'rest', step: 'hours', moveTo: null, roll: false, action, summary: action };
  }
  const plan = { mode: script.mode, step, moveTo: null, roll: false };
  if (script.mode === 'travel') {
    const ways = E.Engine.linkedRooms(state, state.characters[state.player].status.location);
    const to = ways.length ? one(ways) : null;
    if (to) { plan.moveTo = to; plan.action = `Go to ${state.locations[to].name}.`; plan.summary = plan.action; return plan; }
  }
  if (script.mode === 'active' || script.mode === 'travel') { plan.action = one(TALK); plan.roll = rand() < 0.3; } else if (script.mode === 'skip') plan.action = 'Keep to the routine and see what comes.';
  else plan.action = one(PASSIVE);
  plan.summary = plan.action;
  return plan;
}

const hoursOf = (state) => state.time.day * 24 + state.time.hour;

// One turn's sample, kept small: a run keeps hundreds.
function sample(E, state, t, life, plan, calls) {
  const Eng = E.Engine, M = E.Memory;
  const people = Eng.cast(state, { alive: true, includePlayer: false });
  const needs = {};
  [state.player].concat(people).forEach((id) => { needs[id] = Object.assign({}, state.characters[id].needs); });
  const at = {};
  people.forEach((id) => { at[id] = state.characters[id].status.location; });
  const res = state.pending && state.pending.turn === state.turn ? state.pending.res : null;
  const budgets = M.budgets(state);
  const facts = M.factsBlock(state); // what reaches the prompts
  const last = Eng.telemetry[Eng.telemetry.length - 1];
  const save = t % 10 === 0 ? JSON.stringify(Object.assign({}, state, { undo: undefined })).length : null;
  return {
    t, life, turn: state.turn, hours: hoursOf(state), mode: plan.mode, step: plan.step,
    clocks: state.clocks.map((c) => ({ id: c.id, name: c.name, value: c.value, max: c.max, perHour: c.perHour, fired: !!c.fired, stopped: !!c.stopped, firedTurn: c.firedTurn ?? null })),
    needs, at,
    counts: { facts: state.facts.length, promptFacts: facts ? facts.split('\n').length : 0, extras: Object.keys(state.extras || {}).length, standees: Object.keys(state.standees || {}).length, clocks: Eng.liveClocks(state).length, tags: Object.values(state.characters).reduce((a, c) => a + (c.tags || []).length, 0) },
    tokens: { facts: E.estTokens(facts), story: E.estTokens(M.storyBlock(state)) },
    budgets: { facts: budgets.facts, story: budgets.story },
    guards: last ? last.guards.map((g) => g.type) : [],
    events: res ? (res.director || []).map((d) => d.text).concat(res.major ? [res.major.text] : []) : [],
    calls: calls.splice(0),
    save,
  };
}

// What each ending looks like when a life closes. status: 'reached', 'broken'
// (it names something that isn't in this game), 'held' (what it waits for
// happened and it still wasn't reached) or 'open' (needs the player or the
// model, or just hasn't come up).
function endingFacts(E, state) {
  const now = hoursOf(state);
  const reached = state.endingsReached || [];
  const clocks = JSON.stringify(state.scenario.clocks || []) + JSON.stringify(state.clocks);
  const canon = state.canon || {};
  const timeline = JSON.stringify(state.scenario.timeline || []);
  return E.Engine.endingsOf(state).map((e) => {
    const w = e.when && typeof e.when === 'object' ? e.when : {};
    const out = { id: e.id, title: e.title || e.id, judged: !!w.judged, status: 'open', detail: '' };
    if (reached.includes(e.id)) return Object.assign(out, { status: 'reached' });
    const set = (status, detail) => Object.assign(out, { status, detail });
    if (w.clock && !clocks.includes(`"id":"${w.clock}"`)) return set('broken', `waits for a pressure "${w.clock}" this start doesn't have`);
    if (w.event && !canon[w.event] && !timeline.includes(`"id":"${w.event}"`)) return set('broken', `waits for a timeline event "${w.event}" this start doesn't have`);
    if (w.reach && !state.locations[w.reach] && !E.Engine.regionDef(state, w.reach)) return set('broken', `waits for a place "${w.reach}" that isn't on the map`);
    if (e.if && e.if.length) return out; // its conditions may not have held
    if (reached.length || state.flags.gameOver) return out; // the story stopped first
    if (w.clock && state.clocks.some((c) => c.id === w.clock && c.fired)) return set('held', `"${w.clock}" fired and the ending didn't follow`);
    if (w.event && canon[w.event] && !['dropped', 'past', 'pending', 'future'].includes(canon[w.event].status)) return set('held', `"${w.event}" happened and the ending didn't follow`);
    if (w.after && now >= E.Timeline.at(w.after) + 48) return set('held', 'its time passed and the ending didn\'t follow');
    return out;
  });
}

// A start for a world with none, through the generated pipeline.
async function generatedStart(E, loaded, life) {
  const skills = {};
  const list = (loaded.bundle.world.skills || []).concat(E.DEFAULT_SKILLS).slice(0, 5);
  list.forEach((s, i) => { skills[typeof s === 'string' ? s : s.id] = i < 2 ? 3 : 2; });
  const base = genMock.replies();
  const replies = genMock.replies({ player: Object.assign({}, base.player, { skills }) });
  const regions = E.StartGen.regions(loaded.bundle.world);
  const region = regions.length ? regions[life % regions.length].id : undefined;
  const job = E.StartGen.newJob(loaded, { line: 'a trucker a long way from home', onePass: false, region, world: genMock.WORLD });
  await E.StartGen.run(loaded, job, {});
  if (!E.StartGen.done(job)) throw new Error(`generated start stopped at ${job.failed && job.failed.step}: ${job.failed && job.failed.error}`);
  return { sc: E.StartGen.scenario(loaded, job), replies };
}

const startIds = (loaded) => (loaded.starts || []).map((s) => (typeof s === 'string' ? s : s.id));

// Plays `turns` turns of a world, starting a new life whenever a story stops.
// opts: { world (folder), turns, seed, start, smaller, connect(E): a real
// model, set up instead of the mock; record: { from, to } makes a fixture of
// those turns (see capture); errorRate; onTurn(sample) }.
async function play(opts) {
  const { world, turns = 300, seed = 1, start, record } = opts;
  const E = loadEngine(opts.globals || {});
  E.Engine.telemetryMax = 2;
  try { loadLibrary(E); } catch (e) { /* worlds that ask for it say so */ }
  const engineDice = seeded(seed * 2654435761);
  const script = seeded(seed * 40503 + 1);
  E.rng = engineDice;
  E.LLM.perf = async () => null;
  if (opts.smaller) E.settings.backends.local.smallerCalls = true;
  const game = { state: null, plan: null, genReplies: null };
  const calls = [];
  E.LLM.onCall = (c) => calls.push({ kind: c.kind, tokens: c.estTokens, over: !!c.overBudget, squeezed: !!c.squeezed, error: c.error || null });
  if (opts.connect) await opts.connect(E);
  else {
    const reply = createMock(E, game, seed * 69069 + 7, { errorRate: opts.errorRate });
    E.LLM.transport = async (url, body, kind) => reply({ kind, user: body.messages[1].content });
  }

  const loaded = readWorld(world, E);
  const run = { world: path.basename(world), seed, turnsAsked: turns, model: opts.connect ? 'real' : 'mock', lives: [], samples: [], crashes: [], breaks: [0], fixture: null };
  const ids = startIds(loaded);
  let t = 0, lifeNo = 0;
  while (t < turns) {
    const startId = start || ids[lifeNo % (ids.length || 1)];
    let sc;
    try {
      if (ids.length) sc = E.Scenario.startScenario(loaded, startId);
      else { const g = await generatedStart(E, loaded, lifeNo); sc = g.sc; game.genReplies = g.replies; }
    } catch (err) {
      run.crashes.push({ t, life: lifeNo, turn: 0, action: `start ${startId || 'generated'}`, message: String(err.message || err) });
      break;
    }
    const state = (game.state = E.Engine.newGame(sc));
    const life = { n: lifeNo, start: startId || 'generated', from: t, why: 'turns ran out', endings: [], turns: 0, kept: 0 };
    run.lives.push(life);
    const stepper = { left: 0, mode: 'active' };
    while (t < turns) {
      const plan = (game.plan = nextPlan(E, state, script, stepper));
      if (record && t === record.from) E.Recorder.start(state, `soak ${run.world} seed ${seed}, turns ${record.from}–${record.to}`);
      let crashed = null;
      try {
        await E.Engine.runTurn(state, plan.action, plan.step, null, null);
      } catch (err) {
        crashed = err;
        run.crashes.push({ t, life: lifeNo, turn: state.turn, action: plan.action, step: plan.step, message: String(err.message || err) });
      }
      const s = sample(E, state, t, lifeNo, plan, calls);
      run.samples.push(s);
      if (opts.onTurn) opts.onTurn(s);
      t++;
      life.turns++;
      if (record && t > record.to) { run.fixture = E.Recorder.stop(); return run; }
      if (crashed) { life.why = `crashed: ${crashed.message}`; break; }
      if (life.keptAt != null && t - life.keptAt >= AFTER_ENDING) { life.why = `kept playing past ${state.ending.title}`; break; }
      if (state.flags.gameOver) { life.why = 'the player died'; break; }
      if (E.Engine.ended(state)) {
        // Sometimes Keep playing, to see the story go on after its ending.
        if (life.kept < 2 && script() < 0.3) {
          E.Engine.keepPlaying(state);
          life.kept++;
          life.keptAt = t;
          run.breaks.push(t);
          continue;
        }
        life.why = `ending: ${state.ending.title}`;
        break;
      }
    }
    life.endings = endingFacts(E, state);
    life.end = { time: E.fmtTime(state), facts: state.facts.length, chapters: state.chapters.length };
    run.breaks.push(t);
    lifeNo++;
    if (t < turns && E.Recorder.active()) E.Recorder.stop();
  }
  if (record) run.fixture = E.Recorder.stop();
  return run;
}

// ---------- alarms ----------
// Each takes one life's samples and limits and returns
// [{ id, subject, t, detail }]; subject makes an alarm's key (id:subject).
const inPlay = (samples, id) => samples.filter((s) => s.at[id] !== undefined);
const LIFE_ALARMS = {
  clockStuck(ss, L) {
    const last = ss[ss.length - 1], out = [];
    (last ? last.clocks : []).forEach((c) => {
      const seen = ss.filter((s) => s.clocks.some((x) => x.id === c.id));
      if (c.fired || c.stopped || c.firedTurn != null || !(c.perHour > 0)) return; // a repeating one starts over at 0
      const hours = last.hours - seen[0].hours;
      const expected = c.max / c.perHour;
      if (hours > expected * L.clockGrace && c.value < c.max) out.push({ id: 'clockStuck', subject: c.id, t: last.t, detail: `"${c.name}" should have run out in about ${Math.round(expected)} hours; ${Math.round(hours)} went by and it stands at ${c.value.toFixed(1)} of ${c.max}` });
    });
    return out;
  },
  clockRacing(ss, L) {
    if (ss.length < L.minTurns) return [];
    const fires = {};
    ss.forEach((s, i) => s.clocks.forEach((c) => {
      const before = i ? ss[i - 1].clocks.find((x) => x.id === c.id) : null;
      if (c.firedTurn != null && c.firedTurn !== (before ? before.firedTurn : null)) (fires[c.id] = fires[c.id] || []).push(s);
    }));
    return Object.entries(fires).filter(([, at]) => at.length / ss.length > L.clockRacing).map(([id, at]) => ({ id: 'clockRacing', subject: id, t: at[0].t, detail: `fired on ${at.length} of ${ss.length} turns` }));
  },
  pinned(ss, L) {
    const out = [], runs = {};
    ss.forEach((s) => Object.entries(s.needs).forEach(([who, needs]) => Object.entries(needs).forEach(([need, v]) => {
      const key = `${who}/${need}`;
      const limit = v >= L.pinHigh ? 'top' : v <= L.pinLow ? 'bottom' : null;
      const r = runs[key] || (runs[key] = { limit: null, n: 0, done: false });
      r.n = limit && limit === r.limit ? r.n + 1 : limit ? 1 : 0;
      r.limit = limit;
      if (r.n >= L.pinnedTurns && !r.done) {
        r.done = true;
        out.push({ id: 'pinned', subject: key, t: s.t, detail: `${who}'s ${need} sat at the ${limit} for ${r.n} turns in a row` });
      }
    })));
    return out;
  },
  statue(ss, L) {
    const ids = [...new Set(ss.flatMap((s) => Object.keys(s.at)))];
    return ids.filter((id) => {
      const seen = inPlay(ss, id);
      return seen.length >= L.statueTurns && new Set(seen.map((s) => s.at[id])).size === 1;
    }).map((id) => ({ id: 'statue', subject: id, t: ss[ss.length - 1].t, detail: `${id} never left ${inPlay(ss, id)[0].at[id]} in ${inPlay(ss, id).length} turns` }));
  },
  pacer(ss, L) {
    const ids = [...new Set(ss.flatMap((s) => Object.keys(s.at)))];
    return ids.flatMap((id) => {
      const seen = inPlay(ss, id);
      if (seen.length < L.minTurns) return [];
      const moves = seen.filter((s, i) => i && s.at[id] !== seen[i - 1].at[id]).length;
      return moves / (seen.length - 1) >= L.pacer ? [{ id: 'pacer', subject: id, t: seen[seen.length - 1].t, detail: `${id} moved on ${moves} of ${seen.length} turns` }] : [];
    });
  },
  growth(ss, L) {
    if (ss.length < L.growthTurns) return [];
    const quarter = Math.floor(ss.length / 4);
    const out = [];
    // Facts keep growing by design, and factsBlock fits them to their budget
    // (overBudget watches that); these have no such limit.
    ['extras', 'standees', 'clocks', 'tags'].forEach((k) => {
      const v = [1, 2, 3, 4].map((q) => ss[Math.min(ss.length - 1, q * quarter - 1)].counts[k]);
      const rising = [1, 2, 3].every((i) => v[i] - v[i - 1] >= Math.max(L.growthMin, v[i - 1] * L.growthShare));
      if (rising) out.push({ id: 'growth', subject: k, t: ss[ss.length - 1].t, detail: `${k} kept climbing: ${v.join(' → ')}` });
    });
    const last = ss[ss.length - 1];
    if (last.counts.facts / ss.length > L.factsPerTurn) out.push({ id: 'growth', subject: 'facts', t: last.t, detail: `${last.counts.facts} facts in ${ss.length} turns` });
    const saved = ss.filter((s) => s.save != null).pop();
    if (saved && saved.save > L.saveMB * 1e6) out.push({ id: 'growth', subject: 'save', t: saved.t, detail: `the save reached ${(saved.save / 1e6).toFixed(1)} MB` });
    return out;
  },
  overBudget(ss, L) {
    const out = [];
    const calls = ss.flatMap((s) => s.calls.map((c) => Object.assign({ t: s.t }, c)));
    const over = calls.filter((c) => c.over);
    if (over.length) out.push({ id: 'overBudget', subject: 'context', t: over[0].t, detail: `${over.length} calls ran past the context window (largest ${Math.max(...over.map((c) => c.tokens))} tokens, ${over[0].kind})` });
    const cut = calls.filter((c) => c.squeezed);
    if (calls.length >= L.minTurns && cut.length / calls.length >= L.squeezed) out.push({ id: 'overBudget', subject: 'squeezed', t: cut[0].t, detail: `${cut.length} of ${calls.length} calls had to be cut to fit` });
    ['facts', 'story'].forEach((k) => {
      let n = 0, done = false;
      ss.forEach((s) => {
        n = s.tokens[k] > s.budgets[k] * L.overStretch ? n + 1 : 0;
        if (n >= L.overTurns && !done) {
          done = true;
          out.push({ id: 'overBudget', subject: k, t: s.t, detail: `${k} stood at ${s.tokens[k]} tokens against a budget of ${s.budgets[k]} for ${n} turns` });
        }
      });
    });
    return out;
  },
  constantGuard(ss, L) {
    if (ss.length < L.minTurns) return [];
    const turns = {};
    ss.forEach((s) => new Set(s.guards).forEach((g) => { if (!ROUTINE_GUARDS.has(g)) (turns[g] = turns[g] || []).push(s.t); }));
    return Object.entries(turns).filter(([, at]) => at.length / ss.length >= L.guardShare).map(([g, at]) => ({ id: 'constantGuard', subject: g, t: at[0], modelDependent: true, detail: `"${g}" fired on ${at.length} of ${ss.length} turns` }));
  },
  repeatedEvents(ss, L) {
    const seen = {}, out = [], done = new Set();
    ss.forEach((s) => s.events.forEach((text) => {
      const key = String(text).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const at = (seen[key] = (seen[key] || []).concat(s.turn).filter((x) => s.turn - x < L.repeatWindow));
      if (at.length >= L.repeatCount && !done.has(key)) {
        done.add(key);
        out.push({ id: 'repeatedEvents', subject: key.slice(0, 40), t: s.t, modelDependent: true, detail: `"${String(text).slice(0, 80)}" happened ${at.length} times in ${L.repeatWindow} turns` });
      }
    }));
    return out;
  },
};

// A run's alarms, one per key, with how many lives tripped it.
function alarms(run, limits) {
  const L = Object.assign({}, LIMITS, limits);
  const found = new Map();
  const add = (a) => {
    const key = `${a.id}:${a.subject}`;
    if (found.has(key)) found.get(key).times++;
    else found.set(key, Object.assign({ key, times: 1 }, a));
  };
  run.crashes.forEach((c) => add({ id: 'crash', subject: c.message.slice(0, 60), t: c.t, detail: `turn ${c.turn}, "${c.action}" (${c.step || 'start'}): ${c.message}` }));
  run.lives.forEach((life) => {
    const ss = run.samples.filter((s) => s.life === life.n);
    if (ss.length) Object.values(LIFE_ALARMS).forEach((f) => f(ss, L).forEach(add));
    life.endings.filter((e) => e.status === 'broken' || e.status === 'held').forEach((e) => add({ id: 'endingOutOfReach', subject: e.id, t: ss.length ? ss[ss.length - 1].t : 0, detail: `"${e.title}" ${e.detail}` }));
  });
  return [...found.values()];
}

// tests/soak-known.json: { world: { "id:subject" or "id:*": why } }.
function isKnown(known, world, alarm) {
  const k = (known && known[world]) || {};
  return !!(k[alarm.key] || k[`${alarm.id}:*`]);
}

// ---------- fixtures ----------
// The turns up to an alarm, as a recording: the same seed again, recording from
// up to `before` turns ahead of it (never across a new life or Keep playing,
// which aren't recorded actions). Replayed once to prove it plays.
async function capture(opts, run, alarm, before = 20) {
  const from = Math.max(alarm.t - before, ...run.breaks.filter((b) => b <= alarm.t));
  const again = await play(Object.assign({}, opts, { turns: alarm.t + 1, record: { from, to: alarm.t } }));
  const fixture = again.fixture;
  if (!fixture || !fixture.actions.length) throw new Error('nothing was recorded');
  await replay(JSON.parse(JSON.stringify(fixture)));
  return fixture;
}

// ---------- the report ----------
function report(run, found, known) {
  const lines = [`# Soak: ${run.world}`, '', `Seed ${run.seed}, ${run.samples.length} turns, ${run.lives.length} ${run.lives.length === 1 ? 'life' : 'lives'}, ${run.model} model.`, ''];
  const fresh = found.filter((a) => !isKnown(known, run.world, a));
  const old = found.filter((a) => isKnown(known, run.world, a));
  lines.push(`## Alarms: ${fresh.length} new, ${old.length} known`, '');
  const row = (a) => `- **${a.key}**${a.times > 1 ? ` (${a.times} lives)` : ''}: ${a.detail}${a.modelDependent && run.model === 'mock' ? ' *(depends partly on the mock)*' : ''}`;
  fresh.forEach((a) => lines.push(row(a) + (a.fixture ? ` Fixture: \`${a.fixture}\`.` : '')));
  old.forEach((a) => lines.push(`${row(a)} *Known: ${known[run.world][a.key] || known[run.world][`${a.id}:*`]}*`));
  if (!found.length) lines.push('None.');
  lines.push('', '## Lives', '', '| life | start | turns | ended by | in-game end | facts | chapters |', '|---|---|---|---|---|---|---|');
  run.lives.forEach((l) => lines.push(`| ${l.n + 1} | ${l.start} | ${l.turns} | ${l.why} | ${l.end ? l.end.time : ''} | ${l.end ? l.end.facts : ''} | ${l.end ? l.end.chapters : ''} |`));
  const endings = {};
  run.lives.forEach((l) => l.endings.forEach((e) => {
    const x = endings[e.id] || (endings[e.id] = { title: e.title, judged: e.judged, reached: 0 });
    if (e.status === 'reached') x.reached++;
  }));
  if (Object.keys(endings).length) {
    lines.push('', '## Endings', '');
    Object.values(endings).forEach((e) => lines.push(`- ${e.title}: ${e.reached ? `reached ${e.reached} times` : e.judged ? 'not tested (the model judges it)' : 'not reached'}`));
  }
  const clocks = {};
  run.samples.forEach((s, i) => s.clocks.forEach((c) => {
    const x = clocks[c.id] || (clocks[c.id] = { name: c.name, fires: 0, seen: null });
    if (c.firedTurn != null && c.firedTurn !== x.seen) { x.fires++; x.seen = c.firedTurn; }
    x.value = c.value; x.max = c.max;
  }));
  if (Object.keys(clocks).length) {
    lines.push('', '## Pressures', '', '| pressure | fired | last value |', '|---|---|---|');
    Object.values(clocks).slice(0, 30).forEach((c) => lines.push(`| ${c.name} | ${c.fires} | ${Number(c.value).toFixed(1)} of ${c.max} |`));
  }
  const guards = {};
  run.samples.forEach((s) => s.guards.forEach((g) => { guards[g] = (guards[g] || 0) + 1; }));
  const sorted = Object.entries(guards).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (sorted.length) {
    lines.push('', '## Guards', '', '| guard | times |', '|---|---|');
    sorted.forEach(([g, n]) => lines.push(`| ${g} | ${n} |`));
  }
  const kinds = {};
  let largest = 0;
  run.samples.forEach((s) => s.calls.forEach((c) => { kinds[c.kind] = (kinds[c.kind] || 0) + 1; largest = Math.max(largest, c.tokens || 0); }));
  lines.push('', '## Calls', '', `Largest ${largest} tokens. ` + Object.entries(kinds).map(([k, n]) => `${k}: ${n}`).join(', ') + '.', '');
  return lines.join('\n');
}

const bundledWorlds = () => scenarioFolders();

module.exports = { LIMITS, ROUTINE_GUARDS, LIFE_ALARMS, play, alarms, isKnown, capture, report, endingFacts, bundledWorlds };
