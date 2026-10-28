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
    state.facts.push(fact);
    return fact;
  };

  Mem.knows = (fact, id) => fact.known_by.includes('all') || fact.known_by.includes(id);
  Mem.playerFacts = (state) => state.facts.filter((f) => Mem.knows(f, state.player));
  // For the header: past timeline events are already in the chapter-zero
  // summary (task 5-2), so their facts are left out there.
  Mem.headerFacts = (state) => Mem.playerFacts(state).filter((f) => !f.inSummary);
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
  Mem.budgets = function (state) {
    const t = E.contextTier();
    const ctx = t.tokens;
    const out = { facts: Math.floor(ctx * 0.2), story: Math.floor(ctx * 0.12), lore: Math.floor(ctx * t.lore), tier: t.id };
    if (!state || !state.scenario || !E.Prompts) return out;
    // A brief cast (task 7-2) carries each present person's wants and voice,
    // and the background's whereabouts, in the user message instead.
    const user = t.user + (E.Prompts.castBrief(state) ? Mem.BRIEF_CAST_USER : 0);
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

  // Player-known facts for the shared prompt prefix, within the budget, in
  // the order they happened. Standard and roomy: every weight-3 fact, then
  // the newest minor ones. Compact (task G-4): facts about the player and
  // weight-3 ones first, then the rest, newest first, all within the budget
  // (older major facts live on in the chapter summaries).
  Mem.factsBlock = function (state) {
    const facts = Mem.headerFacts(state);
    const b = Mem.budgets(state);
    const lines = facts.map(factLine);
    if (E.estTokens(lines.join('\n')) <= b.facts) return lines.join('\n');
    const keep = new Set();
    let used = 0;
    const take = (f) => {
      const cost = E.estTokens(factLine(f));
      if (keep.has(f.id) || used + cost > b.facts) return false;
      keep.add(f.id);
      used += cost;
      return true;
    };
    const newest = facts.slice().reverse();
    if (b.tier === 'compact') {
      newest.filter((f) => f.weight >= 3 || (f.about || []).includes(state.player)).forEach(take);
      newest.forEach(take);
    } else {
      facts.filter((f) => f.weight >= 3).forEach((f) => { keep.add(f.id); used += E.estTokens(factLine(f)); });
      for (const f of newest) if (!keep.has(f.id) && !take(f)) break;
    }
    return facts.filter((f) => keep.has(f.id)).map(factLine).join('\n');
  };

  Mem.storyBlock = function (state) {
    const budget = Mem.budgets(state).story;
    const out = [];
    let used = 0;
    for (let i = state.chapters.length - 1; i >= 0; i--) {
      const c = state.chapters[i];
      const line = `Chapter ${c.n} — ${c.title}: ${c.summary}`;
      const cost = E.estTokens(line);
      if (used + cost > budget) break;
      out.unshift(line);
      used += cost;
    }
    return out.join('\n');
  };

  Mem.turnsInChapter = (state) => state.turn - state.chapterStartTurn + 1;

  // A chapter's job is to free context: its minor player-known facts are
  // replaced by one summary. So it closes when that is worth it, not on a
  // dramatic moment (chapters were closing after one or two turns):
  // - size: the facts it would roll up reach a share of the facts budget
  //   (after a few turns), or the header's facts are over budget (after two);
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
    if (turns >= 2 && E.estTokens(Mem.headerFacts(state).map(factLine).join('\n')) > budget && Mem.freeable(state) > 0) return 'size';
    if (turns >= Mem.CHAPTER.minTurns && Mem.freeable(state) >= budget * Mem.CHAPTER.share) return 'size';
    if (turns >= E.settings.chapterLength) return 'length';
    return false;
  };

  Mem.chapterFacts = (state) =>
    state.facts.filter((f) => f.chapter === state.chapter && Mem.knows(f, state.player));

  // Roll the current chapter up: minor player-known facts are replaced by the
  // summary; major (weight 3) and private facts are kept individually.
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
      (f) => f.chapter !== n || f.weight >= 3 || !Mem.knows(f, state.player)
    );
    state.chapter = n + 1;
    state.chapterStartTurn = state.turn + 1;
    state.flags.chapterWorthy = false;
  };
})(typeof window !== 'undefined' ? window : globalThis);
