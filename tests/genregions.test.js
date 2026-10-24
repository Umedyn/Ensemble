// Generated regions (R-6): when the story heads somewhere bigger than a
// building that isn't on the map, the engine may add it as a region, with
// checked lore and a route from where the player is, then build a place to
// arrive at inside it. Refused for the same reasons as places, one level up;
// faded back to a stub that a return rebuilds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, mockLLM } = require('./helpers');
const { replies, stepOf } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));

// The "One city" template with generated regions on: the player is in the
// Corner Café, in Old Town, Brightwater.
function cityGame(edit) {
  const E = loadEngine();
  const b = E.WorldEdit.templateWorld('city', 'Brightwater Days', []);
  b.files['world.json'].generatedRegions = {};
  if (edit) edit(b.files['world.json'], b.files);
  const w = E.Scenario.prepareWorld(b.folder, plain(b.files));
  assert.equal(w.starts[0].error, undefined, w.starts[0].error);
  const state = E.Engine.newGame(E.Scenario.startScenario(w));
  state.projection = false;
  return { E, state };
}
// The model heads for `region` (a new_region) and plays along.
function heading(E, region, over) {
  const r = replies(over || {});
  return mockLLM(E, (call) => {
    const step = stepOf(call.user);
    if (step) { const v = r[step]; return typeof v === 'function' ? v(call.user, call) : v; }
    if (call.kind === 'intent' && /=== DOWNTIME/.test(call.user)) return { montage: [{ after: '1h', text: 'The bus rattles along the coast road.' }], events: [], major_event: null, positions: [], player_where: null };
    if (call.kind === 'intent') return { player: Object.assign({ summary: 'go', move_to: null }, region ? { new_region: region } : {}), intents: [], events: [] };
    if (call.kind === 'update') return { facts: [], state: [], relations: [], player_attitude: [] };
    if (call.kind === 'chapter') return { title: 'x', summary: 'y' };
    return '[+0m] You get there as the light goes.';
  });
}
const guards = (out, type) => out.res.guards.filter((g) => g.type === type).map((g) => g.detail);
const KESSA = { name: 'Kessa', label: 'town', parent: null };

test('built: a region with checked lore and a route from here, a place to arrive at inside it, and the move', async () => {
  const { E, state } = cityGame();
  const header = E.Prompts.header(state);
  const calls = heading(E, KESSA);
  const out = await E.Engine.runTurn(state, 'I take the bus out to Kessa.', 'hours');
  const r = state.scenario.regions.find((x) => x.name === 'Kessa');
  assert.ok(r && r.generated, 'in the game\'s regions');
  assert.equal(r.label, 'town');
  assert.equal(r.parent, undefined, 'the top level');
  assert.match(r.lore, /market town on the river/);
  assert.deepEqual(plain(r.routes), [{ to: 'old-town', kind: 'road' }], 'the world\'s route kind, from where the player was');
  assert.match(guards(out, 'region built')[0], /^Kessa \(town\), a road from Old Town: A market town/);
  assert.equal(E.Engine.regionOf(state, state.characters.you.status.location), r.id, 'arrived at a place inside it');
  assert.ok(Object.values(state.sites).some((s) => s.region === r.id && !s.stub));
  assert.match(out.res.outcomes[0].action, /\(the way: by road to Kessa \(2h\)\)/);
  assert.deepEqual(calls.map((c) => c.kind).filter((k) => /worldbuild/.test(k)), ['worldbuild (region: Kessa)', 'worldbuild (site: Kessa)'], 'the city template is region-focused (R-8): the place is flavour, one call');
  const now = E.Prompts.header(state);
  const tail = header.indexOf('\n=== STORY SO FAR');
  assert.ok(now.startsWith(header.slice(0, tail > 0 ? tail : header.length)), 'the static header is unchanged (rule 7)');
  assert.match(now, /=== PLACES FOUND DURING THE STORY ===\n- kessa: Kessa, a town — A market town/);
  assert.ok(!/\n- kessa:/.test(now.slice(0, now.indexOf('=== PLACES FOUND'))), 'never in the static outline');
});

test('a trip longer than the step: the new region is reached as a journey', async () => {
  const { E, state } = cityGame();
  heading(E, KESSA);
  const out = await E.Engine.runTurn(state, 'I take the bus out to Kessa.', 'hour');
  assert.ok(guards(out, 'journey').some((d) => /arrived at .* after 2h/.test(d)), out.res.guards.map((g) => g.type).join(', '));
  assert.equal(E.Engine.regionOf(state, state.characters.you.status.location), 'kessa');
});

test('refused, with no call: not in the player\'s words, an unknown or hidden parent, no way there, at the cap, or the world doesn\'t build regions', async () => {
  const play = async (region, action, edit) => {
    const { E, state } = cityGame(edit);
    const calls = heading(E, region);
    const out = await E.Engine.runTurn(state, action, 'hours');
    assert.ok(!calls.some((c) => /worldbuild \(region/.test(c.kind)), 'no region call');
    return { state, refused: guards(out, 'region refused')[0] || '' };
  };
  assert.match((await play(KESSA, 'I look around the café.')).refused, /the player's words don't name "Kessa"/);
  assert.match((await play(Object.assign({}, KESSA, { parent: 'atlantis' }), 'I go to Kessa.')).refused, /"Kessa": unknown region "atlantis"/);
  assert.match((await play(Object.assign({}, KESSA, { parent: 'isle' }), 'I go to Kessa.', (w) => { w.regions.push({ id: 'isle', name: 'The Isle', known: false }); })).refused, /unknown region "isle"/, 'hidden counts as unknown');
  assert.match((await play(Object.assign({}, KESSA, { parent: 'isle' }), 'I go to Kessa.', (w) => { w.regions.push({ id: 'isle', name: 'The Isle' }); })).refused, /"Kessa": there is no way from Old Town to The Isle/);
  const capped = await play(KESSA, 'I go to Kessa.', (w) => { w.generatedRegions.maxRegions = 1; w.regions.push({ id: 'dunmore', name: 'Dunmore', generated: true }); });
  assert.match(capped.refused, /already has 1 regions of its own/);
  assert.match((await play(KESSA, 'I go to Kessa.', (w) => { delete w.generatedRegions; })).refused, /this world doesn't build new regions/);
  const taken = await play({ name: 'The Harbour', label: 'district', parent: 'brightwater' }, 'I go to the Harbour.');
  assert.equal(taken.refused, '', 'a region that exists is just a way there');
});

test('its lore is checked: no one\'s secret, nothing that hasn\'t happened yet, no cast names; a bad reply is retried with the problem named', async () => {
  const { E, state } = cityGame();
  state.characters.you.secret = 'Stole the harbour master\'s ledger and hid it in the boathouse at night.';
  state.timeline.push({ id: 'flood', when: { day: 9, hour: 6 }, text: 'The spring flood takes out the river bridge at Kessa.' });
  const ST = E.Sites;
  assert.match(ST.checkRegionLore(state, { lore: 'Kessa keeps a harbour master\'s ledger hidden in the boathouse; someone stole it at night.' }).error, /gives away something someone hides/);
  assert.match(ST.checkRegionLore(state, { lore: 'Kessa is where the spring flood takes out the river bridge.' }).error, /hasn't happened yet/);
  assert.match(ST.checkRegionLore(state, { lore: 'Kessa, where You grew up, is quiet.' }).error, /don't name You/);
  assert.match(ST.checkRegionLore(state, { lore: 'Small.' }).error, /one or two sentences/);
  let n = 0;
  const calls = heading(E, KESSA, { region: () => (n++ ? { lore: 'A market town on the river, half shuttered now.' } : { lore: 'Kessa is where the spring flood takes out the river bridge.' }) });
  await E.Engine.runTurn(state, 'I take the bus out to Kessa.', 'hours');
  const rc = calls.filter((c) => /worldbuild \(region/.test(c.kind));
  assert.equal(rc.length, 2);
  assert.match(rc[1].user, /hasn't happened yet/, 'the retry names the problem');
  assert.match(state.scenario.regions.find((r) => r.id === 'kessa').lore, /market town/);
});

test('it fades to a stub with nothing notable, is kept with something notable, and a return rebuilds it', async () => {
  const { E, state } = cityGame();
  heading(E, KESSA);
  await E.Engine.runTurn(state, 'I take the bus out to Kessa.', 'hours');
  const r = state.scenario.regions.find((x) => x.id === 'kessa');
  assert.equal(r.visits, 1);
  state.characters.you.status.location = 'corner-cafe';
  state.time.day += 8;
  const faded = E.Sites.fadeRegions(state);
  assert.match(faded[0], /^Kessa faded/);
  assert.equal(r.stub, true);
  assert.equal(r.lore, undefined, 'its lore goes');
  assert.deepEqual(plain(r.routes), [{ to: 'old-town', kind: 'road' }], 'the way back stays');
  assert.match(r.summary, /^visited once, last on Day/);
  // Heading there again: one call rebuilds its lore, told about the visit.
  const calls = heading(E, KESSA);
  const out = await E.Engine.runTurn(state, 'I take the bus back to Kessa.', 'hours');
  const rc = calls.filter((c) => /worldbuild \(region/.test(c.kind));
  assert.equal(rc.length, 1);
  assert.match(rc[0].user, /The player has been there before \(visited once/);
  assert.match(guards(out, 'region built')[0], /\(rebuilt\)/);
  assert.equal(r.stub, false);
  assert.equal(state.scenario.regions.filter((x) => x.name === 'Kessa').length, 1, 'the same region, not a second one');
  // A second visit keeps it.
  assert.deepEqual([r.kept, r.keptWhy], [true, 'a second visit']);
  state.characters.you.status.location = 'corner-cafe';
  state.time.day += 30;
  assert.deepEqual([...E.Sites.fadeRegions(state)], []);
});

test('something notable there keeps a generated region from fading', async () => {
  const { E, state } = cityGame();
  heading(E, KESSA);
  await E.Engine.runTurn(state, 'I take the bus out to Kessa.', 'hours');
  const kept = [];
  const before = state.facts.length;
  E.Memory.addFact(state, { about: [], text: 'The Kessa ferryman promised to carry a letter across.', known_by: ['you'], weight: 2 });
  E.Sites.noteRegionFacts(state, before, [state.characters.you.status.location], kept);
  assert.match(kept[0], /Kessa is kept: "The Kessa ferryman/);
  state.characters.you.status.location = 'corner-cafe';
  state.time.day += 30;
  assert.deepEqual([...E.Sites.fadeRegions(state)], []);
});

test('generatedRegions validates, and needs generated sites; a save with a generated region round-trips', async () => {
  const E = loadEngine();
  const errs = (g, sites) => {
    const b = E.WorldEdit.templateWorld('city', 'X', []);
    b.files['world.json'].generatedRegions = g;
    if (sites === false) delete b.files['world.json'].generatedSites;
    try { E.Scenario.prepareWorld(b.folder, plain(b.files)); return ''; } catch (e) { return e.message; }
  };
  assert.match(errs({ maxRegions: 99 }), /"maxRegions" must be a whole number from 1 to 30/);
  assert.match(errs({ colour: 1 }), /generatedRegions: unknown field "colour"/);
  assert.match(errs({}, false), /generatedRegions needs "generatedSites" too/);
  assert.equal(errs({ routeKind: 'bus', keepDays: 3 }), '');
  const { E: G, state } = cityGame();
  heading(G, KESSA);
  await G.Engine.runTurn(state, 'I take the bus out to Kessa.', 'hours');
  const back = G.Engine.migrate(plain(state));
  assert.ok(back.scenario.regions.find((r) => r.id === 'kessa').generated);
  assert.equal(G.Engine.regionKnown(back, 'kessa'), true);
});
