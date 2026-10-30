// Names in the story: places, people and lore terms in a scene are linked to
// what the player may know about them (hover for a short box, click for the
// whole entry or a person's card). Only public things, never secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame } = require('./helpers');

const keys = (html) => [...html.matchAll(/data-term="([^"]+)">([^<]+)</g)].map((m) => `${m[2]}=${m[1]}`);

test('people, places and capitalised lore terms are linked, the first mention in each paragraph only', () => {
  const { E, state } = newGame('seiryo-high');
  const html = E.Glossary.markup(state, 'Aoi waves from the gate. Aoi again. Mito is grey; Kairakuen blooms. Ms. Saeki yawns.\n\nAoi runs to the Hayakawa house.', E.esc);
  assert.deepEqual(keys(html), ['Aoi=person:aoi', 'Mito=region:mito', 'Kairakuen=lore:kairakuen', 'Saeki=person:saeki', 'Aoi=person:aoi', 'Hayakawa house=site:hayakawa-house']);
  assert.match(html, /\n\n/, 'paragraphs keep their spacing');
});

test('a name part shared in the cast, a title, a lowercase keyword or part of a longer word links nothing', () => {
  const { E, state } = newGame('seiryo-high');
  const html = E.Glossary.markup(state, 'The Hayakawa family. Principal Matsudaira speaks. Lunch at school; Aoiko is not Aoi.', E.esc);
  assert.deepEqual(keys(html), ['Principal Matsudaira=extra:matsudaira', 'Aoi=person:aoi']);
});

test('the text is escaped, links or not', () => {
  const { E, state } = newGame('seiryo-high');
  assert.equal(E.Glossary.markup(state, '<b>Aoi</b> & "Ren"', E.esc).replace(/<span[^>]*>|<\/span>/g, ''), '&lt;b&gt;Aoi&lt;/b&gt; &amp; &quot;Ren&quot;');
});

test('hidden regions, people who have not joined yet and rooms not seen are not linked, until they are', () => {
  const { E, state } = newGame('frontier');
  const gulch = state.scenario.regions.find((r) => r.id === 'poormans-gulch');
  assert.equal(state.regions['poormans-gulch'].known, false);
  assert.deepEqual(keys(E.Glossary.markup(state, `They say ${gulch.name} is rich.`, E.esc)), [], 'a hidden region');
  state.regions['poormans-gulch'].known = true;
  state.turn++;
  assert.deepEqual(keys(E.Glossary.markup(state, `They say ${gulch.name} is rich.`, E.esc)), [`${E.esc(gulch.name)}=region:poormans-gulch`]);

  const s = newGame('seiryo-high');
  const lena = s.state.waiting.lena;
  const name = (lena.character || lena).name;
  assert.ok(name, 'Lena waits to join');
  assert.deepEqual(keys(s.E.Glossary.markup(s.state, `${name} is new.`, s.E.esc)), []);
  // The dorm's rules are lore about its entrance: shown once the player has
  // seen it, in their own box and in the dorm's.
  const G = s.E.Glossary;
  s.state.seenRooms = s.state.seenRooms.filter((r) => r !== 'dorm-entrance');
  s.state.turn++;
  assert.equal(G.info(s.state, { kind: 'lore', id: 'dorm-rules' }), null);
  assert.ok(![...G.index(s.state).terms.values()].some((t) => t.id === 'dorm-rules'), 'no term links to it');
  assert.ok(!G.info(s.state, { kind: 'site', id: 'dorm' }).text.some((t) => /curfew|forty students/.test(t)));
  s.state.seenRooms.push('dorm-entrance');
  s.state.turn++;
  assert.ok(G.info(s.state, { kind: 'lore', id: 'dorm-rules' }));
  assert.ok(G.info(s.state, { kind: 'site', id: 'dorm' }).text.some((t) => /forty students/.test(t)));
});

test('what a link shows is public: no one\'s secret, and a person\'s box is their card\'s', () => {
  for (const world of ['seiryo-high', 'mars-station', 'zombie-holdout', 'frontier']) {
    const { E, state } = newGame(world);
    const { terms } = E.Glossary.index(state);
    const secrets = Object.values(state.characters).map((c) => c.secret).filter(Boolean);
    for (const target of terms.values()) {
      const info = E.Glossary.info(state, target);
      assert.ok(info, `${world}: ${target.kind}:${target.id} has a box`);
      const all = [info.title, info.sub].concat(info.text).join(' ');
      secrets.forEach((sec) => assert.ok(!all.includes(sec), `${world}: ${target.kind}:${target.id} shows a secret`));
    }
  }
  const { E, state } = newGame('seiryo-high');
  const aoi = E.Glossary.info(state, { kind: 'person', id: 'aoi' });
  assert.equal(aoi.person, 'aoi', 'a click opens her card');
  assert.equal(aoi.title, state.characters.aoi.name);
  assert.match(aoi.feel, /^(trusts|friendly|neutral|wary|hostile) /);
  const mito = E.Glossary.info(state, { kind: 'region', id: 'mito' });
  assert.ok(mito.text.some((t) => /capital of Ibaraki/.test(t)), 'its lore');
  assert.match(mito.sub, /Ibaraki/);
});
