// Fact points, chapter rollups and prompt budgets.
(function (root) {
  const E = root.Ensemble;
  const Mem = (E.Memory = {});

  Mem.addFact = function (state, f) {
    const fact = {
      id: 'f' + state.nextFactId++,
      turn: state.turn,
      chapter: state.chapter,
      about: f.about || [],
      text: E.clip(f.text, 220),
      known_by: f.known_by && f.known_by.length ? f.known_by : ['all'],
      weight: E.clamp(Math.round(Number(f.weight) || 1), 1, 3),
    };
    // Its home (task B-0): a room, site or region id, beside the people in `about`.
    if (f.where) fact.where = f.where;
    // Where it came from (task B-0b): "intent" (the update step's record of
    // what happened) or "narration" (a detail the scene said); no field: the
    // engine or the author.
    if (f.source) fact.source = f.source;
    // Hearsay (task B-3) always reads as said, never as fact.
    if (fact.source === 'hearsay' && !Mem.saidWords(fact.text)) fact.text = E.clip(`People say ${fact.text.replace(/^(?:The|A|An|It|There|This|That|Someone|Somebody|He|She|They)\b/, (w) => w.toLowerCase())}`, 220);
    state.facts.push(fact);
    return fact;
  };

  Mem.knows = (fact, id) => fact.known_by.includes('all') || fact.known_by.includes(id);
  Mem.playerFacts = (state) => state.facts.filter((f) => Mem.knows(f, state.player));
  // What memory can still put in a prompt: past timeline events are already in
  // the chapter-zero summary (task 5-2), so their facts are left out.
  Mem.liveFacts = (state) => Mem.playerFacts(state).filter((f) => !f.inSummary);
  // Narrated details (task B-0b) count for consistency and never drive rules.
  // They stay at their home through chapter closes, so they are neither in the
  // core nor rolled up, and a close doesn't free them.
  Mem.narrated = (f) => f.source === 'narration';
  // Hearsay (task B-3): what people are saying, recorded as said. Like a
  // narrated detail it is never true for the engine: rules read only proven
  // facts (`Mem.unproven` covers both sources).
  Mem.hearsay = (f) => f.source === 'hearsay';
  Mem.unproven = (f) => Mem.narrated(f) || Mem.hearsay(f);
  // Text worded as said: "People say…", "Word is…", "Teo says…".
  Mem.SAID = [
    /^(?:people|everyone|everybody|someone|somebody|folks?|they)\b[^.;:]{0,30}?\b(?:say|says|said|claim|claims|reckon|whisper|whispers|swear)\b/i,
    /^(?:word|rumou?r|the (?:rumou?r|word|talk|story)) (?:is|goes|has it)\b/i,
    /^(?:[A-Z][\w.'-]*\s){1,3}(?:says|said|claims|claimed|insists|swears)\b/,
  ];
  Mem.saidWords = (text) => Mem.SAID.some((re) => re.test(String(text || '').trim()));
  Mem.rollable = (state) => Mem.liveFacts(state).filter((f) => !Mem.narrated(f));
  Mem.DETAILS_PER_HOME = 5;
  // Past the cap the oldest detail at that home goes. → the dropped facts.
  Mem.capDetails = function (state, fact) {
    const home = (f) => f.where || (f.about || [])[0];
    const same = state.facts.filter((f) => Mem.narrated(f) && home(f) === home(fact));
    const gone = same.slice(0, Math.max(0, same.length - Mem.DETAILS_PER_HOME));
    state.facts = state.facts.filter((f) => !gone.includes(f));
    return gone;
  };
  // Facts a given character knows that the player does not.
  Mem.privateFacts = (state, id) =>
    state.facts.filter((f) => !Mem.knows(f, state.player) && Mem.knows(f, id));

  // Budgets (task G-4): fit first, then fill. The reply, the header's fixed
  // part and a turn's user message come first (their sizes by context tier,
  // E.contextTier); facts and chapter summaries share what is left, at most
  // their old shares (a fifth and an eighth of the context) and at least
  // FLOOR. Lore is a share of the context by tier (task 5-1). Without a game
  // (the creator's lore test), the shares alone.
  Mem.FLOOR = { facts: 500, story: 400 };
  Mem.BRIEF_CAST_USER = 500;
  // A player who leads or is favored in a group (task G-6) gets the orders
  // task and its reply field in every intent call (task 7-7: the captain).
  Mem.ORDERS_USER = 150;
  Mem.budgets = function (state) {
    const t = E.contextTier();
    const ctx = t.tokens;
    const out = { facts: Math.floor(ctx * 0.2), story: Math.floor(ctx * 0.12), lore: Math.floor(ctx * t.lore), tier: t.id };
    if (!state || !state.scenario || !E.Prompts) return out;
    // A brief cast (task 7-2) carries each present person's wants and voice,
    // and the background's whereabouts, in the user message instead.
    const user = t.user + (E.Prompts.castBrief(state) ? Mem.BRIEF_CAST_USER : 0) + (E.Prompts.commandable && E.Prompts.commandable(state).length ? Mem.ORDERS_USER : 0);
    const room = ctx - t.reply - user - Mem.fixedHeader(state);
    out.facts = Math.min(out.facts, Math.max(Mem.FLOOR.facts, Math.floor(room * 0.55)));
    out.story = Math.min(out.story, Math.max(Mem.FLOOR.story, Math.floor(room * 0.45)));
    return out;
  };
  // Tokens in the header's fixed part (all but its live blocks) for this
  // scenario, player and tier, worked out once.
  const fixedSizes = new WeakMap();
  Mem.fixedHeader = function (state) {
    const key = `${state.player}|${E.contextTier().id}`;
    const seen = fixedSizes.get(state.scenario) || {};
    if (seen[key] == null) {
      seen[key] = E.estTokens(E.Prompts.fixedHeader(state));
      fixedSizes.set(state.scenario, seen);
    }
    return seen[key];
  };

  const factLine = (f) => `- [T${f.turn}] ${f.text}`;

  // ---------- scoped facts (task B-0) ----------
  // The header carries a core frozen at each chapter close (rule 7: it changes
  // only where the chapters block already rewrites what follows it). Everything
  // else is chosen per call for the user message, by what the scene touches.
  // Both come out of the facts budget, which the tiers already leave room for.
  Mem.CORE_SHARE = 0.5;
  Mem.SCENE_SHARES = { place: 0.3, people: 0.3, named: 0.2, always: 0.2 };
  Mem.freezeCore = (state) => { state.factCore = Mem.rollable(state).map((f) => f.id); };

  // The frozen facts that fit the core's share, newest kept, in the order they
  // happened. Older major facts live on in the chapter summaries, and come back
  // through the scene when it touches them.
  Mem.core = function (state) {
    const frozen = new Set(state.factCore || []);
    const facts = Mem.liveFacts(state).filter((f) => frozen.has(f.id));
    const budget = Math.floor(Mem.budgets(state).facts * Mem.CORE_SHARE);
    const keep = new Set();
    let used = 0;
    for (const f of facts.slice().reverse()) {
      used += E.estTokens(factLine(f));
      if (used > budget) break;
      keep.add(f.id);
    }
    return facts.filter((f) => keep.has(f.id));
  };
  Mem.factsBlock = (state) => Mem.core(state).map(factLine).join('\n');

  // The ids among `ids` whose names are in the text: the glossary's terms for
  // people, regions and sites (with its rule for parts of a name), and rooms
  // and unnamed groups by name.
  function namedIn(state, ids, text) {
    const hit = new Set();
    if (!text || !ids.size) return hit;
    const test = (id, term) => { if (ids.has(id) && !hit.has(id) && E.Lore.matches(term, text)) hit.add(id); };
    if (E.Glossary) E.Glossary.index(state).terms.forEach((t, term) => { if (t.kind !== 'lore') test(t.id, term); });
    ids.forEach((id) => {
      const l = state.locations[id];
      const g = (state.standees || {})[id];
      if (l) test(id, l.name);
      if (g) test(id, g.label);
    });
    return hit;
  }

  // Facts outside the core for this moment, within what the core leaves, in
  // the order they happened: [{ fact, compartment, tokens }]. Each compartment
  // fills up to its share, newest first, then spare room goes in the same
  // order. opts: action, scene (default: the last scene), room (default: where
  // the player is). Only player-known facts, so nothing reaches a prompt it
  // wasn't allowed in. Deterministic, so the engine and Debug always agree.
  Mem.sceneFacts = function (state, opts) {
    const o = opts || {};
    const Eng = E.Engine;
    const core = Mem.core(state);
    const inCore = new Set(core.map((f) => f.id));
    const rest = Mem.liveFacts(state).filter((f) => !inCore.has(f.id)).reverse();
    if (!rest.length) return [];
    const room = o.room || state.characters[state.player].status.location;
    const region = Eng.regionOf(state, room);
    const places = new Set([room, E.Sites.siteOf(state, room)].concat(region ? Eng.regionChain(state, region) : []));
    const here = new Set(Eng.present(state, room)
      .concat(Object.values(state.extras || {}).filter((x) => x.location === room).map((x) => x.id))
      .concat(Object.values(state.standees || {}).filter((g) => g.location === room).map((g) => g.id)));
    const about = (f) => f.about || [];
    const homes = { place: [], people: [], named: [], always: [] };
    const others = [];
    rest.forEach((f) => {
      if (f.where && places.has(f.where)) homes.place.push(f);
      else if (about(f).some((id) => here.has(id) || id === state.player)) homes.people.push(f);
      else others.push(f);
    });
    // The people in the room before the player's own running record, and a
    // home's details first: what was said about a place has nowhere else to live.
    const local = (f) => (about(f).some((id) => here.has(id)) ? 1 : 0);
    const detail = (f) => (Mem.narrated(f) ? 1 : 0);
    homes.place.sort((a, b) => detail(b) - detail(a));
    homes.people.sort((a, b) => local(b) - local(a) || detail(b) - detail(a));
    const last = state.recent && state.recent[state.recent.length - 1];
    const scene = o.scene != null ? o.scene : last ? last.text : '';
    const ids = new Set(others.flatMap((f) => about(f).concat(f.where || [])));
    const named = namedIn(state, ids, [o.action, scene].filter(Boolean).join('\n'));
    others.forEach((f) => {
      if (about(f).concat(f.where || []).some((id) => named.has(id))) homes.named.push(f);
      // "Always": major facts, and this chapter's facts with no home at all.
      else if (f.weight >= 3 || (!f.where && !about(f).length && f.chapter === state.chapter)) homes.always.push(f);
    });
    const total = Mem.budgets(state).facts - E.estTokens(core.map(factLine).join('\n'));
    const kinds = Object.keys(Mem.SCENE_SHARES);
    const picks = new Map();
    let used = 0;
    const take = (f, compartment, left) => {
      const tokens = E.estTokens(factLine(f));
      if (picks.has(f.id) || tokens > left) return 0;
      picks.set(f.id, { fact: f, compartment, tokens });
      used += tokens;
      return tokens;
    };
    kinds.forEach((k) => {
      let left = Math.floor(total * Mem.SCENE_SHARES[k]);
      homes[k].forEach((f) => { left -= take(f, k, left); });
    });
    kinds.forEach((k) => homes[k].forEach((f) => take(f, k, total - used)));
    return rest.filter((f) => picks.has(f.id)).reverse().map((f) => picks.get(f.id));
  };
  Mem.sceneBlock = (picks) => picks.map((p) => factLine(p.fact)).join('\n');

  // Debug: while a turn report is open, what each prompt carried per
  // compartment ([{ call, compartment, count, tokens }]); set by the engine's
  // telemetry.
  Mem.collector = null;
  Mem.note = function (call, picks) {
    const c = Mem.collector;
    if (!c || c.some((x) => x.call === call)) return;
    const by = {};
    picks.forEach((p) => {
      const row = by[p.compartment] || (by[p.compartment] = { call, compartment: p.compartment, count: 0, tokens: 0 });
      row.count++;
      row.tokens += p.tokens;
    });
    c.push(...Object.values(by));
  };

  // ---------- the story so far: the canon past, arcs, chapters (task B-10) ----------
  // A game is long when its summaries outgrow the story budget, which goes by
  // turns and facts, never in-game time. Then the oldest fold into an arc
  // (one call at a chapter close) instead of dropping out of the header. The
  // canon past ("Before the story") is authored, so the model never folds it:
  // it comes first with up to CANON_SHARE of the budget, rewritten once to fit
  // when it runs over (personal events stay as facts about the people in them).
  Mem.CANON_SHARE = 0.5;
  Mem.canon = (state) => state.chapters.find((c) => c.n === 0) || null;
  const canonLine = (c, text) => `Chapter 0 — ${c.title}: ${text}`;
  const chapterLine = (c) => `Chapter ${c.n} — ${c.title}: ${c.summary}`;
  const arcLine = (a) => `Chapters ${a.from}–${a.to} — ${a.title}: ${a.summary}`;
  // Tokens the canon past may take, and its text as shown: the rewrite, else
  // the original, else (over its share, not rewritten yet) its newest sentences.
  Mem.canonShare = (state) => Math.floor(Mem.budgets(state).story * Mem.CANON_SHARE);
  // A rewrite stands while it still fits (the budget moves a little with the
  // header); over it again, the history is rewritten from the original.
  const canonBase = (c) => (c.fitted ? c.fitted.text : c.summary);
  Mem.canonOver = function (state) {
    const c = Mem.canon(state);
    return !!c && E.estTokens(canonLine(c, canonBase(c))) > Mem.canonShare(state);
  };
  Mem.canonText = function (state) {
    const c = Mem.canon(state);
    if (!c) return null;
    return Mem.fitSentences(canonBase(c), Mem.canonShare(state) - E.estTokens(canonLine(c, '')));
  };
  // The newest sentences of a text that fit in so many tokens (it is in time order).
  Mem.fitSentences = function (text, tokens) {
    if (E.estTokens(text) <= tokens) return text;
    const parts = String(text).split(/(?<=[.!?])\s+/);
    const out = [];
    for (let i = parts.length - 1; i >= 0; i--) {
      if (E.estTokens(out.concat(parts[i]).join(' ')) > tokens) break;
      out.unshift(parts[i]);
    }
    return out.join(' ');
  };
  // What the block lists after the canon past, oldest first: arcs not folded
  // into another, then chapters not folded into an arc.
  Mem.storyEntries = function (state) {
    const arcs = (state.arcs || []).filter((a) => a.into == null).map((a) => ({ kind: 'arc', n: a.n, fromTurn: a.fromTurn, line: arcLine(a), item: a }));
    const chapters = state.chapters.filter((c) => c.n !== 0 && c.arc == null).map((c) => ({ kind: 'chapter', n: c.n, fromTurn: c.fromTurn, line: chapterLine(c), item: c }));
    return arcs.concat(chapters).sort((a, b) => a.fromTurn - b.fromTurn);
  };
  Mem.storyBlock = function (state) {
    const budget = Mem.budgets(state).story;
    const c = Mem.canon(state);
    const text = c && Mem.canonText(state);
    const head = text ? canonLine(c, text) : null;
    let used = head ? E.estTokens(head) : 0;
    const out = [];
    const entries = Mem.storyEntries(state);
    for (let i = entries.length - 1; i >= 0; i--) {
      const cost = E.estTokens(entries[i].line);
      if (used + cost > budget) break;
      out.unshift(entries[i].line);
      used += cost;
    }
    return (head ? [head] : []).concat(out).join('\n');
  };
  // Entries to fold into an arc when they no longer all fit: the oldest half
  // (at least two). → [] when everything fits.
  Mem.needsArc = function (state) {
    const budget = Mem.budgets(state).story;
    const c = Mem.canon(state);
    const text = c && Mem.canonText(state);
    const head = text ? E.estTokens(canonLine(c, text)) : 0;
    const entries = Mem.storyEntries(state);
    // Counted line by line, as the block counts them.
    if (entries.length < 2 || entries.reduce((n, e) => n + E.estTokens(e.line), head) <= budget) return [];
    return entries.slice(0, Math.max(2, Math.floor(entries.length / 2)));
  };
  Mem.foldArc = function (state, sum, entries) {
    state.arcs = state.arcs || [];
    const n = state.arcs.length + 1;
    const chapterNs = (e) => (e.kind === 'chapter' ? [e.n] : [e.item.from, e.item.to]);
    const ns = entries.flatMap(chapterNs);
    const arc = {
      n,
      title: String(sum.title || `Chapters ${Math.min(...ns)}–${Math.max(...ns)}`).slice(0, 80),
      summary: E.clip(sum.summary || '', 900),
      from: Math.min(...ns),
      to: Math.max(...ns),
      fromTurn: entries[0].item.fromTurn,
      toTurn: entries[entries.length - 1].item.toTurn,
    };
    state.arcs.push(arc);
    entries.forEach((e) => { e.item[e.kind === 'chapter' ? 'arc' : 'into'] = n; });
    return arc;
  };
  // The canon past rewritten to fit its share. Past events about particular
  // people go back to being facts, which the scene opens when they are there.
  Mem.fitCanon = function (state, text) {
    const c = Mem.canon(state);
    c.fitted = { text, share: Mem.canonShare(state) };
    state.facts.forEach((f) => { if (f.canon && f.inSummary && (f.about || []).length) delete f.inSummary; });
  };

  Mem.turnsInChapter = (state) => state.turn - state.chapterStartTurn + 1;

  // A chapter's job is to free context: its minor player-known facts are
  // replaced by one summary. So it closes when that is worth it, not on a
  // dramatic moment (chapters were closing after one or two turns):
  // - size: the facts it would roll up reach a share of the facts budget
  //   (after a few turns), or the live facts are over budget (after two). All
  //   of them, wherever they are shown (task B-0): what the scene happens to
  //   open never changes when a chapter closes;
  // - length: a backstop, the most turns a chapter runs (Settings).
  Mem.CHAPTER = { minTurns: 4, share: 0.35 };
  // Tokens a chapter close would free: this chapter's minor facts the player knows.
  Mem.freeable = (state) => E.estTokens(Mem.chapterFacts(state).filter((f) => f.weight < 3 && !f.inSummary).map(factLine).join('\n'));
  Mem.needsChapter = function (state) {
    if (state.turn < state.chapterStartTurn) return false;
    const turns = Mem.turnsInChapter(state);
    const budget = Mem.budgets(state).facts;
    // Over budget counts only when a close would free something: major facts
    // stay after it, so they alone would close a chapter every two turns.
    if (turns >= 2 && E.estTokens(Mem.rollable(state).map(factLine).join('\n')) > budget && Mem.freeable(state) > 0) return 'size';
    if (turns >= Mem.CHAPTER.minTurns && Mem.freeable(state) >= budget * Mem.CHAPTER.share) return 'size';
    if (turns >= E.settings.chapterLength) return 'length';
    return false;
  };

  Mem.chapterFacts = (state) =>
    state.facts.filter((f) => f.chapter === state.chapter && Mem.knows(f, state.player) && !Mem.narrated(f));

  // Roll the current chapter up: minor player-known facts are replaced by the
  // summary; major (weight 3) and private facts and narrated details are kept
  // individually.
  Mem.closeChapter = function (state, summary, reason) {
    const n = state.chapter;
    state.chapters.push({
      n,
      title: String(summary.title || `Chapter ${n}`).slice(0, 80),
      summary: E.clip(summary.summary || '', 700),
      fromTurn: state.chapterStartTurn,
      toTurn: state.turn,
      reason,
    });
    state.facts = state.facts.filter(
      (f) => f.chapter !== n || f.weight >= 3 || !Mem.knows(f, state.player) || Mem.narrated(f)
    );
    state.chapter = n + 1;
    state.chapterStartTurn = state.turn + 1;
    state.flags.chapterWorthy = false;
    Mem.freezeCore(state);
  };
})(typeof window !== 'undefined' ? window : globalThis);
