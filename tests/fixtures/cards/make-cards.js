// Writes the fixture cards for tests/cards.test.js (task 6-2): node tests/fixtures/cards/make-cards.js tests/fixtures/cards
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const out = process.argv[2];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const png = (texts) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 200, 120, 60, 40, 90, 160, 0, 40, 90, 160, 200, 120, 60]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...texts.map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(Buffer.from(JSON.stringify(v), 'utf8').toString('base64'), 'latin1')]))), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const v1 = { name: 'Marta Kowal', description: '{{char}} is a ferry mechanic in her fifties with oil under her nails and a laugh like a foghorn.', personality: 'gruff, generous, superstitious about engines', scenario: '{{user}} is a passenger stuck on the night ferry when the engine dies mid-crossing.', first_mes: '*Marta wipes her hands and squints at you.* "You. Hold this torch."', mes_example: '<START>\n{{char}}: "Engines are like goats. Talk nice and they still bite."' };
const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Juniper Vale', description: 'Juniper keeps the lighthouse on Gull Point. She is thirty-four, wiry and sunburnt, and writes down every ship that passes in a ledger nobody reads.', personality: 'dry, patient, quietly lonely, fiercely honest', scenario: 'A storm has wrecked a sailboat and {{user}} washed up half-drowned below the lighthouse stairs.', first_mes: '*She hauls you up the stairs by your collar.* "Don\'t drip on the ledger."', mes_example: '<START>\n{{user}}: Do you ever leave?\n{{char}}: "The light doesn\'t leave. So no."', creator_notes: 'Slow burn.', system_prompt: 'You are Juniper. Stay in character.', post_history_instructions: '', alternate_greetings: ['*Juniper is asleep at the lamp when you knock.*'], tags: ['lighthouse', 'drama'], creator: 'fixture', character_version: '1', extensions: {} } };
const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: Object.assign({}, v2.data, { name: 'Oskar Lind', description: 'Oskar runs the bait shop by the harbor wall and knows every rumor in town before the people in it do.', personality: 'chatty, nosy, kind underneath', scenario: '{{user}} has just rented the flat above the bait shop.', first_mes: '"New tenant! You\'ll want worms."', nickname: 'Oz', group_only_greetings: [], assets: [] }) };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'v1.png'), png([['chara', v1]]));
fs.writeFileSync(path.join(out, 'v2.png'), png([['chara', v2]]));
fs.writeFileSync(path.join(out, 'v3.png'), png([['chara', v2], ['ccv3', v3]]));
fs.writeFileSync(path.join(out, 'v2.json'), JSON.stringify(v2, null, 2) + '\n');
