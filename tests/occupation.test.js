// The occupied France world (task 7-1) and what building it changed in the
// engine: a real calendar, authored canon events that change many regions at
// once, holders summarised through the tree, a big world's outline, routes
// listed once, maps on a region's own map, and a made character's keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, newGame, mockLLM } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const WORLD = 'occupied-france';
// Fires the world's canon events in order, as written, up to and including one.
function fireUntil(E, state, lastId) {
  const res = { events: [], guards: [] };
  for (const ev of state.scenario.timeline) {
    if (E.Timeline.at(ev.when) <= E.Timeline.at(state.scenario.start)) continue;
    state.time.day = ev.when.day; state.time.hour = ev.when.hour;
    E.Timeline.resolveDue(state, [{ ev, broken: E.Timeline.broken(state, ev) }], [], res);
    if (ev.id === lastId) break;
  }
  return res;
}
const depts = (state) => state.scenario.regions.filter((r) => r.label === 'département');

// ---------- the calendar ----------

test('a world with a calendar names its days as dates; one without keeps "Day 12"', () => {
  const E = loadEngine();
  const sc = { calendar: { day1: '1939-09-01' } };
  assert.equal(E.dayName(sc, 1), 'Friday 1 September 1939');
  assert.equal(E.dayOfDate(sc, '1942-04-16'), 959);
  assert.equal(E.dayName(sc, 959), 'Thursday 16 April 1942');
  assert.equal(E.dayName(sc, E.dayOfDate(sc, '1944-02-29')), 'Tuesday 29 February 1944', 'leap years');
  assert.equal(E.dayName({ timeLabel: 'Sol' }, 214), 'Sol 214');
  assert.equal(E.dayName({}, 3), 'Day 3');
  assert.equal(E.Timeline.fmt(sc, { day: 959, hour: 8 }), 'Thursday 16 April 1942, 08:00');

  const { state } = newGame(WORLD, 'roquette');
  assert.equal(E.fmtTime(state), 'Thursday 16 April 1942, 08:00');
  assert.match(state.chapters[0].summary, /^Tuesday 18 June 1940: From London/, 'the past is dated too');
  // Validation: a real date or nothing.
  for (const bad of [{ day1: '1942-02-30' }, { day1: '16/04/1942' }, '1939-09-01']) {
    assert.throws(() => E.Scenario.prepareWorld('w', { 'world.json': { title: 'T', setting: 'S', calendar: bad } }), /"calendar" must be/);
  }
});

// ---------- the world ----------

test('occupied France loads with no warnings: 90 départements of 1942, the 13 the line cut split along it, three city maps', () => {
  const w = readWorld(WORLD);
  assert.deepEqual([...w.warnings], [], 'regions drawn on France\'s and the cities\' own maps count as on the map');
  assert.deepEqual(w.starts.map((s) => s.error || 'ok'), ['ok', 'ok']);
  const { E, state } = newGame(WORLD, 'roquette');
  const sc = state.scenario;
  const ds = depts(state);
  assert.equal(new Set(ds.map((d) => d.key)).size, 90, 'Seine, Seine-et-Oise and one Corse, as in 1942');
  ['Seine', 'Seine-et-Oise', 'Corse', 'Basses-Pyrénées (occupied)', 'Loire-Inférieure', 'Seine-Inférieure'].forEach((n) => assert.ok(ds.some((d) => d.name === n), n));
  ['Paris', 'Yvelines', 'Essonne', 'Haute-Corse'].forEach((n) => assert.ok(!ds.some((d) => d.name === n), `${n} is later`));
  const cut = ds.filter((d) => /-(free|occupied)$/.test(d.id));
  assert.equal(cut.length, 26);
  cut.forEach((d) => assert.equal(d.parent, d.id.endsWith('-free') ? 'free' : 'occupied', d.id));
  assert.equal(ds.find((d) => d.id === 'allier-free').controller, 'vichy');
  assert.equal(sc.regions.find((r) => r.id === 'vichy').parent, 'allier-free', 'Vichy is on the free side of Allier');
  // Paris → Seine → Occupied Zone → France; Lyon's seven arrondissements of 1942.
  assert.deepEqual([...E.Scenario.regionChainIn(sc.regions, 'paris-11')], ['paris-11', 'paris', 'seine', 'occupied', 'france']);
  assert.equal(sc.regions.filter((r) => r.parent === 'lyon').length, 7);
  assert.equal(sc.regions.filter((r) => r.parent === 'marseille').length, 16);
  ['seine', 'lyon', 'marseille', 'france'].forEach((id) => assert.ok(sc.regions.find((r) => r.id === id).map, `${id} has a map`));
});
test('crossing the demarcation line is closed until it is lifted, and can be risked; the line is no free border', () => {
  const { E, state } = newGame(WORLD, 'roquette');
  const trip = E.Engine.regionTrip(state, 'paris-11', 'lyon-1');
  assert.equal(trip.blocked, true);
  assert.equal(trip.risky, true);
  assert.match(trip.why, /demarcation line to Free Zone needs demarcation line is "lifted"/);
  const split = E.Engine.regionTrip(state, 'cher-occupied', 'cher-free');
  assert.equal(split.blocked, true, 'the two halves of Cher are not next door');
  assert.ok(!E.Engine.regionTrip(state, 'paris-11', 'nord').blocked, 'the Nord is reached freely from the occupied zone');
  state.world['demarcation line'] = 'lifted';
  const open = E.Engine.regionTrip(state, 'paris-11', 'lyon-1');
  assert.ok(!open.blocked);
  assert.ok(open.legs.some((e) => e.kind === 'demarcation line'));
  // The escape lines: over the Pyrenees is a risk, never open.
  const pyrenees = E.Engine.regionTrip(state, 'lyon-1', 'spain');
  assert.equal(pyrenees.blocked, true);
  assert.equal(pyrenees.risky, true);
});

// ---------- authored events ----------

test('an authored canon event hands a whole zone over at once; the model\'s events stay rationed', () => {
  const { E, state } = newGame(WORLD, 'roquette');
  const res = fireUntil(E, state, 'anton');
  assert.equal(state.canon.anton.status, 'fired');
  assert.ok(!res.guards.some((g) => g.type === 'effect rejected'), JSON.stringify(res.guards.filter((g) => g.type === 'effect rejected')));
  const holder = (id) => state.regions[id].controller;
  ['lyon', 'lyon-1', 'marseille-2', 'vichy', 'allier-free', 'haute-garonne', 'bouches-du-rhone'].forEach((id) => assert.equal(holder(id), 'germany', id));
  ['alpes-maritimes', 'savoie', 'corse', 'monaco'].forEach((id) => assert.equal(holder(id), 'italy', id));
  assert.equal(holder('algeria'), 'allies', 'Torch came three days before');

  // The same three changes from the model: one is applied.
  const { E: E2, state: s2 } = newGame(WORLD, 'roquette');
  const r2 = { guards: [] };
  E2.Engine.applyEffects(s2, { control: [{ region: 'cher-free', to: 'germany' }, { region: 'indre', to: 'germany' }, { region: 'creuse', to: 'germany' }] }, 'regional', r2);
  assert.equal(s2.regions['cher-free'].controller, 'germany');
  assert.equal(s2.regions.indre.controller, 'vichy');
  assert.ok(r2.guards.some((g) => g.type === 'effect rejected' && /only 1 allowed/.test(g.detail)));
  // A projected event is the model's too.
  const r3 = { events: [], guards: [] };
  const ev = { id: 'projected-1-1', when: s2.time, scope: 'regional', region: 'free', text: 'Troops move south.', projected: true,
    effects: { control: [{ region: 'indre', to: 'germany' }, { region: 'creuse', to: 'germany' }] } };
  E2.Timeline.happen(s2, ev, ev, r3, 'fired');
  assert.equal(s2.regions.creuse.controller, 'vichy');
});

test('a region with no holder of its own names the one group that holds everything inside it', () => {
  const { E, state } = newGame(WORLD, 'roquette');
  assert.equal(E.Engine.regionHolder(state, 'occupied').text, 'The German occupation (all of it)');
  assert.equal(E.Engine.regionHolder(state, 'france').text, 'no single holder (The German occupation holds 3 of 4, The French State (Vichy) holds 1 of 4)', 'France counts its zones by who holds what is inside them');
  fireUntil(E, state, 'anton');
  const free = E.Engine.regionHolder(state, 'free');
  assert.equal(free.mixed, true);
  assert.match(free.text, /The German occupation holds \d+ of \d+, Kingdom of Italy holds 9 of/);
});

test('by the liberation of Strasbourg every département is back in French hands, and the story ends there', () => {
  const { E, state } = newGame(WORLD, 'roquette');
  const res = fireUntil(E, state, 'strasbourg');
  assert.ok(!res.guards.some((g) => g.type === 'effect rejected' || g.type === 'canon dropped'), JSON.stringify(res.guards.filter((g) => g.type !== 'canon fired')));
  const still = [...depts(state).filter((d) => state.regions[d.id].controller !== 'free-french').map((d) => d.id)];
  assert.deepEqual(still, []);
  ['paris', 'paris-11', 'lyon-1', 'marseille-2', 'vichy', 'menton'].forEach((id) => assert.equal(state.regions[id].controller, 'free-french', id));
  assert.equal(state.world['demarcation line'], 'lifted');
  E.Engine.checkEndings(state, res);
  assert.equal(state.ending && state.ending.id, 'timeline-strasbourg');
  assert.equal(state.ending.kind, 'bittersweet');
});

// ---------- prompts ----------

test('a big world\'s outline gives borders only along the start\'s chain, and the routes line lists each way once', () => {
  const { E, state } = newGame(WORLD, 'roquette');
  const header = E.Prompts.header(state);
  assert.match(header, /- paris-1: Louvre \(1st\), an arrondissement in Paris\n/, 'no neighbours off the chain');
  assert.match(header, /- france: France, a country — .*\(neighbours: /);
  const user = E.Prompts.intent(state, E.Engine.present(state), 'Look around.', 'a few minutes', 'moment', {});
  const routes = (typeof user === 'string' ? user : user.user).split('\n').find((l) => l.startsWith('Routes from here:'));
  const items = routes.replace('Routes from here: ', '').split(' | ');
  assert.equal(new Set(items).size, items.length, routes);
  assert.ok(E.estTokens(header) < 3600, `header ${E.estTokens(header)} tokens`);
});

// ---------- the starts ----------

test('a made character takes the authored player\'s place, keys and all', () => {
  const { E, state } = newGame(WORLD, 'roquette');
  const sc = state.scenario;
  const made = E.CharMaker.sample(sc);
  const out = E.CharMaker.withPlayer(sc, made);
  const link = out.locations.find((l) => l.id === 'backroom').links.find((k) => k.to === 'cellar');
  assert.deepEqual([...link.key], ['ferrand', made.id]);
  assert.ok(!out.characters.includes('vasseur'));
});

test('both starts play a turn with the dates of 1942 in the prompt', async () => {
  for (const id of ['roquette', 'traboules']) {
    const { E, state } = newGame(WORLD, id);
    const calls = mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { needs_roll: false }, intents: [], events: [] } : 'You listen to the street.'));
    await E.Engine.runTurn(state, 'Listen.', 'moment');
    assert.equal(state.turn, 1);
    assert.match(calls[0].user, /=== NOW: Thursday 16 April 1942, \d\d:00 ===/);
    assert.match(calls[0].system, /Chapter 0 — Before the story: Tuesday 18 June 1940/);
  }
});

// ---------- the map ----------

test('a map level leaves out what is drawn on a deeper map, and "you are here" is the nearest region of yours on the picture', () => {
  const { E, state } = newGame(WORLD, 'roquette');
  const sc = state.scenario;
  const ids = (lv) => [...lv.regions.map((r) => r.id)];
  const root = E.MapDraw.level(sc, null);
  assert.ok(ids(root).includes('france') && ids(root).includes('spain'));
  assert.ok(!ids(root).includes('seine') && !ids(root).includes('paris-11'), 'départements and arrondissements are on France\'s and Seine\'s maps');
  const france = E.MapDraw.level(sc, 'france');
  assert.ok(ids(france).includes('seine') && ids(france).includes('lyon'));
  assert.ok(!ids(france).includes('paris') && !ids(france).includes('paris-11'), 'Paris is on Seine\'s map');
  const branch = [...E.Engine.regionChain(state, 'paris-11')];
  const svg = (lv) => E.MapDraw.worldSvg({ g: lv.g, regions: lv.regions, now: state.regions, factions: state.factions, mine: 'paris-11', branch, viewBox: lv.viewBox, id: 'm', view: 'v', label: 'Map' });
  assert.match(svg(root), /aria-label="France, held by no one, you are here"/);
  assert.match(svg(france), /aria-label="Seine, held by The German occupation, you are here"/);
  assert.match(svg(E.MapDraw.level(sc, 'paris')), /aria-label="Popincourt \(11th\), held by The German occupation, you are here"/);
});
