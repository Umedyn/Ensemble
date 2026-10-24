// Presence and unknown regions (R-5): several groups in a region at once
// (contested when two are close), changed by events; regions that stay
// hidden from the map, the sidebar and every prompt the narrator sees until
// the story reveals them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, worldFiles, newGame } = require('./helpers');

const plain = (o) => JSON.parse(JSON.stringify(o));
const intent = (E, state, due = {}) => E.Prompts.intent(state, [], 'Look around.', 'about an hour', 'hour', due);
const narrate = (E, state) => E.Prompts.narrate(state, [], 'Look around.', { startLoc: state.characters[state.player].status.location, startTime: E.fmtTime(state), stepId: 'hour', stepLabel: 'about an hour', spanMinutes: 60 }, { outcomes: [], events: [], guards: [] });

// ---------- presence ----------

test('a contested region shows both groups, in words, wherever its state shows', () => {
  const { E, state } = newGame('zombie-holdout');
  const p = E.Engine.presenceIn(state, 'junction');
  assert.deepEqual(plain(p.groups.map((g) => [g.id, g.word])), [['convoy', 'some'], ['ridge', 'a little']]);
  assert.equal(p.contested, true);
  assert.equal(E.Engine.presenceIn(state, 'ridge-town').contested, false, 'one group alone');
  assert.equal(E.Engine.presenceText(state, 'main-street'), '', 'nobody');
  assert.match(intent(E, state), /Highway junction \(junction\): held by no one; present: Coastal rescue convoy \(some\), The Ridge \(a little\); contested; tags: blocked/);
  assert.ok(!/present:/.test(E.Prompts.header(state)), 'presence changes in play: never in the header');
  const lv = E.MapDraw.level(state.scenario, null);
  const svg = E.MapDraw.worldSvg({ g: lv.g, regions: lv.regions, factions: state.factions, contested: ['junction'] });
  assert.match(svg, /data-region="junction"[^>]*aria-label="Highway junction, held by no one, contested"/);
  assert.match(svg, /class="region-shape [^"]*contested/);
});

test('presence changes through an event: clamped, at most half a step, stamped, and only for real groups and regions', () => {
  const { E, state } = newGame('zombie-holdout');
  const ev = (presence) => ({ events: [{ text: 'Convoy trucks fan out across the junction.', scope: 'regional', region: 'junction', visibility: 'heard', who: [], moves: [], effects: { presence } }] });
  const out = { res: { outcomes: [], events: [], guards: [] } };
  E.Engine.applyEvents(state, ev([{ group: 'convoy', region: 'junction', to: 1 }, { group: 'ridge', region: 'junction', to: 0 }]), [], 'hour', out.res, { regional: true });
  E.Engine.applyEvents(state, ev([{ group: 'raiders', region: 'junction', to: 1 }]), [], 'hour', out.res, { regional: true });
  assert.equal(state.presence.convoy.junction, 0.9, '0.4 up by at most 0.5');
  assert.equal(state.presence.ridge.junction, undefined, 'gone');
  assert.equal(E.Engine.presenceIn(state, 'junction').contested, false);
  const g = out.res.guards.map((x) => `${x.type}: ${x.detail}`).join('\n');
  assert.match(g, /effect rejected: presence: unknown group "raiders"/);
  assert.deepEqual(plain(state.regionChanged.junction.what), ['presence changed']);
  assert.ok(Object.keys(E.Engine.EFFECTS).includes('presence'), 'in the effect table, so the timeline can use it');
});

test('presence validates: groups, regions and strengths', () => {
  const E = loadEngine();
  const err = (edit) => { const f = worldFiles('zombie-holdout'); edit(f['world.json']); return E.Scenario.prepareWorld('z', f).starts[0].error || ''; };
  assert.match(err((w) => { w.presence.mob = { junction: 0.5 }; }), /presence: "mob" is not one of the groups/);
  assert.match(err((w) => { w.presence.ridge.moon = 0.5; }), /presence.ridge: unknown region "moon"/);
  assert.match(err((w) => { w.presence.ridge.junction = 2; }), /presence.ridge.junction must be a number from 0 to 1/);
  assert.equal(err(() => {}), '');
});

// ---------- unknown regions ----------

test('a hidden region and everything inside it never reach the map, the narrator or the header until revealed', () => {
  const { E, state } = newGame('mars-station');
  assert.equal(E.Engine.regionKnown(state, 'lava-tube'), false);
  const header = E.Prompts.header(state);
  assert.ok(!/lava|Collapsed/i.test(header), 'not in the header');
  state.characters[state.player].status.location = 'surface';
  const scene = narrate(E, state);
  assert.ok(!/lava|Collapsed/i.test(scene), 'not in what the narrator sees');
  const ask = intent(E, state, { regional: true });
  const hiddenBlock = ask.slice(ask.indexOf('=== HIDDEN PLACES'));
  assert.match(hiddenBlock, /- lava-tube: Collapsed lava tube \(in Hellas crater rim\) — A void under the rim/, 'the intent call alone, like a secret');
  assert.ok(!/lava|Collapsed/i.test(ask.slice(0, ask.indexOf('=== HIDDEN PLACES'))), 'nowhere else in the intent message');
  assert.ok(!E.Engine.nearbyRegions(state).includes('lava-tube'));
  const lv = E.MapDraw.level(state.scenario, null, { hidden: E.Engine.hiddenRegions(state) });
  assert.ok(!lv.regions.some((r) => r.id === 'lava-tube') && !lv.g.shapes['lava-tube'], 'not on the map');
  assert.ok(E.MapDraw.level(state.scenario, null).g.shapes['lava-tube'], 'the data has it all along');
  // A route to it isn't listed either.
  state.scenario.regions.find((r) => r.id === 'crater-rim').routes.push({ to: 'lava-tube', kind: 'checkpoint' });
  assert.ok(!E.Engine.routesFrom(state, 'crater-rim').some((x) => x.to === 'lava-tube'));
});

test('revealed by an effect, a public event naming it, a fact the player knows, or being there; then it shows everywhere, and the header only grows', () => {
  const ways = {
    effect: (E, s) => E.Engine.EFFECTS.reveal.apply(s, { region: 'lava-tube' }),
    event: (E, s, res) => E.Engine.revealNamed(s, 'Lev reports a collapsed lava tube opening near the drill site.', res, 'a public event names it'),
    fact: (E, s, res) => { E.Memory.addFact(s, { about: [], text: 'There is a collapsed lava tube under the rim.', known_by: [s.player], weight: 2 }); E.Engine.revealAround(s, res); },
    there: (E, s, res) => { s.locations.surface.region = 'lava-tube'; s.characters[s.player].status.location = 'surface'; E.Engine.revealAround(s, res); },
  };
  for (const [way, go] of Object.entries(ways)) {
    const { E, state } = newGame('mars-station');
    const before = E.Prompts.header(state);
    const res = { guards: [] };
    go(E, state, res);
    assert.equal(E.Engine.regionKnown(state, 'lava-tube'), true, way);
    const after = E.Prompts.header(state);
    // The static part is untouched; found places join the live tail (rule 7), as newcomers do.
    const tail = before.indexOf('\n=== STORY SO FAR');
    assert.ok(tail > 0 && after.startsWith(before.slice(0, tail)), `${way}: the static header is unchanged`);
    assert.match(after.slice(tail), /^\n=== PLACES FOUND DURING THE STORY ===\n- lava-tube: Collapsed lava tube, a cave in Hellas crater rim — A void/);
    assert.ok(E.MapDraw.level(state.scenario, null, { hidden: E.Engine.hiddenRegions(state) }).g.shapes['lava-tube'], `${way}: on the map now`);
    assert.ok(!/=== HIDDEN PLACES/.test(intent(E, state)), `${way}: nothing hidden any more`);
    if (way !== 'effect') assert.ok(res.guards.some((g) => g.type === 'region revealed' && /Collapsed lava tube/.test(g.detail)), way);
  }
});

test('revealing a region reveals the hidden regions it is inside', () => {
  const E = loadEngine();
  const f = worldFiles('mars-station');
  f['world.json'].regions.push({ id: 'deep-chamber', name: 'Deep chamber', parent: 'lava-tube' });
  const state = E.Engine.newGame(E.Scenario.startScenario(E.Scenario.prepareWorld('mars-station', f)));
  assert.equal(E.Engine.regionKnown(state, 'deep-chamber'), false, 'inside a hidden region: hidden too');
  assert.deepEqual([...E.Engine.revealRegion(state, 'deep-chamber', null, 'test')], ['Collapsed lava tube']);
  assert.equal(E.Engine.regionKnown(state, 'deep-chamber'), true);
});

test('a public event that happens somewhere hidden makes it known; a hidden event changes nothing', () => {
  const { E, state } = newGame('mars-station');
  const rumble = (visibility) => ({ events: [{ text: 'A section of the rim gives way with a long rumble.', scope: 'regional', region: 'lava-tube', visibility, who: [], moves: [] }] });
  E.Engine.applyEvents(state, rumble('hidden'), [], 'hour', { outcomes: [], events: [], guards: [] }, { regional: true });
  assert.equal(E.Engine.regionKnown(state, 'lava-tube'), false, 'hidden events reveal nothing');
  const out = { res: { outcomes: [], events: [], guards: [] } };
  E.Engine.applyEvents(state, rumble('heard'), [], 'hour', out.res, { regional: true });
  assert.equal(E.Engine.regionKnown(state, 'lava-tube'), true);
  assert.ok(out.res.guards.some((g) => g.type === 'region revealed' && /a public event happens there/.test(g.detail)));
});

test('hidden regions: validation, no start inside one, no new places or generated starts there, old saves load', () => {
  const E = loadEngine();
  const f = worldFiles('mars-station');
  f['world.json'].regions.find((r) => r.id === 'lava-tube').known = 'no';
  assert.match(E.Scenario.prepareWorld('m', f).starts[0].error, /region "lava-tube": "known" must be true or false/);
  const g = worldFiles('mars-station');
  g['starts/garage.json'].region = 'lava-tube';
  g['starts/garage.json'].locations = (g['starts/garage.json'].locations || []).map((l) => Object.assign({}, l, { region: 'lava-tube' }));
  assert.match(E.Scenario.prepareWorld('m', g).starts.find((s) => s.id === 'garage').error, /the start is in Collapsed lava tube, which is hidden/);
  const { E: G, state } = newGame('mars-station');
  assert.ok(!G.StartGen.regions(state.scenario).some((r) => r.id === 'lava-tube'));
  assert.equal(G.Sites.regionHeadedFor(state, null, 'I head into the Collapsed lava tube.'), null, 'the player can\'t head for what they don\'t know');
  const old = plain(state);
  old.version = 14;
  delete old.presence;
  Object.values(old.regions).forEach((r) => { delete r.known; });
  const m = G.Engine.migrate(old);
  assert.deepEqual(plain(m.presence), {});
  assert.equal(G.Engine.regionKnown(m, 'lava-tube'), true, 'a save from before R-5 knows every region');
});

test('the creator keeps presence whole: renames and removals of groups and regions', () => {
  const E = loadEngine();
  const files = worldFiles('zombie-holdout');
  const w = files['world.json'];
  E.WorldEdit.renameGroup(files, 'convoy', 'rescue');
  assert.deepEqual(plain(w.presence.rescue), { junction: 0.4 });
  E.MapEdit.renameRegion(w, {}, 'junction', 'crossing', files);
  assert.deepEqual(plain(w.presence), { ridge: { 'ridge-town': 1, crossing: 0.3 }, rescue: { crossing: 0.4 } });
  E.MapEdit.deleteRegion(w, {}, 'crossing', files);
  assert.deepEqual(plain(w.presence), { ridge: { 'ridge-town': 1 }, rescue: {} });
  assert.ok(E.WorldEdit.removeGroup(files, 'ridge').includes('ridge is present nowhere now'));
  assert.equal(w.presence.ridge, undefined);
});
