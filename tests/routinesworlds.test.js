// Routines in the worlds (task G-9): Seiryo High and Ares Deep keep their
// days, cards say so, timeline events change a routine, the creator edits
// them, and generated casts can take one.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, newGame, readWorld, worldFiles, mockLLM } = require('./helpers');

const seiryo = (start = 'hayakawa') => {
  const g = newGame('seiryo-high', start);
  g.state.characters[g.state.player].status.location = 'cafe'; // out of everyone's way
  return Object.assign(g, { Eng: g.E.Engine, where: (id) => g.state.characters[id].status.location });
};
const toHour = (g, hour) => {
  const left = (hour - g.state.time.hour + 24) % 24 || 24;
  for (let i = 0; i < left; i++) g.Eng.advanceTime(g.state, 1, { events: [] });
};

test('a Seiryo school day moves its people by routine', () => {
  const g = seiryo(); // a Wednesday, the first day of term
  toHour(g, 10);
  assert.equal(g.where('aoi'), 'classroom-1c');
  assert.equal(g.where('rin'), 'classroom-1b');
  assert.equal(g.where('ren'), 'classroom-1a');
  assert.ok(g.Eng.isAway(g.state, 'kenji'), 'Dad is at the office');
  assert.equal(g.Eng.knownWhere(g.state, 'kenji') && g.Eng.inWords(g.state, 'kenji'), 'at work');
  assert.ok(g.Eng.isAway(g.state, 'momo'), 'Momo is at her middle school, off the map');
  toHour(g, 16);
  assert.equal(g.where('goro'), 'judo-dojo');
  assert.equal(g.where('kotone'), 'art-room');
  assert.equal(g.where('aoi'), 'field');
  toHour(g, 23);
  assert.ok(g.Eng.isAway(g.state, 'aoi'), 'home, off the map');
  assert.equal(g.where('kazuha'), 'kazuha-room', 'a dorm student sleeps in their room');
  assert.equal(g.where('kenji'), 'parents-room');
  assert.ok(!g.Eng.isAway(g.state, 'kenji'));
  assert.equal(g.where('momo'), 'momo-room');
});

test('a weekend and the summer break aren\'t school days', () => {
  const g = seiryo();
  const student = g.state.scenario.routines.student;
  assert.equal(g.Eng.dayType(g.state, student, g.E.dayOfDate(g.state.scenario, '2026-04-08')), 'school');
  assert.equal(g.Eng.dayType(g.state, student, g.E.dayOfDate(g.state.scenario, '2026-04-11')), 'free', 'a Saturday');
  assert.equal(g.Eng.dayType(g.state, student, g.E.dayOfDate(g.state.scenario, '2026-08-03')), 'free', 'a Monday in summer');
  assert.equal(g.Eng.dayType(g.state, student, g.E.dayOfDate(g.state.scenario, '2027-12-28')), 'free', 'the winter break, a year on');
  assert.equal(g.Eng.routineAt(g.state, 'kenji', { day: g.E.dayOfDate(g.state.scenario, '2026-08-03'), hour: 10 }), 'away', 'Dad still works');
});

test('Ares Deep\'s crew keep their shifts across a sol', () => {
  const { E, state } = newGame('mars-station');
  const g = { E, state, Eng: E.Engine };
  state.characters[state.player].status.location = 'surface';
  state.clocks.forEach((c) => { c.perHour = 0; });
  const where = (id) => state.characters[id].status.location;
  toHour(g, 9);
  assert.equal(where('bauer'), 'hydro');
  assert.equal(where('raman'), 'garage');
  toHour(g, 12);
  assert.equal(where('bauer'), 'commons', 'lunch');
  toHour(g, 23);
  assert.equal(where('okafor'), 'quarters');
});

test('the graduates leave, and the rest move up a year', () => {
  const g = seiryo();
  const ev = g.state.scenario.timeline.find((e) => e.id === 'class-lists-2');
  const before = { rin: g.state.characters.rin.places.class, momo: g.state.characters.momo.routine };
  g.E.Timeline.happen(g.state, ev, ev, { events: [], guards: [], director: [] }, 'fired');
  assert.equal(before.rin, 'classroom-1b');
  assert.equal(g.state.characters.rin.places.class, 'classrooms-2');
  assert.equal(g.state.characters.kazuha.places.class, 'classrooms-3');
  assert.equal(g.state.characters.momo.routine, 'student', 'Momo starts at Seiryo');
  assert.equal(g.state.characters.momo.places.home, 'momo-room', 'and still lives at home');
  const grad = g.state.scenario.timeline.find((e) => e.id === 'graduation-1');
  g.E.Timeline.happen(g.state, grad, grad, { events: [], guards: [], director: [] }, 'fired');
  assert.equal(g.where('reiko'), 'tokyo-campus');
  toHour(g, 10);
  assert.equal(g.where('reiko'), 'tokyo-campus', 'no routine pulls them back to class');
});

test('a timeline event can name someone not in the story yet', () => {
  const g = seiryo('dorm');
  assert.ok(g.state.waiting.momo);
  const ev = g.state.scenario.timeline.find((e) => e.id === 'class-lists-2');
  g.E.Timeline.happen(g.state, ev, ev, { events: [], guards: [], director: [] }, 'fired');
  assert.equal(g.state.waiting.momo.routine, 'student');
});

test('a card says someone\'s usual day, leaving private slots out', () => {
  const g = seiryo();
  const aoi = g.Eng.routineWords(g.state, 'aoi');
  assert.match(aoi, /8–12 Class 1-C/);
  assert.match(aoi, /15–18 (Sports Field|[A-Z])/);
  assert.match(aoi, /at home/);
  const takumi = g.Eng.routineWords(g.state, 'takumi');
  assert.doesNotMatch(takumi, /12–13/, 'the private slot');
  assert.match(takumi, /8–12/);
  assert.ok(g.Eng.routineWords(g.state, g.state.player), 'the player has theirs too');
  assert.equal(newGame('zombie-holdout').E.Engine.routineWords(newGame('zombie-holdout').state, newGame('zombie-holdout').state.player), null);
});

test('the bundled examples: routines where a day has a shape, none in the siege', () => {
  const E = loadEngine();
  assert.ok(readWorld('seiryo-high', E).starts.every((s) => !s.error));
  assert.ok(readWorld('mars-station', E).starts.every((s) => !s.error));
  assert.equal(worldFiles('zombie-holdout')['world.json'].routines, undefined);
});

test('a routine made in the creator plays', () => {
  const E = loadEngine();
  const WE = E.WorldEdit;
  const files = JSON.parse(JSON.stringify(worldFiles(path.join(__dirname, 'fixtures', 'routine-town'))));
  assert.equal(WE.addRoutine(files, 'night watch'), 'names are lowercase letters, digits, - or _');
  assert.equal(WE.addRoutine(files, 'watch'), '');
  assert.match(WE.addRoutine(files, 'watch'), /already a routine/);
  const r = files['world.json'].routines.watch;
  WE.set(files['world.json'], 'routines.watch.slots.0.at', 'csv', 'canteen, yard');
  WE.set(files['world.json'], 'routines.watch.slots.1.at', 'csv', 'home');
  assert.equal(WE.addDayType(r, 'duty'), '');
  assert.deepEqual([...Object.keys(r.slots)], ['duty'], 'the plain list becomes the first type\'s');
  WE.removeDayType(r, 'duty');
  assert.ok(Array.isArray(r.slots), 'and back');
  assert.equal(WE.renameRoutine(files, 'student', 'pupil'), '');
  assert.equal(files['characters/aoi.json'].routine, 'pupil', 'people follow a rename');
  assert.equal(files['starts/monday.json'].playerSlot.routine, 'pupil');
  files['characters/gil.json'].routine = 'watch';
  files['characters/gil.json'].places = WE.parse('places', 'home=away').value;
  assert.equal(files['characters/gil.json'].places.home, null);
  assert.equal(WE.show('places', { home: null, class: 'classroom' }), 'home=away, class=classroom');
  const world = E.Scenario.prepareWorld('routine-town', files);
  assert.equal(world.starts[0].error, undefined);
  const state = E.Engine.newGame(E.Scenario.startScenario(world, 'monday'));
  assert.ok(['canteen', 'yard'].includes(E.Engine.routineAt(state, 'gil', { day: 5, hour: 10 })));
  WE.removeRoutine(files, 'pupil');
  assert.equal(files['characters/aoi.json'].routine, undefined, 'removing it takes it off people');
});

test('date lists read and write in the creator\'s words', () => {
  const WE = loadEngine().WorldEdit;
  const v = WE.parse('dates', '2026-07-21..2026-08-31, 2026-12-25').value;
  assert.deepEqual(JSON.parse(JSON.stringify(v)), [{ from: '2026-07-21', to: '2026-08-31' }, '2026-12-25']);
  assert.equal(WE.show('dates', v), '2026-07-21..2026-08-31, 2026-12-25');
  assert.match(WE.parse('places', 'nonsense').error, /word=room-id/);
});

test('the character form keeps a routine and its places through a save', () => {
  const E = loadEngine();
  const files = worldFiles('seiryo-high');
  const pool = Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith('characters/')).map(([k, v]) => [k.slice(11, -5), v]));
  const sc = E.CharMaker.authorScenario(files['world.json'], null, pool, 'takumi');
  const f = E.CharMaker.authorForm(sc, pool.takumi);
  assert.equal(f.routine, 'student');
  const out = E.CharMaker.buildAuthor(sc, f, pool.takumi);
  assert.deepEqual(out.errors, undefined);
  assert.equal(out.character.routine, 'student');
  assert.equal(out.character.places.club, 'behind-gym');
  assert.ok(out.character.slots, 'own slots, which the form doesn\'t show, stay');
  assert.equal(E.CharMaker.toFile(out.character).routine, 'student');
});

test('a generated person can take a routine, its words filled from the rooms made', () => {
  const E = loadEngine();
  const sc = readWorld('seiryo-high', E).starts[0].scenario;
  const rooms = [{ id: 'den', name: 'Den', desc: 'x', connects: [] }];
  const ctx = { sc, job: { steps: { rooms: { rooms, playerRoom: 'den' }, plan: { people: [] } }, cast: [] }, taken: { ids: new Set(), names: new Set(), people: [] } };
  const sheet = { want: 'pass', traits: ['calm'], secret: 'cheats at cards', room: 'den', routine: 'student', places: [{ word: 'home', room: 'den' }, { word: 'class', room: 'nowhere' }] };
  const out = E.StartGen.cleanPerson(sheet, { name: 'Nao Abe', role: 'first-year' }, ctx, new Set());
  assert.equal(out.error, undefined);
  assert.equal(out.character.routine, 'student');
  assert.equal(out.character.places.home, 'den');
  assert.equal(out.character.places.class, null, 'a word with no real room is off the map');
  const none = E.StartGen.cleanPerson(Object.assign({}, sheet, { routine: 'pirate' }), { name: 'Nao Abe', role: 'first-year' }, ctx, new Set());
  assert.equal(none.character.routine, undefined, 'only the world\'s named routines');
});

test('a routine\'s place words are what isn\'t a room', () => {
  const E = loadEngine();
  assert.deepEqual([...E.Scenario.routineWords({ slots: [{ at: ['class', 'cafeteria'] }] }, new Set(['cafeteria']))], ['class']);
});

test('a real school day plays through turns with people coming and going', async () => {
  const g = newGame('seiryo-high', 'hayakawa');
  const { E, state } = g;
  state.characters.sora.status.location = 'classroom-1b';
  state.time.hour = 11.5;
  mockLLM(E, ({ kind }) => (kind.startsWith('intent') ? { player: { summary: 'waits', needs_roll: false, move_to: null }, intents: [], events: [] } : kind.startsWith('update') ? { facts: [] } : '[+5m] The lesson drags.\n\n[+40m] Lunch.'));
  const out = await E.Engine.runTurn(state, 'I sit through class.', 'hour');
  assert.ok(out.res.routineDay);
});
