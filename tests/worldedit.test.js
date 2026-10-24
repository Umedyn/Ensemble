// World, group and start editing for the creator (task 6-1): fields bound to
// paths, a blank world that plays, starts, rooms and their references, the
// cast and its overrides, groups and needs with their references, legacy
// folders and zips.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, worldFiles, newGame, mockLLM } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const E = loadEngine();
const WE = E.WorldEdit;
const loads = (folder, files) => {
  const w = E.Scenario.prepareWorld(folder, plain(files));
  w.starts.forEach((s) => assert.equal(s.error, undefined, `start "${s.id}": ${s.error}`));
  return w;
};

// ---------- fields ----------

test('a bound field sets, makes the objects on the way, and blank deletes', () => {
  const o = {};
  WE.set(o, 'eventRates.regional', 'num', '24');
  assert.deepEqual(plain(o), { eventRates: { regional: 24 } });
  WE.set(o, 'eventRates.regional', 'num', '');
  assert.deepEqual(plain(o), {}, 'an emptied object goes too');
  assert.match(WE.set(o, 'wakeHour', 'int', '7.5').error, /whole number/);
  assert.match(WE.set(o, 'skillPenalties', 'json', '{"health":').error, /not valid JSON/);
  assert.deepEqual(plain(o), {}, 'a bad value changes nothing');
  WE.set(o, 'rules', 'lines', 'one\n\n  two  \n');
  WE.set(o, 'tags', 'csv', 'survival, , horror, survival');
  WE.set(o, 'features', 'features', 'forklift, camera=on');
  assert.deepEqual(plain(o), { rules: ['one', 'two'], tags: ['survival', 'horror'], features: ['forklift', { name: 'camera', state: 'on' }] });
  WE.set(o, 'opening', 'str', '');
  assert.equal(o.opening, '', 'str keeps an empty text');
  WE.set(o, 'seen', 'unseen', false);
  assert.equal(o.seen, false);
  WE.set(o, 'seen', 'unseen', true);
  assert.ok(!('seen' in o), 'known rooms leave the field out');
  WE.set(o, 'location', 'null', '');
  assert.equal(o.location, null);
  assert.equal(WE.show('features', o.features), 'forklift, camera=on');
});

test('setting inside a plain cast id turns it into an entry', () => {
  const st = { cast: ['okafor', { id: 'bauer' }] };
  WE.set(st, 'cast.0.status.location', 'text', 'lab');
  assert.deepEqual(plain(st.cast[0]), { id: 'okafor', status: { location: 'lab' } });
  WE.set(st, 'cast.1.relations.okafor', 'int', '', {});
  assert.deepEqual(plain(st.cast[1]), { id: 'bauer' }, 'deleting nothing makes nothing');
});

test('renaming a key keeps its place', () => {
  const o = { power: 'on', comms: 'up' };
  assert.equal(WE.renameKey(o, 'power', 'grid'), '');
  assert.deepEqual(Object.keys(o), ['grid', 'comms']);
  assert.match(WE.renameKey(o, 'grid', 'comms'), /already used/);
  assert.match(WE.renameKey(o, 'grid', 'a.b'), /without dots/);
});

// ---------- a blank world ----------

test('a blank world loads, starts a game and plays a turn', async () => {
  const b = WE.blankWorld('The Lighthouse', ['lighthouse']);
  assert.equal(b.folder, 'lighthouse-2', 'the folder name is unique');
  const w = loads(b.folder, b.files);
  assert.deepEqual([...w.warnings], []);
  const state = E.Engine.newGame(E.Scenario.startScenario(w, 'start'));
  assert.equal(state.player, 'you');
  mockLLM(E, ({ kind }) => (kind === 'intent' ? { intents: [] } : kind === 'update' ? {} : 'The room is quiet.'));
  await E.Engine.runTurn(state, 'I look around.', 'hour');
  assert.equal(state.turn, 1);
});

test('a world built up from blank: a room with a door, a new person, a group, a need and a pressure chain', () => {
  const { folder, files } = WE.blankWorld('Harbor Watch');
  const st = files['starts/start.json'];
  const room = WE.addRoom(files, 'start', 'Boathouse');
  WE.connect(st, 'main-room', room, 'locked door', ['you']);
  const ana = WE.newPerson(files, { name: 'Ana Reyes', role: 'harbormaster' });
  WE.addToCast(files, 'start', ana, room);
  const g = WE.addGroup(files, 'Harbor Guild');
  WE.addNeed(files, 'Sleep');
  WE.set(files['world.json'], 'world.tide', 'str', 'low');
  const clock = WE.newClock(files, 'Storm');
  clock.fireWorld = { tide: 'storm surge' };
  clock.then = [WE.newClock(files, 'Flood')];
  clock.then[0].id = 'flood';
  st.clocks.push(clock);
  WE.set(st, 'cast.1.relations.you', 'int', '20');
  const w = loads(folder, files);
  const sc = w.starts[0].scenario;
  assert.deepEqual([...sc.characters], ['you', 'ana-reyes']);
  assert.equal(sc.characterData[1].status.location, 'boathouse');
  assert.equal(sc.characterData[1].relations.you, 20);
  const door = sc.locations.find((l) => l.id === 'main-room').links[0];
  assert.deepEqual(plain(door), { to: 'boathouse', kind: 'locked door', key: ['you'] });
  assert.ok(sc.locations.find((l) => l.id === 'boathouse').links.some((k) => k.to === 'main-room' && k.kind === 'locked door'), 'both sides');
  assert.equal(sc.factions[0].id, g);
  assert.equal(sc.needs[0].id, 'sleep');
  const state = E.Engine.newGame(E.Scenario.startScenario(w, 'start'));
  assert.ok(state.clocks.some((c) => c.id === 'storm'));
});

test('a blank world whose player makes their own character still loads', () => {
  const { folder, files } = WE.blankWorld('Open Door');
  delete files['starts/start.json'].player;
  WE.ensureSlot(files, 'start');
  loads(folder, files);
});

// ---------- starts ----------

test('starts are added, duplicated, renamed and removed, and the world stays valid', () => {
  const files = worldFiles('mars-station');
  const dup = WE.duplicateStart(files, 'garage');
  assert.equal(dup, 'garage-copy');
  assert.deepEqual([...files['world.json'].starts], ['recycler', 'garage', 'garage-copy'], 'next to the original');
  assert.match(files['starts/garage-copy.json'].title, /\(copy\)$/);
  const fresh = WE.addStart(files, 'Sol 1: landing');
  assert.equal(files[`starts/${fresh}.json`].region, 'station', 'a new start begins where the others do');
  loads('mars-station', files);
  assert.match(WE.renameStart(files, dup, 'garage'), /already a start/);
  assert.equal(WE.renameStart(files, dup, 'night-shift'), '');
  assert.ok(files['starts/night-shift.json'] && !files['starts/garage-copy.json']);
  assert.equal(files['starts/night-shift.json'].id, 'night-shift');
  WE.removeStart(files, fresh);
  assert.ok(!files[`starts/${fresh}.json`]);
  loads('mars-station', files);
  const b = WE.blankWorld('Solo');
  assert.equal(WE.removeStart(b.files, 'start').error, undefined);
  const open = loads(b.folder, b.files);
  assert.equal(open.starts.length, 0);
  assert.equal(open.generate, true, 'a world with no starts gets "Make my own"');
});

// ---------- rooms ----------

test('removing a room clears everything that points at it, and says so', () => {
  const files = worldFiles('zombie-holdout');
  const sid = files['world.json'].starts[0];
  const st = files[`starts/${sid}.json`];
  const target = st.locations.find((l) => (st.cast || []).some((c) => ((c.status && c.status.location) || (files[`characters/${c.id || c}.json`].status || {}).location) === l.id) && l.id !== st.locations[0].id) || st.locations[1];
  const id = target.id;
  st.entrances = (st.entrances || []).concat([{ room: id, kind: 'door', watched: false }]);
  const r = WE.removeRoom(files, sid, id);
  assert.ok(r.notes.length, 'notes for the page');
  assert.ok(!st.locations.some((l) => l.id === id));
  assert.ok(st.locations.every((l) => !(l.connects || []).includes(id) && !(l.links || []).some((k) => k.to === id)));
  assert.ok(!(st.entrances || []).some((e) => e.room === id));
  loads('zombie-holdout', files);
});

test('the last room of a start cannot be removed', () => {
  const b = WE.blankWorld('Tiny');
  assert.match(WE.removeRoom(b.files, 'start', 'main-room').error, /at least one room/);
});

test('connections are read from either side and change kind on both', () => {
  const st = { locations: [{ id: 'a', connects: ['b'] }, { id: 'b' }, { id: 'c', links: [{ to: 'a', kind: 'vent' }] }] };
  assert.deepEqual(plain(WE.connections(st, 'a')), [{ to: 'b', kind: null }, { to: 'c', kind: 'vent' }]);
  WE.connect(st, 'a', 'b', 'door');
  assert.deepEqual(plain(st.locations[1].links), [{ to: 'a', kind: 'door' }]);
  WE.connect(st, 'a', 'b', null);
  assert.ok(!st.locations[0].links && st.locations[0].connects.includes('b'), 'back to a plain connection');
  WE.disconnect(st, 'c', 'a');
  assert.deepEqual(plain(WE.connections(st, 'a')), [{ to: 'b', kind: null }]);
});

// ---------- the cast ----------

test('a cast override that says what the file says is dropped', () => {
  const files = worldFiles('mars-station');
  const st = files['starts/garage.json'];
  const i = st.cast.findIndex((c) => (c.id || c) === 'okafor');
  const fileRel = files['characters/okafor.json'].relations.navarro;
  WE.set(st, `cast.${i}.relations.navarro`, 'int', String(fileRel));
  WE.tidyCastEntry(files, 'garage', i);
  assert.ok(!(st.cast[i].relations && 'navarro' in st.cast[i].relations));
  const solo = { cast: [{ id: 'okafor', relations: { navarro: fileRel } }] };
  files['starts/solo.json'] = solo;
  files['world.json'].starts.push('solo');
  WE.tidyCastEntry(files, 'solo', 0);
  assert.equal(solo.cast[0], 'okafor', 'nothing left: the plain id again');
});

test('taking the player out of the cast hands the part on, and drops feelings about them', () => {
  const files = worldFiles('mars-station');
  const st = files['starts/garage.json'];
  const notes = WE.removeFromCast(files, 'garage', 'raman');
  assert.ok(!WE.castIds(st).includes('raman'));
  assert.ok(st.player && st.player !== 'raman');
  assert.match(notes.join(' '), /is the player now/);
  assert.ok(st.cast.every((c) => typeof c === 'string' || !(c.relations && 'raman' in c.relations)));
  loads('mars-station', files);
});

test('joining a shared room to a start room writes only on the start side', () => {
  const files = worldFiles('mars-station');
  const w = files['world.json'], st = files['starts/garage.json'];
  const id = WE.addRoom(files, 'garage', 'Dust shed');
  WE.connect([w, st], 'garage', id, 'door');
  assert.ok(!JSON.stringify(w.locations).includes(id), 'world.json is untouched');
  assert.deepEqual(plain(WE.connections([w, st], 'garage').find((c) => c.to === id)), { to: id, kind: 'door' });
  loads('mars-station', files);
  WE.disconnect([w, st], 'garage', id);
  assert.equal(WE.connections([w, st], id).length, 0);
});

test('a new person gets an id that clashes with nothing', () => {
  const files = worldFiles('mars-station');
  const id = WE.newPerson(files, { name: 'Commons', role: 'cook' });
  assert.equal(id, 'commons-2', 'a room is already "commons"');
  assert.ok(files['world.json'].characters.includes(id));
  WE.addToCast(files, 'garage', id);
  loads('mars-station', files);
});

// ---------- groups and needs ----------

test('renaming a group follows regions, groups on the map and timeline events', () => {
  const files = worldFiles('zombie-holdout');
  const w = files['world.json'];
  const held = (w.regions || []).find((r) => r.controller);
  const from = held.controller;
  w.timeline = (w.timeline || []).concat([{ id: 'test-ev', when: { day: 99, hour: 9 }, scope: 'world', text: 'Something shifts.', preconditions: [{ not: { controls: { group: from, region: held.id } } }], effects: { groups: [{ id: from, stance: 'wary' }] } }]);
  assert.match(WE.renameGroup(files, from, 'Bad Id'), /lowercase/);
  assert.equal(WE.renameGroup(files, from, 'renamed'), '');
  assert.equal(held.controller, 'renamed');
  const ev = w.timeline.find((e) => e.id === 'test-ev');
  assert.equal(ev.preconditions[0].not.controls.group, 'renamed');
  assert.equal(ev.effects.groups[0].id, 'renamed');
  loads('zombie-holdout', files);
  const notes = WE.removeGroup(files, 'renamed');
  assert.ok(notes.length);
  assert.equal(held.controller, null);
  assert.ok(!ev.preconditions && !ev.effects);
  loads('zombie-holdout', files);
});

test('renaming or removing a need follows it into thresholds, cast entries and character files', () => {
  const files = worldFiles('mars-station');
  assert.equal(WE.renameNeed(files, 'fatigue', 'tiredness'), '');
  assert.ok(files['world.json'].needs.some((n) => n.id === 'tiredness'));
  const st = files['starts/garage.json'];
  assert.ok(st.cast.some((c) => c.needs && 'tiredness' in c.needs) && !st.cast.some((c) => c.needs && 'fatigue' in c.needs));
  loads('mars-station', files);
  WE.removeNeed(files, 'tiredness');
  assert.ok(!JSON.stringify(files).includes('"tiredness"'));
  loads('mars-station', files);
});

test('picking a region for an event idea turns it into {text, region}, and none back into text', () => {
  const w = { eventSeeds: { regional: ['a quake'] } };
  WE.setSeedRegion(w, 'regional', 0, 'rim');
  assert.deepEqual(plain(w.eventSeeds.regional), [{ text: 'a quake', region: 'rim' }]);
  assert.equal(WE.seedPath(w, 'regional', 0), 'eventSeeds.regional.0.text');
  WE.setSeedRegion(w, 'regional', 0, '');
  assert.deepEqual(plain(w.eventSeeds.regional), ['a quake']);
});

// ---------- importing ----------

test('a legacy folder opens as a world that loads', () => {
  const files = WE.fromFiles(worldFiles(path.join(__dirname, 'fixtures', 'legacy-scenario')));
  assert.equal(files['world.json'].format, 2);
  assert.deepEqual([...files['world.json'].starts], ['default']);
  loads('legacy-scenario', files);
});

test('a zip of a world folder opens with its files and images', () => {
  const files = worldFiles('mars-station');
  const entries = Object.entries(files).map(([p, j]) => ({ name: `mars-station/${p}`, data: E.Zip.utf8(JSON.stringify(j)) }))
    .concat([{ name: 'mars-station/maps/hellas.svg', data: E.Zip.utf8('<svg/>') }, { name: 'mars-station/notes.txt', data: E.Zip.utf8('x') }]);
  const z = WE.fromZip(E.Zip.read(E.Zip.build(entries)));
  assert.equal(z.folder, 'mars-station');
  assert.deepEqual(Object.keys(z.files).sort(), Object.keys(files).sort());
  assert.deepEqual(Object.keys(z.assets), ['maps/hellas.svg'], 'images only');
  loads(z.folder, z.files);
  const rootZip = WE.fromZip(E.Zip.read(E.Zip.build([{ name: 'world.json', data: E.Zip.utf8(JSON.stringify(files['world.json'])) }])));
  assert.equal(rootZip.folder, 'mars-station', 'at the root: named by the world id');
  assert.throws(() => WE.fromZip(E.Zip.read(E.Zip.build([{ name: 'a/b.txt', data: E.Zip.utf8('x') }]))), /No world\.json/);
});

test('the test-play payload is a copy, so later edits do not reach a running test', () => {
  const b = WE.blankWorld('Copy');
  const p = WE.testPlayPayload(b.folder, b.files, {}, 'start');
  b.files['world.json'].title = 'Changed';
  assert.equal(p.files['world.json'].title, 'Copy');
  assert.equal(p.type, WE.TEST_WORLD);
  assert.equal(p.startId, 'start');
});

// ---------- the world's people (task 6-2) ----------

const poolOf = (files) => Object.fromEntries(files['world.json'].characters.map((id) => [id, files[`characters/${id}.json`]]));
const sorted = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

test('every bundled character opens in the author form and saves back unchanged', () => {
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const files = worldFiles(folder);
    const base = E.Scenario.prepareWorld(folder, plain(files)).starts[0].scenario;
    const pool = poolOf(files);
    Object.keys(pool).forEach((id) => {
      const sc = E.CharMaker.authorScenario(files['world.json'], base, pool, id);
      const out = E.CharMaker.buildAuthor(sc, E.CharMaker.authorForm(sc, pool[id]), pool[id]);
      assert.equal(out.errors, undefined, `${folder}/${id}: ${out.errors}`);
      assert.equal(sorted(plain(out.character)), sorted(pool[id]), `${folder}/${id}`);
    });
  }
});

test('the author form has no point budget, only the cap, and sets what a player never does', () => {
  const files = worldFiles('mars-station');
  const pool = poolOf(files);
  const sc = E.CharMaker.authorScenario(files['world.json'], null, pool, null);
  const f = E.CharMaker.authorForm(sc, {});
  Object.assign(f, { name: 'Lena Sato', roleText: 'cargo pilot', want: 'fly the lander home', traits: ['calm'] });
  sc.skills.forEach((k) => (f.skills[k] = 4));
  Object.assign(f, { knows: ['The lander is overdue.'], tier: 'secondary', pinned: true, tags: ['flight suit'], needs: { stress: 0.4 }, agendaMode: 'set' });
  f.agenda = { goal: 'check the lander telemetry', hours: 6, visibility: '', steps: [{ text: 'reads the logs', contact: false }, { text: 'comes to ask about fuel', contact: true }] };
  f.feelings.okafor = 30;
  const out = E.CharMaker.buildAuthor(sc, f, {});
  assert.equal(out.errors, undefined, String(out.errors));
  const c = plain(out.character);
  assert.equal(c.id, 'lena-sato');
  assert.equal(c.role, 'cargo pilot');
  assert.ok(Object.values(c.skills).every((v) => v === 4), 'no budget');
  assert.ok(!('status' in c), 'no play state in a pool file');
  assert.deepEqual(c.relations, { okafor: 30 }, 'only the feelings that were set');
  assert.deepEqual(c.agenda, { goal: 'check the lander telemetry', steps: ['reads the logs', { text: 'comes to ask about fuel', contact: true }], hours: 6 });
  assert.equal(c.tier, 'secondary');
  assert.equal(c.pinned, true);
  assert.deepEqual(c.needs, { stress: 0.4 });
  // Lore topics (task 5-5): checked against the world's list.
  f.topics = ['Travel', 'science'];
  assert.deepEqual(plain(E.CharMaker.buildAuthor(sc, f, {}).character.topics), ['travel', 'science']);
  f.topics = ['astrology'];
  assert.ok(E.CharMaker.buildAuthor(sc, f, {}).errors.some((e) => /"astrology" is not a topic this world knows/.test(e)));
  f.topics = [];
  f.skills.tech = 5;
  assert.ok(E.CharMaker.buildAuthor(sc, f, {}).errors.some((e) => /^Tech must be from 0 to 4/.test(e)), 'the cap still holds');
  f.skills.tech = 2;
  f.needs.stress = 3;
  assert.ok(E.CharMaker.buildAuthor(sc, f, {}).errors.some((e) => /Starting stress must be from 0 to 1/.test(e)));
});

test('an author portrait can be any image in the world folder', () => {
  const files = worldFiles('mars-station');
  const pool = poolOf(files);
  const sc = E.CharMaker.authorScenario(files['world.json'], null, pool, 'okafor');
  const f = E.CharMaker.authorForm(sc, pool.okafor);
  f.portrait = 'portraits/okafor.png';
  assert.equal(E.CharMaker.buildAuthor(sc, f, pool.okafor).character.portrait, 'portraits/okafor.png');
  f.portrait = 'none';
  assert.equal(E.CharMaker.buildAuthor(sc, f, pool.okafor).character.portrait, false);
  f.portrait = 'standin';
  assert.ok(!('portrait' in E.CharMaker.buildAuthor(sc, f, pool.okafor).character));
});

test('renaming a character follows casts, players, feelings, keys, the timeline and lore', () => {
  const files = worldFiles('mars-station');
  const w = files['world.json'];
  w.timeline.push({ id: 'test-ev', when: { day: 300, hour: 9 }, scope: 'world', text: 'A message arrives.', who: ['raman'], preconditions: [{ alive: 'raman' }, { known: 'landing', by: 'raman' }] });
  w.lore.push({ id: 'about-priya', title: 'Priya', level: 'character', ref: 'raman', text: 'She flew cargo before Mars.' });
  const garage = files['starts/garage.json'];
  garage.locations = [{ id: 'shed', name: 'Shed', connects: ['garage'], links: [{ to: 'garage', kind: 'locked door', key: ['raman'] }] }];
  assert.match(WE.renameCharacter(files, 'raman', 'commons'), /already used/);
  assert.equal(WE.renameCharacter(files, 'raman', 'priya'), '');
  assert.ok(files['characters/priya.json'] && !files['characters/raman.json']);
  assert.equal(files['characters/priya.json'].id, 'priya');
  assert.ok(w.characters.includes('priya') && !w.characters.includes('raman'));
  assert.equal(garage.player, 'priya');
  assert.equal(files['characters/okafor.json'].relations.priya, 5);
  assert.deepEqual(plain(garage.locations[0].links[0].key), ['priya']);
  const ev = w.timeline.find((e) => e.id === 'test-ev');
  assert.deepEqual(plain(ev.who), ['priya']);
  assert.deepEqual(plain(ev.preconditions), [{ alive: 'priya' }, { known: 'landing', by: 'priya' }]);
  assert.equal(w.lore.find((e) => e.id === 'about-priya').ref, 'priya');
  loads('mars-station', files);
});

test('taking a character out of the world leaves it valid, and says what changed', () => {
  const files = worldFiles('mars-station');
  const w = files['world.json'];
  w.timeline.push({ id: 'test-ev', when: { day: 300, hour: 9 }, scope: 'world', text: 'A message arrives.', who: ['bauer'], preconditions: [{ not: { alive: 'bauer' } }] });
  w.lore.push({ id: 'about-lev', title: 'Lev', level: 'character', ref: 'bauer', text: 'He grows the soy.' });
  const notes = WE.removeCharacter(files, 'bauer');
  assert.ok(!files['characters/bauer.json'] && !w.characters.includes('bauer'));
  assert.ok(!JSON.stringify(files).includes('"bauer"'), 'no reference is left');
  assert.ok(notes.some((n) => /condition/.test(n)) && notes.some((n) => /now a topic/.test(n)));
  assert.equal(w.lore.find((e) => e.id === 'about-lev').level, 'topic');
  loads('mars-station', files);
  // The player: the part passes to someone else in that start.
  const n2 = WE.removeCharacter(files, 'raman');
  assert.ok(n2.some((n) => /start "garage": .* is the player now/.test(n)));
  loads('mars-station', files);
});

test('portraits get a free path under portraits/', () => {
  const files = worldFiles('mars-station');
  assert.equal(WE.portraitPath(files, {}, 'Juniper Vale.PNG'), 'portraits/juniper-vale.png');
  assert.equal(WE.portraitPath(files, { 'portraits/okafor.png': {} }, 'x.png', 'okafor'), 'portraits/okafor-2.png');
});

// ---------- templates (R-4) ----------

test('every New world template loads, starts and plays a turn', async () => {
  for (const kind of Object.keys(WE.TEMPLATES)) {
    const b = WE.templateWorld(kind, `Test ${kind}`, []);
    const G = loadEngine();
    const w = G.Scenario.prepareWorld(b.folder, plain(b.files));
    assert.equal(w.starts[0].error, undefined, `${kind}: ${w.starts[0].error}`);
    assert.deepEqual([...w.warnings], [], kind);
    const state = G.Engine.newGame(G.Scenario.startScenario(w));
    assert.ok(G.Engine.regionChain(state, G.Engine.playerRegion(state)).length >= 2 || kind === 'planets', `${kind}: the start is inside a bigger region`);
    mockLLM(G, ({ kind: k }) => (k === 'intent' ? { player: { summary: 'look around' }, intents: [], events: [] }
      : k === 'update' ? { facts: [], state: [], relations: [], player_attitude: [] } : '[+0m] It is quiet.'));
    await G.Engine.runTurn(state, 'Look around.', 'moment');
    assert.equal(state.turn, 1, kind);
  }
  const p = WE.templateWorld('planets', 'Stars', []);
  const G = loadEngine();
  const state = G.Engine.newGame(G.Scenario.startScenario(G.Scenario.prepareWorld(p.folder, plain(p.files))));
  assert.equal(G.Engine.regionTrip(state, 'veyra-port', 'ossam').hours, 48, 'a hyperlane, two days');
  state.world.ship = 'grounded';
  assert.match(G.Engine.regionTrip(state, 'veyra-port', 'ossam').why, /needs ship is "ready"/);
  assert.deepEqual([...WE.templateWorld('city', 'Town', []).files['world.json'].regionLabels], ['city', 'district']);
});
