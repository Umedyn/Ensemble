// Routines in the engine (task G-7): people move around the map as the hours
// pass, with no model call. Fixture: fixtures/routine-town/ (school days and
// free days, a break, a home off the map, a locked door, a long ride).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadEngine, readWorld, worldFiles, newGame, mockLLM } = require('./helpers');

const TOWN = path.join(__dirname, 'fixtures', 'routine-town');
const MONDAY = 5, SATURDAY = 10, IN_THE_BREAK = 12;
const game = () => {
  const g = newGame(TOWN);
  // The player waits out of everyone's way unless a test says otherwise.
  g.state.characters.sora.status.location = 'canteen';
  return Object.assign(g, { Eng: g.E.Engine, where: (id) => g.state.characters[id].status.location });
};
const advance = (g, hours) => g.Eng.advanceTime(g.state, hours, { events: [] });

test('where someone should be follows the type of day, the hour and a slot past midnight', () => {
  const { Eng, state } = game();
  const at = (id, day, hour) => Eng.routineAt(state, id, { day, hour });
  assert.equal(at('aoi', MONDAY, 10), 'classroom');
  assert.equal(at('aoi', MONDAY, 10.5), 'classroom', 'part way through an hour');
  assert.equal(at('aoi', MONDAY, 15), 'canteen', 'a place word');
  assert.equal(at('aoi', MONDAY, 19), null, 'no slot for this hour');
  assert.equal(at('aoi', MONDAY, 23), 'aoi-room');
  assert.equal(at('aoi', MONDAY + 1, 3), 'aoi-room', 'the night slot wraps into the next day');
  assert.equal(at('ken', MONDAY + 1, 3), 'away', 'a home off the map');
  assert.equal(at('aoi', SATURDAY, 10), null, 'a free day has its own slots');
  assert.equal(at('ken', SATURDAY + 1, 7), 'away', 'Saturday night runs to eight');
  assert.equal(at('ken', SATURDAY + 2, 7), 'away', 'Sunday night too');
  assert.equal(at('ken', IN_THE_BREAK, 10), null, 'a Monday in the break is a free day');
  assert.equal(at('gil', 3, 10), 'city', 'a routine with no types of day runs every day');
  assert.equal(at('gil', 3, 3), 'plaza');
  assert.equal(at('rin', MONDAY, 12), 'workshop', 'their own slot comes before the routine');
  assert.equal(at('rin', MONDAY, 13), 'classroom', 'and the routine picks up after it');
});

test('the place among several is fixed for the person and the day, without dice', () => {
  const a = game(), b = game();
  a.E.rng = b.E.rng = () => { throw new Error('a routine rolled dice'); };
  const picks = new Set();
  for (let week = 0; week < 30; week++) {
    const day = MONDAY + 7 * (week + 2);
    const one = a.Eng.routineAt(a.state, 'aoi', { day, hour: 12 });
    assert.equal(one, b.Eng.routineAt(b.state, 'aoi', { day, hour: 12 }), 'the same in any game');
    assert.equal(one, a.Eng.routineAt(a.state, 'aoi', { day, hour: 12.9 }), 'the same all slot');
    picks.add(one);
  }
  assert.deepEqual([...picks].sort(), ['canteen', 'yard'], 'and it varies from day to day');
  advance(a, 30);
});

test('the player\'s routine is worked out and is their own entry, else the first listed', () => {
  const { Eng, state } = game();
  assert.equal(Eng.routineAt(state, 'sora', { day: MONDAY, hour: 12 }), 'canteen', 'the first listed, never chance');
  assert.equal(Eng.routineAt(state, 'sora', { day: MONDAY, hour: 15 }), 'yard', 'their own entry');
});

test('each whole hour moves offscreen people through the rooms, and never the player', () => {
  const g = game();
  advance(g, 0.5);
  assert.equal(g.where('aoi'), 'aoi-room', 'no whole hour has passed');
  advance(g, 0.5);
  assert.equal(g.state.time.hour, 9);
  assert.equal(g.where('aoi'), 'classroom');
  assert.equal(g.where('ken'), 'classroom');
  advance(g, 6);
  assert.equal(g.where('sora'), 'canteen', 'the player only moves by their own words');
  assert.equal(g.where('aoi'), 'canteen', 'a routine may bring someone to the player');
});

test('someone in the player\'s room stays, and goes once the player has left', () => {
  const g = game();
  g.state.characters.sora.status.location = 'aoi-room';
  advance(g, 2);
  assert.equal(g.where('aoi'), 'aoi-room', 'leaving a scene is for later');
  g.state.characters.sora.status.location = 'plaza';
  advance(g, 1);
  assert.equal(g.where('aoi'), 'classroom');
});

test('a locked door stops those without the key until it opens', () => {
  const g = game();
  g.state.time = { day: MONDAY, hour: 11 };
  g.state.characters.ken.status.location = 'yard';
  g.state.characters.rin.status.location = 'yard';
  advance(g, 1);
  assert.equal(g.where('rin'), 'workshop', 'Rin has the key');
  g.state.time = { day: MONDAY, hour: 14 };
  advance(g, 1);
  assert.equal(g.where('ken'), 'yard', 'no key, no way in, and they do not wander off');
  g.state.links[g.Eng.linkKey('yard', 'workshop')].locked = false;
  advance(g, 1);
  assert.equal(g.where('ken'), 'workshop', 'tried again the next hour');
});

test('a trip longer than the hour waits on the way and arrives when its minutes are up', () => {
  const g = game();
  advance(g, 2);
  assert.equal(g.where('gil'), 'plaza', 'two hours into a 150-minute ride');
  advance(g, 1);
  assert.equal(g.where('gil'), 'city');
});

test('a person the story moved keeps that place until the next slot begins', () => {
  const g = game();
  g.state.characters.sora.status.location = 'city';
  advance(g, 1.5);
  g.Eng.setLocation(g.state, 'aoi', 'yard');
  advance(g, 2);
  assert.equal(g.state.time.hour, 11.5);
  assert.equal(g.where('aoi'), 'yard', 'for the rest of the lesson');
  advance(g, 2);
  assert.equal(g.where('aoi'), 'classroom', 'the bell at one brings them back');
});

test('a move made before a step holds through a slot beginning in that step', () => {
  const g = game();
  g.state.time = { day: MONDAY, hour: 8.5 };
  g.Eng.storyMove(g.state, 'aoi', 'yard');
  advance(g, 1);
  assert.equal(g.where('aoi'), 'yard');
  advance(g, 1);
  assert.equal(g.where('aoi'), 'yard', 'the slot it held through stays passed');
  advance(g, 2);
  assert.notEqual(g.where('aoi'), 'classroom');
});

test('a story move ends a trip under way', () => {
  const g = game();
  advance(g, 1);
  g.Eng.setLocation(g.state, 'gil', 'yard');
  advance(g, 3);
  assert.equal(g.where('gil'), 'yard');
});

test('routines pause for the dead, the badly hurt, needs given out and an emergency around them', () => {
  const after = (setup) => {
    const g = game();
    setup(g);
    advance(g, 1);
    return g.where('aoi');
  };
  assert.equal(after((g) => { g.state.characters.aoi.status.health = 'dead'; }), 'aoi-room');
  assert.equal(after((g) => { g.state.characters.aoi.status.health = 'badly_hurt'; }), 'aoi-room');
  assert.equal(after((g) => { g.state.characters.aoi.needs.hunger = 1; g.state.characters.aoi.tier = 'local'; }), 'aoi-room');
  assert.equal(after((g) => { g.state.crisis = { turn: g.state.turn, text: 'Fire', who: ['aoi'] }; }), 'aoi-room');
  assert.equal(after((g) => { g.state.characters.aoi.status.health = 'hurt'; }), 'classroom', 'hurt keeps going');
  assert.equal(after((g) => { g.state.crisis = { turn: g.state.turn, text: 'Fire', who: ['ken'] }; }), 'classroom', 'someone else\'s emergency');
  // Once it's over, the day picks up.
  const g = game();
  g.state.characters.aoi.status.health = 'badly_hurt';
  advance(g, 1);
  g.state.characters.aoi.status.health = 'hurt';
  advance(g, 1);
  assert.equal(g.where('aoi'), 'classroom');
});

test('a pressure firing near someone pauses them in that same hour', () => {
  const g = game();
  g.state.characters.sora.status.location = 'yard';
  g.state.characters.aoi.status.location = 'yard';
  g.state.characters.sora.status.location = 'plaza';
  g.state.clocks.push({ id: 'fire', name: 'The fire', value: 0.9, max: 1, perHour: 1, fired: false });
  advance(g, 1);
  assert.equal(g.where('aoi'), 'yard', 'everyone at the site stops for it');
});

test('away: nowhere on the map, in words on the card, back through the room they left by', () => {
  const g = game();
  const { Eng, state } = g;
  Eng.knowAll(state, 0);
  state.time = { day: MONDAY, hour: 21 };
  state.characters.ken.status.location = 'yard';
  advance(g, 1);
  const ken = state.characters.ken;
  assert.equal(ken.status.away, 'home');
  assert.equal(ken.status.location, 'yard', 'the room they left by');
  state.characters.sora.status.location = 'yard';
  assert.ok(![...Eng.present(state)].includes('ken'), 'not present where they left');
  assert.ok(![...Eng.tokens(state, 'yard')].some((t) => t.id === 'ken'), 'not a token there');
  assert.equal(Eng.resolveLocation(state, 'ken', true), null, 'nobody to go to');
  assert.ok(![...Eng.crisisPeople(state)].includes('ken'), 'not in an emergency there');
  const seen = state.known.ken.turn;
  Eng.noteSeen(state, null, 9);
  assert.equal(state.known.ken.turn, seen, 'not seen by looking at the room');
  const kw = Eng.knownWhere(state, 'ken');
  assert.deepEqual([kw.loc, kw.now, kw.away], [null, false, 'at home'], 'the card and the map');
  // Morning: back, starting from the yard.
  state.characters.sora.status.location = 'canteen';
  advance(g, 11);
  assert.equal(state.time.hour, 9);
  assert.equal(ken.status.away, undefined);
  assert.equal(g.where('ken'), 'classroom');
});

test('a move of someone away brings them back at once', () => {
  const g = game();
  g.state.time = { day: MONDAY, hour: 21 };
  advance(g, 1);
  assert.ok(g.Eng.isAway(g.state, 'ken'));
  g.Eng.setLocation(g.state, 'ken', 'canteen');
  assert.ok([...g.Eng.present(g.state)].includes('ken'));
  assert.equal(g.state.characters.ken.status.away, undefined);
});

test('the update step can\'t move someone away for being "in the scene" at the room they left by', () => {
  const g = game();
  g.state.time = { day: MONDAY, hour: 21 };
  g.state.characters.ken.status.location = 'canteen';
  g.state.characters.sora.status.location = 'yard';
  advance(g, 1);
  g.state.characters.sora.status.location = 'canteen';
  const report = g.Eng.applyUpdate(g.state, { moves: [{ id: 'ken', to: 'yard' }] }, [], { startLoc: 'canteen', endLoc: 'canteen', prose: 'Ken walks to the School Yard.', turn: 1, action: 'wait' });
  assert.ok(g.Eng.isAway(g.state, 'ken'), JSON.stringify(report.rejected));
});

test('the prompts say where someone away is, never the room they left by', async () => {
  const g = game();
  g.state.time = { day: MONDAY, hour: 21 };
  g.state.characters.ken.status.location = 'yard';
  g.state.characters.ken.tier = 'local';
  advance(g, 1);
  assert.ok(g.Eng.isAway(g.state, 'ken'));
  const calls = mockLLM(g.E, ({ kind }) => (kind === 'intent' ? { player: { needs_roll: false }, intents: [], events: [] } : kind === 'update' ? { facts: [] } : 'Sora waits by the counter.'));
  await g.Eng.runTurn(g.state, 'I wait.', 'moment');
  const user = calls.find((c) => c.kind === 'intent').user;
  assert.match(user, /- ken \(Ken Oda\), at home:/);
  assert.doesNotMatch(user, /Ken Oda\), in School Yard/);
});

test('winding the clock back puts routine moves back (a scene that settles early)', async () => {
  const g = game();
  g.state.time = { day: MONDAY, hour: 8.9 };
  mockLLM(g.E, ({ kind }) => (kind === 'intent' ? { player: { needs_roll: false }, intents: [], events: [] } : kind === 'update' ? { facts: [] } : 'Sora waits by the counter.'));
  await g.Eng.runTurn(g.state, 'I wait.', 'hours');
  const { hour } = g.state.time;
  // The rewound step crosses nine or doesn't; where Aoi stands must agree with the clock.
  assert.equal(g.where('aoi'), hour >= 9 ? 'classroom' : 'aoi-room', `the clock settled at ${hour}`);
  assert.ok(hour < 9.9, 'this scene settled early, or the test proves nothing');
});

test('stepping in keeps routines to the moment stepped into', async () => {
  const g = game();
  g.state.time = { day: MONDAY, hour: 8.5 };
  let n = 0;
  mockLLM(g.E, ({ kind }) => (kind === 'intent' ? { player: { needs_roll: false }, intents: [], events: [] } : kind === 'update' ? { facts: [] } : (n++, '[+5m] Sora wipes the table.\n\n[+10m] Sora sits down.\n\n[+170m] Sora stands up at last.')));
  await g.Eng.runTurn(g.state, 'I wait.', 'hours');
  await g.Eng.commitPending(g.state, 1, () => {});
  assert.ok(g.state.time.hour < 9);
  assert.equal(g.where('aoi'), 'aoi-room', 'the bell has not gone');
});

test('people on a routine live it offscreen: needs settle, not climb', () => {
  const g = game();
  g.state.characters.aoi.tier = 'local';
  g.state.characters.aoi.needs.hunger = 0.9;
  advance(g, 2);
  assert.ok(g.state.characters.aoi.needs.hunger < 0.9);
});

test('a made character gets the slot\'s routine, and their class from their role', () => {
  const E = loadEngine();
  const world = readWorld(TOWN, E);
  const sc = world.starts.find((s) => s.id === 'monday').scenario;
  const form = Object.assign(E.CharMaker.defaults(sc), { name: 'Ana Reyes', want: 'pass', traits: ['patient'], role: 'first-year', pronouns: 'she/her' });
  const { character, errors } = E.CharMaker.build(sc, form);
  assert.deepEqual([...(errors || [])], []);
  assert.equal(character.routine, 'student');
  const state = E.Engine.newGame(E.Scenario.startScenario(world, 'monday', character));
  assert.equal(E.Engine.routineAt(state, state.player, { day: MONDAY, hour: 10 }), 'classroom', 'the room their role names');
  assert.equal(E.Engine.routineAt(state, state.player, { day: MONDAY, hour: 15 }), 'yard');
});

test('validation says what is wrong with a routine in plain words', () => {
  const E = loadEngine();
  const report = (change) => {
    const files = JSON.parse(JSON.stringify(worldFiles(TOWN)));
    change(files);
    const world = E.Scenario.prepareWorld('routine-town', files);
    return world.starts.map((s) => String(s.error || (s.errors || []).join('; '))).concat(world.warnings || []).join('\n');
  };
  const says = (change, pattern) => assert.match(report(change), pattern);
  const routines = (f) => f['world.json'].routines;
  assert.equal(report(() => {}).trim(), '', 'the fixture itself is clean');
  says((f) => { f['characters/aoi.json'].routine = 'pupil'; }, /routine "pupil" doesn't exist/);
  says((f) => { f['characters/aoi.json'].places.home = 'attic'; }, /place "home" is unknown room "attic"/);
  says((f) => { delete f['characters/aoi.json'].places.club; }, /"club" in their routine is neither a room nor one of their places/);
  says((f) => { routines(f).student.slots.school[1].from = 11; }, /slots overlap at 11:00/);
  says((f) => { routines(f).student.slots.school[0].to = 9; }, /is empty/);
  says((f) => { routines(f).student.slots.free = []; }, /has no slots/);
  says((f) => { routines(f).student.slots.school[0].at = []; }, /at least one place/);
  says((f) => { delete routines(f).student.dayTypes.free.default; }, /has no days/);
  says((f) => { routines(f).student.dayTypes.free.days = ['Funday']; }, /must be weekdays/);
  says((f) => { routines(f).student.dayTypes.free.dates = ['soon']; }, /must be dates/);
  says((f) => { delete f['world.json'].calendar; }, /types of day need the world's "calendar"/);
  says((f) => { f['characters/gil.json'].slots = 'never'; }, /must be a list/);
});

test('a world without routines gets no routine state', () => {
  const { E, state } = newGame('mars-station');
  E.Engine.advanceTime(state, 30, { events: [] });
  assert.ok(Object.values(state.characters).every((c) => !c.routineState && !c.status.away));
});
