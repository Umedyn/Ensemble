// Worlds and starts (docs/WORLDS.md): composing a world plus a start into the
// flat scenario the engine plays, validating worlds, legacy folders and save
// migration.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, readWorld, readScenario, scenarioFolders, newGame, mockLLM } = require('./helpers');

const LEGACY = path.join(__dirname, 'fixtures', 'legacy-scenario');
const plain = (o) => JSON.parse(JSON.stringify(o));

// A small inline world: two rooms, three people, two starts. files is what a
// loader hands Scenario.prepareWorld; edit() changes it before loading.
function testWorld(edit) {
  const files = {
    'world.json': {
      format: 2, id: 'harbor', title: 'Grey Harbor', summary: 'A fishing town.', setting: 'A cold fishing town.',
      rules: ['No magic.', 'Boats need fuel.'], facts: ['The cannery closed last year.'], timeLabel: 'Day', wakeHour: 7,
      majorEventDays: 4, skills: ['social', 'physical'], needs: [],
      world: { weather: 'fog', fuel: 'scarce' }, eventRates: { regional: 30, world: 100 },
      factions: [{ id: 'coop', name: 'The co-op', desc: 'Fishers who share boats.', stance: 'wary' }],
      locations: [{ id: 'dock', name: 'The dock', desc: 'Wet planks.', connects: [] }],
      characters: ['mara', 'jonah', 'ines'],
      starts: ['morning', 'storm'],
    },
    'starts/morning.json': {
      id: 'morning', title: 'Morning catch', summary: 'You are Mara, back from the boats.', start: { day: 1, hour: 6 },
      player: 'mara', cast: ['mara', 'jonah'], castLabel: 'Crew',
      locations: [{ id: 'bar', name: 'The bar', desc: 'Warm.', connects: ['dock'] }],
      opening: 'Gulls overhead.',
    },
    'starts/storm.json': {
      id: 'storm', title: 'The storm', summary: 'You are Ines, in the storm.', start: { day: 9, hour: 22 },
      player: 'ines', castLabel: 'Survivors', timeLabel: 'Night', majorEventDays: 1,
      cast: ['ines', { id: 'jonah', status: { location: 'bar' }, relations: { ines: 40 }, knows: ['The boat is gone.'] }],
      rules: ['No magic.', 'Nobody leaves in a storm.'], facts: ['A storm has cut the road.'], tags: ['grim'],
      world: { weather: 'storm' }, eventRates: { world: 0 },
      factions: [{ id: 'coop', stance: 'desperate' }, { id: 'coast', name: 'Coastguard', desc: 'Far away.', stance: 'absent' }],
      locations: [{ id: 'dock', desc: 'Under water.' }, { id: 'bar', name: 'The bar', desc: 'Dark.', connects: ['dock'] }],
    },
    'characters/mara.json': { id: 'mara', name: 'Mara', status: { location: 'dock' }, relations: { jonah: 10, ines: -5 } },
    'characters/jonah.json': { id: 'jonah', name: 'Jonah', want: 'a boat', status: { location: 'dock', health: 'ok' }, relations: { mara: 5, ines: 0 }, knows: ['Mara owes money.'] },
    'characters/ines.json': { id: 'ines', name: 'Ines', status: { location: 'bar' } },
  };
  if (edit) edit(files);
  return files;
}
const load = (edit, E = loadEngine()) => E.Scenario.prepareWorld('harbor', testWorld(edit));
const scenarioOf = (loaded, startId) => loaded.starts.find((s) => s.id === startId).scenario;

// ---------- compose ----------

test('composing: a start replaces the world\'s scalars and strings', () => {
  const sc = scenarioOf(load(), 'storm');
  assert.equal(sc.timeLabel, 'Night');
  assert.equal(sc.majorEventDays, 1);
  assert.equal(sc.wakeHour, 7, 'what the start leaves out comes from the world');
  assert.equal(sc.setting, 'A cold fishing town.');
  assert.equal(sc.player, 'ines');
  assert.deepEqual(plain(sc.start), { day: 9, hour: 22 });
  assert.equal(sc.title, 'Grey Harbor: The storm');
  assert.equal(sc.worldTitle, 'Grey Harbor');
  assert.equal(sc.startTitle, 'The storm');
  assert.equal(sc.worldId, 'harbor');
  assert.equal(sc.startId, 'storm');
  assert.equal(sc.folder, 'harbor');
  assert.equal(sc.format, undefined);
  assert.equal(sc.starts, undefined);
});

test('composing: lists of objects with ids merge by id, field by field, new ids appended', () => {
  const sc = scenarioOf(load(), 'storm');
  assert.deepEqual([...sc.locations.map((l) => l.id)], ['dock', 'bar']);
  assert.equal(sc.locations[0].desc, 'Under water.');
  assert.equal(sc.locations[0].name, 'The dock', 'fields the start leaves out are kept');
  assert.deepEqual(plain(sc.factions), [
    { id: 'coop', name: 'The co-op', desc: 'Fishers who share boats.', stance: 'desperate' },
    { id: 'coast', name: 'Coastguard', desc: 'Far away.', stance: 'absent' },
  ]);
});

test('composing: lists of strings are the world\'s then the start\'s, without duplicates', () => {
  const sc = scenarioOf(load(), 'storm');
  assert.deepEqual([...sc.rules], ['No magic.', 'Boats need fuel.', 'Nobody leaves in a storm.']);
  assert.deepEqual([...sc.facts], ['The cannery closed last year.', 'A storm has cut the road.']);
  assert.deepEqual([...sc.tags], ['grim']);
});

test('composing: plain objects merge shallowly with the start winning', () => {
  const sc = scenarioOf(load(), 'storm');
  assert.deepEqual(plain(sc.world), { weather: 'storm', fuel: 'scarce' });
  assert.deepEqual(plain(sc.eventRates), { regional: 30, world: 0 });
});

test('a cast entry overrides location, relations and knows; a plain id uses the file', () => {
  const w = load();
  const storm = scenarioOf(w, 'storm');
  assert.deepEqual([...storm.characters], ['ines', 'jonah']);
  const jonah = storm.characterData[1];
  assert.equal(jonah.status.location, 'bar');
  assert.equal(jonah.status.health, 'ok', 'status merges field by field');
  assert.equal(jonah.relations.ines, 40);
  assert.deepEqual([...jonah.knows], ['The boat is gone.']);
  assert.equal(jonah.want, 'a boat', 'identity comes from the file');
  const morning = scenarioOf(w, 'morning');
  const file = testWorld()['characters/jonah.json'];
  assert.deepEqual(plain(morning.characterData[1]), Object.assign(plain(file), { relations: { mara: 5 } }), 'only relations to absent people drop out');
});

test('relations to people who are not in this start are left out, and the start plays', () => {
  const w = load();
  const morning = scenarioOf(w, 'morning');
  assert.deepEqual(plain(morning.characterData[0].relations), { jonah: 10 });
  const E = loadEngine();
  const state = E.Engine.newGame(E.Scenario.startScenario(w, 'morning'));
  assert.equal(state.characters.mara.status.location, 'dock');
  assert.ok(E.Prompts.header(state).includes('SETTING: Grey Harbor'), 'the header names the world, not the start');
});

test('the first start is the default', () => {
  const E = loadEngine();
  const w = load(undefined, E);
  assert.equal(w.defaultStart, 'morning');
  assert.equal(E.Scenario.startScenario(w).startId, 'morning');
  assert.throws(() => E.Scenario.startScenario(w, 'nope'), /no start "nope"/);
});

// ---------- validation ----------

test('validateWorld: a missing start file is named', () => {
  assert.throws(() => load((f) => delete f['starts/storm.json']), /missing starts\/storm\.json/);
});

test('validateWorld: a cast id not in the pool is caught', () => {
  assert.throws(() => load((f) => f['starts/morning.json'].cast.push('ghost')), /cast member "ghost" is not in the world's characters/);
});

test('validateWorld: a player not in the cast is caught', () => {
  assert.throws(() => load((f) => (f['starts/morning.json'].player = 'ines')), /starts\/morning\.json: "player" must be in the cast/);
});

test('validateWorld: duplicate ids are caught', () => {
  assert.throws(() => load((f) => {
    f['world.json'].characters.push('mara');
    f['world.json'].starts.push('storm');
    f['starts/morning.json'].cast.push('jonah');
    f['starts/storm.json'].locations.push({ id: 'bar', name: 'Again', desc: 'x' });
  }), (err) => /character "mara" is listed twice/.test(err.message) && /start "storm" is listed twice/.test(err.message) &&
    /"jonah" is in the cast twice/.test(err.message) && /locations has "bar" twice/.test(err.message));
});

test('validateWorld: missing character files and relations outside the pool are caught', () => {
  assert.throws(() => load((f) => {
    delete f['characters/ines.json'];
    f['characters/mara.json'].relations.nobody = 3;
  }), (err) => /missing characters\/ines\.json/.test(err.message) && /relation to unknown "nobody"/.test(err.message));
});

test('a broken start reports its error without hiding the others', () => {
  const w = load((f) => (f['starts/storm.json'].cast[1].status.location = 'lighthouse'));
  const storm = w.starts.find((s) => s.id === 'storm');
  assert.match(storm.error, /unknown location "lighthouse"/);
  assert.equal(storm.scenario, undefined);
  assert.ok(scenarioOf(w, 'morning'));
  assert.throws(() => loadEngine().Scenario.startScenario(w, 'storm'), /unknown location "lighthouse"/);
});

test('reserved fields are accepted silently; unknown fields are ignored with a warning', () => {
  const w = load((f) => {
    Object.assign(f['world.json'], { lore: [], timeline: [], colour: 'grey' });
    Object.assign(f['starts/morning.json'], { extras: [], standees: [], oppening: 'typo' });
    f['starts/storm.json'].cast[1].mood = 'grim';
  });
  assert.deepEqual([...w.warnings], [
    'world.json: unknown field "colour" (ignored)',
    'starts/morning.json: unknown field "oppening" (ignored)',
    'starts/storm.json cast "jonah": unknown field "mood" (ignored)',
  ]);
  assert.ok(w.starts.every((s) => s.scenario), 'every start still composes');
});

test('a new-format world may leave out format (it is 2); any other value is a problem', () => {
  assert.equal(load((f) => delete f['world.json'].format).legacy, false);
  assert.throws(() => load((f) => { f['world.json'].format = 1; }), /"format" must be 2/);
});

// ---------- legacy ----------

test('a legacy scenario folder composes to the same game it produced before', () => {
  const E = loadEngine();
  const w = readWorld(LEGACY, E);
  assert.equal(w.legacy, true);
  assert.deepEqual([...w.starts.map((s) => s.id)], ['default']);
  assert.deepEqual([...w.warnings], []);
  const composed = E.Scenario.startScenario(w);
  // The old loader: scenario.json + characterData, validated as it is.
  const before = E.Scenario.validate(readScenario(LEGACY));
  const added = ['worldId', 'startId', 'worldTitle', 'startTitle'];
  assert.deepEqual(Object.keys(composed).filter((k) => !added.includes(k)).sort(), Object.keys(before).sort());
  Object.keys(before).forEach((k) => assert.deepEqual(plain(composed[k]), plain(before[k]), `scenario.${k}`));
  assert.equal(composed.worldId, 'mars-station');
  assert.equal(composed.startId, 'default');
  const a = E.Engine.newGame(before);
  const b = E.Engine.newGame(composed);
  ['characters', 'locations', 'clocks', 'facts', 'order', 'time', 'world', 'factions'].forEach((k) =>
    assert.deepEqual(plain(b[k]), plain(a[k]), `state.${k}`));
  assert.equal(E.Prompts.header(b), E.Prompts.header(a), 'the prompt header is unchanged');
});

test('fromLegacy splits a scenario into a world and one start, "default"', () => {
  const E = loadEngine();
  const b = E.Scenario.fromLegacy(readScenario(LEGACY));
  assert.deepEqual([...b.world.starts], ['default']);
  assert.equal(b.starts.default.player, 'navarro');
  assert.deepEqual([...b.starts.default.cast], [...b.world.characters]);
  ['start', 'player', 'locations', 'clocks', 'opening', 'castLabel'].forEach((k) => assert.equal(b.world[k], undefined, k));
  assert.ok(b.world.setting && b.world.factions);
});

// ---------- bundled worlds ----------

test('every bundled world validates, and every start in it starts a game and plays a turn', async () => {
  for (const folder of scenarioFolders()) {
    const w = readWorld(folder);
    assert.deepEqual([...w.warnings], [], `${folder}: no unknown fields`);
    for (const st of w.starts) {
      assert.ok(!st.error, `${folder}/${st.id}: ${st.error}`);
      const { E, state } = newGame(folder, st.id);
      assert.ok(state.characters[state.player], `${folder}/${st.id}: player exists`);
      assert.equal(state.scenario.startId, st.id);
      mockLLM(E, ({ kind }) => (kind === 'intent' ? { player: { needs_roll: false }, intents: [], events: [] } : 'You look around.'));
      await E.Engine.runTurn(state, 'Look around.', 'moment');
      assert.equal(state.turn, 1, `${folder}/${st.id}: a turn played`);
    }
  }
});

// Captured before the bundled folders were converted (task 1-2): each
// converted world's default start must begin the same game its old
// scenario.json did.
test('converted bundled worlds start the same game as their legacy versions', () => {
  const pairs = { 'mars-station': LEGACY, 'zombie-holdout': path.join(__dirname, 'fixtures', 'legacy-zombie-holdout') };
  for (const [folder, legacyDir] of Object.entries(pairs)) {
    const now = newGame(folder);
    const before = newGame(legacyDir);
    // Descriptions and appearances were added after the conversion (task 1-7).
    Object.values(now.state.characters).forEach((c) => { delete c.description; delete c.appearance; });
    // Cast tiers (task 2-1) and agendas (task 2-2) were added after the conversion too: zombie-holdout's Ortiz starts local.
    [now, before].forEach((g) => Object.values(g.state.characters).forEach((c) => { delete c.tier; delete c.agenda; }));
    // Memberships of the groups (task G-6) too: Ares Deep's crew belong to Mission Control.
    Object.values(now.state.characters).forEach((c) => { delete c.groups; });
    // Regions (task 3-1) too: every location got a region, and the header a REGIONS block.
    Object.values(now.state.locations).forEach((l) => { delete l.region; });
    // And site layout data (task 3-3).
    Object.values(now.state.locations).forEach((l) => ['size', 'level', 'outside', 'features', 'links'].forEach((k) => delete l[k]));
    // And faction colours for the world map (task 3-4).
    now.state.factions.forEach((f) => { delete f.color; delete f.allies; delete f.enemies; });
    // And the canon past (task 5-2): its facts and chapter zero.
    now.state.facts = now.state.facts.filter((f) => !f.canon);
    // And harmful, repeating pressures (playtest-coffee-skips): Ares Deep's thirst, Holdout's hunger.
    const noHarm = (list) => (list || []).forEach((c) => {
      delete c.fireHarm; delete c.repeat;
      if (c.then) { c.then = c.then.filter((t) => t.id !== 'thirst'); noHarm(c.then); if (!c.then.length) delete c.then; }
    });
    noHarm(now.state.clocks);
    ['characters', 'locations', 'clocks', 'world', 'facts', 'factions', 'order', 'time', 'recent', 'player'].forEach((k) =>
      assert.deepEqual(plain(now.state[k]), plain(before.state[k]), `${folder}: state.${k}`));
    assert.equal(now.state.scenario.worldId, folder);
    // Genre tags (task 1-4), regions (3-1) and always-on lore (5-1) were added after the conversion; everything else is unchanged.
    const withoutGenre = (h) => h.replace(/\n\n=== (GENRE AND TONE|REGIONS|WORLD LORE|STORY SO FAR) ===\n[\s\S]*?(?=\n\n=== )/g, '').replace(/ \[region: [a-z0-9_-]+\]/g, '');
    assert.equal(withoutGenre(now.E.Prompts.header(now.state)), before.E.Prompts.header(before.state), `${folder}: prompt header`);
  }
});

// ---------- saves ----------

test('save migration v1→v2 records the world and start, and changes nothing else', () => {
  const { E, state } = newGame();
  const v1 = plain(state);
  v1.version = 1;
  delete v1.scenario.worldId;
  delete v1.scenario.startId;
  v1.undo = { state: plain(v1), turn: 1 };
  const before = plain(v1);
  const v2 = E.Engine.migrate(v1);
  assert.equal(v2.version, E.Engine.STATE_VERSION, 'and on through later steps');
  assert.equal(v2.scenario.worldId, 'mars-station');
  assert.equal(v2.scenario.startId, 'default');
  assert.equal(v2.undo.state.version, E.Engine.STATE_VERSION, 'the undo copy is migrated too');
  const strip = (s) => { const o = plain(s); delete o.version; delete o.scenario.worldId; delete o.scenario.startId; if (o.undo) o.undo.state = strip(o.undo.state); return o; };
  assert.deepEqual(strip(v2), strip(before));
});

test('save migration: a state with no version is version 1; current states pass through; newer ones are refused', () => {
  const { E, state } = newGame();
  assert.equal(state.version, E.Engine.STATE_VERSION);
  assert.deepEqual(plain(E.Engine.migrate(plain(state))), plain(state));
  const old = plain(state);
  delete old.version;
  delete old.scenario.worldId;
  old.scenario.folder = undefined;
  assert.equal(E.Engine.migrate(old).scenario.worldId, 'mars-station', 'falls back to the scenario id');
  assert.throws(() => E.Engine.migrate(Object.assign(plain(state), { version: 99 })), /newer version/);
});

// Ares Deep's second start (task 1-2): same world and crew, seen by Priya.
test('one world, two starts: Priya\'s garage start shares the crew but not the player, place or pressures', () => {
  const kit = newGame('mars-station', 'recycler').state;
  const priya = newGame('mars-station', 'garage').state;
  assert.equal(kit.player, 'navarro');
  assert.equal(priya.player, 'raman');
  assert.equal(priya.characters.raman.status.location, 'garage');
  assert.equal(priya.characters.navarro.status.location, 'commons');
  ['name', 'secret', 'want', 'skills', 'relations'].forEach((k) =>
    assert.deepEqual(plain(priya.characters.okafor[k]), plain(kit.characters.okafor[k]), `identity: ${k}`));
  assert.ok(priya.clocks.some((c) => c.id === 'uplink'));
  assert.ok(!kit.clocks.some((c) => c.id === 'uplink'));
  assert.equal(priya.scenario.title, 'Ares Deep: Sol 214: the Mule');
  assert.notEqual(priya.recent[0].text, kit.recent[0].text, 'its own opening');
});
