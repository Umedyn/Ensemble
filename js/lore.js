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
  L.LIMITS = { title: 80, text: 800, keywords: 12, keyword: 40, topics: 4, worldTopics: 12, topicWords: 20 };

  // Topic tags (task 5-5): what an entry is about beyond where, so two players
  // in the same city pull different lore. Each topic's words find it in the
  // player character's role, traits and tags, and in the action or the last
  // scene. Words common in any scene ("work", "home", "party") are left out,
  // so a topic comes up only when the scene is really about it. A world adds
  // its own in "loreTopics" ({ topic: [words] }), or more words for these.
  L.TOPICS = {
    school: ['school', 'student', 'students', 'pupil', 'teacher', 'teachers', 'classmate', 'classmates', 'homework', 'exam', 'exams', 'university', 'college', 'campus', 'professor', 'lecture', 'headmaster', 'principal'],
    work: ['coworker', 'coworkers', 'colleague', 'colleagues', 'employee', 'employees', 'employer', 'workplace', 'technician', 'mechanic', 'foreman', 'factory', 'warehouse', 'overtime', 'payday', 'clerk'],
    business: ['business', 'businessman', 'businesswoman', 'company', 'corporation', 'CEO', 'executive', 'manager', 'investor', 'investors', 'startup', 'entrepreneur', 'shopkeeper', 'merchant', 'trader', 'owner', 'contract'],
    crime: ['crime', 'criminal', 'criminals', 'gang', 'gangs', 'gangster', 'mafia', 'yakuza', 'thief', 'thieves', 'theft', 'smuggler', 'smuggling', 'drugs', 'dealer', 'police', 'cop', 'cops', 'detective', 'heist', 'murder'],
    military: ['military', 'army', 'soldier', 'soldiers', 'reservist', 'marine', 'marines', 'navy', 'air force', 'officer', 'sergeant', 'troops', 'war', 'veteran', 'National Guard'],
    politics: ['politics', 'political', 'politician', 'government', 'minister', 'mayor', 'council', 'election', 'senator', 'parliament', 'regulator', 'regulators', 'diplomat', 'governor'],
    religion: ['religion', 'religious', 'church', 'priest', 'pastor', 'temple', 'shrine', 'monk', 'nun', 'faith', 'prayer', 'mosque', 'imam', 'rabbi'],
    nightlife: ['nightlife', 'bar', 'bars', 'nightclub', 'club', 'clubs', 'bartender', 'DJ', 'karaoke', 'drinking'],
    family: ['family', 'mother', 'father', 'mom', 'dad', 'parent', 'parents', 'sister', 'brother', 'son', 'daughter', 'wife', 'husband', 'kids', 'children', 'grandmother', 'grandfather'],
    health: ['health', 'doctor', 'nurse', 'medic', 'hospital', 'clinic', 'medicine', 'illness', 'patient', 'patients', 'surgeon', 'pharmacy', 'paramedic'],
    travel: ['travel', 'traveller', 'traveler', 'driver', 'pilot', 'journey', 'highway', 'train', 'bus', 'airport', 'flight', 'sailor', 'trucker', 'delivery'],
    tech: ['tech', 'technology', 'technician', 'engineer', 'engineering', 'computer', 'computers', 'hacker', 'programmer', 'software', 'robot', 'robots', 'AI', 'electronics'],
    science: ['science', 'scientist', 'research', 'researcher', 'lab', 'laboratory', 'geologist', 'biologist', 'astrobiologist', 'chemist', 'physicist', 'experiment', 'samples'],
    sport: ['sport', 'sports', 'athlete', 'coach', 'football', 'soccer', 'baseball', 'basketball', 'stadium'],
    arts: ['art', 'artist', 'music', 'musician', 'band', 'painter', 'writer', 'actor', 'actress', 'theatre', 'theater', 'film', 'singer', 'poet'],
    law: ['law', 'lawyer', 'judge', 'court', 'courthouse', 'trial', 'attorney', 'legal', 'lawsuit'],
  };
  // { topic: [words] }: the defaults and the world's own (words added up).
  L.topicTable = function (sc) {
    const out = {};
    Object.entries(L.TOPICS).forEach(([t, ws]) => (out[t] = ws.slice()));
    const own = sc && isObj(sc.loreTopics) ? sc.loreTopics : {};
    Object.entries(own).forEach(([t, ws]) => {
      out[t] = [...new Set((out[t] || []).concat(Array.isArray(ws) ? ws.filter((w) => typeof w === 'string' && w.trim()) : []))];
    });
    return out;
  };
  L.topicIds = (sc) => Object.keys(L.topicTable(sc));
  // The topics whose words are in a text, in table order. A word's plain
  // plural counts too ("smugglers" for "smuggler").
  const wordIn = (w, text) => L.matches(w, text) || L.matches(`${w}s`, text);
  L.topicsIn = function (table, text) {
    if (!text) return [];
    return Object.keys(table).filter((t) => table[t].some((w) => wordIn(w, text)));
  };
  // The player character's topics: from their role, traits and authored
  // tags, plus their own "topics". Fixed for the game (from the scenario, not
  // the live sheet), so it is cached per scenario and costs nothing per call.
  const playerCache = new WeakMap();
  L.playerTopics = function (state) {
    const sc = state.scenario || {};
    const hit = playerCache.get(sc);
    if (hit && hit.player === state.player) return hit.topics;
    const c = (Array.isArray(sc.characterData) && sc.characterData.find((x) => x && x.id === state.player)) || (state.characters && state.characters[state.player]) || {};
    const table = L.topicTable(sc);
    const words = [c.role].concat(Array.isArray(c.traits) ? c.traits : [], Array.isArray(c.tags) ? c.tags.map((t) => (isObj(t) ? t.text : t)) : [])
      .filter((x) => typeof x === 'string' && x.trim()).join('. ');
    const own = Array.isArray(c.topics) ? c.topics : [];
    const topics = Object.keys(table).filter((t) => own.includes(t) || table[t].some((w) => wordIn(w, words)));
    playerCache.set(sc, { player: state.player, topics });
    return topics;
  };

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
    const chain = region ? Eng().regionChain(state, region) : [];
    const people = [state.player].concat(Eng().present(state, room));
    const last = state.recent && state.recent[state.recent.length - 1];
    const scene = o.scene != null ? o.scene : last ? last.text : '';
    const nm = (id) => (state.characters[id] ? state.characters[id].name : id);
    // Topics (task 5-5): the action's, then the player's own, then the last scene's.
    const table = L.topicTable(state.scenario);
    const mine = L.playerTopics(state);
    const said = L.topicsIn(table, o.action);
    const seen = L.topicsIn(table, scene);
    const topicOf = (e) => {
      const ts = Array.isArray(e.topics) ? e.topics : [];
      let t = ts.find((x) => said.includes(x));
      if (t) return { group: 2.1, why: `topic "${t}" in the action` };
      t = ts.find((x) => mine.includes(x));
      if (t) return { group: 2.2, why: `topic "${t}" (the player character)` };
      t = ts.find((x) => seen.includes(x));
      return t ? { group: 2.4, why: `topic "${t}" in the last scene` } : null;
    };
    const picks = new Map();
    const add = (e, i, group, why) => {
      const p = picks.get(e.id);
      if (p) { p.group = Math.min(p.group, group); p.why.push(why); }
      else picks.set(e.id, { e, i, group, why: [why] });
    };
    all.forEach((e, i) => {
      if (e.alwaysOn === true) return; // already in the header
      // A region the player doesn't know of yet (R-5): none of its lore, even by keyword.
      if (e.level === 'region' && e.ref && Eng().regionDef(state, e.ref) && !Eng().regionKnown(state, e.ref)) return;
      if (e.level === 'location' && e.ref === room) add(e, i, 0, 'the player is here');
      if (e.level === 'character' && people.includes(e.ref)) add(e, i, 0, e.ref === state.player ? 'the player character' : `${nm(e.ref)} is present`);
      if (e.level === 'region' && region && e.ref === region) add(e, i, 1, "the player's region");
      // Up the tree (R-1): the regions the player's is inside, nearest first,
      // after the action's keywords, so a place with no lore of its own is
      // still grounded by its city's or its country's.
      const up = e.level === 'region' && region ? chain.indexOf(e.ref) : -1;
      if (up > 0) add(e, i, 2.5 + up / 10, `inside ${(Eng().regionDef(state, e.ref) || {}).name || e.ref}`);
      // A matching topic brings in world and topic entries after the player's
      // region and before the regions up the tree; entries about a region,
      // room or person keep their places (a topic only puts them first within
      // their own trigger, below).
      const tp = (e.level === 'world' || e.level === 'topic') && topicOf(e);
      if (tp) add(e, i, tp.group, tp.why);
      const kws = Array.isArray(e.keywords) ? e.keywords : [];
      const inAction = kws.find((k) => L.matches(k, o.action));
      if (inAction) add(e, i, 2, `"${inAction}" in the action`);
      else {
        const inScene = kws.find((k) => L.matches(k, scene));
        if (inScene) add(e, i, 3, `"${inScene}" in the last scene`);
      }
    });
    // The last fallback: when neither the room nor any region up the chain has
    // lore of its own, the world entries come in last, best priority first,
    // so the narrator always has something grounded.
    const grounded = all.some((e) => e.alwaysOn !== true && ((e.level === 'location' && e.ref === room) || (e.level === 'region' && chain.includes(e.ref))));
    if (!grounded) all.forEach((e, i) => { if (e.level === 'world' && e.alwaysOn !== true && !picks.has(e.id)) add(e, i, 5, 'world lore (nothing here has its own)'); });
    picks.forEach((p) => {
      const tp = L.REF_LEVELS.includes(p.e.level) && topicOf(p.e);
      if (tp) { p.topical = true; p.why.push(tp.why); }
    });
    const ranked = [...picks.values()].sort((a, b) => a.group - b.group
      || (b.topical ? 1 : 0) - (a.topical ? 1 : 0)
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
  // topics: the topic tags entries may use (default: the built-in list).
  L.problems = function (entries, where, topics) {
    const problems = [];
    const known = topics ? [...topics] : Object.keys(L.TOPICS);
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
      if (e.topics != null) {
        if (!Array.isArray(e.topics) || e.topics.length > lim.topics || !e.topics.every((t) => typeof t === 'string')) problems.push(`${at}: "topics" must be a list of at most ${lim.topics} topic tags`);
        else e.topics.filter((t) => !known.includes(t)).forEach((t) => problems.push(`${at}: "${t}" is not a topic this world knows (${known.join(', ')}); add it to the world's "loreTopics" to use it`));
      }
      req(e.priority == null || (Number.isInteger(e.priority) && e.priority >= 1 && e.priority <= 5), '"priority" must be a whole number from 1 to 5');
      req(e.alwaysOn == null || typeof e.alwaysOn === 'boolean', '"alwaysOn" must be true or false');
      req(e.draft == null || typeof e.draft === 'boolean', '"draft" must be true or false');
      req(e.alwaysOn !== true || e.level === 'world', '"alwaysOn" is for world entries only');
      req(e.sources == null || (Array.isArray(e.sources) && e.sources.every((s) => isObj(s) && typeof s.title === 'string' && s.title.trim() && typeof s.url === 'string' && /^https?:\/\//.test(s.url))),
        '"sources" must be a list of {title, url}');
    });
    return problems;
  };

  // The world's own topics: { topic: [words] }, short lowercase tags.
  L.topicProblems = function (loreTopics, where) {
    if (loreTopics == null) return [];
    const lim = L.LIMITS;
    const at = where ? `${where}: ` : '';
    if (!isObj(loreTopics)) return [`${at}"loreTopics" must map each topic to the words that bring it up, like {"mining": ["miner", "ore"]}`];
    const problems = [];
    const keys = Object.keys(loreTopics);
    if (keys.length > lim.worldTopics) problems.push(`${at}"loreTopics" can have at most ${lim.worldTopics} topics`);
    keys.forEach((t) => {
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(t)) problems.push(`${at}topic "${t}" must be a short lowercase tag (letters, digits or -, up to 24 characters)`);
      const ws = loreTopics[t];
      if (!Array.isArray(ws) || ws.length > lim.topicWords || !ws.every((w) => typeof w === 'string' && w.trim() && w.length <= lim.keyword)) {
        problems.push(`${at}topic "${t}" must list at most ${lim.topicWords} words or phrases (${lim.keyword} characters each) that bring it up`);
      }
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
