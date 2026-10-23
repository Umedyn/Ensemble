// Lore entries (task 5-1): public world knowledge, chosen per turn so a big
// world stays playable in a small context. Always-on world entries go in the
// static header; the rest go in a user message when something triggers them:
// the player's room, the people present, the player's region, or a keyword in
// the player's action or the last scene. Lore is public: secrets belong in
// character secrets and private facts, future events in the timeline.
(function (root) {
  const E = root.Ensemble;
  const L = (E.Lore = {});
  const Eng = () => E.Engine;

  L.LEVELS = ['world', 'region', 'location', 'character', 'topic'];
  // Levels that point at something (ref) and the order levels rank in: the
  // most specific first.
  L.REF_LEVELS = ['region', 'location', 'character'];
  const LEVEL_RANK = { location: 0, character: 1, region: 2, topic: 3, world: 4 };
  L.LIMITS = { title: 80, text: 800, keywords: 12, keyword: 40 };

  // Debug: while a turn report is open, the lore each prompt included
  // ([{ call, id, title, why }]); set by the engine's telemetry.
  L.collector = null;

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  // Drafts (from the research helper or a packet, "draft": true) wait for
  // review in the creator and never reach a prompt.
  L.entries = (sc) => (sc && Array.isArray(sc.lore) ? sc.lore.filter((e) => isObj(e) && e.draft !== true) : []);
  L.always = (sc) => L.entries(sc).filter((e) => e.alwaysOn === true);
  L.line = (e) => `- ${e.title}: ${e.text}`;

  // A keyword matches as a whole word or phrase, ignoring case: "ash" is not
  // in "crash", and "Ridge road" matches "the ridge  road".
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  L.matches = function (keyword, text) {
    const k = String(keyword || '').trim();
    if (!k || !text) return false;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${k.split(/\s+/).map(escRe).join('\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    return re.test(String(text));
  };

  // The entries for this moment, best first, within the lore budget:
  // [{ id, title, level, text, why, tokens }]. opts: action (the player's
  // words), scene (default: the last scene), room (default: where the player
  // is). Deterministic, so the engine and Debug always agree.
  L.select = function (state, opts) {
    const o = opts || {};
    const all = L.entries(state.scenario);
    if (!all.length) return [];
    const room = o.room || state.characters[state.player].status.location;
    const region = Eng().regionOf(state, room);
    const people = [state.player].concat(Eng().present(state, room));
    const last = state.recent && state.recent[state.recent.length - 1];
    const scene = o.scene != null ? o.scene : last ? last.text : '';
    const nm = (id) => (state.characters[id] ? state.characters[id].name : id);
    const picks = new Map();
    const add = (e, i, group, why) => {
      const p = picks.get(e.id);
      if (p) { p.group = Math.min(p.group, group); p.why.push(why); }
      else picks.set(e.id, { e, i, group, why: [why] });
    };
    all.forEach((e, i) => {
      if (e.alwaysOn === true) return; // already in the header
      if (e.level === 'location' && e.ref === room) add(e, i, 0, 'the player is here');
      if (e.level === 'character' && people.includes(e.ref)) add(e, i, 0, e.ref === state.player ? 'the player character' : `${nm(e.ref)} is present`);
      if (e.level === 'region' && region && e.ref === region) add(e, i, 1, "the player's region");
      const kws = Array.isArray(e.keywords) ? e.keywords : [];
      const inAction = kws.find((k) => L.matches(k, o.action));
      if (inAction) add(e, i, 2, `"${inAction}" in the action`);
      else {
        const inScene = kws.find((k) => L.matches(k, scene));
        if (inScene) add(e, i, 3, `"${inScene}" in the last scene`);
      }
    });
    const ranked = [...picks.values()].sort((a, b) => a.group - b.group
      || (b.e.priority || 3) - (a.e.priority || 3)
      || LEVEL_RANK[a.e.level] - LEVEL_RANK[b.e.level]
      || a.i - b.i);
    // Greedy within the budget: an entry that doesn't fit is skipped, and a
    // smaller one after it can still go in.
    const budget = E.Memory.budgets().lore;
    let used = 0;
    const out = [];
    ranked.forEach((p) => {
      const tokens = E.estTokens(L.line(p.e));
      if (used + tokens > budget) return;
      used += tokens;
      out.push({ id: p.e.id, title: p.e.title, level: p.e.level, text: p.e.text, why: p.why.join('; '), tokens });
    });
    return out;
  };

  // Debug: note what a prompt included, once per call kind and entry.
  L.note = function (call, picks) {
    const c = L.collector;
    if (!c) return;
    picks.forEach((p) => {
      if (!c.some((x) => x.call === call && x.id === p.id)) c.push({ call, id: p.id, title: p.title, why: p.why });
    });
  };

  // ---------- data ----------
  // world.lore items are entries, or ids of files in lore/ (one entry, or a
  // list of them: a lore packet). → { entries, problems }.
  L.resolve = function (list, files) {
    const entries = [];
    const problems = [];
    if (list == null) return { entries, problems };
    if (!Array.isArray(list)) return { entries, problems: ['"lore" must be a list of entries or lore file ids (files in lore/)'] };
    list.forEach((item) => {
      if (typeof item !== 'string') return entries.push(item);
      const f = (files || {})[`lore/${item}.json`];
      if (f == null) return problems.push(`missing lore/${item}.json`);
      if (Array.isArray(f)) entries.push(...f);
      else if (isObj(f)) entries.push(f.id == null ? Object.assign({ id: item }, f) : f);
      else problems.push(`lore/${item}.json must hold an entry or a list of entries`);
    });
    return { entries, problems };
  };

  // Shape problems of a list of entries (refs are checked by the caller,
  // which knows every start's rooms and the whole character pool).
  L.problems = function (entries, where) {
    const problems = [];
    const seen = new Set();
    const lim = L.LIMITS;
    (entries || []).forEach((e) => {
      if (!isObj(e)) return problems.push(`${where}: each lore entry must be {id, title, level, text}${typeof e === 'string' ? ` (lore file ids work in world.json only: "${e}")` : ''}`);
      const at = `${where}: lore "${e.id || '?'}"`;
      const req = (cond, msg) => { if (!cond) problems.push(`${at}: ${msg}`); };
      req(typeof e.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(e.id), '"id" must be lowercase letters, digits, - or _');
      if (seen.has(e.id)) problems.push(`${at} is listed twice`);
      seen.add(e.id);
      req(typeof e.title === 'string' && e.title.trim() && e.title.length <= lim.title, `"title" must be text of at most ${lim.title} characters`);
      req(L.LEVELS.includes(e.level), `"level" must be one of ${L.LEVELS.join(', ')}`);
      if (L.REF_LEVELS.includes(e.level)) req(typeof e.ref === 'string' && e.ref.trim(), `"ref" must name the ${e.level} it is about`);
      else req(e.ref == null, `"ref" is only for ${L.REF_LEVELS.join(', ')} entries`);
      req(typeof e.text === 'string' && e.text.trim() && e.text.length <= lim.text, `"text" must be text of at most ${lim.text} characters`);
      req(e.keywords == null || (Array.isArray(e.keywords) && e.keywords.length <= lim.keywords && e.keywords.every((k) => typeof k === 'string' && k.trim() && k.length <= lim.keyword)),
        `"keywords" must be a list of at most ${lim.keywords} words or phrases (${lim.keyword} characters each)`);
      req(e.priority == null || (Number.isInteger(e.priority) && e.priority >= 1 && e.priority <= 5), '"priority" must be a whole number from 1 to 5');
      req(e.alwaysOn == null || typeof e.alwaysOn === 'boolean', '"alwaysOn" must be true or false');
      req(e.draft == null || typeof e.draft === 'boolean', '"draft" must be true or false');
      req(e.alwaysOn !== true || e.level === 'world', '"alwaysOn" is for world entries only');
      req(e.sources == null || (Array.isArray(e.sources) && e.sources.every((s) => isObj(s) && typeof s.title === 'string' && s.title.trim() && typeof s.url === 'string' && /^https?:\/\//.test(s.url))),
        '"sources" must be a list of {title, url}');
    });
    return problems;
  };

  // The person whose secret an entry gives away (4+ content words in common),
  // or null. Lore reaches the narrator, which must never see a secret.
  L.leak = function (entry, people) {
    const words = (s) => Eng().contentWords(s);
    const text = words(`${entry.title || ''} ${entry.text || ''}`);
    return (people || []).find((c) => {
      if (!c || !c.secret) return false;
      const secret = words(c.secret);
      let hits = 0;
      text.forEach((w) => { if (secret.has(w)) hits++; });
      return hits >= 4;
    }) || null;
  };
})(typeof window !== 'undefined' ? window : globalThis);
