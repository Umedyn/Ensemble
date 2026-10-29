// The Frontier, 1866–1869 (task 7-4): America after the Civil War, from
// Boston to San Francisco. The world only (its starts come later): the
// country of 1866 and the nations' lands, the trails, stage lines, rivers
// and rails with the times of the time, the timeline from the Homestead Act
// to the Golden Spike, and four towns drawn as plans. The engine work it
// brought: a generated start in a region that holds one of the world's
// places begins in that place.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, readWorld, mockLLM, newGame } = require('./helpers');
const { replies, stepOf, SHEETS } = require('./genmock');

const plain = (o) => JSON.parse(JSON.stringify(o));
function at(E, context) {
  E.settings.backends.local.context = context;
  Object.keys(E.settings.routing).forEach((k) => { E.settings.routing[k] = 'local'; });
}
// The model for a generated start (genmock's replies, written for the
// holdout: the engine checks them the same way here), then for play.
// rooms: where each person starts ({name: room id}), and withYou who is
// with the player when it opens: an ordinary scene in the town.
function model(E, rooms, withYou) {
  const over = rooms ? {
    person: (user) => { const n = /sheet for ([^,]+),/.exec(user)[1]; return Object.assign({}, SHEETS[n], { room: rooms[n] }); },
    opening: Object.assign({}, replies().opening, { with_you: withYou || [] }),
  } : {};
  const r = replies(over);
  return mockLLM(E, (call) => {
    const v = r[stepOf(call.user)];
    if (v == null) return call.kind.startsWith('intent') ? { player: { summary: 'look around' }, intents: [], events: [] } : { facts: [], state: [], relations: [], player_attitude: [] };
    return typeof v === 'function' ? v(call.user, call) : v;
  });
}
// A generated start in one of the world's regions, played from.
async function start(region, opts) {
  const E = loadEngine();
  at(E, 8192);
  const w = readWorld('frontier', E);
  const o = opts || {};
  const job = E.StartGen.newJob(w, { region, line: 'a drover from Texas, owed three months of wages', onePass: false, place: o.place });
  const calls = model(E, o.rooms, o.withYou);
  await E.StartGen.run(w, job, {});
  assert.ok(E.StartGen.done(job), job.failed);
  return { E, w, job, calls, state: E.Engine.newGame(E.StartGen.scenario(w, job)) };
}
const world = () => { const E = loadEngine(); return { E, w: readWorld('frontier', E) }; };
const def = (w, id) => w.bundle.world.regions.find((r) => r.id === id);
const chain = (E, w, id) => [...E.Scenario.regionChainIn(w.bundle.world.regions, id)];

// ---------- the world ----------

test('The Frontier loads with no warnings, with its In the West starts and Make my own start, and opens on Tuesday 1 May 1866', () => {
  const { E, w } = world();
  assert.deepEqual([...w.warnings], []);
  assert.deepEqual(w.starts.map((s) => s.id), ['salt-lick', 'haddon', 'julesburg', 'wind-river', 'powder-river']);
  assert.ok(w.generate, 'Make my own start');
  const sc = w.bundle.world;
  assert.equal(E.dayName(sc, sc.date.day), 'Tuesday 1 May 1866');
  assert.ok(sc.timeline.length >= 60);
  assert.equal(E.dayName(sc, sc.timeline.find((e) => e.id === 'golden-spike').when.day), 'Monday 10 May 1869');
  assert.equal(E.dayName(sc, sc.timeline.find((e) => e.id === 'appomattox').when.day), 'Sunday 9 April 1865');
});

test('the country of 1866: Dakota Territory takes in the Wyoming country, Oklahoma is Indian Territory and the unclaimed strip, and the nations\' lands are their own', () => {
  const { E, w } = world();
  assert.deepEqual(chain(E, w, 'fort-laramie'), ['fort-laramie', 'dakota', 'plains', 'united-states']);
  assert.ok(chain(E, w, 'south-pass').includes('dakota'));
  assert.ok(!w.bundle.world.regions.some((r) => r.id === 'wyoming' || r.id === 'oklahoma'));
  assert.equal(def(w, 'indian-territory').controller, 'five-tribes');
  assert.equal(def(w, 'neutral-strip').controller, null);
  assert.equal(def(w, 'nebraska').controller, 'federal', 'a territory until 1867');
  assert.equal(def(w, 'texas').controller, null, 'a state');
  // The nations' lands, inside the territory that holds most of each.
  [['powder-river', 'lakota', 'dakota'], ['black-hills', 'lakota', 'dakota'], ['comancheria', 'comanche', 'texas'], ['smoky-hill', 'cheyenne', 'kansas'],
    ['ute-country', 'ute', 'colorado'], ['apacheria', 'apache', 'arizona'], ['crow-country', 'crow', 'montana'], ['wind-river', 'shoshone', 'dakota']].forEach(([id, group, parent]) => {
    assert.equal(def(w, id).controller, group, id);
    assert.equal(def(w, id).parent, parent, id);
    assert.ok(w.bundle.world.map.regions[id].polygon || w.bundle.world.map.regions[id].polygons, `${id} is drawn`);
  });
  // Dinétah is empty: its people are held at Bosque Redondo.
  assert.equal(def(w, 'dinetah').controller, null);
  // Every nation is a group, with its lore.
  const lore = w.bundle.world.lore.map((e) => e.id);
  ['lakota', 'cheyenne-arapaho', 'comanche-kiowa', 'apache', 'dine', 'shoshone', 'ute', 'crow', 'blackfeet', 'nez-perce', 'five-tribes', 'pawnee'].forEach((id) => assert.ok(lore.includes(id), id));
});

test('Boston and San Francisco have maps of their own: districts of 1866 on the shore of the time, with bridges and a ferry across the water', () => {
  const { E, w } = world();
  ['boston', 'san-francisco'].forEach((city) => {
    const m = def(w, city).map;
    assert.ok(m && m.image.endsWith('.svg') && m.width > 1000);
    const districts = w.bundle.world.regions.filter((r) => r.parent === city);
    assert.ok(districts.length >= 12, city);
    districts.forEach((d) => assert.ok(m.regions[d.id], `${d.id} is drawn on ${city}'s map`));
    assert.ok(m.places.length >= 12);
  });
  assert.ok(chain(E, w, 'sf-barbary-coast').includes('california'));
  // East Boston is an island: the ferry is the way.
  const { state } = (() => { const E2 = loadEngine(); return { state: { scenario: E2.Scenario.compose(w.bundle.world, { id: 't', cast: [], region: 'boston' }, {}, 'frontier'), regions: Object.fromEntries(w.bundle.world.regions.map((r) => [r.id, {}])) } }; })();
  const t = E.Engine.regionTrip(state, 'boston-north-end', 'east-boston');
  assert.equal(t.legs.length, 1);
  assert.equal(t.legs[0].kind, 'ferry');
});

test('four towns are drawn plans: every room a building or lot with its shape, on the street, and Poorman\'s Gulch hidden until it is found', () => {
  const { w } = world();
  const sc = w.bundle.world;
  const want = { haddon: 'haddon-front', 'salt-lick': 'saltlick-front', julesburg: 'julesburg-road', 'poormans-gulch': 'poorman-trail' };
  Object.entries(want).forEach(([place, entry]) => {
    const info = sc.siteInfo[place];
    const map = w.bundle.siteMaps[info.map];
    const rooms = sc.locations.filter((l) => l.site === place);
    assert.ok(rooms.length >= 8, place);
    assert.equal(map.entry, entry);
    assert.deepEqual(map.rooms.map((r) => r.id).sort(), rooms.map((l) => l.id).sort());
    map.rooms.forEach((r) => assert.ok(r.shape.length >= 3, r.id));
    rooms.forEach((l) => assert.equal(l.region, place));
  });
  assert.equal(def(w, 'poormans-gulch').known, false);
  assert.equal(def(w, 'julesburg').name, 'Julesburg', 'the one real town');
});

// ---------- a start in one of the world's places ----------

test('a generated start in Salt Lick begins on its Front Street with no rooms call and adds no rooms of its own', async () => {
  const { E, w, job, calls, state } = await start('salt-lick');
  assert.ok(!calls.some((c) => /TASK: THE PLACE\b/.test(c.user)), 'no rooms call');
  assert.equal(job.steps.rooms.place, 'salt-lick');
  assert.equal(state.characters[state.player].status.location, 'saltlick-front');
  assert.deepEqual([...E.StartGen.toStart(w, job).start.locations], []);
  // The later steps saw the town's rooms, and placed people in them.
  const plan = calls.find((c) => /TASK: WHO IS HERE/.test(c.user));
  assert.match(plan.user, /The Drovers' Rest/);
  assert.ok(E.StartGen.people(job).every((c) => state.locations[c.status.location].site === 'salt-lick'));
  // The review shows the place but doesn't edit or reroll the world's rooms.
  assert.ok(E.StartGen.setField(w, job, 'room', 'saltlick-saloon', 'name', 'The Lone Star').error);
  await assert.rejects(E.StartGen.rerollRoom(w, job, 'saltlick-saloon'), /world's own places/);
  // It plays.
  await E.Engine.runTurn(state, 'I walk over to the Drovers\' Rest.', 'hour');
  assert.ok(state.turn >= 1);
});

test('saying where exactly in a town still builds a place of its own', async () => {
  const { job, calls } = await start('haddon', { place: 'a dugout behind the boarding house' });
  assert.ok(calls.some((c) => /TASK: THE PLACE\b/.test(c.user)));
  assert.ok(!job.steps.rooms.place);
});

// ---------- travel ----------

test('the trail west takes weeks; the stage is quicker where it runs, and the rails once they are laid', async () => {
  const { E, state } = await start('haddon');
  const hours = (a, b) => E.Engine.regionTrip(state, a, b).hours;
  // Omaha to Fort Laramie: the stage to Julesburg, then wagons up the North Platte.
  assert.equal(hours('omaha', 'fort-laramie'), 48 + 12 + 48 + 7 * 24 + 5 * 24);
  // Fort Laramie to Oregon City: quickest by stage to Sacramento and a
  // steamer north, about a month.
  const far = E.Engine.regionTrip(state, 'fort-laramie', 'oregon-city');
  assert.ok(far.hours > 25 * 24 && far.legs.some((e) => e.kind === 'sea'), `${far.hours}h`);
  // A territory's border is never the quick way past the trail.
  assert.ok(E.Engine.regionTrip(state, 'omaha', 'fort-laramie').legs.every((e) => e.kind !== 'overland'));
  // The rails: being graded in May 1866; laid, Fort Kearny to Haddon is four hours.
  assert.equal(hours('fort-kearny', 'haddon'), 12);
  state.world['rails to Haddon'] = 'laid';
  assert.equal(hours('fort-kearny', 'haddon'), 4);
  // Boston to San Francisco: the train to New York, then the steamer by Panama.
  const t = E.Engine.regionTrip(state, 'boston-downtown', 'sf-montgomery');
  assert.deepEqual([...t.legs.map((e) => e.kind)], ['rail', 'sea']);
});

test('the spring rise, the snow and Red Cloud\'s war close the ways that need them; most can be risked', async () => {
  const { E, state } = await start('julesburg');
  // The North Platte crossing in May: running high, so the way round is weeks
  // longer, and the crossing itself can be risked.
  const crossing = () => [...E.Engine.routesFrom(state, 'platte-bridge')].find((e) => e.to === 'independence-rock');
  assert.match(crossing().closed, /rivers/);
  assert.equal(crossing().risky, true);
  assert.ok(E.Engine.regionTrip(state, 'platte-bridge', 'independence-rock').hours > 30 * 24);
  state.world.rivers = 'fordable';
  assert.equal(crossing().closed, null);
  assert.equal(E.Engine.regionTrip(state, 'platte-bridge', 'independence-rock').hours, 4 * 24);
  // The Bozeman Trail: open in May 1866; after the Fetterman fight, closed but risky.
  assert.ok(!E.Engine.regionTrip(state, 'fort-reno', 'fort-phil-kearny').blocked);
  state.world['Bozeman Trail'] = 'closed by Red Cloud\'s war';
  const boz = E.Engine.regionTrip(state, 'fort-reno', 'fort-phil-kearny');
  assert.ok(boz.blocked && boz.risky);
  // Winter on the Sierra: the stage over the summit waits for spring.
  assert.equal(E.Engine.regionTrip(state, 'virginia-city-nv', 'sacramento').hours, 48);
  state.world['Sierra passes'] = 'snowed in';
  const winter = E.Engine.regionTrip(state, 'virginia-city-nv', 'sacramento');
  assert.ok(winter.hours > 7 * 24, `${winter.hours}h the long way round`);
  assert.ok(!winter.legs.some((e) => e.from === 'virginia-city-nv' && e.to === 'sacramento'));
});

test('the timeline moves the world: Fort Phil Kearny appears in July 1866, the South goes under the army in March 1867, the Golden Spike opens the railroad', () => {
  const { w } = world();
  const tl = w.bundle.world.timeline;
  const ev = (id) => tl.find((e) => e.id === id);
  assert.deepEqual(plain(ev('fort-phil-kearny-built').effects.reveal), [{ region: 'fort-phil-kearny' }]);
  assert.equal(def(w, 'fort-phil-kearny').known, false);
  assert.equal(ev('reconstruction-acts').effects.control.length, 10);
  assert.ok(ev('reconstruction-acts').effects.control.every((c) => c.to === 'army'));
  assert.equal(ev('golden-spike').effects.world['Pacific railroad'], 'complete');
  assert.equal(ev('dine-go-home').effects.control[0].region, 'dinetah');
  // Past events before the start; the rest after it.
  const startDay = w.bundle.world.date.day;
  assert.ok(ev('sand-creek').when.day < startDay && ev('memphis-riot').when.day >= startDay);
});

test('Poorman\'s Gulch stays out of the map and every prompt until it is found, and can\'t be a start', async () => {
  const { E, w, state } = await start('julesburg');
  assert.ok(!E.Engine.regionKnown(state, 'poormans-gulch'));
  const header = E.Prompts.header(state);
  assert.ok(!/Poorman/.test(header), 'not in the header');
  assert.ok(!E.StartGen.regions(w.bundle.world).some((r) => r.id === 'poormans-gulch'));
  assert.throws(() => E.StartGen.newJob(w, { region: 'poormans-gulch', line: 'a prospector' }));
});

test('the whole world fits an 8K context forty turns in, from a start in a town', async () => {
  const { measureState } = await import('../tools/context-report.mjs');
  const { E, state } = await start('haddon', { rooms: { 'Lena Marsh': 'haddon-front', 'Owen Pruitt': 'haddon-saloon', 'Kay Dunbar': 'haddon-store' }, withYou: ['lena-marsh'] });
  const r = measureState(E, state, 8192, true);
  const sum = r.totals.header + r.totals.intent + r.reply;
  assert.ok(sum <= 8192, `header ${r.totals.header} + intent ${r.totals.intent} + reply ${r.reply} = ${sum}`);
  assert.ok(r.totals.header + r.totals.narrate + 704 <= 8192, 'the narrator\'s call fits too');
});

// ---------- In the West (task 7-6) ----------

test('In the West: every start lets you play anyone in its cast, or make your own', () => {
  const E = loadEngine();
  const w = readWorld('frontier', E);
  const st = w.starts.find((s) => s.id === 'salt-lick');
  assert.equal(st.defaultPlayer, 'Hollis Brandt');
  assert.deepEqual(st.playable.map((p) => p.id), ['rosa-delgado', 'amos-tull', 'josiah-reed', 'wes-calhoun']);
  assert.ok(st.slot, 'Make my own');
  const sc = E.Scenario.startScenario(w, 'salt-lick', 'rosa-delgado');
  const state = E.Engine.newGame(sc);
  assert.equal(state.player, 'rosa-delgado');
  assert.equal(state.characters[state.player].status.location, 'saltlick-saloon', 'she starts where she is');
  assert.ok(state.characters['hollis-brandt'], 'the marshal is someone else now');
  assert.throws(() => E.Scenario.startScenario(w, 'salt-lick', 'tall-grass'), /can't be played as "tall-grass"/);
  w.starts.forEach((s) => assert.equal(s.playable.length + 1, s.scenario.characters.length, `${s.id}: everyone in the cast`));
});

test('"playable" is checked in plain words, and never offers someone who joins later', () => {
  const E = loadEngine();
  const base = () => ({ world: { title: 'T', setting: 'S', characters: ['a', 'b', 'c'], starts: ['s'], locations: [{ id: 'r', name: 'R', desc: 'd', connects: [] }] },
    starts: { s: { id: 's', player: 'a', cast: ['a', 'b', { id: 'c', joins: 'later' }], playable: ['b'], timeline: [] } },
    characters: { a: { id: 'a', name: 'A', role: 'x' }, b: { id: 'b', name: 'B', role: 'y' }, c: { id: 'c', name: 'C', role: 'z' } } });
  const ok = base();
  E.Scenario.validateWorld(ok);
  const bad = base();
  bad.starts.s.playable = ['b', 'zed'];
  assert.throws(() => E.Scenario.validateWorld(bad), /"playable" must be true \(anyone in the cast\) or a list of cast ids/);
  const later = base();
  later.starts.s.playable = ['c'];
  assert.throws(() => E.Scenario.validateWorld(later), /"playable" names c, who joins later/);
  assert.deepEqual([...E.Scenario.playableIds({ playable: true, cast: ['a', 'b', { id: 'c', joins: 'later' }] }, {})], ['a', 'b']);
});

test('each In the West start plays a turn as each of its people', async () => {
  const E = loadEngine();
  const w = readWorld('frontier', E);
  for (const st of w.starts) {
    for (const id of [st.scenario.player].concat(st.playable.map((p) => p.id))) {
      const E2 = loadEngine();
      const state = E2.Engine.newGame(E2.Scenario.startScenario(readWorld('frontier', E2), st.id, id));
      mockLLM(E2, ({ kind }) => (kind === 'intent' ? { player: { needs_roll: false }, intents: [], events: [] } : kind === 'update' ? { facts: [] } : 'You look around.'));
      await E2.Engine.runTurn(state, 'Look around.', 'moment');
      assert.equal(state.turn, 1, `${st.id} as ${id}`);
    }
  }
});

test('the camps move with the band, only when an elder says so; the towns\' people are characters now', () => {
  const E = loadEngine();
  const w = readWorld('frontier', E);
  const step = { id: 'hour', hours: 1 };
  const as = (id) => E.Engine.newGame(E.Scenario.startScenario(w, 'wind-river', id));
  const willow = as('red-willow');
  assert.match(E.Engine.campJourneyFor(willow, { player: {} }, 'We break camp and move to Fort Bridger.', step).refused, /only its leader can turn it/);
  const elder = as('tall-grass');
  const j = E.Engine.campJourneyFor(elder, { player: {} }, 'We break camp and move to Fort Bridger.', step);
  assert.equal(j.destRegion, 'fort-bridger');
  assert.ok(!(w.bundle.world.extras || []).some((x) => x.id === 'rosa-delgado'), 'Rosa is a character, not a minor person');
});

test('every In the West start fits an 8K context forty turns in', async () => {
  const { measureState } = await import('../tools/context-report.mjs');
  for (const id of ['salt-lick', 'haddon', 'julesburg', 'wind-river', 'powder-river']) {
    const { E, state } = newGame('frontier', id);
    const r = measureState(E, state, 8192, true);
    assert.ok(r.totals.header + r.totals.intent + r.reply <= 8192, `${id}: ${r.totals.header} + ${r.totals.intent} + ${r.reply}`);
  }
});
