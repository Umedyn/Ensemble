// Character card import (task 6-2): reading Tavern PNG cards (v1, v2, v3)
// and JSON, the conversion prompt, and the engine's checks on the reply.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadEngine, newGame, mockLLM } = require('./helpers');

const E = loadEngine();
const C = E.Cards;
const dir = path.join(__dirname, 'fixtures', 'cards');
const bytes = (name) => new Uint8Array(fs.readFileSync(path.join(dir, name)));
const plain = (v) => JSON.parse(JSON.stringify(v));
const { state } = newGame('zombie-holdout');
const sc = state.scenario;

// ---------- reading ----------

test('a v1 PNG card reads from its "chara" text chunk', () => {
  const { card, image } = C.fromFile(bytes('v1.png'), 'v1.png');
  assert.equal(card.version, 1);
  assert.equal(card.name, 'Marta Kowal');
  assert.match(card.description, /ferry mechanic/);
  assert.match(card.scenario, /night ferry/);
  assert.ok(image && image.length > 100, 'the image comes along for the portrait');
});

test('a v2 PNG card reads its "data", and the same card as JSON matches', () => {
  const png = C.fromFile(bytes('v2.png')).card;
  assert.equal(png.version, 2);
  assert.equal(png.name, 'Juniper Vale');
  assert.equal(png.systemPrompt, 'You are Juniper. Stay in character.');
  assert.deepEqual([...png.greetings], ['*Juniper is asleep at the lamp when you knock.*']);
  const json = C.fromFile(bytes('v2.json'), 'v2.json');
  assert.deepEqual(plain(json.card), plain(png));
  assert.equal(json.image, null);
});

test('a v3 card ("ccv3") wins over the v2 copy in the same image', () => {
  const { card } = C.fromFile(bytes('v3.png'));
  assert.equal(card.version, 3);
  assert.equal(card.name, 'Oskar Lind');
});

test('files that are not cards say so plainly', () => {
  const png = bytes('v1.png');
  // An image with no text chunks: keep the signature, IHDR and IEND only.
  const ihdrEnd = 8 + 12 + 13;
  const bare = new Uint8Array([...png.subarray(0, ihdrEnd), ...png.subarray(png.length - 12)]);
  assert.throws(() => C.fromFile(bare), /no character card/);
  assert.throws(() => C.fromFile(png.subarray(0, 60)), /cut short/);
  assert.throws(() => C.fromFile(E.Zip.utf8('hello'), 'notes.txt'), /neither a PNG card nor card JSON/);
  assert.throws(() => C.parse({ spec: 'chara_card_v2', data: { description: 'x' } }), /no name/);
});

test('a compressed card is refused with a way out', () => {
  // A zTXt chunk named "chara": [length][type][keyword \0 method][data][crc]
  const png = bytes('v1.png');
  const kw = [...'chara'].map((c) => c.charCodeAt(0));
  const data = [...kw, 0, 0, 1, 2, 3];
  const chunk = [0, 0, 0, data.length, ...[...'zTXt'].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  const ihdrEnd = 8 + 12 + 13;
  const z = new Uint8Array([...png.subarray(0, ihdrEnd), ...chunk, ...png.subarray(png.length - 12)]);
  assert.throws(() => C.fromFile(z), /compressed[\s\S]*JSON/);
});

test('base64 decodes the way the cards are written', () => {
  assert.equal(E.Zip.text(C.base64('SnVuaXBlciDinJM=')), 'Juniper ✓');
});

// ---------- the prompt ----------

test('the conversion prompt has the card\'s personality and never its scenario, greeting or system prompt', () => {
  const card = C.fromFile(bytes('v2.png')).card;
  const p = E.Prompts.cardConvert(sc, card);
  assert.match(p.user, /Juniper keeps the lighthouse/);
  assert.match(p.user, /dry, patient/);
  assert.match(p.user, /The light doesn't leave/);
  assert.doesNotMatch(p.user, /washed up|hauls you|Stay in character|asleep at the lamp|\{\{user\}\}/);
  assert.match(p.system, /SETTING/, 'the world comes first, as for generated starts');
  sc.skills.forEach((k) => assert.match(p.user, new RegExp(`"${k}":1`)));
  assert.deepEqual([...C.dropped(card)], ['scenario', 'first message', 'system prompt', 'other greetings']);
});

// ---------- checking the reply ----------

const juniper = () => C.fromFile(bytes('v2.png')).card;
const reply = (over) => Object.assign({
  pronouns: 'she/her', age: 34, role: 'keeps the old harbor light', people: null,
  traits: ['Dry', 'patient', 'honest', 'a trait that is far too long to be a trait at all'],
  want: 'keep the light burning through the outbreak', voice: 'Few words, all of them true.',
  appearance: 'Wiry and sunburnt, with salt-stiff hair. She always smells of lamp oil.',
  description: 'Juniper has kept the light on Gull Point for ten years and logs every ship in a ledger.',
  secret: null, guard: 'high', skills: { fighting: 2, medicine: 9, piloting: 3 },
}, over || {});

test('a good reply becomes a sheet within the limits and the world\'s skills', () => {
  const out = C.clean(reply(), juniper(), sc);
  const c = out.character;
  assert.equal(c.name, 'Juniper Vale', 'the card\'s name is kept');
  assert.deepEqual([...c.traits], ['dry', 'patient', 'honest']);
  assert.deepEqual(Object.keys(c.skills).sort(), [...sc.skills].sort(), 'every world skill, nothing else');
  Object.values(c.skills).forEach((v) => assert.ok(v >= 0 && v <= 4));
  assert.ok(!('guard' in c), 'no secret, no guard');
  assert.ok(!('people' in c));
  assert.ok(out.notes.some((n) => /piloting/.test(n)), 'a skill the world lacks is reported');
});

test('lines written to the player and lines from the card\'s scenario are left out, with a note', () => {
  const out = C.clean(reply({
    description: 'Juniper has kept the light for ten years. She pulled you out of the surf last night. A storm wrecked a sailboat and the half-drowned stranger washed up below the lighthouse stairs.',
  }), juniper(), sc);
  assert.equal(out.character.description, 'Juniper has kept the light for ten years.');
  assert.ok(out.notes.some((n) => /written to the player/.test(n)));
  assert.ok(out.notes.some((n) => /card's own scenario/.test(n)));
});

test('a secret stays out of the description, and gets a guard', () => {
  const out = C.clean(reply({
    secret: 'She saw the cargo ship that brought the sickness and never reported it to anyone.',
    description: 'Juniper keeps the light. She saw the cargo ship that brought the sickness and never reported it.',
    guard: 'sideways',
  }), juniper(), sc);
  assert.equal(out.character.description, 'Juniper keeps the light.');
  assert.equal(out.character.guard, 'medium');
  assert.ok(out.notes.some((n) => /gives the secret away/.test(n)));
});

test('fields outside a sheet are ignored, and what is missing is named', () => {
  const out = C.clean({ relations: { ferris: 90 }, agenda: { goal: 'x' }, scenario: 'x' }, juniper(), sc);
  assert.ok(!('relations' in out.character) && !('agenda' in out.character));
  assert.ok(out.notes.some((n) => /Ignored "relations"/.test(n)));
  assert.ok(out.notes.some((n) => /Still needed before adding: a role, what they want, traits/.test(n)));
});

test('{{char}} in the reply becomes the name', () => {
  const out = C.clean(reply({ voice: '{{char}} speaks slowly.' }), juniper(), sc);
  assert.equal(out.character.voice, 'Juniper Vale speaks slowly.');
});

test('one conversion call, routed with world building, makes the sheet', async () => {
  const calls = mockLLM(E, () => reply());
  const out = await C.convert(sc, juniper());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'worldbuild (character)');
  assert.equal(out.character.role, 'keeps the old harbor light');
});
