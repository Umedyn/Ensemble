// Outlines that move (task A-11A): a region's map entry may list stages, each
// drawn while its conditions hold (what everyone can see). Occupied France's
// demarcation line moves to the Rhône once the Germans hold Vichy; the Oregon
// Trail's gold camp grows from a dot as the company takes it and builds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, mockLLM, worldFiles, loadEngine } = require('./helpers');

const LOTS = (state, n) => { for (let i = 1; i <= 6; i++) state.features[`poorman-lot-${i}|lot`] = i <= n ? 'built' : 'staked'; };

test('a stage is drawn while its conditions hold, the last that holds winning', () => {
  const { E, state } = newGame('oregon-trail');
  const stage = () => E.Engine.regionStage(state, 'poormans-gulch');
  assert.equal(stage(), null, 'a dot until the company holds it');
  state.regions['poormans-gulch'].controller = 'company';
  assert.equal(stage(), 'camp');
  LOTS(state, 2);
  assert.equal(stage(), 'town', 'two lots built');
  LOTS(state, 4);
  assert.equal(stage(), 'founded', 'four');
  state.regions['poormans-gulch'].controller = 'army';
  assert.equal(stage(), null, 'lost: the dot again, whatever is built');
  assert.equal(JSON.stringify(E.Engine.regionStages(state)), JSON.stringify({ 'poormans-gulch': null }));
});

test('Occupied France: the free zone is drawn as its border, and the line moves when the Germans hold Vichy', () => {
  const { E, state } = newGame('occupied-france');
  assert.equal(E.Engine.regionStage(state, 'free'), null, 'spring 1942: the demarcation line');
  const lv = E.MapDraw.level(state.scenario, 'france', { stages: E.Engine.regionStages(state) });
  assert.ok(lv.g.shapes.free.border, 'a border, drawn as a line');
  const svg = E.MapDraw.worldSvg({ g: lv.g, regions: lv.regions, now: state.regions, factions: state.factions, viewBox: lv.g.full });
  assert.match(svg, /<g class="region-border-g" data-region="free" aria-hidden="true"><polygon class="region-border"/);
  assert.ok(!/<g class="region-g[^"]*"[^>]*data-region="free"/.test(svg), 'not a region to click');
  assert.match(svg, /data-region="ain-free"/, 'and the départements inside it still show, at the whole map\'s zoom');
  const before = lv.g.shapes.free.polygons[0];
  state.regions.vichy.controller = 'germany';
  assert.equal(E.Engine.regionStage(state, 'free'), 'italian-zone');
  const after = E.MapDraw.level(state.scenario, 'france', { stages: E.Engine.regionStages(state) }).g.shapes.free.polygons[0];
  assert.notEqual(JSON.stringify(after), JSON.stringify(before), 'east of the Rhône now');
  const xs = (r) => r.reduce((s, p) => s + p[0], 0) / r.length;
  assert.ok(xs(after) > xs(before), 'it moved east');
});

test('the line moves on the beat that tells it, in a played turn', async () => {
  const g = newGame('occupied-france');
  const anton = g.state.scenario.timeline.find((e) => e.id === 'anton');
  g.state.time = { day: anton.when.day, hour: anton.when.hour - 1 };
  mockLLM(g.E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'listen', needs_roll: false, move_to: null }, intents: [], events: [] };
    return kind.startsWith('update') ? { facts: [] } : '[+0m] You tune the wireless.\n\n[+30m] London says German columns crossed into the free zone at dawn.\n\n[+50m] You turn it off.';
  });
  await g.E.Engine.runTurn(g.state, 'I listen to the news.', 'hour');
  assert.equal(g.state.regions.vichy.controller, 'germany', 'the canon event has played');
  const sr = g.E.Engine.sceneRegions(g.state, 0);
  const c = sr.changes.find((x) => x.region === 'free');
  assert.ok(c, 'the free zone changed');
  assert.equal(JSON.stringify(c.outline), JSON.stringify([null, 'italian-zone']));
  assert.equal(c.beat, 1, 'the beat that names the free zone');
  assert.equal(sr.regions.free.outline, null, 'before it, the old line');
  assert.equal(g.E.Engine.sceneRegions(g.state, 1).regions.free.outline, 'italian-zone');
});

test('the gulch grows from a dot in a played turn, once found', async () => {
  const g = newGame('oregon-trail');
  g.state.regions['poormans-gulch'].known = undefined;
  g.state.regions['wind-river'].known = undefined;
  g.E.rng = () => 0.0001;
  const take = { text: 'The Mercer company stakes Poorman\'s Gulch and calls it theirs.', scope: 'regional', region: 'poormans-gulch', visibility: 'heard', effects: { control: [{ region: 'poormans-gulch', to: 'company' }] } };
  mockLLM(g.E, ({ kind }) => {
    if (kind.startsWith('intent')) return { player: { summary: 'wait', needs_roll: false, move_to: null }, intents: [], events: [take] };
    return kind.startsWith('update') ? { facts: [] } : '[+0m] You wait by the wagons.\n\n[+30m] Word comes that the company holds Poorman\'s Gulch.';
  });
  await g.E.Engine.runTurn(g.state, 'I wait.', 'hour');
  assert.equal(g.state.regions['poormans-gulch'].controller, 'company');
  const c = g.E.Engine.sceneRegions(g.state, 0).changes.find((x) => x.region === 'poormans-gulch');
  assert.equal(JSON.stringify(c.outline), JSON.stringify([null, 'camp']));
  const sh = (stages) => g.E.MapDraw.level(g.state.scenario, null, { stages }).g.shapes['poormans-gulch'];
  assert.ok(sh({}).circle, 'a dot');
  assert.equal(sh({ 'poormans-gulch': 'camp' }).polygons[0].length, 12, 'the camp outline');
});

test('outline stages are checked in plain words', () => {
  const E = loadEngine();
  const files = () => worldFiles('oregon-trail');
  const bad = (edit, msg) => {
    const f = files();
    edit(f['world.json'].map.regions['poormans-gulch']);
    assert.throws(() => E.Scenario.prepareWorld('oregon-trail', f).starts.forEach((s) => { if (s.error) throw new Error(s.error); }), (e) => msg.test(e.message), String(msg));
  };
  bad((e) => { e.outlines[0].name = 'Big Camp'; }, /outline "Big Camp": "name" must be lowercase letters/);
  bad((e) => { e.outlines[1].name = 'camp'; }, /outline "camp" is listed twice/);
  bad((e) => { delete e.outlines[0].when; }, /outline "camp": "when" must be a condition, or a list of them/);
  bad((e) => { e.outlines[0].when = { known: 'cheyenne-founded' }; }, /"when" can't use "known": an outline follows what everyone can see/);
  bad((e) => { e.outlines[0].when = { controls: { region: 'atlantis', group: 'company' } }; }, /unknown region "atlantis"/);
  bad((e) => { e.outlines[0].polygon[0] = [99999, 1]; }, /outline "camp" polygon has a point outside the image/);
  bad((e) => { e.border = 'yes'; }, /"border" must be true or false/);
  bad((e) => { e.outlines = {}; }, /"outlines" must be a list/);
});

test('a world without stages is unchanged', () => {
  const { E, state } = newGame('mars-station');
  assert.equal(JSON.stringify(E.Engine.regionStages(state)), '{}');
  assert.equal(E.Engine.regionStage(state, 'station'), null);
});
