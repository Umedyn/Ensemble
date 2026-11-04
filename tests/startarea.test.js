// The area around and the starting floor plan (generated starts in a world
// with no regions, such as Your own story): the model sketches the wider
// area and the places in it with the ways between them, then lays out the
// start's place room by room with sizes, floors and the kind of each way
// through. The engine checks both and fixes what a retry would get wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, mockLLM, worldFiles } = require('./helpers');
const { replies, stepOf, WORLD } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));

// The genmock replies were written for the holdout; the player's sheet here
// spends the default skills.
function mock(E, over) {
  const r = replies(Object.assign({ player: Object.assign({}, replies().player, { skills: { physical: 3, technical: 3, social: 2 } }) }, over));
  return mockLLM(E, (call) => {
    const v = r[stepOf(call.user)];
    if (v == null) return call.kind === 'intent' ? { player: { summary: 'look around' }, intents: [], events: [] }
      : call.kind === 'update' ? { facts: [], state: [], relations: [], player_attitude: [] } : '[+0m] The wind leans on the windows.';
    return typeof v === 'function' ? v(call.user, call) : v;
  });
}
async function yourStory(over) {
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('your-story', worldFiles('your-story'));
  const job = E.StartGen.newJob(w, { world: WORLD, line: 'a crofter\'s daughter home for the summer', onePass: false });
  const calls = mock(E, over);
  await E.StartGen.run(w, job, {});
  return { E, w, job, calls, GEN: E.StartGen };
}
const ctxFor = (E, w, job) => E.StartGen.context(w, job);
// A your-story job just past the player step, for the checkers.
function upToArea() {
  const E = loadEngine();
  const w = E.Scenario.prepareWorld('your-story', worldFiles('your-story'));
  const job = E.StartGen.newJob(w, { world: WORLD, line: 'a crofter', onePass: false });
  job.steps.setting = { setting: 'A crofting parish on a Scottish island in the 1950s, where the ferry comes twice a week.', tags: ['slice-of-life'] };
  job.steps.player = { character: { id: 'eilidh-gillies', name: 'Eilidh Gillies', role: 'crofter', traits: ['stubborn'], want: 'keep the croft', secret: 'She has already sold the ewes to pay the doctor.', guard: 'medium', skills: {}, status: {} } };
  return { E, w, job, GEN: E.StartGen };
}

test('a world with no regions sketches the area around before the rooms, and the start is played on that map', async () => {
  const { E, w, job, calls, GEN } = await yourStory();
  assert.ok(job.area, 'the world has no regions');
  assert.deepEqual([...GEN.order(job)].slice(0, 4), ['setting', 'player', 'area', 'rooms']);
  assert.equal(job.region, null, 'the player picked no region');
  assert.equal(GEN.startRegion(job), 'the-croft');
  const sc = GEN.scenario(w, job);
  assert.deepEqual(plain(sc.regions.map((r) => [r.id, r.parent || null, r.label])),
    [['corran-parish', null, 'parish'], ['the-croft', 'corran-parish', 'croft'], ['mains-farm', 'corran-parish', 'farm'], ['harbour-town', 'corran-parish', 'town'], ['birch-wood', 'corran-parish', 'woods']]);
  assert.equal(sc.region, 'the-croft');
  assert.ok(sc.locations.every((l) => l.region === 'the-croft'), 'the rooms are the croft');
  const croft = sc.regions.find((r) => r.id === 'the-croft');
  assert.deepEqual(plain(croft.routes), [{ to: 'harbour-town', kind: 'road', time: '20m' }, { to: 'mains-farm', kind: 'track', time: '10m' }]);
  assert.deepEqual(plain(sc.regions.find((r) => r.id === 'mains-farm').routes || []), [], 'a way listed from both ends is one route');
  assert.ok(job.log.some((l) => l.step === 'area' && l.warnings.some((x) => /Portcorran to Birch Wood had no minutes; 30/.test(x))));
  // The rooms step is told where it is and what is around it.
  const rooms = calls.find((c) => stepOf(c.user) === 'rooms').user;
  assert.match(rooms, /Region: Gillies Croft — A stone croft house/);
  assert.match(rooms, /Inside: Corran Parish\./);
  assert.match(rooms, /Next to: Portcorran, Mains Farm, Birch Wood\./);
  assert.match(rooms, /Lay out Gillies Croft, where the story starts, like a simple floor plan/);
  assert.match(rooms, /Only this place: the other places nearby are built when the player goes there\./);
  // It plays, and the town is twenty minutes down the road.
  const state = E.Engine.newGame(sc);
  await E.Engine.runTurn(state, 'Look around.', 'moment');
  assert.equal(E.Engine.playerRegion(state), 'the-croft');
  assert.ok(Math.abs(E.Engine.regionTrip(state, 'the-croft', 'harbour-town').hours - 20 / 60) < 0.01);
  assert.ok(Math.abs(E.Engine.regionTrip(state, 'harbour-town', 'the-croft').hours - 20 / 60) < 0.01, 'routes go both ways');
  // Save as start writes the map with the start, and the folder loads.
  const files = GEN.files(w, job);
  const start = files[`starts/${job.id}.json`];
  assert.equal(start.region, 'the-croft');
  assert.equal(start.regions.length, 5);
  const folder = Object.assign({}, files);
  Object.keys(folder).forEach((k) => { folder[k] = plain(folder[k]); });
  const again = E.Scenario.prepareWorld('your-story', folder);
  assert.ok(again.starts.some((s) => s.id === job.id));
});

test('a world with regions of its own has no area step, and neither has a job made before it', async () => {
  const E = loadEngine();
  const w = readWorld('zombie-holdout', E);
  const job = E.StartGen.newJob(w, { region: 'main-street', line: 'a trucker', onePass: false });
  assert.equal(job.area, false);
  assert.ok(!E.StartGen.order(job).includes('area'));
  const y = E.Scenario.prepareWorld('your-story', worldFiles('your-story'));
  const old = E.StartGen.newJob(y, { world: WORLD, line: 'a crofter', onePass: false });
  delete old.area;
  assert.ok(!E.StartGen.order(old).includes('area'), 'a job kept from before resumes as it was');
});

test('the area: places nobody can reach get a road from the start, a start that is no place is the first, the numbers are kept in range', () => {
  const { E, w, job, GEN } = upToArea();
  const out = GEN.check.area({
    area: { name: 'Corran Parish', label: 'parish', lore: 'Crofts along one coast road.' },
    places: [
      { name: 'Gillies Croft', label: 'croft', ways: [{ to: 'Portcorran', kind: 'Road', minutes: 2000 }] },
      { name: 'Portcorran', label: 'town', ways: [{ to: 'gillies-croft', minutes: 0 }] },
      { name: 'The Lighthouse', label: 'lighthouse', ways: [] },
    ], start: 'the moon',
  }, ctxFor(E, w, job));
  assert.equal(out.error, undefined);
  assert.equal(out.region, 'gillies-croft');
  const croft = out.regions.find((r) => r.id === 'gillies-croft');
  assert.deepEqual(plain(croft.routes), [{ to: 'portcorran', kind: 'road', time: '600m' }, { to: 'lighthouse', kind: 'road', time: '30m' }]);
  assert.ok(out.warnings.some((x) => /"the moon" is not one of the places; the story starts at Gillies Croft/.test(x)));
  assert.ok(out.warnings.some((x) => /no way to The Lighthouse; a road from Gillies Croft/.test(x)));
  // "Where exactly" picks the start when the reply gives none.
  job.place = 'the lighthouse';
  assert.equal(GEN.check.area({ area: { name: 'Corran' }, places: [{ name: 'A' }, { name: 'B' }, { name: 'The Lighthouse' }] }, ctxFor(E, w, job)).region, 'lighthouse');
});

test('the area: too few places, no area name, two places of one name and a place that gives away a secret are sent back', () => {
  const { E, w, job, GEN } = upToArea();
  const ctx = ctxFor(E, w, job);
  const places = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  assert.match(GEN.check.area({ area: { name: 'Corran' }, places: places.slice(0, 2) }, ctx).error, /make 3 to 7 places/);
  assert.match(GEN.check.area({ area: {}, places }, ctx).error, /give the wider area a "name"/);
  assert.match(GEN.check.area({ area: { name: 'Corran' }, places: [{ name: 'A' }, { name: 'a' }, { name: 'C' }] }, ctx).error, /two places have the same name/);
  assert.match(GEN.check.area({ area: { name: 'Corran' }, places: [{ name: 'Corran' }, { name: 'B' }, { name: 'C' }] }, ctx).error, /the wider area's name/);
  const leak = [{ name: 'Gillies Croft', lore: 'Eilidh Gillies has already sold the ewes to pay the doctor.' }, { name: 'B' }, { name: 'C' }];
  assert.match(GEN.check.area({ area: { name: 'Corran' }, places: leak }, ctx).error, /gives away a secret/);
});

test('the floor plan: sizes, floors and the kind of each way through; stairs between floors, no locked doors, unknown ways left open', () => {
  const { E, w, job, GEN } = upToArea();
  const ctx = ctxFor(E, w, job);
  const out = GEN.check.rooms({ rooms: [
    { id: 'kitchen', name: 'Kitchen', desc: 'A range and a long table.', size: 'medium', level: 0, links: [{ to: 'porch', kind: 'door' }, { to: 'bedroom', kind: 'door' }, { to: 'cellar', kind: 'locked door' }] },
    { id: 'porch', name: 'Porch', desc: 'Boots and a bench.', size: 'small', level: 0, links: [{ to: 'yard', kind: 'open' }] },
    { id: 'bedroom', name: 'Bedroom', desc: 'A low ceiling under the eaves.', size: 'small', level: 1, links: [] },
    { id: 'cellar', name: 'Cellar', desc: 'Damp stone and potatoes.', size: 'huge', level: -1 },
    { id: 'yard', name: 'Farmyard', desc: 'Mud and hens.', size: 'large', level: 0, outside: true, links: [{ to: 'byre', kind: 'gate' }] },
    { id: 'byre', name: 'Byre', desc: 'Two cows and their warmth.', size: 'large', level: 9, outside: true, links: [{ to: 'yard', kind: 'door' }] },
  ], player_room: 'kitchen' }, ctx);
  assert.equal(out.error, undefined);
  const by = Object.fromEntries(out.rooms.map((r) => [r.id, r]));
  assert.equal(by.kitchen.size, 'medium');
  assert.equal(by.cellar.size, undefined, 'not a size');
  assert.equal(by.bedroom.level, 1);
  assert.equal(by.kitchen.level, undefined, 'the ground floor is the default');
  assert.equal(by.byre.level, undefined, 'floor 9 is the ground floor');
  assert.equal(by.yard.outside, true);
  assert.deepEqual(plain(by.kitchen.links), [{ to: 'porch', kind: 'door' }, { to: 'bedroom', kind: 'stairs' }, { to: 'cellar', kind: 'stairs' }], 'a door upstairs is stairs; a locked door nobody has a key to is a door');
  assert.deepEqual(plain(by.porch.links || []), [], 'open needs no link');
  assert.deepEqual(plain(by.yard.connects), ['porch', 'byre']);
  assert.ok(out.warnings.some((x) => /Farmyard to Byre was a "gate"; left open/.test(x)));
  assert.ok(out.warnings.some((x) => /Byre was on floor 9/.test(x)));
  // The plan validates and lays out on two floors and a cellar.
  job.steps.area = GEN.check.area(replies().area, ctx);
  const sc = E.Scenario.compose({ title: 't', setting: 's', regions: job.steps.area.regions }, { id: 's', cast: [], region: job.steps.area.region, locations: out.rooms }, {}, 'x');
  const plan = E.Layouts.plan(sc.locations, 'generic', 'seed');
  assert.deepEqual(plain(plan.levels.map((l) => l.level)), [0, 1, -1]);
});

test('the review edits a place of the area, keeps its name unique, and the start carries the edit', async () => {
  const { E, w, job, GEN } = await yourStory();
  assert.match(GEN.setField(w, job, 'region', 'mains-farm', 'name', 'Portcorran').error, /Another place has that name/);
  assert.equal(GEN.setField(w, job, 'region', 'mains-farm', 'name', 'Achmore Farm').value, 'Achmore Farm');
  assert.equal(GEN.setField(w, job, 'region', 'mains-farm', 'lore', 'The MacLeods\' farm, over the hill.').value, 'The MacLeods\' farm, over the hill.');
  const sc = GEN.scenario(w, job);
  assert.equal(sc.regions.find((r) => r.id === 'mains-farm').name, 'Achmore Farm');
  assert.deepEqual([...GEN.reviewProblems(w, job)], []);
});
