// The region tree (R-1): parent, label and regionLabels; the chain, children
// and what's near; who holds a parent; the header outline (static, the same
// for the whole game) and the user message (the player's chain and what's
// near, never the tree's size); lore and event ideas up the chain; the map
// and the creator keeping the tree whole.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, worldFiles, mockLLM } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));
const FLAT = path.join(__dirname, 'fixtures', 'slice-of-life');

// A made-up tree, deep in one branch and broad elsewhere:
// Valdora (nation) › Northern Zone (zone) › Brennmark (province) ›
// Kessel (city) › Old Quarter (ward), with siblings at each level, and two
// other nations that stay one region each.
const TREE = () => [
  { id: 'valdora', name: 'Valdora', controller: null, lore: 'A republic split in two since the armistice.' },
  { id: 'north-zone', name: 'Northern Zone', parent: 'valdora', label: 'zone', controller: 'occupiers' },
  { id: 'south-zone', name: 'Southern Zone', parent: 'valdora', label: 'zone', controller: 'republic' },
  { id: 'brennmark', name: 'Brennmark', parent: 'north-zone' },
  { id: 'lowmarsh', name: 'Lowmarsh', parent: 'north-zone' },
  { id: 'kessel', name: 'Kessel', parent: 'brennmark', tags: ['curfew'] },
  { id: 'old-quarter', name: 'Old Quarter', parent: 'kessel', status: 'checkpoints on every bridge', neighbours: ['docks'] },
  { id: 'docks', name: 'The Docks', parent: 'kessel' },
  { id: 'hill', name: 'Hill District', parent: 'kessel' },
  { id: 'ostrava', name: 'Ostrava', neighbours: ['valdora'] },
  { id: 'lunmark', name: 'Lunmark' },
];
const LABELS = ['nation', 'zone', 'province', 'city', 'ward'];

// The slice-of-life flat (two rooms) set in the Old Quarter of the tree.
function treeFiles(edit) {
  const f = worldFiles(FLAT);
  const w = f['world.json'];
  w.regions = TREE();
  w.regionLabels = LABELS.slice();
  w.factions = w.factions.concat([{ id: 'occupiers', name: 'The Occupation', desc: 'Foreign administration.', stance: 'watchful' }, { id: 'republic', name: 'The Republic', desc: 'What is left of the government.', stance: 'defiant' }]);
  f['starts/sunday.json'].region = 'old-quarter';
  if (edit) edit(f);
  return f;
}
function treeGame(edit) {
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('tree', treeFiles(edit));
  assert.equal(w.starts[0].error, undefined, w.starts[0].error);
  return { E, w, state: E.Engine.newGame(E.Scenario.startScenario(w)) };
}
const problems = (E, edit) => {
  const w = E.Scenario.prepareWorld('tree', treeFiles(edit));
  return w.starts[0].error || '';
};
const intent = (E, state, due = {}) => E.Prompts.intent(state, [], 'Look around.', 'about an hour', 'hour', due);

// ---------- the tree ----------

test('chain, children and nearby on a branch-deep tree', () => {
  const { E, state } = treeGame();
  const Eng = E.Engine;
  assert.deepEqual([...Eng.regionChain(state, 'old-quarter')], ['old-quarter', 'kessel', 'brennmark', 'north-zone', 'valdora']);
  assert.deepEqual([...Eng.regionChain(state, 'ostrava')], ['ostrava']);
  assert.deepEqual([...Eng.regionChildren(state, null)], ['valdora', 'ostrava', 'lunmark']);
  assert.deepEqual([...Eng.regionChildren(state, 'kessel')], ['old-quarter', 'docks', 'hill']);
  // Neighbours, then siblings, then children; never itself or its chain.
  assert.deepEqual([...Eng.regionNear(state, 'old-quarter')], ['docks', 'hill']);
  assert.deepEqual([...Eng.regionNear(state, 'brennmark')], ['lowmarsh', 'kessel']);
  assert.deepEqual([...Eng.nearbyRegions(state)], ['old-quarter', 'docks', 'hill'], 'the player is in the Old Quarter');
  // At the top level only neighbours are near: the other nations aren't siblings.
  assert.deepEqual([...Eng.regionNear(state, 'lunmark')], []);
  assert.deepEqual([...Eng.regionNear(state, 'ostrava')], ['valdora']);
});

test('nearby is capped, so a city of many wards stays a short line', () => {
  const { E, state } = treeGame((f) => {
    for (let i = 0; i < 20; i++) f['world.json'].regions.push({ id: `ward-${i}`, name: `Ward ${i}`, parent: 'kessel' });
  });
  // The flat is a slice-of-life world: region-focused (R-8), so regions get 12.
  assert.equal(E.Sites.mapFocus(state.scenario), 'region');
  const near = E.Engine.regionNear(state, 'old-quarter');
  assert.equal(near.length, 12);
  assert.deepEqual([...near.slice(0, 2)], ['docks', 'hill'], 'neighbours and the first siblings first');
  state.scenario.mapFocus = 'local';
  assert.equal(E.Engine.regionNear(state, 'old-quarter').length, E.Scenario.REGION_NEAR, 'a local-focused world: 8');
});

test('labels: a region\'s own wins, else the world\'s for its depth; none is fine', () => {
  const { E, state } = treeGame();
  const sc = state.scenario;
  assert.equal(E.Scenario.regionLabel(sc, 'valdora'), 'nation');
  assert.equal(E.Scenario.regionLabel(sc, 'north-zone'), 'zone');
  assert.equal(E.Scenario.regionLabel(sc, 'old-quarter'), 'ward');
  assert.equal(E.Scenario.regionLabel(Object.assign({}, sc, { regionLabels: undefined }), 'kessel'), null);
});

test('validation: missing parents, loops and depth, in plain words with names', () => {
  const E = loadEngine();
  const regions = (fn) => (f) => fn(f['world.json'].regions);
  assert.match(problems(E, regions((r) => { r[3].parent = 'atlantis'; })), /Brennmark is inside "atlantis", which isn't one of the regions/);
  assert.match(problems(E, regions((r) => { r[0].parent = 'kessel'; })), /Valdora is inside Northern Zone|is inside .*, which is inside .*Valdora/);
  const loop = problems(E, regions((r) => { r[0].parent = 'brennmark'; }));
  assert.match(loop, /Valdora is inside Brennmark, which is inside Northern Zone, which is inside Valdora/);
  assert.equal(loop.split('which is inside Valdora').length - 1, 1, 'one loop, said once');
  assert.match(problems(E, regions((r) => { r[9].parent = 'ostrava'; })), /Ostrava is inside Ostrava/);
  assert.match(problems(E, regions((r) => { r.push({ id: 'cellar', name: 'The Cellar', parent: 'old-quarter' }, { id: 'vault', name: 'The Vault', parent: 'cellar' }); })),
    /The Vault is 7 levels deep \(inside The Cellar › Old Quarter › Kessel › Brennmark › Northern Zone › Valdora\); 6 is the most/);
  assert.equal(problems(E, regions((r) => { r.push({ id: 'cellar', name: 'The Cellar', parent: 'old-quarter' }); })), '', 'six levels is fine');
  assert.match(problems(E, regions((r) => { r[1].label = 'x'.repeat(31); })), /region "north-zone": "label" must be a short word/);
  assert.match(problems(E, (f) => { f['world.json'].regionLabels = 'nation'; }), /"regionLabels" must be a list of at most 6 short words/);
});

test('who holds a parent: its own controller, else a summary of its children, never a made-up owner', () => {
  const { E, state } = treeGame();
  const holder = (id) => E.Engine.regionHolder(state, id).text;
  assert.equal(holder('north-zone'), 'The Occupation');
  assert.equal(holder('valdora'), 'no single holder (The Occupation holds 1 of 2, The Republic holds 1 of 2)');
  assert.equal(holder('kessel'), 'no one', 'children held by no one: no one');
  assert.equal(holder('old-quarter'), 'no one');
  state.regions.valdora.controller = 'republic';
  assert.equal(holder('valdora'), 'The Republic');
});

// ---------- prompts ----------

test('the user message carries the chain, one line a level, and what is near', () => {
  const { E, state } = treeGame();
  E.settings.backends.local.context = 16384;
  const user = intent(E, state);
  assert.match(user, /\nRegion: Old Quarter, a ward \(old-quarter\): held by no one; checkpoints on every bridge\n/);
  E.settings.backends.local.context = 8192;
  assert.match(intent(E, state), /\nInside: Kessel, a city \(kessel\): held by no one › Brennmark, a province \(brennmark\): held by no one › /, 'compact: who holds each, no tags');
  assert.match(user, /\nInside: Kessel, a city \(kessel\): held by no one; tags: curfew › Brennmark, a province \(brennmark\): held by no one › Northern Zone, a zone \(north-zone\): held by The Occupation › Valdora, a nation \(valdora\): held by no single holder/);
  assert.match(user, /\nNearby: The Docks \(docks\): held by no one \| Hill District \(hill\): held by no one\n/);
  assert.ok(!/Lunmark|Ostrava|Southern Zone/.test(user), 'far regions stay out of the user message');
});

test('the user message does not grow with the tree: 300 more regions elsewhere change nothing', () => {
  const small = treeGame();
  const big = treeGame((f) => {
    for (let i = 0; i < 300; i++) f['world.json'].regions.push({ id: `far-${i}`, name: `Far ${i}`, parent: i % 2 ? 'lunmark' : 'south-zone' });
  });
  const lines = (g) => intent(g.E, g.state, { regional: true }).split('\n').filter((l) => /^(Region|Inside|Nearby):|regional events:/.test(l.trim()));
  assert.deepEqual(lines(big), lines(small));
});

test('the header outline is the same across turns and moves, with the start\'s branch in full', async () => {
  const { E, state } = treeGame((f) => {
    for (let i = 0; i < 40; i++) f['world.json'].regions.push({ id: `far-${i}`, name: `Far ${i}`, parent: 'lunmark' });
  });
  const header = E.Prompts.header(state);
  const block = header.slice(header.indexOf('=== REGIONS ==='));
  ['old-quarter', 'kessel', 'brennmark', 'north-zone', 'valdora', 'docks', 'hill'].forEach((id) => assert.match(block, new RegExp(`\\n- ${id}: `), `${id} in full`));
  assert.match(block, /\n- old-quarter: Old Quarter, a ward in Kessel \(neighbours: docks\)/);
  assert.match(block, /\n- valdora: Valdora, a nation — A republic split in two/);
  assert.match(block, /\n- south-zone: Southern Zone, a zone in Valdora\n/, 'the other zone, beside the chain');
  assert.match(block, /Further away: Ostrava, Lunmark, Far 0/, 'top-level names first');
  assert.ok(!/\n- far-0:/.test(block));
  // A move to another branch and a turn later: the same header (rule 7).
  state.locations.living.region = 'south-zone';
  state.characters[state.player].status.location = 'living';
  state.turn += 3;
  assert.ok(E.Prompts.header(state).startsWith(header));
  assert.match(intent(E, state), /\nRegion: Southern Zone, a zone \(south-zone\): held by The Republic\nInside: Valdora/);
});

test('a flat world\'s region lines are the ones it always had, without "held by no one" when no group holds anywhere', () => {
  const E = loadEngine();
  const f = worldFiles(FLAT);
  f['world.json'].regions = [{ id: 'flat', name: 'The Flat', neighbours: ['bakery'] }, { id: 'bakery', name: 'The Bakery' }];
  f['starts/sunday.json'].region = 'flat';
  const state = E.Engine.newGame(E.Scenario.startScenario(E.Scenario.prepareWorld('flat', f)));
  assert.match(E.Prompts.header(state), /\n- flat: The Flat \(neighbours: bakery\)\n- bakery: The Bakery \(neighbours: flat\)/);
  const user = intent(E, state);
  // No group holds any region, so who holds each says nothing (task 7-2).
  assert.match(user, /\nRegion: The Flat \(flat\)\nNearby: The Bakery \(bakery\)\n/);
  assert.ok(!/Inside:/.test(user));
  // Once one does, every line says who holds it.
  state.regions.bakery.controller = 'landlord';
  assert.match(intent(E, state), /\nRegion: The Flat \(flat\): held by no one\nNearby: The Bakery \(bakery\): held by Mr\. Petrov\n/);
});

test('event ideas and regional events reach up the chain: an idea for Valdora counts in the Old Quarter', () => {
  const { E, state } = treeGame((f) => {
    f['world.json'].eventSeeds = { regional: [{ text: 'a strike at the rail yards', region: 'valdora' }, { text: 'a storm off the coast', region: 'ostrava' }] };
  });
  const user = intent(E, state, { regional: true });
  assert.match(user, /a strike at the rail yards \(Valdora\)/);
  assert.ok(!/a storm off the coast/.test(user), 'Ostrava is another nation');
  assert.match(user, /regional events: old-quarter, kessel, brennmark, north-zone, valdora, docks, hill;/);
});

test('lore falls back up the chain: the city\'s and the nation\'s, after the region\'s own', () => {
  const { E, state } = treeGame((f) => {
    f['world.json'].lore = [
      { id: 'valdora-history', title: 'The armistice', level: 'region', ref: 'valdora', text: 'The armistice line was drawn in a single night.' },
      { id: 'kessel-life', title: 'Life in Kessel', level: 'region', ref: 'kessel', text: 'Kessel runs on ration cards and rumours.' },
      { id: 'quarter', title: 'The Old Quarter', level: 'region', ref: 'old-quarter', text: 'Narrow lanes and old bridges.' },
      { id: 'ostrava-notes', title: 'Ostrava', level: 'region', ref: 'ostrava', text: 'Across the border.' },
    ];
  });
  const picks = E.Lore.select(state, { action: 'Look around.' });
  assert.deepEqual([...picks.map((p) => p.id)], ['quarter', 'kessel-life', 'valdora-history']);
  assert.match(picks[1].why, /inside Kessel/);
});

test('a new place may be in the player\'s region, a region it is inside, or one near; not another nation', () => {
  const { E, state } = treeGame((f) => { f['world.json'].generatedSites = {}; });
  const go = (region) => E.Sites.wanted(state, { new_place: { name: 'the tram depot', kind: 'depot', region } }, 'Go to the tram depot.') || {};
  assert.ok(go('kessel').build, 'somewhere in Kessel, which the Old Quarter is inside');
  assert.ok(go('hill').build, 'a ward next to it');
  assert.match(go('lunmark').error || '', /Lunmark: there is no way from Old Quarter to Lunmark/);

});

// ---------- map and creator ----------

test('the map draws a parent only when it has a shape of its own; its children stand for it', () => {
  const E = loadEngine();
  const regions = TREE();
  const nodes = E.MapDraw.geometry(regions, null, 'tree');
  assert.deepEqual(Object.keys(nodes.shapes).sort(), ['docks', 'hill', 'lowmarsh', 'lunmark', 'old-quarter', 'ostrava', 'south-zone']);
  const map = { image: 'm.png', width: 400, height: 300, regions: { valdora: { polygon: [[0, 0], [200, 0], [200, 200]] }, docks: { point: [50, 50] } } };
  const g = E.MapDraw.geometry(regions, map, 'tree');
  assert.ok(g.shapes.valdora.polygons, 'a parent with an outline is drawn');
  assert.equal(g.shapes.kessel, undefined, 'a parent without one is not');
  const svg = E.MapDraw.worldSvg({ g, regions, factions: [] });
  assert.ok(svg.indexOf('data-region="valdora"') < svg.indexOf('data-region="docks"'), 'parents under their children');
});

test('the creator keeps the tree whole: renames follow parents, a deleted region\'s children move up, no loops offered', () => {
  const E = loadEngine();
  const M = E.MapEdit;
  const world = { regions: TREE() };
  M.renameRegion(world, {}, 'kessel', 'kessel-city', {});
  assert.deepEqual(world.regions.filter((r) => r.parent === 'kessel-city').map((r) => r.id), ['old-quarter', 'docks', 'hill']);
  const notes = M.deleteRegion(world, {}, 'kessel-city', {});
  assert.deepEqual(world.regions.filter((r) => r.parent === 'brennmark').map((r) => r.id), ['old-quarter', 'docks', 'hill']);
  assert.ok(notes.some((n) => /Old Quarter, The Docks, Hill District are now inside Brennmark/.test(n)), notes.join('; '));
  M.deleteRegion(world, {}, 'valdora', {});
  assert.equal(world.regions.find((r) => r.id === 'north-zone').parent, undefined, 'a top-level parent\'s children go to the top');
  const choices = M.parentChoices({ regions: TREE() }, 'brennmark').map((r) => r.id);
  assert.ok(!choices.includes('brennmark') && !choices.includes('kessel') && !choices.includes('old-quarter'), 'not itself or anything inside it');
  assert.ok(choices.includes('valdora') && choices.includes('lunmark'));
});

// ---------- every other world ----------

test('worlds without a tree start the same game as before, and the minimum world still plays', async () => {
  const E = loadEngine();
  const f = worldFiles(FLAT);
  const state = E.Engine.newGame(E.Scenario.startScenario(E.Scenario.prepareWorld('slice-of-life', f)));
  assert.deepEqual(plain(state.regions), {});
  assert.ok(!/REGIONS|Region:/.test(E.Prompts.header(state) + intent(E, state)));
  mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { summary: 'look around' }, intents: [], events: [] }
    : kind === 'update' ? { facts: [], state: [], relations: [], player_attitude: [] } : '[+0m] The radiator knocks.'));
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  assert.equal(state.turn, 1);
});

test('every bundled and fixture world still loads with no new warnings, each start composing', () => {
  const fs = require('fs');
  const { scenarioFolders } = require('./helpers');
  const fixtures = fs.readdirSync(path.join(__dirname, 'fixtures'), { withFileTypes: true }).filter((d) => d.isDirectory()
    && ['world.json', 'scenario.json'].some((f) => fs.existsSync(path.join(__dirname, 'fixtures', d.name, f)))).map((d) => path.join(__dirname, 'fixtures', d.name));
  assert.ok(fixtures.length >= 5);
  scenarioFolders().concat(fixtures).forEach((folder) => {
    const E = loadEngine();
    const w = E.Scenario.prepareWorld(path.basename(folder), worldFiles(folder));
    w.starts.forEach((s) => assert.equal(s.error, undefined, `${path.basename(folder)}/${s.id}: ${s.error}`));
    assert.ok(![...w.warnings].some((m) => /region/.test(m) && !/is not on the map/.test(m)), `${path.basename(folder)}: ${w.warnings.join('; ')}`);
  });
});
