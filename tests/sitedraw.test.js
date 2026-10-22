// Detailed local maps with fog (task 3-7): js/sitedraw.js draws floor plans
// from the layout, but only where the player is looking. Rooms in view get
// full detail, remembered rooms structure with no feature state, unknown rooms
// nothing but a "?" past a known opening. Decoration is visual only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame } = require('./helpers');

const planOf = (E, state) => E.Layouts.plan(state.scenario.locations, { type: state.scenario.site && state.scenario.site.type, seed: `${state.scenario.worldId}:${state.scenario.startId}`, linkLocs: state.locations });
// The renderer's inputs, built the way ui.js builds them (detailedMapSvg).
function draw(E, state, inView, remembered, extra) {
  const plan = planOf(E, state);
  const rooms = {};
  Object.keys(plan.rooms).forEach((id) => {
    const l = state.locations[id];
    rooms[id] = { name: l.name, outside: !!l.outside, features: E.Engine.features(state, id) };
  });
  const tokenSvg = (t, cx, cy, r) => `<circle class="tok" data-id="${t.id}" cx="${cx}" cy="${cy}" r="${r}"/>`;
  const svg = E.SiteDraw.render(plan, rooms, Object.assign({ inView, remembered, here: inView[0], seed: 'test', tokens: {}, tokenSvg }, extra));
  return { plan, svg };
}
const allRooms = (state) => Object.keys(state.locations);
// The <g …>…</g> pieces of one class (gameplay pieces and decoration never nest).
const groups = (svg, cls) => [...svg.matchAll(new RegExp(`<g class="[^"]*\\b${cls}\\b[^"]*"[^>]*>.*?</g>`, 'g'))].map((m) => m[0]);
const roomRect = (svg, id) => (svg.match(new RegExp(`data-room="${id}"[^>]*><rect class="sd-(?:floor|ground)" ([^/]*)/>`)) || [])[1];

test('the same input gives byte-identical SVG, in a fresh engine too', () => {
  const a = newGame('mars-station'), b = newGame('mars-station');
  const one = draw(a.E, a.state, ['commons', 'lab'], ['surface']).svg;
  assert.equal(draw(a.E, a.state, ['commons', 'lab'], ['surface']).svg, one);
  assert.equal(draw(b.E, b.state, ['commons', 'lab'], ['surface']).svg, one);
  assert.doesNotMatch(require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'sitedraw.js'), 'utf8'), /Math\.random/);
});

test('unknown rooms leave no trace: no rect, label or feature, only a "?" where a drawn room has an opening into one', () => {
  const { E, state } = newGame('mars-station');
  const { plan, svg } = draw(E, state, ['garage'], []);
  const drawn = new Set(['garage']);
  for (const id of allRooms(state).filter((r) => !drawn.has(r))) {
    const l = state.locations[id];
    assert.ok(!svg.includes(`>${l.name}<`) && !svg.includes(`"${l.name}"`), `${l.name} is not named`);
    (l.features || []).forEach((f) => { const n = E.Engine.featName(f); assert.ok(!svg.includes(`"${n}"`) && !svg.includes(`>${n}<`), `${id}: ${n} is not drawn`); });
    const opening = plan.links.some((k) => !k.remote && ((k.a === id && drawn.has(k.b)) || (k.b === id && drawn.has(k.a))));
    const marks = [...svg.matchAll(new RegExp(`<g class="([^"]*)"[^>]*data-room="${id}"`, 'g'))].map((m) => m[1]);
    assert.ok(marks.every((c) => c === 'map-room sd-stub'), `${id}: only stubs carry its id`);
    assert.equal(marks.length > 0, opening, `${id}: a "?" exactly when the garage opens into it`);
  }
  // The view is cropped to what's drawn: the garage and a cell around it.
  const g = plan.rooms.garage;
  assert.equal(svg.match(/viewBox="([^"]*)"/)[1], [(g.x - 1) * 30, (g.y - 1) * 30, (g.w + 2) * 30, (g.h + 2) * 30].join(' '));
});

test('remembered rooms show their pieces with no state; in view, the state shows', () => {
  const { E, state } = newGame('mars-station');
  state.locations.lab.features = state.locations.lab.features.concat([{ name: 'security camera', state: 'on' }]);
  E.Engine.initSite(state);
  const cabinet = (svg) => groups(svg, 'map-feature').find((g) => g.includes('data-feature="drug cabinet"'));
  const camera = (svg) => groups(svg, 'map-feature').find((g) => g.includes('data-feature="security camera"'));
  const past = draw(E, state, ['commons'], ['med', 'lab']).svg;
  assert.ok(cabinet(past) && camera(past), 'the pieces are drawn');
  assert.match(cabinet(past), /sd-remembered/);
  assert.doesNotMatch(cabinet(past), /sd-lock|locked/, 'no padlock, no "(locked)"');
  assert.doesNotMatch(camera(past), /sd-on|\(on\)/, 'no on dot');
  const now = draw(E, state, ['med', 'lab'], []).svg;
  assert.match(cabinet(now), /#sd-lock/);
  assert.match(cabinet(now), /<title>drug cabinet \(locked\)<\/title>/);
  assert.match(camera(now), /class="sd-on"/);
});

test('every gameplay feature is drawn in view: templates, inferred ones, ones no template knows, a crowded room', () => {
  const { E, state } = newGame('mars-station');
  state.locations.lab.features.push({ name: 'vent cover', inferred: true });
  state.locations.surface.features.push('strange cairn');
  state.locations.suitroom.features.push('fire axe', 'spare tanks', 'tool chest', 'oxygen candles', 'a battered radio');
  const { svg } = draw(E, state, allRooms(state), []);
  for (const id of allRooms(state)) {
    for (const f of E.Engine.features(state, id)) {
      assert.equal(groups(svg, 'map-feature').filter((g) => g.includes(`data-room="${id}"`) && g.includes(`data-feature="${f.name}"`)).length, 1, `${id}: ${f.name}`);
    }
  }
});

test('a window feature sits on an outside wall; an inferred way out is drawn as its opening', () => {
  const { E, state } = newGame('zombie-holdout');
  const win = (svg, id, name) => groups(svg, 'map-feature').find((g) => g.includes(`data-room="${id}"`) && g.includes(`data-feature="${name}"`));
  assert.match(win(draw(E, state, ['floor'], []).svg, 'floor', 'boarded windows'), /sd-window/);
  state.characters[state.player].status.location = 'stockroom';
  const res = E.Engine.inferFeature(state, { name: 'back window', to: 'lot' }, 'I climb out the back window');
  assert.ok(!res.error, res.error);
  const svg = draw(E, state, ['stockroom'], ['lot']).svg;
  assert.match(win(svg, 'stockroom', 'back window'), /sd-window/);
});

test('decoration is visual only: no data the page could act on, and no feature names', () => {
  for (const folder of ['mars-station', 'zombie-holdout']) {
    const { E, state } = newGame(folder);
    const { svg } = draw(E, state, allRooms(state), []);
    const decor = groups(svg, 'sd-decor');
    assert.ok(decor.length > 5, `${folder}: chairs, rocks and the like`);
    decor.forEach((g) => { assert.doesNotMatch(g, /data-|tabindex|role=|<title>|map-feature/, g); });
    // Everything clickable is a room, a "?", a gameplay piece or a token.
    [...svg.matchAll(/<g class="([^"]*)"[^>]*data-/g)].forEach((m) => assert.match(m[1], /map-room|map-feature/, m[1]));
    // Turned off (small or high visibility), decoration isn't drawn at all.
    assert.equal(groups(draw(E, state, allRooms(state), [], { decor: false }).svg, 'sd-decor').length, 0);
  }
});

test('rooms never move as more are discovered', () => {
  const { E, state } = newGame('mars-station');
  const few = draw(E, state, ['garage'], []).svg;
  const more = draw(E, state, ['garage', 'commons'], ['lab']).svg;
  const all = draw(E, state, allRooms(state), []).svg;
  assert.ok(roomRect(few, 'garage'));
  assert.equal(roomRect(more, 'garage'), roomRect(few, 'garage'));
  assert.equal(roomRect(all, 'garage'), roomRect(few, 'garage'));
  assert.equal(roomRect(all, 'commons'), roomRect(more, 'commons'));
  assert.equal(roomRect(all, 'lab'), roomRect(more, 'lab'));
});

test('a door is drawn as it is shown: a padlock only where the page says it is locked', () => {
  const { E, state } = newGame('zombie-holdout');
  const near = draw(E, state, ['floor'], ['office']).svg;
  assert.match(near, /class="sd-lock"/, 'locked, seen from the sales floor');
  const far = draw(E, state, ['dock'], ['floor', 'office'], { links: { 'floor|office': 'door' } }).svg;
  assert.doesNotMatch(far, /class="sd-lock"/, 'out of sight: a door, with no state');
  assert.match(far, /door: Sales Floor – Manager&#39;s Office/);
});

test('room kinds come from names and features; anything else is generic', () => {
  const { E, state } = newGame('mars-station');
  const kinds = {};
  allRooms(state).forEach((id) => (kinds[id] = E.SiteDraw.kindOf(state.locations[id])));
  assert.deepEqual(kinds, { commons: 'galley', ops: 'ops', med: 'med', lab: 'lab', hydro: 'hydro', quarters: 'quarters', suitroom: 'suits', garage: 'garage', surface: 'outdoor' });
  const holdout = newGame('zombie-holdout');
  const hk = {};
  allRooms(holdout.state).forEach((id) => (hk[id] = E.SiteDraw.kindOf(holdout.state.locations[id])));
  assert.deepEqual(hk, { floor: 'store', stockroom: 'warehouse', office: 'office', roof: 'outdoor', dock: 'warehouse', lot: 'street' });
  const k = (name, features, outside) => E.SiteDraw.kindOf({ id: 'x', name, features: features || [], outside });
  assert.equal(k('Antechamber'), 'generic');
  assert.equal(k('The Rusty Anchor', ['bar', 'stools']), 'bar');
  assert.equal(k('Holding Cells'), 'cell');
  assert.equal(k('Back Alley', [], true), 'alley');
  assert.equal(k('Server Room'), 'server');
  assert.equal(k('Armory'), 'armory');
  assert.equal(k('Studio Apartment'), 'apartment');
  assert.equal(E.SiteDraw.countIn('two cots'), 2);
});
