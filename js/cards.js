// Character card import (task 6-2): SillyTavern/Tavern cards, as a PNG with
// the card in a text chunk ("chara" for v1 and v2, "ccv3" for v3, base64
// JSON) or as JSON. One conversion call maps the card into a character sheet
// for this world; the engine then checks the reply: allowed fields and
// limits, the world's skills, no lines addressed to the player, and nothing
// from the card's own scenario or first message (the card's framing is
// dropped, its personality kept). DOM-free; the review is in creator.js.
(function (root) {
  const E = root.Ensemble;
  const C = (E.Cards = {});
  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : '');

  // ---------- reading ----------
  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const latin1 = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // base64 → bytes (no atob in the test VM).
  C.base64 = function (text) {
    const s = String(text).replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor((s.length * 3) / 4));
    let n = 0, bits = 0, acc = 0;
    for (const ch of s) {
      acc = (acc << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 255; }
    }
    return out.slice(0, n);
  };
  C.isPng = (bytes) => bytes && bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
  // The text chunks of a PNG: [{keyword, text, compressed}]. Throws on a
  // file that isn't a PNG or is cut short.
  C.pngText = function (bytes) {
    if (!C.isPng(bytes)) throw new Error('That file is not a PNG image.');
    const out = [];
    let p = 8;
    while (p + 8 <= bytes.length) {
      const len = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
      const type = latin1(bytes.subarray(p + 4, p + 8));
      if (p + 12 + len > bytes.length) throw new Error(`The PNG is cut short (in its "${type}" chunk).`);
      const data = bytes.subarray(p + 8, p + 8 + len);
      if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
        const z = data.indexOf(0);
        const keyword = latin1(data.subarray(0, z < 0 ? data.length : z));
        let text = '', compressed = type === 'zTXt';
        if (type === 'tEXt') text = latin1(data.subarray(z + 1));
        else if (type === 'iTXt') {
          compressed = data[z + 1] === 1;
          let q = z + 3;
          q = data.indexOf(0, q) + 1; // language tag
          q = data.indexOf(0, q) + 1; // translated keyword
          if (!compressed) text = E.Zip.text(data.subarray(q));
        }
        out.push({ keyword, text, compressed });
      }
      if (type === 'IEND') break;
      p += 12 + len;
    }
    return out;
  };
  // A PNG card → its JSON (v3 "ccv3" first, then "chara").
  C.readPng = function (bytes) {
    const chunks = C.pngText(bytes);
    const pick = ['ccv3', 'chara'].map((k) => chunks.find((c) => c.keyword.toLowerCase() === k)).find(Boolean);
    if (!pick) throw new Error('That image has no character card in it (no "chara" or "ccv3" text).');
    if (pick.compressed) throw new Error('That card is stored compressed, which isn\'t supported: export it from SillyTavern as JSON and import that.');
    try { return JSON.parse(E.Zip.text(C.base64(pick.text))); } catch (e) { throw new Error(`The card in that image can't be read: ${e.message}`); }
  };

  // Any card version → one shape. v1 is flat; v2 and v3 keep it in "data".
  C.parse = function (json) {
    if (!isObj(json)) throw new Error('That is not a character card.');
    const spec = str(json.spec);
    const d = /^chara_card_v[23]$/.test(spec) && isObj(json.data) ? json.data : isObj(json.data) && json.data.name ? json.data : json;
    const name = str(d.name).trim() || str(d.char_name).trim();
    if (!name) throw new Error('That card has no name, so it isn\'t a character card.');
    return {
      version: spec === 'chara_card_v3' ? 3 : spec === 'chara_card_v2' || json.data ? 2 : 1,
      name,
      description: str(d.description) || str(d.char_persona),
      personality: str(d.personality),
      scenario: str(d.scenario) || str(d.world_scenario),
      firstMes: str(d.first_mes) || str(d.char_greeting),
      examples: str(d.mes_example) || str(d.example_dialogue),
      systemPrompt: str(d.system_prompt),
      greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.filter((g) => typeof g === 'string') : [],
      tags: Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string').slice(0, 12) : [],
      creator: str(d.creator),
    };
  };
  // A file's bytes → { card, image } (image: the PNG's bytes, for a portrait).
  C.fromFile = function (bytes, fileName) {
    if (C.isPng(bytes)) return { card: C.parse(C.readPng(bytes)), image: bytes };
    let json;
    try { json = JSON.parse(E.Zip.text(bytes)); } catch (e) { throw new Error(`${fileName || 'That file'} is neither a PNG card nor card JSON.`); }
    return { card: C.parse(json), image: null };
  };

  // The card's own text with its macros filled in: {{char}} is the name,
  // {{user}} someone the character meets; <START> markers go. What the
  // conversion sees.
  C.macros = (text, name) => String(text || '').replace(/\r/g, '').replace(/^[ \t]*<START>[ \t]*\n?/gim, '').replace(/\{\{char\}\}|<BOT>/gi, name).replace(/\{\{user\}\}|<USER>/gi, 'someone they meet').replace(/\{\{[^}]*\}\}/g, '').replace(/\r/g, '');
  C.LIMITS = { description: 1500, personality: 600, examples: 800 };
  // What the conversion call uses, and what it never sees.
  C.used = (card) => ({
    description: E.shorten(C.macros(card.description, card.name), C.LIMITS.description),
    personality: E.shorten(C.macros(card.personality, card.name), C.LIMITS.personality),
    examples: E.shorten(C.macros(card.examples, card.name), C.LIMITS.examples),
  });
  C.dropped = (card) => [['scenario', card.scenario], ['first message', card.firstMes], ['system prompt', card.systemPrompt], ['other greetings', card.greetings.join(' ')]].filter(([, v]) => String(v || '').trim()).map(([k]) => k);

  // ---------- checking the reply ----------
  const sentences = (t) => String(t || '').match(/[^.!?]+[.!?]*["”']?\s*/g) || [];
  const words = (t) => E.Engine.contentWords(t);
  const shared = (a, b) => [...a].filter((w) => b.has(w)).length;
  const ADDRESS = /\{\{user\}\}|<user>|\b(you|your|yours|yourself)\b/i;
  const TEXT = { description: 600, appearance: 400, want: 160, voice: 160, secret: 300 };
  // The model's sheet → { character, notes }. Fields outside the sheet are
  // dropped; text is cut to the limits; skills are the world's, 0–4.
  C.clean = function (raw, card, sc) {
    const obj = isObj(raw) ? raw : {};
    const notes = [];
    const L = E.CharMaker.LIMITS;
    const t = (v, n) => str(v).replace(/\s+/g, ' ').trim().slice(0, n);
    const frame = words([card.scenario, card.firstMes, card.systemPrompt].concat(card.greetings).join(' '));
    const self = words([card.description, card.personality].join(' '));
    const secretWords = words(str(obj.secret));
    const c = { name: t(card.name, L.name) };
    c.pronouns = t(obj.pronouns, L.pronouns) || 'they/them';
    const age = Math.round(Number(obj.age));
    if (age > 0 && age < 130) c.age = age;
    c.role = t(obj.role, L.role);
    const people = t(obj.people, L.people);
    if (people) c.people = people;
    // Text fields: sentences that talk to the player, come from the card's
    // own scenario, or give the secret away (outside the secret) are cut.
    Object.entries(TEXT).forEach(([k, max]) => {
      let v = C.macros(str(obj[k]), c.name);
      if (!v.trim()) return;
      const keep = sentences(v).filter((s) => {
        if (ADDRESS.test(s)) { notes.push(`Left out a line written to the player (${k}): "${s.trim()}"`); return false; }
        const w = words(s);
        const f = shared(w, frame);
        if (f >= 3 && f > shared(w, self)) { notes.push(`Left out a line from the card's own scenario (${k}): "${s.trim()}"`); return false; }
        if (k !== 'secret' && secretWords.size && shared(w, secretWords) >= 4) { notes.push(`Left out a line that gives the secret away (${k}): "${s.trim()}"`); return false; }
        return true;
      });
      v = keep.join('').replace(/\s+/g, ' ').trim();
      if (v.length > max) { v = E.shorten(v, max); notes.push(`Shortened ${k} to ${max} characters.`); }
      if (v) c[k] = v;
    });
    const traits = (Array.isArray(obj.traits) ? obj.traits : []).map((x) => t(x, 100).toLowerCase()).filter((x) => x && x.length <= L.trait);
    c.traits = [...new Set(traits)].slice(0, L.traits);
    if (c.secret) c.guard = ['low', 'medium', 'high'].includes(obj.guard) ? obj.guard : 'medium';
    c.skills = {};
    (sc.skills || []).forEach((k) => {
      const v = isObj(obj.skills) ? Number(obj.skills[k]) : NaN;
      c.skills[k] = Number.isFinite(v) ? E.clamp(Math.round(v), 0, 4) : 0;
    });
    Object.keys(isObj(obj.skills) ? obj.skills : {}).filter((k) => !(sc.skills || []).includes(k)).forEach((k) => notes.push(`Dropped the skill "${k}": not one of this world's skills.`));
    Object.keys(obj).filter((k) => !['name', 'pronouns', 'age', 'role', 'people', 'traits', 'skills', 'guard'].concat(Object.keys(TEXT)).includes(k)).forEach((k) => notes.push(`Ignored "${k}": not part of a character sheet.`));
    const missing = [!c.role && 'a role', !c.want && 'what they want', !c.traits.length && 'traits'].filter(Boolean);
    if (missing.length) notes.push(`Still needed before adding: ${missing.join(', ')}.`);
    return { character: c, notes };
  };

  // One worldbuild call → { character, notes }. sc: a composed start of
  // the world (its header and skills).
  C.convert = async function (sc, card) {
    const p = E.Prompts.cardConvert(sc, card);
    const raw = await E.LLM.chatJSON({ kind: 'worldbuild (character)', system: p.system, user: p.user, maxTokens: 500, temperature: 0.7 });
    return C.clean(raw, card, sc);
  };
})(typeof window !== 'undefined' ? window : globalThis);
